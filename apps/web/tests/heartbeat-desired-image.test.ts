import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const token = "desired-image-token";
const digest = `harbor.example/fedlify-s-x/study@sha256:${"c".repeat(64)}`;

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/rbac", () => ({ canAccessStudy: async () => true }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    site: { findUnique: async () => ({ id: "x", studyId: "s", status: "CONNECTED", apiTokenHash: createHash("sha256").update(token).digest("hex"), study: { orgId: "o" }, studySite: null }) },
    nvflareDeployment: { findFirst: async () => ({ imageDigest: digest, hostname: "x.fedlify.com", pipelineVersionId: "pv1" }) },
    pipelineVersion: { findUnique: async () => ({ version: "v7", gitTag: "release 7/rc" }) },
    $transaction: async () => ({ id: "hb" })
  }
}));

import { POST } from "@/app/api/v1/sites/[siteId]/heartbeat/route";

describe("heartbeat response for `fedlify-runner update`", () => {
  it("returns the full desired digest and a plain-label pipeline version to confirm", async () => {
    const request = new Request("http://x/api", { method: "POST", headers: { "x-site-token": token, "content-type": "application/json" }, body: JSON.stringify({ status: "CONNECTED" }) });
    const response = (await POST(request as never, { params: Promise.resolve({ siteId: "desired-site" }) })) as Response;
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.desiredImageDigest).toBe(digest);
    expect(body.desiredPipelineVersion).toBe("release_7_rc");
  });
});
