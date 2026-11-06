import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FORBIDDEN_AUDIT_KEYS } from "@/lib/agent-thread-types";

const { db, gitea, auditMock } = vi.hoisted(() => ({
  db: {
    agentProposal: { findMany: vi.fn(), updateMany: vi.fn() },
    auditEvent: { findMany: vi.fn() },
    pipelineVersion: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    pipelineProject: { findFirst: vi.fn() }
  },
  gitea: { getGiteaBranch: vi.fn(), listGiteaCommits: vi.fn(), compareGiteaCommit: vi.fn(), readGiteaFileAtRef: vi.fn() },
  auditMock: vi.fn()
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditMock(...a) }));
vi.mock("@/lib/gitea", async () => ({ ...(await vi.importActual<object>("@/lib/gitea")), ...gitea }));
vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/rbac", () => ({ assertStudyAccess: vi.fn(async () => undefined), isForbiddenError: () => false }));

import { GET } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/timeline/route";
import { clearTimelineCache, decodeCursor, encodeCursor, loadCommitDiff, loadTimeline, mergeTimeline, parseProposalTrailer, reconcileAgentCommits, type TimelineProposal } from "@/lib/agent-timeline";

const project = { id: "p1", studyId: "s1", giteaOwner: "fed", giteaRepo: "repo", defaultBranch: "main", study: { orgId: "o1" } };

const commit = (sha: string, at: string, message = "msg", extra: object = {}) => ({ sha, message, authorName: "Git Author", authorEmail: null, at, parents: [], additions: 2, deletions: 1, ...extra });
const proposal = (over: Partial<TimelineProposal> & { id: string }): TimelineProposal => ({
  title: "Add FedProx",
  status: "PROPOSED",
  files: [{ path: "a.py", action: "update", content: "x", added: 5, removed: 1 }] as never,
  acceptedCommit: null,
  acceptedById: null,
  requestedById: "u1",
  rejectedById: null,
  rejectedAt: null,
  decidedAt: null,
  createdAt: new Date("2026-11-01T10:00:00Z"),
  threadId: "t1",
  turnId: "tr1",
  ...over
});

beforeEach(() => {
  vi.clearAllMocks();
  clearTimelineCache();
  gitea.getGiteaBranch.mockResolvedValue({ name: "main", commit: { id: "head1" } });
  gitea.listGiteaCommits.mockResolvedValue([]);
  db.agentProposal.findMany.mockResolvedValue([]);
  db.agentProposal.updateMany.mockResolvedValue({ count: 1 });
  db.auditEvent.findMany.mockResolvedValue([]);
  db.pipelineVersion.findMany.mockResolvedValue([]);
  db.user.findMany.mockResolvedValue([
    { id: "u1", name: "Ana" },
    { id: "u2", name: "Ben" }
  ]);
});

describe("parseProposalTrailer", () => {
  it("reads the trailer and ignores look-alikes", () => {
    expect(parseProposalTrailer("Agent proposal: x\n\nbody\n\nFedlify-Agent-Proposal: abc12345xyz\nCo-authored-by: a")).toBe("abc12345xyz");
    expect(parseProposalTrailer("Fedlify-Agent-Proposal: abc12345xyz\r\n")).toBe("abc12345xyz");
    expect(parseProposalTrailer("no trailer here")).toBeNull();
    expect(parseProposalTrailer("see Fedlify-Agent-Proposal: abc12345xyz in text")).toBeNull();
    expect(parseProposalTrailer("Fedlify-Agent-Proposal: short")).toBeNull();
  });
});

describe("cursor", () => {
  it("round-trips and rejects junk", () => {
    const cursor = encodeCursor({ at: "2026-11-01T10:00:00.000Z", id: "commit:abc_def" });
    expect(decodeCursor(cursor)).toEqual({ at: Date.parse("2026-11-01T10:00:00.000Z"), id: "commit:abc_def" });
    expect(decodeCursor("nope")).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });
});

