import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  userId: { current: "u1" },
  roles: { current: { read: true, runAgent: true, manage: false, audit: false } as Record<string, boolean> },
  audit: vi.fn(),
  store: {
    getThreadInProject: vi.fn(),
    listThreads: vi.fn(),
    createThread: vi.fn(),
    loadThreadDetail: vi.fn(),
    renameThread: vi.fn(),
    setThreadStatus: vi.fn()
  },
  project: vi.fn()
}));

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: h.userId.current }) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => h.audit(...a) }));
vi.mock("@/lib/rbac", () => ({ canAccessStudy: async (_u: string, _s: string, perm: string) => h.roles.current[perm] === true }));
vi.mock("@/lib/prisma", () => ({ prisma: { pipelineProject: { findUnique: (...a: unknown[]) => h.project(...a) } } }));
vi.mock("@/lib/agent-thread-store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agent-thread-store")>()), ...h.store }));

import { GET as listGetRaw, POST as listPostRaw } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/threads/route";
import { GET as oneGetRaw, PATCH as onePatchRaw } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/threads/[tid]/route";
import { FORBIDDEN_AUDIT_KEYS } from "@/lib/agent-thread-types";

const listGet = async (...args: Parameters<typeof listGetRaw>) => (await listGetRaw(...args)) as Response;
const listPost = async (...args: Parameters<typeof listPostRaw>) => (await listPostRaw(...args)) as Response;
const oneGet = async (...args: Parameters<typeof oneGetRaw>) => (await oneGetRaw(...args)) as Response;
const onePatch = async (...args: Parameters<typeof onePatchRaw>) => (await onePatchRaw(...args)) as Response;



const now = new Date("2026-11-11T10:00:00Z");
const row = (over: Record<string, unknown> = {}) => ({
  id: "t1", projectId: "p1", studyId: "s1", createdById: "u1", title: "Add FedProx with secret idea", status: "ACTIVE", mode: "ask", turnCount: 2,
  lastTurnAt: now, createdAt: now, createdBy: { id: "u1", name: "Ana" }, plans: [], _count: { proposals: 0 }, ...over
});
const params = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ studyId: "s1", projectId: "p1", ...extra }) }) as never;
const req = (url: string, init?: RequestInit) => new Request(`http://x${url}`, init) as never;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AGENT_THREADS_ENABLED = "true";
  h.userId.current = "u1";
  h.roles.current = { read: true, runAgent: true, manage: false, audit: false };
  h.project.mockResolvedValue({ id: "p1", studyId: "s1", study: { id: "s1", orgId: "o1" } });
  h.store.getThreadInProject.mockResolvedValue(row());
  h.store.listThreads.mockResolvedValue({ rows: [row()], nextCursor: null });
  h.store.createThread.mockResolvedValue(row({ title: "New chat", turnCount: 0 }));
  h.store.loadThreadDetail.mockImplementation(async ({ thread }: { thread: { id: string } }) => ({ thread: { id: thread.id }, turns: [], plans: [], proposals: [] }));
});

function auditKeys() {
  return h.audit.mock.calls.flatMap((call) => Object.keys((call[0] as { metadata: object }).metadata));
}

