import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HarborError,
  assertStudyProject,
  createProject,
  createPullRobot,
  deleteRobot,
  ensureRetention,
  harborConfig,
  listProjectRobots,
  pullPermissions,
  retentionPolicy,
  robotSafeName,
  studyProjectFromImage,
  studyProjectName
} from "@/lib/harbor-registry";

const FAKE_PASSWORD = "unit-test-provisioner-pass";
const FAKE_SECRET = "unit-test-robot-secret-not-real";
type Call = { method: string; url: string; body: unknown; headers: Record<string, string> };
let calls: Call[];
let responder: (call: Call) => { status: number; body?: unknown } | Error;

beforeEach(() => {
  calls = [];
  responder = () => ({ status: 200, body: {} });
  process.env.FEDLIFY_HARBOR_URL = "https://harbor.test/";
  process.env.FEDLIFY_HARBOR_PROVISIONER_USERNAME = "robot$prov";
  process.env.FEDLIFY_HARBOR_PROVISIONER_PASSWORD = FAKE_PASSWORD;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call: Call = { method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> };
    calls.push(call);
    const result = responder(call);
    if (result instanceof Error) throw result;
    return new Response(result.body === undefined ? "" : JSON.stringify(result.body), { status: result.status });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FEDLIFY_HARBOR_URL;
  delete process.env.FEDLIFY_HARBOR_PROVISIONER_USERNAME;
  delete process.env.FEDLIFY_HARBOR_PROVISIONER_PASSWORD;
});

describe("project name guard", () => {
  it("accepts only fedlify-s-<slug>", () => {
    expect(studyProjectName("demo-abc123")).toBe("fedlify-s-demo-abc123");
    for (const bad of ["hivelab", "fedlify-studies", "fedlify-public", "fedlify-mirror", "lab-sites-x", "fedlify-s-", "fedlify-s-A", "fedlify-s-a/../b", "fedlify-s--x", "fedlify-s-x_y", `fedlify-s-${"a".repeat(200)}`]) {
      expect(() => assertStudyProject(bad), bad).toThrow(HarborError);
    }
  });

  it("never reaches the network for a refused project", async () => {
    await expect(createProject({ name: "hivelab", quotaBytes: 1 })).rejects.toMatchObject({ code: "forbidden_project" });
    await expect(createPullRobot({ project: "fedlify-studies", name: "x", days: 1 })).rejects.toMatchObject({ code: "forbidden_project" });
    await expect(ensureRetention("lab-sites-a", 5)).rejects.toMatchObject({ code: "forbidden_project" });
    await expect(listProjectRobots("hivelab")).rejects.toMatchObject({ code: "forbidden_project" });
    expect(calls).toHaveLength(0);
  });

  it("reads the project from an image reference; the legacy project and malformed references give null", () => {
    expect(studyProjectFromImage("harbor.fedlify.com/fedlify-s-demo/demo@sha256:abc")).toBe("fedlify-s-demo");
    expect(studyProjectFromImage("harbor.fedlify.com/fedlify-studies/demo@sha256:abc")).toBeNull();
    expect(studyProjectFromImage("harbor.fedlify.com/hivelab/x@sha256:abc")).toBeNull();
    expect(studyProjectFromImage("demo@sha256:abc")).toBeNull();
    expect(studyProjectFromImage(null)).toBeNull();
  });
});

