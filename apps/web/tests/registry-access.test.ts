import { beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_SECRET = "unit-test-robot-secret-not-real";
type Row = Record<string, any>;
const state = vi.hoisted(() => ({ projects: [] as Record<string, any>[], robots: [] as Record<string, any>[], seq: 0 }));
const audit = vi.fn();
const harbor = {
  createProject: vi.fn(),
  createPullRobot: vi.fn(),
  deleteRobot: vi.fn(),
  ensureRetention: vi.fn(),
  listProjectRobots: vi.fn()
};

vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/harbor-registry", async (orig) => {
  const real = await orig<typeof import("@/lib/harbor-registry")>();
  return { ...real, createProject: (...a: unknown[]) => harbor.createProject(...a), createPullRobot: (...a: unknown[]) => harbor.createPullRobot(...a), deleteRobot: (...a: unknown[]) => harbor.deleteRobot(...a), ensureRetention: (...a: unknown[]) => harbor.ensureRetention(...a), listProjectRobots: (...a: unknown[]) => harbor.listProjectRobots(...a) };
});

const { matches, table } = vi.hoisted(() => {
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return (cond.in as unknown[]).includes(value);
      if ("not" in cond) return value !== cond.not;
      if ("lt" in cond) return value < cond.lt;
    }
    return value === cond;
  });
}
const table = (rows: () => Row[], make: (data: Row) => Row, extra: Record<string, unknown> = {}) => ({
  findUnique: async ({ where, include }: Row) => {
    const row = rows().find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
    if (!row) return null;
    return include?.registryProject ? { ...row, registryProject: state.projects.find((p) => p.id === row.registryProjectId) } : row;
  },
  findMany: async ({ where }: Row = {}) => rows().filter((r) => matches(r, where)),
  create: async ({ data }: Row) => { const row = make(data); rows().push(row); return row; },
  update: async ({ where, data }: Row) => { const row = rows().find((r) => r.id === where.id); if (!row) throw new Error("no row"); Object.assign(row, data); return row; },
  updateMany: async ({ where, data }: Row) => { const hit = rows().filter((r) => matches(r, where)); hit.forEach((r) => Object.assign(r, data)); return { count: hit.length }; },
  deleteMany: async ({ where }: Row) => { const keep = rows().filter((r) => !matches(r, where)); rows().splice(0, rows().length, ...keep); return {}; },
  ...extra
});
  return { matches, table };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    registryProject: table(() => state.projects, (d) => ({ id: `p${++state.seq}`, status: "ACTIVE", retiredAt: null, ...d })),
    registryRobot: table(() => state.robots, (d) => ({ id: `robotrow${String(++state.seq).padStart(8, "0")}`, harborRobotId: null, siteJoinPackageId: null, status: "PENDING", createdAt: new Date(), deletedAt: null, lastError: null, ...d })),
    studySite: { findUnique: async ({ where }: Row) => (where.id === "ss1" ? { code: "a" } : null) }
  }
}));

const projects = state.projects;
const robots = state.robots;
import {
  activateRobotInTransaction,
  deleteRobotRows,
  discardMintedRobot,
  ensureStudyRegistryProject,
  mintSiteRobot,
  registryMode,
  revokeSiteRegistryAccess,
  reactivateStudyRegistryAccess,
  revokeStudyRegistryAccess,
  shortName,
  siteRobotShortName,
  sweepRegistry
} from "@/lib/registry-access";
import { HarborError } from "@/lib/harbor-registry";

const ctx = { actorUserId: "u1", orgId: "o1" };
const auditText = () => JSON.stringify(audit.mock.calls);

beforeEach(() => {
  state.projects.length = 0;
  state.robots.length = 0;
  state.seq = 0;
  vi.clearAllMocks();
  harbor.createProject.mockResolvedValue({ created: true });
  harbor.ensureRetention.mockResolvedValue({ created: true });
  harbor.deleteRobot.mockResolvedValue(undefined);
  harbor.listProjectRobots.mockResolvedValue([]);
  harbor.createPullRobot.mockImplementation(async ({ name }: { name: string }) => ({ id: 42, name: `robot$fedlify-s-demo+${name}`, secret: FAKE_SECRET, expiresAt: new Date("2027-01-01T00:00:00Z") }));
  delete process.env.FEDLIFY_REGISTRY_MODE;
});