describe("threads routes", () => {
  it("answers 404 threads_disabled when the flag is off", async () => {
    process.env.AGENT_THREADS_ENABLED = "false";
    const res = await listGet(req("/t"), params());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("threads_disabled");
  });

  it("lists own threads for an author, all for a manager", async () => {
    await listGet(req("/t"), params());
    expect(h.store.listThreads.mock.calls[0][0]).toMatchObject({ scope: "own", viewerId: "u1" });
    h.roles.current = { read: true, runAgent: true, manage: true, audit: false };
    await listGet(req("/t?q=x&status=ARCHIVED"), params());
    expect(h.store.listThreads.mock.calls[1][0]).toMatchObject({ scope: "all", q: "x", status: "ARCHIVED" });
  });

  it("redacts titles for the audit role and ignores its search", async () => {
    h.roles.current = { read: true, runAgent: false, manage: false, audit: true };
    h.store.listThreads.mockResolvedValue({ rows: [row({ createdById: "u2" })], nextCursor: null });
    const res = await listGet(req("/t?q=secret"), params());
    const body = await res.json();
    expect(body.threads[0].title).toBe("");
    expect(h.store.listThreads.mock.calls[0][0].q).toBeUndefined();
  });

  it("refuses a user with no study access", async () => {
    h.roles.current = { read: false, runAgent: false, manage: false, audit: false };
    expect((await listGet(req("/t"), params())).status).toBe(403);
  });

  it("creates a thread for read + runAgent and audits ids only", async () => {
    const res = await listPost(req("/t", { method: "POST", body: JSON.stringify({ message: "my private prompt" }) }), params());
    expect(res.status).toBe(201);
    expect(h.store.createThread.mock.calls[0][0]).toMatchObject({ createdById: "u1", firstMessage: "my private prompt" });
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("private prompt");
    expect(auditKeys().filter((key) => (FORBIDDEN_AUDIT_KEYS as readonly string[]).includes(key))).toEqual([]);
  });

  it("does not let an audit-only user create a thread", async () => {
    h.roles.current = { read: true, runAgent: false, manage: false, audit: true };
    expect((await listPost(req("/t", { method: "POST", body: "{}" }), params())).status).toBe(403);
  });

  it("returns 404 for a thread of another project and for a user without access", async () => {
    h.store.getThreadInProject.mockResolvedValue(null);
    expect((await oneGet(req("/t/t1"), params({ tid: "t1" }))).status).toBe(404);
    h.store.getThreadInProject.mockResolvedValue(row({ createdById: "u2" }));
    expect((await oneGet(req("/t/t1"), params({ tid: "t1" }))).status).toBe(404);
  });

  it("gives the author the content with no view audit", async () => {
    const res = await oneGet(req("/t/t1?after=3"), params({ tid: "t1" }));
    expect(res.status).toBe(200);
    expect(h.store.loadThreadDetail.mock.calls[0][0]).toMatchObject({ afterSeq: 3 });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("lets a manager read another user's thread read-only and audits the view", async () => {
    h.roles.current = { read: true, runAgent: true, manage: true, audit: false };
    h.store.getThreadInProject.mockResolvedValue(row({ createdById: "u2" }));
    const res = await oneGet(req("/t/t1"), params({ tid: "t1" }));
    expect(res.status).toBe(200);
    expect(h.store.loadThreadDetail.mock.calls[0][0].access).toMatchObject({ level: "manager", readOnly: true, canDecidePlan: false });
    expect(h.audit.mock.calls[0][0]).toMatchObject({ action: "pipeline_project.thread_view_other", metadata: { threadId: "t1", authorId: "u2" } });
  });

  it("gives the audit role metadata only", async () => {
    h.roles.current = { read: true, runAgent: false, manage: false, audit: true };
    h.store.getThreadInProject.mockResolvedValue(row({ createdById: "u2" }));
    const body = await (await oneGet(req("/t/t1"), params({ tid: "t1" }))).json();
    expect(body.metadataOnly).toBe(true);
    expect(body.thread.title).toBe("");
    expect(body.turns).toBeUndefined();
    expect(h.store.loadThreadDetail).not.toHaveBeenCalled();
  });

  it("archives for the author and for a manager, not for an auditor, with an id-only audit", async () => {
    const patch = (body: unknown) => onePatch(req("/t/t1", { method: "PATCH", body: JSON.stringify(body) }), params({ tid: "t1" }));
    expect((await patch({ status: "ARCHIVED" })).status).toBe(200);
    expect(h.store.setThreadStatus).toHaveBeenCalledWith("t1", "ARCHIVED");
    expect(h.audit.mock.calls[0][0]).toMatchObject({ action: "pipeline_project.thread_archive", metadata: { threadId: "t1", archived: true } });
    expect((await patch({ title: "Renamed" })).status).toBe(200);
    expect(h.store.renameThread).toHaveBeenCalledWith("t1", "Renamed");
    expect((await patch({})).status).toBe(400);

    h.roles.current = { read: true, runAgent: false, manage: false, audit: true };
    h.store.getThreadInProject.mockResolvedValue(row({ createdById: "u2" }));
    expect((await patch({ status: "ARCHIVED" })).status).toBe(403);
  });
});
