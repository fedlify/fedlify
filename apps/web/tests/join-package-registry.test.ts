import argon2 from "argon2";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_ROBOT_SECRET = "unit-test-robot-secret-not-real";
const FAKE_GLOBAL_SECRET = "unit-test-global-pull-secret-not-real";
const uploadObject = vi.fn();
const deleteObject = vi.fn();
const transaction = vi.fn();
const audit = vi.fn();
const storageConfigured = vi.fn();
const findPackages = vi.fn();
const mintSiteRobot = vi.fn();
const discardMintedRobot = vi.fn();
const deleteRobotRows = vi.fn();
const activate = vi.fn();
const harborConfigured = vi.fn();
const deployment = vi.fn();

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
vi.mock("@/lib/harbor-registry", async (orig) => {
  const real = await orig<typeof import("@/lib/harbor-registry")>();
  return { ...real, harborConfig: () => (harborConfigured() ? { baseUrl: "https://harbor.test", username: "u", password: "p" } : null) };
});
vi.mock("@/lib/registry-access", () => ({
  mintSiteRobot: (...a: unknown[]) => mintSiteRobot(...a),
  discardMintedRobot: (...a: unknown[]) => discardMintedRobot(...a),
  deleteRobotRows: (...a: unknown[]) => deleteRobotRows(...a),
  activateRobotInTransaction: (...a: unknown[]) => activate(...a)
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: async () => ({ passwordHash: hashHolder.hash }) },
    studySite: {
      findUnique: async () => ({ id: "ss1", studyId: "s1", code: "a", name: "Site A", organizationId: "o1", study: { title: "T" }, site: { id: "site1", nvflareClientName: "site-a" } })
    },
    siteJoinPackage: { findMany: (...a: unknown[]) => findPackages(...a) },
    nvflareDeployment: { findFirst: async () => deployment() },
    $transaction: (...a: unknown[]) => transaction(...a)
  }
}));
const hashHolder = vi.hoisted(() => ({ hash: "" }));

import { decryptKit } from "@/lib/kit-crypto";
import { POST } from "@/app/api/v1/sites/[siteId]/join-package/route";

const PASSWORD = "test-only-account-password";
const DIGEST = "a".repeat(64);
const perStudy = () => ({ id: "d1", studyId: "s1", runtimeMode: "k8s", status: "ACTIVE", hostname: "demo.fedlify.test", serverAddress: "demo.fedlify.test:443", clientKitPrefix: "k/clients", provisionedSites: [{ name: "site-a" }], imageDigest: `harbor.test/fedlify-s-demo/demo@sha256:${DIGEST}` });
const legacy = () => ({ ...perStudy(), imageDigest: `harbor.test/fedlify-studies/demo@sha256:${DIGEST}` });

beforeAll(async () => {
  hashHolder.hash = await argon2.hash(PASSWORD, { memoryCost: 1024, timeCost: 2, parallelism: 1 });
});

function call() {
  const request = new Request("http://x/api", { method: "POST", body: JSON.stringify({ password: PASSWORD }), headers: { "content-type": "application/json" } });
  return POST(Object.assign(request, { nextUrl: new URL("http://x/api") }) as never, { params: Promise.resolve({ siteId: "ss1" }) });
}

function commitOk(created: unknown[] = []) {
  transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      siteJoinPackage: { updateMany: async () => ({}), create: async (a: unknown) => (created.push(a), { id: "pkg1" }) },
      site: { update: async () => ({}) },
      studySite: { update: async () => ({}) }
    })
  );
  return created;
}

async function innerKit(body: { passphrase: string }) {
  const outer = JSON.parse((uploadObject.mock.calls[0]![1] as Buffer).toString()) as Record<string, string>;
  return JSON.parse((await decryptKit(Buffer.from(outer["kit.zip.age"]!, "base64"), body.passphrase)).toString()) as Record<string, string>;
}
const text = (b64: string) => Buffer.from(b64, "base64").toString();