describe("mode", () => {
  it("defaults to legacy and only the exact value per-study switches", () => {
    expect(registryMode({})).toBe("legacy");
    expect(registryMode({ FEDLIFY_REGISTRY_MODE: "per-study" })).toBe("per-study");
    expect(registryMode({ FEDLIFY_REGISTRY_MODE: "per_study" })).toBe("legacy");
    expect(registryMode({ FEDLIFY_REGISTRY_MODE: "" })).toBe("legacy");
  });
});

describe("ensureStudyRegistryProject", () => {
  it("records the project before calling Harbor, then sets retention and audits", async () => {
    harbor.createProject.mockImplementation(async () => {
      expect(projects).toHaveLength(1);
      return { created: true };
    });
    expect(await ensureStudyRegistryProject({ studyId: "s1", runtimeSlug: "demo", ...ctx })).toEqual({ name: "fedlify-s-demo", created: true });
    expect(projects[0]).toMatchObject({ studyId: "s1", name: "fedlify-s-demo", status: "ACTIVE" });
    expect(harbor.createProject).toHaveBeenCalledWith({ name: "fedlify-s-demo", quotaBytes: 20 * 1024 ** 3 });
    expect(harbor.ensureRetention).toHaveBeenCalledWith("fedlify-s-demo", 10);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "registry.project.ensure" }));
  });

  it("is idempotent for a project we already recorded", async () => {
    await ensureStudyRegistryProject({ studyId: "s1", runtimeSlug: "demo", ...ctx });
    harbor.createProject.mockResolvedValue({ created: false });
    await expect(ensureStudyRegistryProject({ studyId: "s1", runtimeSlug: "demo", ...ctx })).resolves.toMatchObject({ created: false });
    expect(projects).toHaveLength(1);
  });

  it("fails closed when Harbor already has a project of that name that we never created, and leaves no record", async () => {
    harbor.createProject.mockResolvedValue({ created: false });
    await expect(ensureStudyRegistryProject({ studyId: "s1", runtimeSlug: "demo", ...ctx })).rejects.toMatchObject({ code: "conflict" });
    expect(projects).toHaveLength(0);
    expect(harbor.ensureRetention).not.toHaveBeenCalled();
  });

  it("keeps the record when Harbor times out or answers 5xx (it may have created the project), so the retry reads 409 as ours", async () => {
    harbor.createProject.mockRejectedValue(new HarborError("down", "unavailable"));
    await expect(ensureStudyRegistryProject({ studyId: "s1", runtimeSlug: "demo", ...ctx })).rejects.toMatchObject({ code: "unavailable" });
    expect(projects).toHaveLength(1);
    harbor.createProject.mockResolvedValue({ created: false });
    await expect(ensureStudyRegistryProject({ studyId: "s1", runtimeSlug: "demo", ...ctx })).resolves.toMatchObject({ name: "fedlify-s-demo", created: false });
    expect(projects).toHaveLength(1);
  });

  it("drops the record on a definite refusal, and refuses a project outside fedlify-s-*", async () => {
    harbor.createProject.mockRejectedValue(new HarborError("no", "rejected", 403));
    await expect(ensureStudyRegistryProject({ studyId: "s1", runtimeSlug: "demo", ...ctx })).rejects.toMatchObject({ code: "rejected" });
    expect(projects).toHaveLength(0);
    await expect(ensureStudyRegistryProject({ studyId: "s1", runtimeSlug: "Demo X", ...ctx })).rejects.toMatchObject({ code: "forbidden_project" });
    expect(harbor.createProject).toHaveBeenCalledTimes(1);
  });

  it("a concurrent first publish that loses the unique-constraint race continues instead of failing", async () => {
    const { prisma } = await import("@/lib/prisma");
    const spy = vi.spyOn((prisma as any).registryProject, "create").mockImplementationOnce(async () => {
      projects.push({ id: "pRace", studyId: "s1", name: "fedlify-s-demo", status: "ACTIVE", retiredAt: null });
      throw new Error("Unique constraint failed");
    });
    harbor.createProject.mockResolvedValue({ created: false });
    await expect(ensureStudyRegistryProject({ studyId: "s1", runtimeSlug: "demo", ...ctx })).resolves.toMatchObject({ name: "fedlify-s-demo" });
    expect(projects).toHaveLength(1);
    spy.mockRestore();
  });

  it("a retention failure does not fail the publish, and is recorded", async () => {
    harbor.ensureRetention.mockRejectedValue(new HarborError("no", "rejected"));
    await expect(ensureStudyRegistryProject({ studyId: "s1", runtimeSlug: "demo", ...ctx })).resolves.toBeDefined();
    expect(auditText()).toContain("failed");
  });
});

