import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  user: { userId: "admin1" } as { userId: string } | { response: Response },
  prisma: { user: { findUnique: vi.fn() }, pipelineProject: { findUnique: vi.fn() }, workItem: { findFirst: vi.fn() } },
  plan: vi.fn(),
  proposal: vi.fn(),
  ask: vi.fn(),
  accept: vi.fn()
}));

vi.mock("@/lib/api", () => ({ requireUser: async () => h.user }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/agent-thread-store", () => ({ createThread: async () => ({ id: "t1", mode: "plan" }), setThreadStatus: async () => ({}), acceptProposal: h.accept }));
vi.mock("@/lib/agent-thread-runner", () => ({ runPlanTurn: h.plan, runAskTurn: h.ask }));
vi.mock("@/lib/agent-proposal-run", () => ({ runProposal: h.proposal }));

import { __resetRateLimitsForTests as resetFailures } from "@/lib/rate-limit";
import { POST } from "@/app/api/v1/studies/[studyId]/probe-executor/route";

const TOKEN = ["probe", "bearer", "x"].join("-").padEnd(40, "0");
const body = { probeId: "A-1", prompt: "hello", isolationKey: "A-1:h:1", projectId: "p1", runId: "r1" };
const call = async (headers: Record<string, string> = {}, payload: unknown = body, studyId = "s1"): Promise<Response> =>
  (await POST(new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload) }) as never, { params: Promise.resolve({ studyId }) })) as Response;

beforeEach(() => {
  vi.stubEnv("PROBE_EXECUTOR_ENABLED", "true");
  vi.stubEnv("PROBE_EXECUTOR_TOKEN", TOKEN);
  vi.stubEnv("PROBE_EXECUTOR_USER_ID", "svc1");
  vi.stubEnv("ASSISTANT_CONTROL_ENFORCE_STUDIES", "s1");
  vi.stubEnv("OPENAI_API_KEY", "k");
  h.user = { userId: "admin1" };
  h.prisma.user.findUnique.mockResolvedValue({ platformRole: "PLATFORM_ADMIN" });
  resetFailures();
  h.prisma.pipelineProject.findUnique.mockResolvedValue({ studyId: "s1" });
  h.prisma.workItem.findFirst.mockResolvedValue({ id: "wi1", status: "COMPLETED", controlState: "WORK_ITEM_SIGNED", stopCondition: null });
  h.plan.mockReset().mockResolvedValue(Response.json({ plan: { plan: { id: "pl1" } } }, { status: 201 }));
});
afterEach(() => vi.unstubAllEnvs());

describe("probe-executor route", () => {
  it("is off by default", async () => {
    vi.stubEnv("PROBE_EXECUTOR_ENABLED", "false");
    expect((await call()).status).toBe(404);
    expect(h.plan).not.toHaveBeenCalled();
  });

  it("rejects anonymous, non-admin and wrong-token callers", async () => {
    h.user = { response: Response.json({}, { status: 401 }) };
    expect((await call()).status).toBe(401);
    h.user = { userId: "u2" };
    h.prisma.user.findUnique.mockResolvedValue({ platformRole: "USER" });
    expect((await call()).status).toBe(403);
    expect((await call({ authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
    vi.stubEnv("PROBE_EXECUTOR_TOKEN", "");
    expect((await call({ authorization: "Bearer " })).status).toBe(503);
    expect(h.plan).not.toHaveBeenCalled();
  });

  it("refuses a study that is not listed for enforcement", async () => {
    expect((await call({}, body, "s2")).status).toBe(409);
    vi.stubEnv("ASSISTANT_CONTROL_ENFORCE_STUDIES", "*");
    expect((await call()).status).toBe(409);
    expect(h.plan).not.toHaveBeenCalled();
  });

  it("runs for a platform admin and for the bearer token, and returns the observation", async () => {
    const admin = await call();
    expect(admin.status).toBe(200);
    expect(await admin.json()).toMatchObject({ executionMode: "LIVE_E2E_ASSISTANT", disposition: "PROCEED_TO_DRAFT", workItemId: "wi1", runtime: { modelRoute: "direct", policyVersion: "fedlify-v3.0" } });
    const token = await call({ authorization: `Bearer ${TOKEN}` });
    expect(token.status).toBe(200);
    expect(h.plan.mock.calls[1]![0].userId).toBe("svc1");
    expect(h.accept).not.toHaveBeenCalled();
  });

  it("a short token is not accepted, and the acting user must be a platform admin", async () => {
    const short = "short-token";
    vi.stubEnv("PROBE_EXECUTOR_TOKEN", short);
    expect((await call({ authorization: `Bearer ${short}` })).status).toBe(503);
    vi.stubEnv("PROBE_EXECUTOR_TOKEN", TOKEN);
    h.prisma.user.findUnique.mockResolvedValue({ platformRole: "USER" });
    expect((await call({ authorization: `Bearer ${TOKEN}` })).status).toBe(503);
    expect(h.plan).not.toHaveBeenCalled();
  });

  it("locks out a caller after repeated wrong tokens", async () => {
    const headers = { "x-forwarded-for": "9.9.9.9" };
    for (let i = 0; i < 10; i += 1) expect((await call({ ...headers, authorization: "Bearer wrong" })).status).toBe(401);
    expect((await call({ ...headers, authorization: "Bearer wrong" })).status).toBe(429);
    expect((await call({ ...headers, authorization: `Bearer ${TOKEN}` })).status).toBe(429);
    expect((await call({ "x-forwarded-for": "8.8.8.8", authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  it("validates the body and the project", async () => {
    expect((await call({}, { probeId: "x" })).status).toBe(400);
    h.prisma.pipelineProject.findUnique.mockResolvedValue({ studyId: "other" });
    expect((await call()).status).toBe(404);
  });

  it("a token without a configured user fails closed", async () => {
    vi.stubEnv("PROBE_EXECUTOR_USER_ID", "");
    expect((await call({ authorization: `Bearer ${TOKEN}` })).status).toBe(503);
  });
});
