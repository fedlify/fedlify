import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ allowed: true, caps: new Set<string>() }));

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/rbac", () => ({
  assertStudyAccess: async () => {
    if (!h.allowed) throw Object.assign(new Error("no"), { name: "ForbiddenError" });
  },
  canAccessStudyActions: async (_u: string, _s: string, actions: string[]) => Object.fromEntries(actions.map((a) => [a, h.caps.has(a)])),
  isForbiddenError: (e: unknown) => e instanceof Error && e.name === "ForbiddenError"
}));
vi.mock("@/lib/aggregator-overview", () => ({
  loadAggregatorOverview: async () => ({ aggregator: null, sites: [], projects: [], jobs: [] })
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    study: { findUnique: async () => ({ title: "Sepsis model", goal: "Predict mortality", status: "DRAFT", ethics: [] }) },
    requirementResponse: { findMany: async () => [] },
    studySite: { findMany: async () => [] },
    modelRelease: { count: async () => 0 }
  }
}));

import { GET } from "@/app/api/v1/studies/[studyId]/next-step/route";

const get = () => GET(new Request("http://x/api/v1/studies/s1/next-step") as never, { params: Promise.resolve({ studyId: "s1" }) }) as Promise<Response>;

beforeEach(() => {
  h.allowed = true;
  h.caps = new Set();
});

describe("GET next-step", () => {
  it("returns the six steps and points a fresh study at the ethics decision", async () => {
    h.caps = new Set(["manageEthics"]);
    const body = await (await get()).json();
    expect(body.current).toBe("authorize");
    expect(body.steps).toHaveLength(6);
    expect(body.steps[0].action).toMatchObject({ label: "Record the ethics decision", permission: "manageEthics" });
    expect(body.steps[1].status).toBe("Not started");
    expect(body.steps[1].action).toBeUndefined();
    expect(body.start).toMatchObject({ started: false, ready: false, canStart: false });
    expect(body.start.missing).toContain("Add your first site");
  });

  it("gives a viewer no action buttons", async () => {
    const body = await (await get()).json();
    expect(body.steps.every((s: { action?: unknown }) => s.action === undefined)).toBe(true);
    expect(body.steps[0].detail).toMatch(/^Ask a study lead/);
  });

  it("refuses someone without study access", async () => {
    h.allowed = false;
    expect((await get()).status).toBe(403);
  });
});