describe("mintSiteRobot", () => {
  beforeEach(async () => {
    await ensureStudyRegistryProject({ studyId: "s1", runtimeSlug: "demo", ...ctx });
    audit.mockClear();
  });

  it("records PENDING first, asks Harbor for 90 days, activates the record, returns the secret once and audits without it", async () => {
    harbor.createPullRobot.mockImplementationOnce(async (input: { name: string }) => {
      expect(robots).toHaveLength(1);
      expect(robots[0]).toMatchObject({ status: "PENDING", studySiteId: "ss1" });
      return { id: 42, name: `robot$fedlify-s-demo+${input.name}`, secret: FAKE_SECRET, expiresAt: new Date("2027-01-01T00:00:00Z") };
    });
    const minted = await mintSiteRobot({ project: "fedlify-s-demo", studySiteId: "ss1", siteCode: "a", ...ctx });
    expect(harbor.createPullRobot).toHaveBeenCalledWith({ project: "fedlify-s-demo", name: siteRobotShortName("a", robots[0]!.id), days: 90 });
    expect(minted).toMatchObject({ rowId: robots[0]!.id, username: expect.stringContaining("robot$"), password: FAKE_SECRET });
    expect(robots[0]).toMatchObject({ harborRobotId: 42, status: "PENDING" });
    // No row, no audit event and no log line holds the secret.
    expect(JSON.stringify(robots)).not.toContain(FAKE_SECRET);
    expect(auditText()).not.toContain(FAKE_SECRET);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "registry.robot.create", metadata: expect.objectContaining({ purpose: "SITE_PULL", harborRobotId: 42 }) }));
    expect(auditText()).not.toMatch(/Basic |password|secret/i);
  });

  it("honours FEDLIFY_SITE_ROBOT_DAYS", async () => {
    process.env.FEDLIFY_SITE_ROBOT_DAYS = "30";
    await mintSiteRobot({ project: "fedlify-s-demo", studySiteId: "ss1", siteCode: "a", ...ctx });
    delete process.env.FEDLIFY_SITE_ROBOT_DAYS;
    expect(harbor.createPullRobot.mock.calls[0]![0].days).toBe(30);
  });

  it("closes the PENDING record and rethrows when Harbor fails, so the caller changes nothing else", async () => {
    harbor.createPullRobot.mockRejectedValue(new HarborError("Harbor is unreachable", "unavailable"));
    await expect(mintSiteRobot({ project: "fedlify-s-demo", studySiteId: "ss1", siteCode: "a", ...ctx })).rejects.toMatchObject({ code: "unavailable" });
    expect(robots[0]).toMatchObject({ status: "DELETED", lastError: "Harbor is unreachable" });
  });

  it("deletes the new robot at once if its record cannot be completed", async () => {
    const { prisma } = await import("@/lib/prisma");
    const update = prisma.registryRobot.update;
    let first = true;
    vi.spyOn(prisma.registryRobot, "update").mockImplementation(((args: never) => {
      if (first) { first = false; throw new Error("db down"); }
      return update(args);
    }) as never);
    await expect(mintSiteRobot({ project: "fedlify-s-demo", studySiteId: "ss1", siteCode: "a", ...ctx })).rejects.toThrow("db down");
    expect(harbor.deleteRobot).toHaveBeenCalledWith(42);
    vi.restoreAllMocks();
  });

  it("refuses a project we have no active record for", async () => {
    await expect(mintSiteRobot({ project: "fedlify-s-other", studySiteId: "ss1", siteCode: "a", ...ctx })).rejects.toMatchObject({ code: "not_found" });
    expect(harbor.createPullRobot).not.toHaveBeenCalled();
  });
});

