import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  members: [] as Array<{ userId: string; role: string; user: { id: string; name: string | null; email: string | null } }>,
  accepted: [] as Array<{ id: string; artifactRevisionId: string | null; acceptedById: string | null }>,
  manualSaves: 0,
  otherSaves: 0,
  previous: null as null | { createdAt: Date },
  bindings: [] as Array<Record<string, any>>,
  artifacts: [] as Array<Record<string, any>>,
  edges: [] as Array<Record<string, any>>,
  queries: { proposals: [] as any[], versions: [] as any[], audits: [] as any[] },
  created: 0,
  userId: "u1"
}));

vi.mock("@/lib/agent", () => ({ submitStudyPublishWorkflow: async () => ({ workflowId: "w1" }) }));
vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: h.userId }) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/rbac", () => ({ assertStudyAccess: async () => undefined, isForbiddenError: () => false, roleCan: (role: string) => role === "PRINCIPAL_INVESTIGATOR", canAccessStudy: async () => true }));
vi.mock("@/lib/governance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/governance")>()),
  ethicsCleared: () => true,
  latestEthicsStatus: () => "APPROVED",
  requirementsGate: () => ({ allowed: true, missing: [] })
}));
vi.mock("@/lib/gitea", () => ({
  GiteaApiError: class extends Error {},
  isRuntimeConfigurationError: () => false,
  getGiteaBranch: async () => ({ commit: { id: "abc123" } }),
  ensureGiteaTag: async () => undefined
}));
vi.mock("@/lib/study-runtime", () => ({
  clientKitPrefix: () => "kits/",
  nvflareClientName: () => "site-a",
  studyAdapterUrl: () => "http://adapter",
  studyHostname: () => "x.fedlify.com",
  studyNamespace: () => "study-x",
  studyRuntimeSlug: () => "x"
}));
vi.mock("@/lib/prisma", () => {
  const deployment = { id: "d1", namespace: "study-x", hostname: "x.fedlify.com", kitGeneration: 1, provisionedSites: [{ name: "site-a" }], pipelineVersionId: null };
  const tx = {
    pipelineVersion: { create: async () => { h.created += 1; return { id: "new-version", gitCommit: "abc123" }; }, update: async () => ({}) },
    cIValidationRun: { findFirst: async () => null, create: async () => ({ id: "ci1" }), update: async () => ({}) },
    nvflareDeployment: { update: async () => ({}) },
    approvalBinding: { create: async ({ data }: any) => { const row = { id: `ab${h.bindings.length + 1}`, ...data }; h.bindings.push(row); return row; } },
    provenanceEdge: { createMany: async ({ data }: any) => { h.edges.push(...data); return { count: data.length }; } }
  };
  return {
    prisma: {
      study: { findUnique: async () => ({ id: "s1", orgId: "o1", slug: "x", title: "X", ethics: [], studySites: [{ code: "a", site: { id: "z" } }] }) },
      pipelineProject: { findUnique: async () => ({ id: "p1", studyId: "s1", giteaOwner: "o", giteaRepo: "r", defaultBranch: "main", templateId: "t1", templateVersionId: null, versions: [] }) },
      requirementResponse: { findMany: async () => [] },
      studyMember: { findMany: async () => h.members },
      agentProposal: { findMany: async (args: unknown) => { h.queries.proposals.push(args); return h.accepted; } },
      auditEvent: { count: async (args: any) => { h.queries.audits.push(args); return typeof args.where.actorUserId === "string" ? h.manualSaves : h.otherSaves; } },
      artifactRevision: {
        findFirst: async ({ where }: any) => h.artifacts.find((row) => row.contentHash === where.contentHash) ?? null,
        findMany: async () => h.artifacts.filter((row) => row.id.startsWith("src")),
        aggregate: async () => ({ _max: { revision: h.artifacts.length } }),
        create: async ({ data }: any) => { const row = { id: `ar${h.artifacts.length + 1}`, ...data }; h.artifacts.push(row); return row; }
      },
      cIValidationRun: { findFirst: async () => null, update: async () => ({}) },
      nvflareDeployment: { findFirst: async () => deployment, update: async () => ({}) },
      nvflareJob: { count: async () => 0 },
      pipelineVersion: { findFirst: async (args: unknown) => { h.queries.versions.push(args); return h.previous; }, update: async () => ({}) },
      $transaction: async (arg: unknown) => (typeof arg === "function" ? (arg as (t: typeof tx) => unknown)(tx) : Promise.all(arg as unknown[]))
    }
  };
});

