import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent", () => ({ submitStudyPublishWorkflow: vi.fn() }));
vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/rbac", () => ({ assertStudyAccess: async () => undefined, isForbiddenError: () => false }));
vi.mock("@/lib/gitea", () => ({
  GiteaApiError: class extends Error {},
  isRuntimeConfigurationError: () => false,
  getGiteaBranch: vi.fn(),
  ensureGiteaTag: vi.fn()
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    study: { findUnique: async () => ({ id: "s1", orgId: "o1", slug: "x", title: "X", ethics: [], studySites: [] }) },
    pipelineProject: { findUnique: async () => ({ id: "p1", studyId: "s1", giteaOwner: "o", giteaRepo: "r", versions: [] }) },
    requirementResponse: { findMany: async () => [{ requirementId: "R01" }] }
  }
}));

import { POST } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/publish/route";

describe("POST publish gate", () => {
  it("returns plain sentences and keeps the raw list in details", async () => {
    const response = (await POST(new Request("http://x/api", { method: "POST", body: "{}" }) as never, {
      params: Promise.resolve({ studyId: "s1", projectId: "p1" })
    })) as Response;
    expect(response.status).toBe(409);
    const { error } = await response.json();
    expect(error.code).toBe("publish_gate");
    expect(error.message).toContain("Record the ethics decision");
    expect(error.message).toMatch(/Answer the remaining study questions \(\d+ left\)/);
    expect(error.message).toContain("Add at least one site");
    expect(error.message).not.toMatch(/ethicsApproval|studySites|requirements \(|R\d\d/);
    expect(error.details.missing).toContain("ethicsApproval");
    expect(error.details.steps).toHaveLength(3);
    const failing = error.details.items.filter((item: { ok: boolean }) => !item.ok).map((item: { code: string }) => item.code);
    expect(failing).toEqual(["ethics", "study_questions", "sites"]);
  });
});
