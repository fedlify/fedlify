import argon2 from "argon2";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const uploadObject = vi.fn();
const deleteObject = vi.fn();
const transaction = vi.fn();
const audit = vi.fn();
const storageConfigured = vi.fn();
const findUser = vi.fn();
const findPackages = vi.fn();

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/rbac", () => ({ assertSiteAccess: async () => undefined, isForbiddenError: () => false }));
vi.mock("@/lib/runtime-config", () => ({ publicBaseUrl: () => "https://app.fedlify.test" }));
vi.mock("@/lib/archive", () => ({
  directoryToArchiveMap: async () => ({}),
  unzipToArchiveMap: async () => ({}),
  zipFiles: async (files: Record<string, string | Buffer>) =>
    Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString("base64")]))))
}));
vi.mock("@/lib/kit-crypto", async (orig) => {
  const real = await orig<typeof import("@/lib/kit-crypto")>();
  return { ...real, encryptKit: (plain: Uint8Array, pass: string) => real.encryptKit(plain, pass, 10) };
});
vi.mock("@/lib/storage", () => ({
  objectKey: (parts: string[]) => parts.join("/"),
  readObject: async () => Buffer.from(""),
  storageConfigured: () => storageConfigured(),
  uploadObject: (...a: unknown[]) => uploadObject(...a),
  deleteObject: (...a: unknown[]) => deleteObject(...a),
  createPresignedDownloadUrl: async () => "https://s3.test/kit.zip"
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: (...a: unknown[]) => findUser(...a) },
    studySite: {
      findUnique: async () => ({
        id: "ss1",
        studyId: "s1",
        code: "a",
        name: "Site A",
        organizationId: "o1",
        study: { title: "T" },
        site: { id: "site1", nvflareClientName: "site-a" }
      })
    },
    siteJoinPackage: { findMany: (...a: unknown[]) => findPackages(...a) },
    nvflareDeployment: { findFirst: async () => null },
    $transaction: (...a: unknown[]) => transaction(...a)
  }
}));

import { decryptKit } from "@/lib/kit-crypto";
import { POST } from "@/app/api/v1/sites/[siteId]/join-package/route";

const PASSWORD = "test-only-account-password";
let hash: string;
beforeAll(async () => {
  hash = await argon2.hash(PASSWORD, { memoryCost: 1024, timeCost: 2, parallelism: 1 });
});