import { POST } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/publish/route";
import { evaluatePreflight, joinNames } from "@/lib/preflight";

const publish = () => POST(new Request("http://x/api", { method: "POST", body: "{}" }) as never, { params: Promise.resolve({ studyId: "s1", projectId: "p1" }) } as never) as Promise<Response>;
const member = (id: string, name: string | null, role = "PRINCIPAL_INVESTIGATOR") => ({ userId: id, role, user: { id, name, email: `${id}@example.org` } });
const previousPublish = new Date("2026-11-01T09:00:00Z");

beforeEach(() => {
  Object.assign(h, { members: [], accepted: [], manualSaves: 0, otherSaves: 0, previous: { createdAt: previousPublish }, bindings: [], artifacts: [], edges: [], created: 0, userId: "u1" });
  h.queries.proposals.length = 0;
  h.queries.versions.length = 0;
  h.queries.audits.length = 0;
  process.env.ASSISTANT_CONTROL_MODE = "shadow";
  process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES = "s1";
});
afterEach(() => {
  delete process.env.ASSISTANT_CONTROL_MODE;
  delete process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES;
});

describe("the two-person rule at publish", () => {
  it("a study with one approver: the person may publish their own change, and it is recorded as self-approved", async () => {
    h.members = [member("u1", "Ana"), member("u5", "Coordinator", "STUDY_COORDINATOR")];
    h.accepted = [{ id: "pr1", artifactRevisionId: "src1", acceptedById: "u1" }];
    h.artifacts.push({ id: "src1", contentHash: "p".repeat(64) });
    const res = await publish();
    expect(res.status).toBe(202);
    expect(h.bindings[0]).toMatchObject({ approvedById: "u1", status: "APPROVED", selfApproved: true, sourceCommit: "abc123" });
    expect(h.artifacts.some((row) => row.artifactType === "published_pipeline_version")).toBe(true);
    expect(h.edges[0]).toMatchObject({ relation: "PUBLISHED_AS", fromId: "src1" });
  });

  it("two approvers: the publisher who accepted a change is refused, and the other approvers are named", async () => {
    h.members = [member("u1", "Ana"), member("u2", "Dr. Lee"), member("u3", "Sam Park")];
    h.accepted = [{ id: "pr1", artifactRevisionId: null, acceptedById: "u1" }];
    const res = await publish();
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error.code).toBe("second_approver_required");
    expect(error.message).toContain("Dr. Lee or Sam Park");
    expect(error.details.items.find((item: { code: string }) => item.code === "second_approver")).toMatchObject({ ok: false, text: "A second approver publishes this version" });
    expect(h.created).toBe(0);
    expect(h.bindings).toHaveLength(0);
  });

  it("two approvers: a publisher who did not accept the changes may publish (not self-approved)", async () => {
    h.members = [member("u1", "Ana"), member("u2", "Dr. Lee")];
    h.accepted = [{ id: "pr1", artifactRevisionId: null, acceptedById: "u2" }];
    const res = await publish();
    expect(res.status).toBe(202);
    expect(h.bindings[0]).toMatchObject({ approvedById: "u1", selfApproved: false });
  });

  it("two approvers: changes saved by hand by the publisher count the same way", async () => {
    h.members = [member("u1", "Ana"), member("u2", "Dr. Lee")];
    h.manualSaves = 2;
    const res = await publish();
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain("Dr. Lee");
  });

  it("two approvers who each changed something do not lock each other out", async () => {
    h.members = [member("u1", "Ana"), member("u2", "Dr. Lee")];
    h.accepted = [{ id: "pr1", artifactRevisionId: null, acceptedById: "u1" }, { id: "pr2", artifactRevisionId: null, acceptedById: "u2" }];
    expect((await publish()).status).toBe(202);
    expect(h.bindings[0]).toMatchObject({ approvedById: "u1", selfApproved: true });
    h.userId = "u2";
    expect((await publish()).status).toBe(202);
  });

  it("the other approver's manual save also makes it a shared version", async () => {
    h.members = [member("u1", "Ana"), member("u2", "Dr. Lee")];
    h.accepted = [{ id: "pr1", artifactRevisionId: null, acceptedById: "u1" }];
    h.otherSaves = 1;
    expect((await publish()).status).toBe(202);
  });

  it("a self-accepted change is counted even when its commit id was never recorded", async () => {
    h.members = [member("u1", "Ana"), member("u2", "Dr. Lee")];
    h.accepted = [{ id: "pr1", artifactRevisionId: null, acceptedById: "u1" }];
    expect((await publish()).status).toBe(409);
    expect(h.queries.proposals[0].where).not.toHaveProperty("acceptedCommit");
  });

  it("never puts an email address in the refusal or the checklist", async () => {
    h.members = [member("u1", "Ana"), member("u2", null)];
    h.accepted = [{ id: "pr1", artifactRevisionId: null, acceptedById: "u1" }];
    const res = await publish();
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("@example.org");
    expect(text).toContain("another approver");
  });

  it("the other approver publishes the same version without trouble", async () => {
    h.userId = "u2";
    h.members = [member("u1", "Ana"), member("u2", "Dr. Lee")];
    h.accepted = [{ id: "pr1", artifactRevisionId: null, acceptedById: "u1" }];
    expect((await publish()).status).toBe(202);
  });

  it("looks only at changes since the previous published version", async () => {
    h.members = [member("u1", "Ana"), member("u2", "Dr. Lee")];
    await publish();
    expect(h.queries.versions.find((query) => query.where.publishedAt)!.where).toMatchObject({ projectId: "p1", publishedAt: { not: null } });
    expect(h.queries.proposals[0].where).toMatchObject({ projectId: "p1", status: "ACCEPTED", decidedAt: { gt: previousPublish } });
    expect(h.queries.audits[0].where).toMatchObject({ action: "pipeline_project.save", actorUserId: "u1", createdAt: { gt: previousPublish } });
  });

  it("the rule is inactive outside enforce: no refusal, no binding, the old stamp only", async () => {
    process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES = "";
    h.members = [member("u1", "Ana"), member("u2", "Dr. Lee")];
    h.accepted = [{ id: "pr1", artifactRevisionId: null, acceptedById: "u1" }];
    const res = await publish();
    expect(res.status).toBe(202);
    expect(h.bindings).toHaveLength(0);
    expect(h.queries.proposals).toHaveLength(0);
  });
});

