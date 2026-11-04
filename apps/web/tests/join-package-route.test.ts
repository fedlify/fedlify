import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadObject = vi.fn();
const transaction = vi.fn();
const audit = vi.fn();
const storageConfigured = vi.fn();

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/rbac", () => ({ assertSiteAccess: async () => undefined, isForbiddenError: () => false }));
vi.mock("@/lib/runtime-config", () => ({ publicBaseUrl: () => "https://app.fedlify.test" }));
vi.mock("@/lib/archive", () => ({
  directoryToArchiveMap: async () => ({}),
  unzipToArchiveMap: async () => ({}),
  zipFiles: async () => Buffer.from("zip")
}));
vi.mock("@/lib/storage", () => ({
  objectKey: (parts: string[]) => parts.join("/"),
  readObject: async () => Buffer.from(""),
  storageConfigured: () => storageConfigured(),
  uploadObject: (...a: unknown[]) => uploadObject(...a),
  createPresignedDownloadUrl: async () => "https://s3.test/kit.zip"
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
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
    nvflareDeployment: { findFirst: async () => null },
    $transaction: (...a: unknown[]) => transaction(...a)
  }
}));

import { POST } from "@/app/api/v1/sites/[siteId]/join-package/route";

function call() {
  const request = new Request("http://x/api", { method: "POST" });
  return POST(Object.assign(request, { nextUrl: new URL("http://x/api") }) as never, { params: Promise.resolve({ siteId: "ss1" }) });
}

describe("join-package route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageConfigured.mockReturnValue(true);
  });

  it("leaves the old kit and token untouched when the upload fails", async () => {
    uploadObject.mockRejectedValue(new Error("s3 down"));
    const response = (await call())!;
    expect(response.status).toBe(502);
    expect(transaction).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "site.join_package.create_failed" }));
    expect(JSON.stringify(await response.json())).not.toContain("enrollmentToken");
  });

  it("commits the new kit only after the upload succeeded", async () => {
    uploadObject.mockResolvedValue(undefined);
    transaction.mockResolvedValue({ id: "pkg1" });
    const response = (await call())!;
    expect(response.status).toBe(201);
    expect(uploadObject).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(uploadObject.mock.invocationCallOrder[0]!).toBeLessThan(transaction.mock.invocationCallOrder[0]!);
  });
});