describe("site pull robot", () => {
  it("sends exactly pull on repository of one project, with an expiry and no repository pattern", async () => {
    responder = () => ({ status: 201, body: { id: 5, name: "robot$fedlify-s-demo+site-a-1", secret: FAKE_SECRET, expires_at: 2_000_000_000 } });
    const robot = await createPullRobot({ project: "fedlify-s-demo", name: "site-a-1", days: 90 });
    expect(calls).toHaveLength(1);
    const { method, url, body } = calls[0]!;
    expect([method, url]).toEqual(["POST", "https://harbor.test/api/v2.0/robots"]);
    expect(body).toEqual({
      name: "site-a-1",
      description: expect.any(String),
      duration: 90,
      level: "project",
      disable: false,
      permissions: [{ kind: "project", namespace: "fedlify-s-demo", access: [{ resource: "repository", action: "pull" }] }]
    });
    expect(JSON.stringify(body)).not.toMatch(/pattern|push|\*/);
    expect(pullPermissions("fedlify-s-demo")).toEqual((body as { permissions: unknown }).permissions);
    expect(robot).toMatchObject({ id: 5, name: "robot$fedlify-s-demo+site-a-1", secret: FAKE_SECRET });
    expect(robot.expiresAt.getTime()).toBe(2_000_000_000_000);
  });

  it("uses the name Harbor returns, not one it built", async () => {
    responder = () => ({ status: 201, body: { id: 1, name: "robot$whatever", secret: FAKE_SECRET } });
    expect((await createPullRobot({ project: "fedlify-s-demo", name: "site-a-1", days: 1 })).name).toBe("robot$whatever");
  });

  it("rejects out-of-range lifetimes and unusable names before calling Harbor", async () => {
    for (const days of [0, -1, 366, 1.5]) await expect(createPullRobot({ project: "fedlify-s-demo", name: "x", days })).rejects.toBeInstanceOf(HarborError);
    expect(() => robotSafeName("$$$")).toThrow(HarborError);
    expect(robotSafeName("Site A/../x")).toBe("site-a-x");
    expect(calls).toHaveLength(0);
  });

  it("authenticates with the provisioner, never leaks it, and strips response bodies from errors", async () => {
    responder = () => ({ status: 403, body: { errors: [{ message: `robot$leak ${FAKE_PASSWORD}` }] } });
    const error = (await createPullRobot({ project: "fedlify-s-demo", name: "x", days: 1 }).catch((e) => e)) as HarborError;
    expect(error).toBeInstanceOf(HarborError);
    expect(error.code).toBe("rejected");
    expect(error.message).not.toContain("leak");
    expect(error.message).not.toContain(FAKE_PASSWORD);
    expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`robot$prov:${FAKE_PASSWORD}`).toString("base64")}`);
  });

  it("maps outages (5xx, network) to unavailable so callers can fail closed", async () => {
    responder = () => ({ status: 503 });
    await expect(createPullRobot({ project: "fedlify-s-demo", name: "x", days: 1 })).rejects.toMatchObject({ code: "unavailable" });
    responder = () => new Error(`connect ECONNREFUSED https://harbor.test with ${FAKE_PASSWORD}`);
    const error = (await createPullRobot({ project: "fedlify-s-demo", name: "x", days: 1 }).catch((e) => e)) as HarborError;
    expect(error.code).toBe("unavailable");
    expect(error.message).not.toContain(FAKE_PASSWORD);
  });

  it("refuses to run without provisioner credentials", async () => {
    delete process.env.FEDLIFY_HARBOR_PROVISIONER_PASSWORD;
    expect(harborConfig()).toBeNull();
    await expect(createPullRobot({ project: "fedlify-s-demo", name: "x", days: 1 })).rejects.toMatchObject({ code: "not_configured" });
  });

  it("treats deleting an already-deleted robot as success", async () => {
    responder = () => ({ status: 404 });
    await expect(deleteRobot(9)).resolves.toBeUndefined();
    responder = () => ({ status: 500 });
    await expect(deleteRobot(9)).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("project creation and retention", () => {
  it("creates a private project with a storage limit and scanning, and reports a conflict as created:false", async () => {
    responder = () => ({ status: 201 });
    expect(await createProject({ name: "fedlify-s-demo", quotaBytes: 20 * 1024 ** 3 })).toEqual({ created: true });
    expect(calls[0]!.body).toMatchObject({ project_name: "fedlify-s-demo", public: false, storage_limit: 20 * 1024 ** 3, metadata: { public: "false", auto_scan: "true" } });
    responder = () => ({ status: 409 });
    expect(await createProject({ name: "fedlify-s-demo", quotaBytes: 1 })).toEqual({ created: false });
  });

  it("retention keeps the newest N pushed tags and the tag active, and is not re-created when the project has one", async () => {
    const policy = retentionPolicy(7, 10) as { rules: Array<{ template: string; params: unknown; tag_selectors: Array<{ pattern: string }> }>; scope: unknown };
    expect(policy.rules.map((r) => r.template)).toEqual(["latestPushedK", "always"]);
    expect(policy.rules[0]!.params).toEqual({ latestPushedK: 10 });
    expect(policy.rules[1]!.tag_selectors[0]!.pattern).toBe("active");
    expect(policy.scope).toEqual({ level: "project", ref: 7 });
    responder = (call) => (call.method === "GET" ? { status: 200, body: { project_id: 7, metadata: { retention_id: "3" } } } : { status: 201 });
    expect(await ensureRetention("fedlify-s-demo", 10)).toEqual({ created: false });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    calls = [];
    responder = (call) => (call.method === "GET" ? { status: 200, body: { project_id: 7, metadata: {} } } : { status: 201 });
    expect(await ensureRetention("fedlify-s-demo", 10)).toEqual({ created: true });
    expect(calls.at(-1)!.url).toBe("https://harbor.test/api/v2.0/retentions");
  });

  it("lists robots of one project by project id", async () => {
    responder = (call) => (call.url.includes("/robots") ? { status: 200, body: [{ id: 1, name: "robot$a+site-x" }, { id: "bad" }] } : { status: 200, body: { project_id: 7 } });
    expect(await listProjectRobots("fedlify-s-demo")).toEqual([{ id: 1, name: "robot$a+site-x", expiresAt: null }]);
    expect(decodeURIComponent(calls[1]!.url)).toContain("Level=project,ProjectID=7");
  });

  it("follows pages: a project with more than 100 robots is listed completely, and reports expiry", async () => {
    const page = (n: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: n * 1000 + i, name: `robot$a+site-${n}-${i}`, expires_at: i === 0 ? 1_700_000_000 : -1 }));
    responder = (call) => {
      if (!call.url.includes("/robots")) return { status: 200, body: { project_id: 7 } };
      const n = Number(new URL(call.url).searchParams.get("page"));
      return { status: 200, body: n === 1 ? page(1, 100) : n === 2 ? page(2, 100) : page(3, 5) };
    };
    const robots = await listProjectRobots("fedlify-s-demo");
    expect(robots).toHaveLength(205);
    expect(robots[0]!.expiresAt).toEqual(new Date(1_700_000_000_000));
    expect(robots[1]!.expiresAt).toBeNull();
    expect(calls.filter((c) => c.url.includes("/robots")).map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2", "3"]);
  });

  it("refuses a partial answer rather than reporting a revocation as complete when pages never end", async () => {
    responder = (call) => (call.url.includes("/robots") ? { status: 200, body: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `robot$a+x${i}` })) } : { status: 200, body: { project_id: 7 } });
    await expect(listProjectRobots("fedlify-s-demo")).rejects.toMatchObject({ code: "unavailable" });
  });
});