describe("the checklist explains it before the click", () => {
  const base = { studyId: "s1", ethics: { status: "APPROVED", validUntil: null }, questions: { answered: 1, total: 1 }, sites: [{ studySiteId: "a", siteId: "a", code: "a", name: "A", signedOff: false, connected: null, imageState: null }], savedCode: true, publishInProgress: false, runInProgress: false };
  it("shows the item with the names when a second approver is needed", () => {
    const result = evaluatePreflight("publish", { ...base, secondApprover: { required: true, names: ["Dr. Lee", "Sam Park"] } });
    const item = result.items.find((entry) => entry.code === "second_approver")!;
    expect(item).toMatchObject({ ok: false, text: "A second approver publishes this version", owner: "study" });
    expect(item.detail).toContain("Dr. Lee or Sam Park");
    expect(result.ok).toBe(false);
  });
  it("is absent when not needed or when the study does not enforce, and has no link that cannot fix it", () => {
    expect(evaluatePreflight("publish", { ...base, secondApprover: { required: false, names: [] } }).items.some((entry) => entry.code === "second_approver")).toBe(false);
    expect(evaluatePreflight("publish", { ...base, secondApprover: { required: true, names: ["x"] } }).items.find((entry) => entry.code === "second_approver")).not.toHaveProperty("fixHref");
    expect(evaluatePreflight("publish", base).items.some((entry) => entry.code === "second_approver")).toBe(false);
    expect(evaluatePreflight("run", { ...base, secondApprover: { required: true, names: ["x"] } }).items.some((entry) => entry.code === "second_approver")).toBe(false);
  });
  it("joins names in plain words", () => {
    expect(joinNames(["Dr. Lee"])).toBe("Dr. Lee");
    expect(joinNames(["Dr. Lee", "Sam Park"])).toBe("Dr. Lee or Sam Park");
    expect(joinNames(["A", "B", "C"])).toBe("A, B or C");
  });
});