describe("rotation, discard and revocation", () => {
  async function activeRobot(studySiteId = "ss1", harborRobotId = 1) {
    const row = { id: `r${++state.seq}`, registryProjectId: projects[0]!.id, studySiteId, purpose: "SITE_PULL", harborRobotId, harborName: `robot$fedlify-s-demo+site-a-${state.seq}`, status: "ACTIVE", createdAt: new Date(), lastError: null };
    robots.push(row);
    return row;
  }
  beforeEach(async () => {
    await ensureStudyRegistryProject({ studyId: "s1", runtimeSlug: "demo", ...ctx });
    audit.mockClear();
  });

  it("activation makes the new robot ACTIVE and the site's earlier ones REVOKING (other sites untouched)", async () => {
    const old = await activeRobot("ss1", 1);
    const other = await activeRobot("ss2", 2);
    const fresh = { ...(await activeRobot("ss1", 3)), status: "PENDING" };
    robots.find((r) => r.id === fresh.id)!.status = "PENDING";
    const tx = { registryRobot: (await import("@/lib/prisma")).prisma.registryRobot };
    const superseded = await activateRobotInTransaction(tx as never, { rowId: fresh.id, studySiteId: "ss1", packageId: "pkg1" });
    expect(superseded).toEqual([old.id]);
    expect(robots.find((r) => r.id === old.id)!.status).toBe("REVOKING");
    expect(robots.find((r) => r.id === other.id)!.status).toBe("ACTIVE");
    expect(robots.find((r) => r.id === fresh.id)).toMatchObject({ status: "ACTIVE", siteJoinPackageId: "pkg1" });
  });

  it("deleting reports revoked, marks DELETED and audits; a Harbor failure keeps REVOKING, reports pending and audits the failure", async () => {
    const a = await activeRobot("ss1", 1);
    expect(await deleteRobotRows([a.id], "kit_rotation", ctx)).toBe("revoked");
    expect(harbor.deleteRobot).toHaveBeenCalledWith(1);
    expect(robots[0]).toMatchObject({ status: "DELETED" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "registry.robot.delete" }));
    const b = await activeRobot("ss1", 2);
    harbor.deleteRobot.mockRejectedValue(new HarborError("Harbor is unreachable", "unavailable"));
    expect(await deleteRobotRows([b.id], "kit_rotation", ctx)).toBe("pending");
    expect(robots.find((r) => r.id === b.id)).toMatchObject({ status: "REVOKING", lastError: "Harbor is unreachable" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "registry.robot.delete_failed" }));
  });

  it("discardMintedRobot removes a robot whose kit never committed", async () => {
    const row = await activeRobot("ss1", 7);
    robots.find((r) => r.id === row.id)!.status = "PENDING";
    await discardMintedRobot(row.id, "upload_failed", ctx);
    expect(harbor.deleteRobot).toHaveBeenCalledWith(7);
    expect(robots.find((r) => r.id === row.id)!.status).toBe("DELETED");
    expect(auditText()).toContain("upload_failed");
  });

  it("a PENDING row with no Harbor id is found by its derived name", async () => {
    const row = await activeRobot("ss1", 0);
    Object.assign(robots.find((r) => r.id === row.id)!, { harborRobotId: null, status: "PENDING" });
    harbor.listProjectRobots.mockResolvedValue([
      { id: 11, name: `robot$fedlify-s-demo+${siteRobotShortName("a", row.id)}` },
      { id: 12, name: "robot$fedlify-s-demo+site-a-someoneelse" }
    ]);
    await deleteRobotRows([row.id], "pending_timeout", ctx);
    expect(harbor.deleteRobot).toHaveBeenCalledTimes(1);
    expect(harbor.deleteRobot).toHaveBeenCalledWith(11);
  });

  it("site disable revokes only that site's robots", async () => {
    await activeRobot("ss1", 1);
    await activeRobot("ss2", 2);
    expect(await revokeSiteRegistryAccess({ studySiteId: "ss1", reason: "site_disabled", ...ctx })).toBe("revoked");
    expect(harbor.deleteRobot.mock.calls).toEqual([[1]]);
    expect(robots.map((r) => r.status)).toEqual(["DELETED", "ACTIVE"]);
  });

  it("study archive revokes every site robot and the aggregator robots, and marks the project retired, not deleted", async () => {
    await activeRobot("ss1", 1);
    await activeRobot("ss2", 2);
    harbor.listProjectRobots.mockResolvedValue([
      { id: 90, name: "robot$fedlify-s-demo+agg-run1" },
      { id: 91, name: "robot$fedlify-s-demo+push-run1" }
    ]);
    expect(await revokeStudyRegistryAccess({ studyId: "s1", reason: "study_archived", ...ctx })).toBe("revoked");
    expect(harbor.deleteRobot.mock.calls.map((c) => c[0]).sort()).toEqual([1, 2, 90]);
    expect(projects[0]).toMatchObject({ status: "RETIRED" });
    expect(projects[0]!.retiredAt).toBeInstanceOf(Date);
    expect(await revokeStudyRegistryAccess({ studyId: "none", reason: "x" })).toBe("not_applicable");
  });

  it("study archive reports pending when Harbor is down and still retires the project", async () => {
    await activeRobot("ss1", 1);
    harbor.deleteRobot.mockRejectedValue(new HarborError("Harbor is unreachable", "unavailable"));
    harbor.listProjectRobots.mockRejectedValue(new HarborError("Harbor is unreachable", "unavailable"));
    expect(await revokeStudyRegistryAccess({ studyId: "s1", reason: "study_archived", ...ctx })).toBe("pending");
    expect(robots[0]!.status).toBe("REVOKING");
    expect(projects[0]!.status).toBe("RETIRED");
  });
});

