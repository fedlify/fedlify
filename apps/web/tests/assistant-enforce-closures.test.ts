import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  createThread: vi.fn(),
  fetch: vi.fn()
}));

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/rbac", () => ({ assertStudyAccess: async () => undefined, isForbiddenError: () => false, canAccessStudy: async () => true }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => true, acquireSlot: () => () => undefined }));
vi.mock("@/lib/agent-thread-route", () => ({
  openThreadRoute: async () => ({ ok: true, actor: { canUse: true, canManage: false, canAudit: false }, project: { study: { orgId: "o1" } } }),
  auditThread: async () => undefined,
  writableThreadOrResponse: () => null
}));
vi.mock("@/lib/agent-thread-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-thread-store")>()),
  createThread: (...a: unknown[]) => h.createThread(...a),
  threadSummaryDto: (row: any) => ({ id: row.id, title: row.title })
}));

import { POST as messagesPost } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/messages/route";
import { POST as threadsPost } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/threads/route";

const SECRET = "sk-" + "proj-9fA3kLm2Qx7ZpR4tVb8NcY1wEd6HgJ0s";
const params = { params: Promise.resolve({ studyId: "s1", projectId: "p1" }) } as never;
const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.ASSISTANT_CONTROL_MODE = "shadow";
  process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES = "s1";
  h.createThread.mockImplementation(async (input: any) => ({ id: "t1", title: input.firstMessage ? input.firstMessage.slice(0, 80) : "New chat", mode: "ask" }));
  vi.stubGlobal("fetch", h.fetch);
});
afterEach(() => {
  delete process.env.ASSISTANT_CONTROL_MODE;
  delete process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES;
  vi.unstubAllGlobals();
});

describe("the old stateless message route", () => {
  it("is closed in an enforced study: no model call, a plain answer", async () => {
    const res = (await messagesPost(post({ message: `my key is ${SECRET}` }), params)) as Response;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "thread_required" });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("a new thread's title", () => {
  it("is not taken from the first message in an enforced study", async () => {
    const res = (await threadsPost(post({ message: `api_key=${SECRET}` }), params)) as Response;
    expect(res.status).toBe(201);
    expect(h.createThread.mock.calls[0]![0].firstMessage).toBeUndefined();
    expect(JSON.stringify(await res.json())).not.toContain(SECRET);
  });
  it("is unchanged when the study is not enforced", async () => {
    process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES = "";
    await threadsPost(post({ message: "How do I add FedProx?" }), params);
    expect(h.createThread.mock.calls[0]![0].firstMessage).toBe("How do I add FedProx?");
  });
});