describe("join-package route with per-study registry projects", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    deleteObject.mockResolvedValue(undefined);
    uploadObject.mockResolvedValue(undefined);
    storageConfigured.mockReturnValue(true);
    harborConfigured.mockReturnValue(true);
    findPackages.mockResolvedValue([{ storageKey: "old/key" }]);
    deployment.mockReturnValue(perStudy());
    mintSiteRobot.mockResolvedValue({ rowId: "row1", username: "robot$fedlify-s-demo+site-a-row1", password: FAKE_ROBOT_SECRET, expiresAt: new Date("2027-01-01T00:00:00Z") });
    discardMintedRobot.mockResolvedValue(undefined);
    deleteRobotRows.mockResolvedValue("revoked");
    activate.mockResolvedValue(["oldrow"]);
    process.env.FEDLIFY_STUDY_PULL_USERNAME = "global-pull";
    process.env.FEDLIFY_STUDY_PULL_PASSWORD = FAKE_GLOBAL_SECRET;
    process.env.FEDLIFY_STUDY_REGISTRY = "harbor.test";
  });

  it("puts the site's own robot in the encrypted kit and never the shared credential", async () => {
    const created = commitOk();
    const response = (await call())!;
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(mintSiteRobot).toHaveBeenCalledWith(expect.objectContaining({ project: "fedlify-s-demo", studySiteId: "ss1", siteCode: "a" }));
    const inner = await innerKit(body);
    expect(text(inner[".fedlify/registry-credential"]!)).toBe(`robot$fedlify-s-demo+site-a-row1\n${FAKE_ROBOT_SECRET}\n`);
    expect(Object.values(inner).map(text).join("\n")).not.toContain(FAKE_GLOBAL_SECRET);
    // Outside the encrypted part, in the database writes, in the audit rows and in the response: no robot secret.
    const outer = JSON.parse((uploadObject.mock.calls[0]![1] as Buffer).toString()) as Record<string, string>;
    for (const [name, b64] of Object.entries(outer)) if (name !== "kit.zip.age") expect(text(b64)).not.toContain(FAKE_ROBOT_SECRET);
    expect((uploadObject.mock.calls[0]![1] as Buffer).includes(Buffer.from(FAKE_ROBOT_SECRET))).toBe(false);
    expect(JSON.stringify(created, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(FAKE_ROBOT_SECRET);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(FAKE_ROBOT_SECRET);
    expect(JSON.stringify(body)).not.toContain(FAKE_ROBOT_SECRET);
  });

  it("activates the robot in the same transaction as the package, then deletes the superseded robots after the commit", async () => {
    commitOk();
    const body = await (await call())!.json();
    expect(activate).toHaveBeenCalledWith(expect.anything(), { rowId: "row1", studySiteId: "ss1", packageId: "pkg1" });
    expect(deleteRobotRows).toHaveBeenCalledWith(["oldrow"], "kit_rotation", expect.anything());
    expect(deleteRobotRows.mock.invocationCallOrder[0]!).toBeGreaterThan(transaction.mock.invocationCallOrder[0]!);
    expect(mintSiteRobot.mock.invocationCallOrder[0]!).toBeLessThan(uploadObject.mock.invocationCallOrder[0]!);
    expect(body.revocationDetail).toEqual({ token: "revoked", registry: "revoked", certificate: "not_reissued" });
  });

  it("keeps the label partial while the certificate is not re-issued, even when the registry revocation completed", async () => {
    commitOk();
    const body = await (await call())!.json();
    expect(body.revocationDetail.registry).toBe("revoked");
    expect(body.revocation).toBe("partial");
  });

  it("reports registry: pending when Harbor could not delete the old robot", async () => {
    commitOk();
    deleteRobotRows.mockResolvedValue("pending");
    const body = await (await call())!.json();
    expect(body.revocationDetail.registry).toBe("pending");
    expect(body.revocation).toBe("partial");
  });

  it("with Harbor down: 502 registry_unavailable, nothing uploaded or committed, previous kit untouched, no fallback to the shared credential", async () => {
    mintSiteRobot.mockRejectedValue(Object.assign(new Error("Harbor is unreachable"), { name: "HarborError", code: "unavailable" }));
    const response = (await call())!;
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.code).toBe("registry_unavailable");
    expect(uploadObject).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
    expect(deleteRobotRows).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain(FAKE_GLOBAL_SECRET);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "site.join_package.create_failed", metadata: expect.objectContaining({ reason: "registry_unavailable" }) }));
  });

  it("deletes the new robot when the upload fails, and commits nothing", async () => {
    uploadObject.mockRejectedValue(new Error("s3 down"));
    const response = (await call())!;
    expect(response.status).toBe(502);
    expect(discardMintedRobot).toHaveBeenCalledWith("row1", "upload_failed", expect.anything());
    expect(transaction).not.toHaveBeenCalled();
    expect(deleteRobotRows).not.toHaveBeenCalled();
  });

  it("deletes the new robot when the commit fails, and does not delete the old ones", async () => {
    transaction.mockRejectedValue(new Error("db down"));
    await expect(call()).rejects.toThrow("db down");
    expect(discardMintedRobot).toHaveBeenCalledWith("row1", "commit_failed", expect.anything());
    expect(deleteRobotRows).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("mints no robot when encryption is busy", async () => {
    const { acquireSlot } = await import("@/lib/rate-limit");
    const held = [acquireSlot("kit-encrypt", 2), acquireSlot("kit-encrypt", 2)];
    const response = (await call())!;
    held.forEach((release) => release?.());
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("kit_encryption_busy");
    expect(mintSiteRobot).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("mints no robot when object storage is not configured (no file is produced)", async () => {
    storageConfigured.mockReturnValue(false);
    commitOk();
    const response = (await call())!;
    expect(response.status).toBe(201);
    expect(mintSiteRobot).not.toHaveBeenCalled();
    expect(uploadObject).not.toHaveBeenCalled();
    expect((await response.json()).passphrase).toBeNull();
  });

  it("answers 503 before minting anything when the provisioner is not configured", async () => {
    harborConfigured.mockReturnValue(false);
    const response = (await call())!;
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("registry_not_configured");
    expect(mintSiteRobot).not.toHaveBeenCalled();
  });

  it("a study still in the legacy project mints no robot and keeps using the global credential", async () => {
    deployment.mockReturnValue(legacy());
    harborConfigured.mockReturnValue(false);
    commitOk();
    const body = await (await call())!.json();
    expect(mintSiteRobot).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    const inner = await innerKit(body);
    expect(text(inner[".fedlify/registry-credential"]!)).toBe(`global-pull\n${FAKE_GLOBAL_SECRET}\n`);
    expect(body.revocationDetail.registry).toBe("not_applicable");
  });

  it("follows the image path, not the registry-mode flag", async () => {
    process.env.FEDLIFY_REGISTRY_MODE = "legacy";
    commitOk();
    await call();
    delete process.env.FEDLIFY_REGISTRY_MODE;
    expect(mintSiteRobot).toHaveBeenCalledTimes(1);
  });
});