function call(body: unknown = { password: PASSWORD }) {
  const request = new Request("http://x/api", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return POST(Object.assign(request, { nextUrl: new URL("http://x/api") }) as never, { params: Promise.resolve({ siteId: "ss1" }) });
}

describe("join-package route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteObject.mockResolvedValue(undefined);
    storageConfigured.mockReturnValue(true);
    findUser.mockResolvedValue({ passwordHash: hash });
    findPackages.mockResolvedValue([{ storageKey: "old/key" }]);
  });

  it("leaves the old kit and token untouched when the upload fails", async () => {
    uploadObject.mockRejectedValue(new Error("s3 down"));
    const response = (await call())!;
    expect(response.status).toBe(502);
    expect(transaction).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "site.join_package.create_failed" }));
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("enrollmentToken");
    expect(text).not.toContain("passphrase\":\"");
  });

  it("commits the new kit only after the upload succeeded, then deletes the superseded object", async () => {
    uploadObject.mockResolvedValue(undefined);
    transaction.mockResolvedValue({ id: "pkg1", downloadGrantHash: "x" });
    const response = (await call())!;
    expect(response.status).toBe(201);
    expect(uploadObject).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(uploadObject.mock.invocationCallOrder[0]!).toBeLessThan(transaction.mock.invocationCallOrder[0]!);
    expect(deleteObject).toHaveBeenCalledWith("old/key");
    expect(deleteObject.mock.invocationCallOrder[0]!).toBeGreaterThan(transaction.mock.invocationCallOrder[0]!);
    const body = await response.json();
    expect(body.package.downloadGrantHash).toBeUndefined();
    expect(body.revocation).toBe("partial");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns the passphrase once and never stores, uploads or audits it", async () => {
    uploadObject.mockResolvedValue(undefined);
    transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const created: unknown[] = [];
      const tx = {
        siteJoinPackage: { updateMany: async () => ({}), create: async (a: unknown) => (created.push(a), { id: "pkg1" }) },
        site: { update: async () => ({}) },
        studySite: { update: async () => ({}) }
      };
      const result = await fn(tx);
      (transaction as unknown as { created: unknown[] }).created = created;
      return result;
    });
    const response = (await call())!;
    const body = await response.json();
    expect(body.passphrase.split("-").length).toBeGreaterThanOrEqual(7);
    const pass: string = body.passphrase;
    const persisted = JSON.stringify((transaction as unknown as { created: unknown[] }).created, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(persisted).not.toContain(pass);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(pass);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(PASSWORD);
    const uploaded = uploadObject.mock.calls[0]![1] as Buffer;
    expect(uploaded.includes(Buffer.from(pass))).toBe(false);
    const outer = JSON.parse(uploaded.toString()) as Record<string, string>;
    expect(Object.keys(outer).sort()).toEqual(["README.txt", "kit.zip.age", "unlock.ps1", "unlock.sh"]);
    // The ciphertext that was uploaded opens with exactly the passphrase the response returned, and with no other.
    const ciphertext = Buffer.from(outer["kit.zip.age"]!, "base64");
    const inner = JSON.parse((await decryptKit(ciphertext, pass)).toString()) as Record<string, string>;
    expect(Object.keys(inner)).toContain("README.md");
    await expect(decryptKit(ciphertext, "wrong-pass-phrase")).rejects.toThrow();
    // Nothing outside the encrypted part holds a kit file's content, and the README holds no secret.
    for (const [name, b64] of Object.entries(outer)) {
      if (name !== "kit.zip.age") expect(Buffer.from(b64, "base64").toString()).not.toContain(pass);
    }
  });

  it("refuses with 503 when too many encryptions are already running, changing nothing", async () => {
    const { acquireSlot } = await import("@/lib/rate-limit");
    const held = [acquireSlot("kit-encrypt", 2), acquireSlot("kit-encrypt", 2)];
    const response = (await call())!;
    held.forEach((release) => release?.());
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("kit_encryption_busy");
    expect(uploadObject).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("a local-runtime kit says so, and the create path counts its one handed-out URL as a download", async () => {
    uploadObject.mockResolvedValue(undefined);
    const created: Array<{ data: { downloadCount: number } }> = [];
    transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        siteJoinPackage: { updateMany: async () => ({}), create: async (a: never) => (created.push(a), { id: "pkg1" }) },
        site: { update: async () => ({}) },
        studySite: { update: async () => ({}) }
      })
    );
    const body = await (await call())!.json();
    expect(body.kitKind).toBe("local");
    expect(body.message).toContain("Publish the study to get the newer runner");
    expect(body.downloadUrl).toBe("https://s3.test/kit.zip");
    expect(created[0]!.data.downloadCount).toBe(1);
  });

  it("rejects a wrong password with 403 step_up_failed, audits it without the password, and changes nothing", async () => {
    const response = (await call({ password: "wrong-wrong" }))!;
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("step_up_failed");
    expect(uploadObject).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "site.join_package.create_failed", metadata: { reason: "step_up_failed", step: "step_up" } }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain("wrong-wrong");
  });

  it("requires a password, and explains accounts that have none", async () => {
    const missing = (await call({}))!;
    expect(missing.status).toBe(403);
    expect((await missing.json()).error.code).toBe("step_up_required");
    findUser.mockResolvedValue({ passwordHash: null });
    const none = (await call())!;
    expect(none.status).toBe(403);
    const body = await none.json();
    expect(body.error.code).toBe("password_not_set");
    expect(body.error.message).toContain("no password");
    expect(uploadObject).not.toHaveBeenCalled();
  });

  it("rate limits repeated wrong passwords with 429", async () => {
    findUser.mockResolvedValue({ passwordHash: hash });
    const { STEP_UP_MAX_FAILURES } = await import("@/lib/step-up");
    let last = 0;
    for (let i = 0; i < STEP_UP_MAX_FAILURES + 2; i++) last = (await call({ password: "nope" }))!.status;
    expect(last).toBe(429);
    // Even the right password is refused while locked, and nothing was uploaded.
    expect((await call())!.status).toBe(429);
    expect(uploadObject).not.toHaveBeenCalled();
  });
});
