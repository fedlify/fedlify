import argon2 from "argon2";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const audit = vi.fn();
const updateMany = vi.fn();
const update = vi.fn();
const findUser = vi.fn();
const store: { hash: string | null; expires: Date | null; count: number } = { hash: null, expires: null, count: 0 };

let currentUser = "u2";
const presign = vi.fn();
vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: currentUser }) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/rbac", () => ({ assertSiteAccess: async () => undefined, isForbiddenError: () => false }));
vi.mock("@/lib/runtime-config", () => ({ publicBaseUrl: () => "https://app.fedlify.test" }));
vi.mock("@/lib/storage", () => ({
  storageConfigured: () => true,
  createPresignedDownloadUrl: (...a: unknown[]) => presign(...a)
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: (...a: unknown[]) => findUser(...a) },
    nvflareDeployment: { findFirst: async () => null },
    siteJoinPackage: {
      findFirst: async () => ({
        id: "pkg1", studySiteId: "ss1", status: "ACTIVE", expiresAt: new Date(Date.now() + 1e9), sizeBytes: BigInt(10),
        storageKey: "k", filename: "a.zip", checksum: "c", downloadGrantHash: store.hash,
        studySite: { id: "ss1", studyId: "s1", organizationId: "o1", code: "a", name: "A", study: { title: "T" }, site: { id: "site1", nvflareClientName: "n" } }
      }),
      update: async (args: { data: { downloadGrantHash: string; downloadGrantExpiresAt: Date } }) => {
        update(args);
        store.hash = args.data.downloadGrantHash;
        store.expires = args.data.downloadGrantExpiresAt;
        return {};
      },
      // Mirrors the conditional update: succeeds only when hash and expiry match, and clears the grant atomically.
      updateMany: async (args: { where: { downloadGrantHash: string; downloadGrantExpiresAt: { gt: Date } } }) => {
        updateMany(args);
        const ok = store.hash !== null && store.hash === args.where.downloadGrantHash && store.expires! > args.where.downloadGrantExpiresAt.gt;
        if (ok) Object.assign(store, { hash: null, expires: null, count: store.count + 1 });
        return { count: ok ? 1 : 0 };
      }
    }
  }
}));

import { POST as RAW_POST } from "@/app/api/v1/sites/[siteId]/join-package/[packageId]/download/route";

const PASSWORD = "test-only-account-password-2";
let hash: string;
beforeAll(async () => {
  hash = await argon2.hash(PASSWORD, { memoryCost: 1024, timeCost: 2, parallelism: 1 });
});
const POST = async (...a: Parameters<typeof RAW_POST>) => (await RAW_POST(...a))!;
const ctx = { params: Promise.resolve({ siteId: "ss1", packageId: "pkg1" }) };
function req(method: string, url: string, body?: unknown) {
  const r = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
  return Object.assign(r, { nextUrl: new URL(url) }) as never;
}

describe("kit download step-up", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = "u2";
    presign.mockResolvedValue("https://s3.test/kit.zip?sig=1");
    Object.assign(store, { hash: null, expires: null, count: 0 });
    findUser.mockResolvedValue({ passwordHash: hash });
  });

  it("wrong password: 403 step_up_failed, audited without the password, no grant minted", async () => {
    const res = await POST(req("POST", "http://x/d", { password: "bad-bad-bad" }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("step_up_failed");
    expect(update).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "site.join_package.download_failed" }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain("bad-bad-bad");
  });

  it("a redeem without a grant is refused and audited", async () => {
    const res = await POST(req("POST", "http://x/d", {}), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("step_up_required");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "site.join_package.download_failed" }));
  });

  it("one step-up yields exactly one presigned URL; a replay and a forged grant get nothing", async () => {
    const step = await POST(req("POST", "http://x/d", { password: PASSWORD }), ctx);
    expect(step.status).toBe(200);
    const { grant } = await step.json();
    expect(typeof grant).toBe("string");
    expect(store.hash).not.toBe(grant); // only a hash is stored
    expect((await POST(req("POST", "http://x/d", { grant: "forged" }), ctx)).status).toBe(403);
    const first = await POST(req("POST", "http://x/d", { grant }), ctx);
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.downloadUrl).toBe("https://s3.test/kit.zip?sig=1");
    expect(body.expiresInSeconds).toBe(300);
    expect(body.package.downloadGrantHash).toBeUndefined();
    expect((await POST(req("POST", "http://x/d", { grant }), ctx)).status).toBe(403);
    expect(store.count).toBe(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "site.join_package.download_authorized" }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "site.join_package.download" }));
  });

  it("an expired grant is refused", async () => {
    const { grant } = await (await POST(req("POST", "http://x/d", { password: PASSWORD }), ctx)).json();
    store.expires = new Date(Date.now() - 1000);
    expect((await POST(req("POST", "http://x/d", { grant }), ctx)).status).toBe(403);
  });

  it("an account without a password gets a clear 403", async () => {
    findUser.mockResolvedValue({ passwordHash: null });
    const res = await POST(req("POST", "http://x/d", { password: "x" }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("password_not_set");
  });

  it("a grant minted for one user cannot be redeemed by another user", async () => {
    const { grant } = await (await POST(req("POST", "http://x/d", { password: PASSWORD }), ctx)).json();
    currentUser = "u3";
    expect((await POST(req("POST", "http://x/d", { grant }), ctx)).status).toBe(403);
    expect(store.hash).not.toBeNull(); // still unspent for the rightful user
    currentUser = "u2";
    expect((await POST(req("POST", "http://x/d", { grant }), ctx)).status).toBe(200);
  });

  it("a signing failure does not burn the one-time grant", async () => {
    const { grant } = await (await POST(req("POST", "http://x/d", { password: PASSWORD }), ctx)).json();
    presign.mockRejectedValueOnce(new Error("signer down"));
    expect((await POST(req("POST", "http://x/d", { grant }), ctx)).status).toBe(502);
    expect(store.count).toBe(0);
    expect((await POST(req("POST", "http://x/d", { grant }), ctx)).status).toBe(200);
    expect(store.count).toBe(1);
  });

  it("the grant is only accepted in the body: no GET handler exists", async () => {
    const mod = await import("@/app/api/v1/sites/[siteId]/join-package/[packageId]/download/route");
    expect((mod as Record<string, unknown>).GET).toBeUndefined();
  });
});
