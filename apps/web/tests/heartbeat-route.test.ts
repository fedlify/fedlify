import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const siteFind = vi.fn();
const transaction = vi.fn();
const heartbeatCreate = vi.fn();

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/rbac", () => ({ canAccessStudy: async () => true }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    site: { findUnique: (...a: unknown[]) => siteFind(...a) },
    nvflareDeployment: { findFirst: async () => null },
    $transaction: (fn: unknown, ...a: unknown[]) => transaction(fn, ...a)
  }
}));

import { POST } from "@/app/api/v1/sites/[siteId]/heartbeat/route";

const token = "site-token-value";
const hash = createHash("sha256").update(token).digest("hex");

function beat(siteId: string, headers: Record<string, string>, body: unknown = { status: "CONNECTED" }) {
  const request = new Request("http://x/api", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  return POST(request as never, { params: Promise.resolve({ siteId }) }) as Promise<Response>;
}

describe("heartbeat route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    siteFind.mockResolvedValue({ id: "x", studyId: "s", apiTokenHash: hash, study: { orgId: "o" }, studySite: null });
    transaction.mockResolvedValue({ id: "hb" });
  });

  it("rejects a wrong or missing token", async () => {
    expect((await beat("auth-site", { "x-site-token": "wrong" })).status).toBe(401);
    expect((await beat("auth-site", {})).status).toBe(401);
    expect((await beat("auth-site", { "x-site-token": token })).status).toBe(201);
  });

  it("stores only allowlisted scalar metadata", async () => {
    transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({ site: { update: async () => undefined }, siteHeartbeat: { create: (args: unknown) => (heartbeatCreate(args), { id: "hb" }) } })
    );
    const response = await beat("meta-site", { "x-site-token": token }, { status: "CONNECTED", metadata: { container: "running", csvCount: 2, rows: [[1, 2]], dataPath: "/secret/data" } });
    expect(response.status).toBe(201);
    expect(heartbeatCreate.mock.calls[0][0].data.metadata).toEqual({ container: "running", csvCount: 2 });
  });

  it("answers 400, not 500, for a body that is not JSON", async () => {
    const request = new Request("http://x/api", { method: "POST", body: "not json" });
    const response = (await POST(request as never, { params: Promise.resolve({ siteId: "bad-json" }) })) as Response;
    expect(response.status).toBe(400);
  });

  it("rate limits failed tokens per site, not per header, and does not let a guesser block the real runner", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await beat("flood-site", { "x-forwarded-for": `9.9.9.${i}`, "x-site-token": `guess-${i}` })).status);
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429, 429, 429]);
    // the failed-attempt bucket also stops a correct token for this site until the window passes; other sites are unaffected
    expect((await beat("other-site", { "x-forwarded-for": "9.9.9.1", "x-site-token": token })).status).toBe(201);
  });

  it("limits accepted beats per site", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await beat("busy-site", { "x-site-token": token, "x-forwarded-for": `1.1.1.${i}` })).status);
    expect(statuses.slice(0, 20).every((status) => status === 201)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });

  it("refuses a disabled site and lifecycle statuses from a token holder", async () => {
    siteFind.mockResolvedValue({ id: "x", studyId: "s", status: "DISABLED", apiTokenHash: hash, study: { orgId: "o" }, studySite: null });
    expect((await beat("dis-1", { "x-site-token": token })).status).toBe(403);
    siteFind.mockResolvedValue({ id: "x", studyId: "s", status: "CONNECTED", apiTokenHash: hash, study: { orgId: "o" }, studySite: { id: "ss", participationStatus: "DISABLED" } });
    expect((await beat("dis-2", { "x-site-token": token })).status).toBe(403);
    siteFind.mockResolvedValue({ id: "x", studyId: "s", status: "CONNECTED", apiTokenHash: hash, study: { orgId: "o" }, studySite: null });
    for (const status of ["DISABLED", "INVITED", "KIT_RELEASED"]) {
      expect((await beat(`st-${status}`, { "x-site-token": token }, { status })).status).toBe(400);
    }
    expect((await beat("st-ok", { "x-site-token": token }, { status: "DEGRADED" })).status).toBe(201);
  });

  it("bounds computeRunId", async () => {
    expect((await beat("len-site", { "x-site-token": token }, { status: "CONNECTED", computeRunId: "r".repeat(500) })).status).toBe(400);
  });
});
