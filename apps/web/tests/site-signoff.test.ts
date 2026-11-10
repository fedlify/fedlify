import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  siteCaps: new Set<string>(),
  studyCaps: new Set<string>(),
  latest: null as null | { policyAccepted: boolean; policyAcceptedById: string | null; policyAcceptedAt: Date | null },
  created: vi.fn(),
  jobStatus: "RUNNING"
}));

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/rbac", () => ({
  canAccessStudy: async (_u: string, _s: string, action: string) => h.studyCaps.has(action),
  canAccessSite: async (_u: string, _s: string, action: string) => h.siteCaps.has(action),
  assertSiteAccess: async (_u: string, _s: string, action: string) => {
    if (!h.siteCaps.has(action)) throw Object.assign(new Error("no"), { name: "ForbiddenError" });
  },
  isForbiddenError: (e: unknown) => e instanceof Error && e.name === "ForbiddenError"
}));
vi.mock("@/lib/prisma", () => {
  const tx = {
    siteReadinessCheck: { create: (...a: unknown[]) => h.created(...a) },
    studySite: { findUnique: async () => ({ id: "ss1" }), update: async () => ({}) }
  };
  return {
    prisma: {
      studySite: { findUnique: async () => ({ id: "ss1", studyId: "s1", study: { orgId: "o1" } }) },
      siteReadinessCheck: { findFirst: async () => h.latest },
      nvflareJob: { findUnique: async () => ({ id: "j1", studyId: "s1", status: h.jobStatus }) },
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx)
    }
  };
});

import { PATCH } from "@/app/api/v1/sites/[siteId]/governance/route";
import { POST as syncModel } from "@/app/api/v1/nvflare/jobs/[jobId]/results/sync/route";
import { describeUnreadySites, executionGateMessage, pipelineExecutionGate } from "@/lib/governance";
import { readinessStatus, siteSignedOff } from "@/lib/site-onboarding";

const gateFor = (checks: Array<{ dependenciesVerified: boolean; policyAccepted: boolean } | null>) =>
  pipelineExecutionGate({ ethicsStatus: "APPROVED", pipelineApprovalStatus: "APPROVED", pipelineValidationStatus: "PASSED", readinessChecks: checks });

describe("site sign-off", () => {
  it("depends only on the dependency and policy confirmations", () => {
    expect(siteSignedOff({ dependenciesVerified: true, policyAccepted: true })).toBe(true);
    expect(siteSignedOff({ dependenciesVerified: true, policyAccepted: false })).toBe(false);
    expect(siteSignedOff({ dependenciesVerified: false, policyAccepted: true })).toBe(false);
    expect(siteSignedOff(null)).toBe(false);
    expect(readinessStatus({ dependenciesVerified: true, policyAccepted: true })).toBe("PASSED");
  });

  it("a sign-off saved while the site was offline still passes the run gate", () => {
    const saved = { connectivityVerified: false, kitInstalled: false, dependenciesVerified: true, policyAccepted: true };
    expect(gateFor([saved]).allowed).toBe(true);
  });

  it("a legacy row stored as PENDING only because of connectivity passes without a backfill", () => {
    const legacy = { status: "PENDING" as const, connectivityVerified: false, kitInstalled: false, dependenciesVerified: true, policyAccepted: true };
    expect(gateFor([legacy]).allowed).toBe(true);
    expect(describeUnreadySites([{ code: "A", name: "Site A", check: legacy }])).toEqual([]);
  });

  it("a missing policy blocks the run and is explained in plain words", () => {
    const check = { dependenciesVerified: true, policyAccepted: false };
    expect(gateFor([check]).missing).toContain("allSitesReady");
    const unready = describeUnreadySites([{ code: "A", name: "Site A", check }, { code: "B", name: "Site B", check: null }]);
    expect(unready[0].problems).toEqual(["data-use policy not accepted"]);
    expect(unready[1].problems).toEqual(["no site sign-off has been recorded"]);
    expect(executionGateMessage(["allSitesReady"], unready)).not.toMatch(/connectivity|kit/i);
  });
});

describe("PATCH site governance: policy acceptance", () => {
  const patch = async (readiness: Record<string, unknown>) =>
    (await PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify({ readiness }) }) as never, { params: Promise.resolve({ siteId: "ss1" }) })) as Response;

  beforeEach(() => {
    vi.clearAllMocks();
    h.siteCaps = new Set(["manageProfile"]);
    h.latest = null;
  });

  it("refuses a site engineer (profile access only) accepting the policy", async () => {
    const response = await patch({ dependenciesVerified: true, policyAccepted: true });
    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/accept the data-use policy/);
    expect(h.created).not.toHaveBeenCalled();
  });

  it("lets someone with the acceptance permission accept it, and ignores client connectivity fields", async () => {
    h.siteCaps.add("acceptSitePolicy");
    const response = await patch({ dependenciesVerified: true, policyAccepted: true, connectivityVerified: false, kitInstalled: false });
    expect(response.status).toBe(200);
    expect(h.created.mock.calls[0][0].data).toMatchObject({ status: "PASSED", policyAccepted: true, policyAcceptedById: "u1" });
  });

  it("lets a profile editor re-save a form whose policy was already accepted", async () => {
    h.latest = { policyAccepted: true, policyAcceptedById: "steward", policyAcceptedAt: new Date("2026-11-01") };
    const response = await patch({ dependenciesVerified: true, policyAccepted: true });
    expect(response.status).toBe(200);
    expect(h.created.mock.calls[0][0].data).toMatchObject({ policyAcceptedById: "steward" });
  });

  it("does not need the acceptance permission to record dependencies without the policy", async () => {
    expect((await patch({ dependenciesVerified: true, policyAccepted: false })).status).toBe(200);
  });
});

describe("Save model permission", () => {
  const sync = async () => (await syncModel(new Request("http://x", { method: "POST" }) as never, { params: Promise.resolve({ jobId: "j1" }) })) as Response;

  beforeEach(() => {
    h.studyCaps = new Set();
    h.jobStatus = "RUNNING";
  });

  it("refuses someone who can only view logs", async () => {
    h.studyCaps = new Set(["read", "viewLogs"]);
    expect((await sync()).status).toBe(403);
  });

  it("allows study managers and release approvers", async () => {
    h.studyCaps = new Set(["manage"]);
    expect((await sync()).status).toBe(409);
    h.studyCaps = new Set(["approveRelease"]);
    expect((await sync()).status).toBe(409);
  });
});