describe("mergeTimeline", () => {
  const base = { versions: [], saveActors: new Map<string, string | null>(), userNames: new Map([["u1", "Ana"], ["u2", "Ben"]]) };

  it("orders newest first, attributes manual saves, and folds trailer commits into their proposal", () => {
    const entries = mergeTimeline({
      ...base,
      saveActors: new Map([["m1", "u2"]]),
      proposals: [
        proposal({ id: "propaccepted1", status: "ACCEPTED", acceptedCommit: "c9", acceptedById: "u1", decidedAt: new Date("2026-11-01T14:02:00Z") }),
        proposal({ id: "proprejected1", status: "REJECTED", rejectedById: "u1", rejectedAt: new Date("2026-11-01T13:10:00Z"), decidedAt: new Date("2026-11-01T13:10:00Z"), title: "Refactor loader" })
      ],
      commits: [
        commit("c9", "2026-11-01T14:02:05Z", "Agent proposal\n\nFedlify-Agent-Proposal: propaccepted1"),
        commit("m1", "2026-11-01T13:40:00Z", "save"),
        commit("x1", "2026-11-01T09:00:00Z", "Initial import\n\nmore")
      ]
    });
    expect(entries.map((e) => e.id)).toEqual(["proposal:propaccepted1", "commit:m1", "proposal:proprejected1", "commit:x1"]);
    expect(entries[0]).toMatchObject({ kind: "agent", commit: "c9", actor: { name: "Ana" }, threadId: "t1", added: 5, removed: 1 });
    expect(entries[1]).toMatchObject({ kind: "manual", title: "Manual save", actor: { id: "u2", name: "Ben" } });
    expect(entries[2]).toMatchObject({ kind: "rejected", actor: { name: "Ana" } });
    expect(entries[3]).toMatchObject({ kind: "external", title: "Initial import", actor: { id: null, name: "Git Author" } });
  });

  it("marks published commits and emits version rows", () => {
    const version = { id: "v1", version: "5", gitCommit: "c1", approvedAt: new Date("2026-11-02T00:00:00Z"), publishedAt: null, approvedById: "u1" };
    const entries = mergeTimeline({ ...base, proposals: [], commits: [commit("c1", "2026-11-01T00:00:00Z")], versions: [version], publishedByCommit: new Map([["c1", version]]) });
    expect(entries[0]).toMatchObject({ kind: "published", title: "v5 published", published: { version: 5, approvedByName: "Ana" } });
    expect(entries[1].published).toEqual({ version: 5, approvedByName: "Ana" });
  });

  it("breaks time ties deterministically", () => {
    const at = "2026-11-01T00:00:00Z";
    const a = mergeTimeline({ ...base, proposals: [], commits: [commit("aa", at), commit("bb", at)] });
    const b = mergeTimeline({ ...base, proposals: [], commits: [commit("bb", at), commit("aa", at)] });
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
  });
});

