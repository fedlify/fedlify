import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  allowed: true,
  ethics: [{ status: "APPROVED", validUntil: null as Date | null }] as Array<{ status: string; validUntil: Date | null }>,
  answered: 29,
  sites: [{ id: "ss1", code: "A", name: "Hospital A", site: null }] as Array<Record<string, unknown>>,
  publishRun: null as unknown,
  deployment: null as unknown,
  runningJobs: 0,
  giteaFail: false,
  branch: { commit: { id: "abc123" } } as unknown
}));

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/rbac", () => ({
  assertStudyAccess: async () => {
    if (!h.allowed) throw Object.assign(new Error("no"), { name: "ForbiddenError" });
  },
  isForbiddenError: (e: unknown) => e instanceof Error && e.name === "ForbiddenError"
}));
vi.mock("@/lib/gitea", () => ({
  getGiteaBranch: async () => {
    if (h.giteaFail) throw new Error("code host down");
    return h.branch;
  }
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    study: { findUnique: async () => ({ id: "s1", ethics: h.ethics, studySites: h.sites }) },
    pipelineProject: { findUnique: async () => ({ id: "p1", studyId: "s1", giteaOwner: "o", giteaRepo: "r", defaultBranch: "main" }) },
    requirementResponse: { findMany: async () => Array.from({ length: h.answered }, (_, i) => ({ requirementId: `R${String(i + 1).padStart(2, "0")}` })) },
    cIValidationRun: { findFirst: async () => h.publishRun },
    nvflareDeployment: { findFirst: async () => h.deployment },
    studySite: { findMany: async () => h.sites.map((site) => ({ ...site, readinessChecks: [], site: null })) },
    nvflareJob: { count: async () => h.runningJobs }
  }
}));

import { GET } from "@/app/api/v1/studies/[studyId]/preflight/route";

const get = (query: string) => GET(new Request(`http://x/api/v1/studies/s1/preflight${query}`) as never, { params: Promise.resolve({ studyId: "s1" }) }) as Promise<Response>;

beforeEach(() => {
  h.allowed = true;
  h.ethics = [{ status: "APPROVED", validUntil: null }];
  h.answered = 29;
  h.sites = [{ id: "ss1", code: "A", name: "Hospital A", site: null }];
  h.publishRun = null;
  h.deployment = null;
  h.runningJobs = 0;
  h.giteaFail = false;
  h.branch = { commit: { id: "abc123" } };
});

describe("GET preflight", () => {
  it("returns the publish checklist", async () => {
    const response = await get("?kind=publish&projectId=p1");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.items.map((i: { code: string }) => i.code)).toEqual(["ethics", "study_questions", "sites", "saved_code", "publish_idle", "run_idle"]);
  });

  it("says the saved code could not be checked, not that none is saved, when the code host is down", async () => {
    h.giteaFail = true;
    const body = await (await get("?kind=publish&projectId=p1")).json();
    const codes = body.items.map((i: { code: string }) => i.code);
    expect(codes).toContain("saved_code_check");
    expect(codes).not.toContain("saved_code");
    expect(body.ok).toBe(false);
  });

  it("counts a commit named in the query as saved code", async () => {
    h.branch = { commit: null };
    const without = await (await get("?kind=publish&projectId=p1")).json();
    expect(without.items.find((i: { code: string }) => i.code === "saved_code").ok).toBe(false);
    const withCommit = await (await get("?kind=publish&projectId=p1&commit=abc1234")).json();
    expect(withCommit.items.find((i: { code: string }) => i.code === "saved_code").ok).toBe(true);
  });

  it("shows what is missing, with counts and a place to fix it", async () => {
    h.ethics = [{ status: "APPROVED", validUntil: new Date("2020-01-01T00:00:00Z") }];
    h.answered = 26;
    h.runningJobs = 1;
    h.deployment = { id: "d1" };
    const body = await (await get("?kind=publish&projectId=p1")).json();
    expect(body.ok).toBe(false);
    const items = Object.fromEntries(body.items.map((i: { code: string }) => [i.code, i]));
    expect(items.ethics.detail).toContain("expired on 1 January 2020");
    expect(items.study_questions.detail).toBe("3 study questions need an answer or a decision. Suggested answers count only after you accept them. Open Study setup, then Questions.");
    expect(items.run_idle.ok).toBe(false);
    expect(items.ethics.fixHref).toBe("/studies/s1?section=protocol&tab=ethics");
  });

  it("returns the run checklist, with no study server yet", async () => {
    const body = await (await get("?kind=run")).json();
    expect(body.ok).toBe(false);
    const codes = body.items.filter((i: { ok: boolean }) => !i.ok).map((i: { code: string }) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["pipeline_published", "study_server", "site_signed_off:ss1"]));
  });

  it("rejects an unknown kind", async () => {
    expect((await get("?kind=nope")).status).toBe(400);
    expect((await get("")).status).toBe(400);
  });

  it("refuses someone without study access", async () => {
    h.allowed = false;
    expect((await get("?kind=publish")).status).toBe(403);
  });
});
