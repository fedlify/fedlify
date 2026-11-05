import { beforeEach, describe, expect, it, vi } from "vitest";

const assertStudyAccess = vi.fn();
const findMany = vi.fn();
const count = vi.fn();
const groupBy = vi.fn();
const audit = vi.fn();

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/rbac", () => ({
  assertStudyAccess: (...a: unknown[]) => assertStudyAccess(...a),
  isForbiddenError: (e: unknown) => e instanceof Error && e.name === "ForbiddenError"
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditEvent: { findMany: (...a: unknown[]) => findMany(...a), count: (...a: unknown[]) => count(...a), groupBy: (...a: unknown[]) => groupBy(...a) },
    user: { findMany: async () => [{ id: "u1", name: "Ada", email: "ada@x.test" }] }
  }
}));

import { GET } from "@/app/api/v1/studies/[studyId]/audit/route";
import { auditToCsv, parseAuditQuery, redactMetadata, toAuditDto } from "@/lib/audit-query";

const row = {
  id: "e1",
  createdAt: new Date("2026-11-01T00:00:00Z"),
  action: "site.join_package.create",
  targetType: "Site",
  targetId: "ss1",
  actorUserId: "u1",
  actor: { name: "Ada", email: "ada@x.test" },
  ipHash: "SECRETHASH",
  userAgent: "UA",
  metadata: { filename: "kit.zip", apiToken: "abc", nested: { password: "p", ok: 1 }, url: "https://s3/x?X-Amz-Signature=zzz" }
};

function call(query = "") {
  return GET({ nextUrl: new URL(`https://app.test/api/v1/studies/s1/audit${query}`) } as never, { params: Promise.resolve({ studyId: "s1" }) });
}

describe("audit route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertStudyAccess.mockResolvedValue(undefined);
    findMany.mockResolvedValue([row]);
    count.mockResolvedValue(1);
    groupBy.mockResolvedValue([{ action: "a", actorUserId: "u1" }]);
  });

  it("requires the audit permission and reads nothing without it", async () => {
    assertStudyAccess.mockRejectedValue(Object.assign(new Error("no"), { name: "ForbiddenError" }));
    const response = (await call())!;
    expect(response.status).toBe(403);
    expect(assertStudyAccess).toHaveBeenCalledWith("u1", "s1", "audit");
    expect(findMany).not.toHaveBeenCalled();
  });

  it("pages, redacts secrets, and never returns ipHash or userAgent", async () => {
    const response = (await call("?page=2&pageSize=500&action=join"))!;
    const body = await response.json();
    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: 100, take: 100, where: { studyId: "s1", action: { contains: "join" } } });
    const text = JSON.stringify(body);
    expect(text).not.toContain("SECRETHASH");
    expect(text).not.toContain("abc");
    expect(text).not.toContain("zzz");
    expect(body.events[0].metadata).toMatchObject({ filename: "kit.zip", apiToken: "[redacted]", nested: { password: "[redacted]", ok: 1 } });
    expect(body.total).toBe(1);
  });

  it("exports CSV with a head hash and audits the export", async () => {
    const response = (await call("?format=csv"))!;
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("x-fedlify-audit-head-hash")).toMatch(/^[0-9a-f]{64}$/);
    const text = await response.text();
    expect(text.split("\n")[0]).toBe("time,actor,actor_email,action,target_type,target_id,metadata");
    expect(text).not.toContain("SECRETHASH");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "study.audit.export", studyId: "s1" }));
  });
});

describe("audit-query helpers", () => {
  it("clamps paging and ignores bad dates", () => {
    const q = parseAuditQuery(new URLSearchParams("page=-3&pageSize=9999&from=nope&format=xml"));
    expect(q).toMatchObject({ page: 1, pageSize: 100, from: undefined, format: "page" });
  });
  it("neutralises CSV formula injection", () => {
    const csv = auditToCsv([{ ...toAuditDto(row), actorName: "=HYPERLINK(1)" }]);
    expect(csv).toContain("'=HYPERLINK(1)");
  });
  it("redacts secret-looking values under innocuous keys", () => {
    expect(redactMetadata({ note: "Bearer abcdefghijkl" })).toEqual({ note: "[redacted]" });
  });
});

describe("audit run filter", () => {
  it("matches nothing for an unknown run or a run of another study", async () => {
    const { auditWhere, parseAuditQuery: parse } = await import("@/lib/audit-query");
    const where = auditWhere("s1", parse(new URLSearchParams("run=other")), null);
    expect(where).toMatchObject({ studyId: "s1", id: { in: [] } });
  });
  it("covers the job, its result and its release", async () => {
    const { auditWhere, parseAuditQuery: parse } = await import("@/lib/audit-query");
    const where = auditWhere("s1", parse(new URLSearchParams("run=j1")), { jobId: "j1", resultId: "r1", releaseId: "m1" }) as { OR: Array<{ targetId?: { in: string[] } }> };
    expect(where.OR[0].targetId?.in).toEqual(["j1", "r1", "m1"]);
  });
});