describe("reconcileAgentCommits", () => {
  const ctx = { projectId: "p1", studyId: "s1", orgId: "o1", actorUserId: "u1" };

  it("fills a missing acceptedCommit and audits ids only", async () => {
    const row = proposal({ id: "propaccepted1", status: "ACCEPTED" });
    const fixed = await reconcileAgentCommits(ctx, [commit("c9", "2026-11-01T14:00:00Z", "t\n\nFedlify-Agent-Proposal: propaccepted1")], new Map([[row.id, row]]), new Set());
    expect(fixed).toEqual(["propaccepted1"]);
    expect(db.agentProposal.updateMany).toHaveBeenCalledWith({ where: { id: "propaccepted1", projectId: "p1", status: "ACCEPTED", acceptedCommit: null }, data: { acceptedCommit: "c9" } });
    const call = auditMock.mock.calls[0][0];
    expect(call.action).toBe("pipeline_project.agent_commit_reconciled");
    expect(call.metadata).toEqual({ proposalId: "propaccepted1", commitSha: "c9" });
    for (const key of FORBIDDEN_AUDIT_KEYS) expect(call.metadata).not.toHaveProperty(key);
    expect(row.acceptedCommit).toBe("c9");
  });

  it("skips recorded, non-accepted, unknown and manually saved commits", async () => {
    const trailer = (id: string) => `t\n\nFedlify-Agent-Proposal: ${id}`;
    const map = new Map([
      ["recorded0001", proposal({ id: "recorded0001", status: "ACCEPTED", acceptedCommit: "c1" })],
      ["proposed0001", proposal({ id: "proposed0001", status: "PROPOSED" })],
      ["forged000001", proposal({ id: "forged000001", status: "ACCEPTED" })]
    ]);
    const fixed = await reconcileAgentCommits(
      ctx,
      [commit("a", "2026-11-01T00:00:00Z", trailer("recorded0001")), commit("b", "2026-11-01T00:00:00Z", trailer("proposed0001")), commit("c", "2026-11-01T00:00:00Z", trailer("unknown00001")), commit("d", "2026-11-01T00:00:00Z", trailer("forged000001"))],
      map,
      new Set(["d"])
    );
    expect(fixed).toEqual([]);
    expect(db.agentProposal.updateMany).not.toHaveBeenCalled();
  });

  it("does not audit when another reader already reconciled", async () => {
    db.agentProposal.updateMany.mockResolvedValue({ count: 0 });
    const row = proposal({ id: "propaccepted1", status: "ACCEPTED" });
    expect(await reconcileAgentCommits(ctx, [commit("c9", "2026-11-01T14:00:00Z", "t\n\nFedlify-Agent-Proposal: propaccepted1")], new Map([[row.id, row]]), new Set())).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("loadTimeline", () => {
  it("reconciles a trailer commit whose proposal has no acceptedCommit and shows one agent row", async () => {
    const accepted = proposal({ id: "propaccepted1", status: "ACCEPTED", acceptedById: "u1", decidedAt: new Date("2026-11-01T14:02:00Z") });
    gitea.listGiteaCommits.mockResolvedValue([commit("c9", "2026-11-01T14:02:05Z", "t\n\nFedlify-Agent-Proposal: propaccepted1"), commit("m1", "2026-11-01T13:40:00Z")]);
    // First findMany calls are the three proposal buckets; the trailer lookup is the fourth.
    db.agentProposal.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([accepted]);
    db.auditEvent.findMany.mockResolvedValue([{ action: "pipeline_project.save", actorUserId: "u2", metadata: { commitSha: "m1" } }]);

    const page = await loadTimeline({ project, actorUserId: "u1" });
    expect(page.entries.map((e) => [e.id, e.kind, e.commit])).toEqual([
      ["proposal:propaccepted1", "agent", "c9"],
      ["commit:m1", "manual", "m1"]
    ]);
    expect(page.entries[1].actor).toEqual({ id: "u2", name: "Ben" });
    expect(db.agentProposal.updateMany).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(page.nextCursor).toBeNull();
  });

  it("pages with a cursor and reports nextCursor", async () => {
    gitea.listGiteaCommits.mockResolvedValue([commit("c3", "2026-11-03T00:00:00Z"), commit("c2", "2026-11-02T00:00:00Z"), commit("c1", "2026-11-01T00:00:00Z")]);
    const first = await loadTimeline({ project, actorUserId: "u1", limit: 2 });
    expect(first.entries.map((e) => e.id)).toEqual(["commit:c3", "commit:c2"]);
    expect(first.nextCursor).toBe(encodeCursor(first.entries[1]));
    const second = await loadTimeline({ project, actorUserId: "u1", limit: 2, cursor: first.nextCursor });
    expect(second.entries.map((e) => e.id)).toEqual(["commit:c1"]);
    expect(second.nextCursor).toBeNull();
  });

  it("caches commit pages by head sha", async () => {
    gitea.listGiteaCommits.mockResolvedValue([commit("c1", "2026-11-01T00:00:00Z")]);
    await loadTimeline({ project, actorUserId: "u1" });
    await loadTimeline({ project, actorUserId: "u1" });
    expect(gitea.listGiteaCommits).toHaveBeenCalledTimes(1);
    gitea.getGiteaBranch.mockResolvedValue({ name: "main", commit: { id: "head2" } });
    await loadTimeline({ project, actorUserId: "u1" });
    expect(gitea.listGiteaCommits).toHaveBeenCalledTimes(2);
  });

  it("the published filter reads no commits", async () => {
    db.pipelineVersion.findMany.mockResolvedValue([{ id: "v1", version: "2", gitCommit: "c1", approvedAt: new Date("2026-11-02T00:00:00Z"), publishedAt: null, approvedById: "u1" }]);
    const page = await loadTimeline({ project, actorUserId: "u1", kind: "published" });
    expect(gitea.listGiteaCommits).not.toHaveBeenCalled();
    expect(page.entries.map((e) => e.kind)).toEqual(["published"]);
  });

  it("lists every proposal status without a 30-row cap", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => proposal({ id: `prop${String(i).padStart(8, "0")}`, createdAt: new Date(Date.UTC(2026, 10, 1, 0, i)) }));
    db.agentProposal.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
    const page = await loadTimeline({ project, actorUserId: "u1", limit: 100 });
    expect(page.entries).toHaveLength(40);
    expect(db.agentProposal.findMany.mock.calls[2][0].take).toBe(101);
  });
});

describe("loadCommitDiff", () => {
  it("reads parent and commit contents and caps the file count", async () => {
    gitea.compareGiteaCommit.mockResolvedValue({
      sha: "c1",
      parent: "p0",
      files: [
        { path: "a.py", status: "modified", previousPath: null },
        { path: "b.py", status: "added", previousPath: null },
        { path: "c.py", status: "deleted", previousPath: null }
      ],
      additions: 1,
      deletions: 1
    });
    gitea.readGiteaFileAtRef.mockImplementation(async ({ ref, path }: { ref: string; path: string }) => `${path}@${ref}`);
    const diff = await loadCommitDiff({ owner: "fed", repo: "repo", commit: "c1" });
    expect(diff?.files).toEqual([
      { path: "a.py", status: "modified", previousPath: null, before: "a.py@p0", after: "a.py@c1", truncated: false },
      { path: "b.py", status: "added", previousPath: null, before: null, after: "b.py@c1", truncated: false },
      { path: "c.py", status: "deleted", previousPath: null, before: "c.py@p0", after: null, truncated: false }
    ]);
    gitea.compareGiteaCommit.mockResolvedValue(null);
    expect(await loadCommitDiff({ owner: "fed", repo: "repo", commit: "zz" })).toBeNull();
  });
});

describe("timeline route", () => {
  const originalFlag = process.env.AGENT_THREADS_ENABLED;
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.AGENT_THREADS_ENABLED;
    else process.env.AGENT_THREADS_ENABLED = originalFlag;
  });
  const call = async (query = "") => (await GET({ nextUrl: new URL(`https://app.test/x${query}`) } as never, { params: Promise.resolve({ studyId: "s1", projectId: "p1" }) })) as Response;

  it("is 404 with the flag off", async () => {
    delete process.env.AGENT_THREADS_ENABLED;
    const res = await call();
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("threads_disabled");
  });

  it("serves a page with the flag on and validates input", async () => {
    process.env.AGENT_THREADS_ENABLED = "true";
    db.pipelineProject.findFirst.mockResolvedValue(project);
    gitea.listGiteaCommits.mockResolvedValue([commit("c1", "2026-11-01T00:00:00Z")]);
    const ok = await call("?kind=manual");
    expect(ok.status).toBe(200);
    expect((await ok.json()).entries).toHaveLength(1);
    expect((await call("?kind=bogus")).status).toBe(400);
    expect((await call("?limit=0")).status).toBe(400);
    expect((await call("?commit=../etc")).status).toBe(400);
    db.pipelineProject.findFirst.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
});