describe("reactivation", () => {
  it("archive then reactivate makes the project ACTIVE again so a kit can be minted", async () => {
    await ensureStudyRegistryProject({ studyId: "s1", runtimeSlug: "demo", ...ctx });
    await revokeStudyRegistryAccess({ studyId: "s1", reason: "study_archived", ...ctx });
    await expect(mintSiteRobot({ project: "fedlify-s-demo", studySiteId: "ss1", siteCode: "a", ...ctx })).rejects.toMatchObject({ code: "not_found" });
    expect(await reactivateStudyRegistryAccess({ studyId: "s1", ...ctx })).toBe("reactivated");
    expect(projects[0]).toMatchObject({ status: "ACTIVE", retiredAt: null });
    await expect(mintSiteRobot({ project: "fedlify-s-demo", studySiteId: "ss1", siteCode: "a", ...ctx })).resolves.toMatchObject({ username: expect.stringContaining("site-a") });
    expect(await reactivateStudyRegistryAccess({ studyId: "none" })).toBe("not_applicable");
  });
});

describe("sweeper", () => {
  beforeEach(async () => {
    await ensureStudyRegistryProject({ studyId: "s1", runtimeSlug: "demo", ...ctx });
    audit.mockClear();
  });
  const robot = (over: Row) => { const row = { id: `r${++state.seq}`, registryProjectId: projects[0]!.id, studySiteId: "ss1", purpose: "SITE_PULL", harborRobotId: 5, harborName: "robot$fedlify-s-demo+site-a-1", status: "ACTIVE", createdAt: new Date(), lastError: null, ...over }; robots.push(row); return row; };

  it("deletes PENDING rows older than 15 minutes but not fresh ones", async () => {
    const old = robot({ status: "PENDING", harborRobotId: 6, harborName: "pending", createdAt: new Date(Date.now() - 20 * 60_000) });
    const fresh = robot({ status: "PENDING", harborRobotId: 7, harborName: "pending", createdAt: new Date() });
    const result = await sweepRegistry();
    expect(result.pendingSwept).toBe(1);
    expect(robots.find((r) => r.id === old.id)!.status).toBe("DELETED");
    expect(robots.find((r) => r.id === fresh.id)!.status).toBe("PENDING");
    expect(harbor.deleteRobot).toHaveBeenCalledWith(6);
    expect(harbor.deleteRobot).not.toHaveBeenCalledWith(7);
  });

  it("retries REVOKING rows", async () => {
    const row = robot({ status: "REVOKING", harborRobotId: 8 });
    expect((await sweepRegistry()).revokingRetried).toBe(1);
    expect(robots.find((r) => r.id === row.id)!.status).toBe("DELETED");
  });

  it("deletes site-* robots no live row owns, keeps owned ones, flags unknown names, leaves push-/agg- alone", async () => {
    robot({ harborName: "robot$fedlify-s-demo+site-a-1" });
    harbor.listProjectRobots.mockResolvedValue([
      { id: 5, name: "robot$fedlify-s-demo+site-a-1" },
      { id: 20, name: "robot$fedlify-s-demo+site-ghost-9" },
      { id: 21, name: "robot$fedlify-s-demo+agg-r" },
      { id: 22, name: "robot$fedlify-s-demo+push-r" },
      { id: 23, name: "robot$fedlify-s-demo+handmade" }
    ]);
    const result = await sweepRegistry();
    expect(harbor.deleteRobot.mock.calls.map((c) => c[0])).toEqual([20]);
    expect(result).toMatchObject({ orphansDeleted: 1, unexpected: 1 });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "registry.robot.orphan_swept" }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "registry.robot.unexpected" }));
  });

  it("does not delete an unrecorded robot while a PENDING row might own it", async () => {
    robot({ status: "PENDING", harborRobotId: null, harborName: "pending" });
    harbor.listProjectRobots.mockResolvedValue([{ id: 20, name: "robot$fedlify-s-demo+site-a-zzzz" }]);
    await sweepRegistry();
    expect(harbor.deleteRobot).not.toHaveBeenCalled();
  });

  it("counts a Harbor outage as an error instead of throwing, and keeps rows for the next run", async () => {
    robot({ status: "REVOKING", harborRobotId: 8 });
    harbor.deleteRobot.mockRejectedValue(new HarborError("down", "unavailable"));
    harbor.listProjectRobots.mockRejectedValue(new HarborError("down", "unavailable"));
    const result = await sweepRegistry();
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(robots[0]!.status).toBe("REVOKING");
  });

  it("reads the live rows after the Harbor list, so a robot minted during the sweep is not deleted", async () => {
    harbor.listProjectRobots.mockImplementation(async () => {
      // A kit request lands between the sweeper's start and the Harbor answer: PENDING row first, robot after.
      robot({ status: "PENDING", harborRobotId: null, harborName: "pending" });
      return [{ id: 30, name: "robot$fedlify-s-demo+site-a-newrow" }];
    });
    await sweepRegistry();
    expect(harbor.deleteRobot).not.toHaveBeenCalled();
  });

  it("deletes expired robots of every kind and closes their rows", async () => {
    const row = robot({ harborName: "robot$fedlify-s-demo+site-a-1", harborRobotId: 5 });
    harbor.listProjectRobots.mockResolvedValue([
      { id: 5, name: "robot$fedlify-s-demo+site-a-1", expiresAt: new Date(Date.now() - 1000) },
      { id: 21, name: "robot$fedlify-s-demo+agg-old", expiresAt: new Date(Date.now() - 1000) },
      { id: 22, name: "robot$fedlify-s-demo+agg-new", expiresAt: new Date(Date.now() + 86_400_000) },
      { id: 23, name: "robot$fedlify-s-demo+push-never", expiresAt: null }
    ]);
    const result = await sweepRegistry();
    expect(harbor.deleteRobot.mock.calls.map((c) => c[0]).sort()).toEqual([21, 5]);
    expect(result.expiredDeleted).toBe(2);
    expect(robots.find((r) => r.id === row.id)).toMatchObject({ status: "DELETED", lastError: "expired" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "registry.robot.expired_swept" }));
    expect(auditText()).not.toContain(FAKE_SECRET);
  });

  it("a RETIRED project loses its aggregator and push robots too, so a failed archive delete is retried", async () => {
    projects[0]!.status = "RETIRED";
    harbor.listProjectRobots.mockResolvedValue([
      { id: 40, name: "robot$fedlify-s-demo+agg-run9", expiresAt: new Date(Date.now() + 86_400_000 * 300) },
      { id: 41, name: "robot$fedlify-s-demo+push-run9", expiresAt: null }
    ]);
    const result = await sweepRegistry();
    expect(harbor.deleteRobot.mock.calls.map((c) => c[0]).sort()).toEqual([40, 41]);
    expect(result.retiredDeleted).toBe(2);
  });

  it("an ACTIVE project keeps its aggregator robot", async () => {
    harbor.listProjectRobots.mockResolvedValue([{ id: 40, name: "robot$fedlify-s-demo+agg-run9", expiresAt: new Date(Date.now() + 86_400_000) }]);
    await sweepRegistry();
    expect(harbor.deleteRobot).not.toHaveBeenCalled();
  });

  it("shortName strips Harbor's robot$project+ prefix", () => {
    expect(shortName("robot$fedlify-s-demo+site-a-1")).toBe("site-a-1");
    expect(shortName("robot$plain")).toBe("plain");
    expect(shortName("bare")).toBe("bare");
  });
});
