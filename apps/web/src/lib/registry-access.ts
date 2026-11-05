/**
 * Registry lifecycle for Fedlify studies and sites (docs/site-runner-and-ux-design.md section 15).
 *
 *  - one private Harbor project per study, created idempotently at publish, fail-closed on a name we did not create;
 *  - one pull-only Harbor robot per site kit, recorded PENDING before Harbor is called so a crash leaves a trace;
 *  - robots deleted on kit rotation, site disable, study archive, and by a sweeper for anything that slipped through.
 * No function here stores, logs or audits a robot secret. The only place a secret is returned is `mintSiteRobot`, to the
 * kit route, which puts it in the encrypted kit.
 */

import type { Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import {
  HarborError,
  createProject,
  createPullRobot,
  deleteRobot,
  ensureRetention,
  listProjectRobots,
  robotSafeName,
  studyProjectName
} from "@/lib/harbor-registry";
import { prisma } from "@/lib/prisma";

export type RegistryMode = "legacy" | "per-study";
export type AuditContext = { actorUserId?: string | null; orgId?: string | null; studyId?: string | null };

export const PENDING_ROBOT_MAX_AGE_MS = 15 * 60_000;
const GIB = 1024 ** 3;

export function registryMode(env: Record<string, string | undefined> = process.env): RegistryMode {
  return env.FEDLIFY_REGISTRY_MODE?.trim() === "per-study" ? "per-study" : "legacy";
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export const studyQuotaBytes = () => intEnv("FEDLIFY_STUDY_PROJECT_QUOTA_GIB", 20, 1, 4096) * GIB;
export const studyRetentionKeep = () => intEnv("FEDLIFY_STUDY_RETENTION_KEEP", 10, 1, 1000);
export const siteRobotDays = () => intEnv("FEDLIFY_SITE_ROBOT_DAYS", 90, 1, 365);

function sanitizeError(error: unknown): string {
  return (error instanceof HarborError ? error.message : "unexpected error").slice(0, 200);
}

async function safeAudit(ctx: AuditContext, action: string, targetType: string, targetId: string, metadata: Record<string, unknown>) {
  try {
    await audit({ actorUserId: ctx.actorUserId, orgId: ctx.orgId, studyId: ctx.studyId, action, targetType, targetId, metadata });
  } catch {
    // The audit table being unavailable must not strand a half-finished registry operation.
  }
}

/** Short robot name; Harbor may prefix it (`robot$<project>+`), so matching always uses `shortName`. */
export function siteRobotShortName(siteCode: string, robotRowId: string): string {
  return robotSafeName(`site-${siteCode.slice(0, 24)}-${robotRowId.slice(-8)}`);
}

export function shortName(harborName: string): string {
  const plus = harborName.indexOf("+");
  return plus >= 0 ? harborName.slice(plus + 1) : harborName.replace(/^robot\$/, "");
}

/** Create or confirm the study's project. Throws HarborError; never returns a project that is not ours. */
export async function ensureStudyRegistryProject(input: { studyId: string; runtimeSlug: string } & AuditContext): Promise<{ name: string; created: boolean }> {
  const name = studyProjectName(input.runtimeSlug);
  let existing = await prisma.registryProject.findUnique({ where: { studyId: input.studyId } });
  if (existing && existing.name !== name) {
    throw new HarborError("This study is already bound to a different registry project.", "conflict");
  }
  // Record first: if the process dies after Harbor creates the project, the next publish still recognises it as ours.
  if (!existing) {
    try {
      await prisma.registryProject.create({ data: { studyId: input.studyId, name, quotaBytes: BigInt(studyQuotaBytes()) } });
    } catch (error) {
      // Two first publishes raced: the other one recorded the row (unique studyId or name). Ours is the same project.
      existing = await prisma.registryProject.findUnique({ where: { studyId: input.studyId } });
      if (!existing || existing.name !== name) throw error;
    }
  } else if (existing.status === "RETIRED") {
    await prisma.registryProject.update({ where: { id: existing.id }, data: { status: "ACTIVE", retiredAt: null } });
  }
  let created: boolean;
  try {
    ({ created } = await createProject({ name, quotaBytes: studyQuotaBytes() }));
  } catch (error) {
    // Only a definite refusal proves Harbor holds nothing of ours. A timeout or 5xx may have happened after Harbor committed,
    // so the record stays: the next publish then reads Harbor's 409 as "ours" instead of "someone else's".
    if (!existing && error instanceof HarborError && ["rejected", "forbidden_project", "bad_name", "not_configured"].includes(error.code)) {
      await prisma.registryProject.deleteMany({ where: { studyId: input.studyId, name } }).catch(() => undefined);
    }
    throw error;
  }
  if (!created && !existing) {
    await prisma.registryProject.deleteMany({ where: { studyId: input.studyId, name } }).catch(() => undefined);
    throw new HarborError(`A Harbor project named ${name} already exists and Fedlify did not create it. Publishing stops here; ask the registry owner.`, "conflict", 409);
  }
  let retention = "ok";
  try {
    await ensureRetention(name, studyRetentionKeep());
  } catch (error) {
    retention = `failed: ${sanitizeError(error)}`;
  }
  await safeAudit(input, "registry.project.ensure", "RegistryProject", name, { project: name, created, quotaBytes: studyQuotaBytes(), retention });
  return { name, created };
}

export type MintedSiteRobot = { rowId: string; username: string; password: string; expiresAt: Date };

/**
 * Create the site's pull robot. The row exists as PENDING before Harbor is called. On a Harbor failure the row is closed
 * and the error is rethrown, so the caller can return 502 with nothing else changed. The password is returned once.
 */
export async function mintSiteRobot(input: { project: string; studySiteId: string; siteCode: string } & AuditContext): Promise<MintedSiteRobot> {
  const projectRow = await prisma.registryProject.findUnique({ where: { name: input.project } });
  if (!projectRow || projectRow.status !== "ACTIVE") {
    throw new HarborError("The study's registry project is not recorded as active.", "not_found");
  }
  const days = siteRobotDays();
  const row = await prisma.registryRobot.create({
    data: {
      registryProjectId: projectRow.id,
      studySiteId: input.studySiteId,
      purpose: "SITE_PULL",
      harborName: "pending",
      status: "PENDING",
      expiresAt: new Date(Date.now() + days * 86_400_000)
    }
  });
  let robot;
  try {
    robot = await createPullRobot({ project: input.project, name: siteRobotShortName(input.siteCode, row.id), days });
  } catch (error) {
    await prisma.registryRobot
      .update({ where: { id: row.id }, data: { status: "DELETED", deletedAt: new Date(), lastError: sanitizeError(error) } })
      .catch(() => undefined);
    throw error;
  }
  try {
    await prisma.registryRobot.update({ where: { id: row.id }, data: { harborRobotId: robot.id, harborName: robot.name, expiresAt: robot.expiresAt } });
  } catch (error) {
    await deleteRobot(robot.id).catch(() => undefined);
    throw error;
  }
  await safeAudit(input, "registry.robot.create", "RegistryRobot", row.id, {
    project: input.project,
    harborName: robot.name,
    harborRobotId: robot.id,
    purpose: "SITE_PULL",
    expiresAt: robot.expiresAt.toISOString()
  });
  return { rowId: row.id, username: robot.name, password: robot.secret, expiresAt: robot.expiresAt };
}

/** Inside the kit transaction: the new robot becomes ACTIVE and the site's earlier robots become REVOKING. Returns their ids. */
export async function activateRobotInTransaction(tx: Prisma.TransactionClient, input: { rowId: string; studySiteId: string; packageId: string }): Promise<string[]> {
  const earlier = await tx.registryRobot.findMany({
    where: { studySiteId: input.studySiteId, status: "ACTIVE", id: { not: input.rowId } },
    select: { id: true }
  });
  if (earlier.length > 0) await tx.registryRobot.updateMany({ where: { id: { in: earlier.map((r) => r.id) } }, data: { status: "REVOKING" } });
  await tx.registryRobot.update({ where: { id: input.rowId }, data: { status: "ACTIVE", siteJoinPackageId: input.packageId } });
  return earlier.map((r) => r.id);
}

/** Delete robots in Harbor. A failure leaves the row REVOKING for the sweeper. Returns "revoked" or "pending". */
export async function deleteRobotRows(ids: string[], reason: string, ctx: AuditContext = {}): Promise<"revoked" | "pending"> {
  let outcome: "revoked" | "pending" = "revoked";
  for (const id of ids) {
    const row = await prisma.registryRobot.findUnique({ where: { id }, include: { registryProject: true } });
    if (!row || row.status === "DELETED") continue;
    const meta = { project: row.registryProject.name, harborName: row.harborName, harborRobotId: row.harborRobotId, purpose: row.purpose, reason };
    try {
      if (row.harborRobotId !== null) await deleteRobot(row.harborRobotId);
      else await deleteByDerivedName(row);
      await prisma.registryRobot.update({ where: { id }, data: { status: "DELETED", deletedAt: new Date(), lastError: null } });
      await safeAudit(ctx, "registry.robot.delete", "RegistryRobot", id, meta);
    } catch (error) {
      outcome = "pending";
      await prisma.registryRobot.update({ where: { id }, data: { status: "REVOKING", lastError: sanitizeError(error) } }).catch(() => undefined);
      await safeAudit(ctx, "registry.robot.delete_failed", "RegistryRobot", id, { ...meta, error: sanitizeError(error) });
    }
  }
  return outcome;
}

// A PENDING row has no Harbor id when the process died between "create" and "record". Its name is derivable from the row.
async function deleteByDerivedName(row: { id: string; studySiteId: string | null; registryProject: { name: string } }): Promise<void> {
  const site = row.studySiteId ? await prisma.studySite.findUnique({ where: { id: row.studySiteId }, select: { code: true } }) : null;
  if (!site) return;
  const wanted = siteRobotShortName(site.code, row.id);
  for (const robot of await listProjectRobots(row.registryProject.name)) {
    if (shortName(robot.name) === wanted) await deleteRobot(robot.id);
  }
}

/** Failure path inside the kit route (upload or transaction failed): the new robot must not survive. */
export async function discardMintedRobot(rowId: string, reason: string, ctx: AuditContext): Promise<void> {
  await prisma.registryRobot.update({ where: { id: rowId }, data: { status: "REVOKING" } }).catch(() => undefined);
  await deleteRobotRows([rowId], reason, ctx);
}

export async function revokeSiteRegistryAccess(input: { studySiteId: string; reason: string } & AuditContext): Promise<"revoked" | "pending"> {
  const rows = await prisma.registryRobot.findMany({ where: { studySiteId: input.studySiteId, status: { in: ["PENDING", "ACTIVE", "REVOKING"] } }, select: { id: true } });
  if (rows.length === 0) return "revoked";
  await prisma.registryRobot.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: "REVOKING" } });
  return deleteRobotRows(rows.map((r) => r.id), input.reason, input);
}

/** Study archive or retirement: revoke every site robot, the aggregator robots, and mark the project RETIRED (not deleted). */
export async function revokeStudyRegistryAccess(input: { studyId: string; reason: string } & AuditContext): Promise<"revoked" | "pending" | "not_applicable"> {
  const project = await prisma.registryProject.findUnique({ where: { studyId: input.studyId } });
  if (!project) return "not_applicable";
  const rows = await prisma.registryRobot.findMany({ where: { registryProjectId: project.id, status: { in: ["PENDING", "ACTIVE", "REVOKING"] } }, select: { id: true } });
  if (rows.length > 0) await prisma.registryRobot.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: "REVOKING" } });
  let outcome = rows.length > 0 ? await deleteRobotRows(rows.map((r) => r.id), input.reason, input) : "revoked";
  try {
    for (const robot of await listProjectRobots(project.name)) {
      if (!shortName(robot.name).startsWith("agg-")) continue;
      await deleteRobot(robot.id);
      await safeAudit(input, "registry.robot.delete", "RegistryRobot", String(robot.id), { project: project.name, harborName: robot.name, harborRobotId: robot.id, purpose: "AGGREGATOR_PULL", reason: input.reason });
    }
  } catch (error) {
    outcome = "pending";
    await safeAudit(input, "registry.robot.delete_failed", "RegistryProject", project.name, { project: project.name, purpose: "AGGREGATOR_PULL", error: sanitizeError(error) });
  }
  await prisma.registryProject.update({ where: { id: project.id }, data: { status: "RETIRED", retiredAt: new Date() } });
  return outcome;
}

/**
 * Study reactivation: the project was only marked RETIRED at archive, so it is simply marked ACTIVE again and kit creation
 * works. The aggregator's pull robot was deleted at archive: the study needs a republish to get a new one.
 */
export async function reactivateStudyRegistryAccess(input: { studyId: string } & AuditContext): Promise<"reactivated" | "not_applicable"> {
  const project = await prisma.registryProject.findUnique({ where: { studyId: input.studyId } });
  if (!project) return "not_applicable";
  if (project.status === "RETIRED") {
    await prisma.registryProject.update({ where: { id: project.id }, data: { status: "ACTIVE", retiredAt: null } });
    await safeAudit(input, "registry.project.reactivate", "RegistryProject", project.name, { project: project.name });
  }
  return "reactivated";
}

export type SweepResult = { pendingSwept: number; revokingRetried: number; orphansDeleted: number; expiredDeleted: number; retiredDeleted: number; unexpected: number; errors: number };

/** Idempotent. Deletes stale PENDING robots, retries REVOKING, removes `site-*` robots no live row owns, flags unknown names. */
export async function sweepRegistry(now = new Date()): Promise<SweepResult> {
  const result: SweepResult = { pendingSwept: 0, revokingRetried: 0, orphansDeleted: 0, expiredDeleted: 0, retiredDeleted: 0, unexpected: 0, errors: 0 };
  const stale = await prisma.registryRobot.findMany({
    where: { status: "PENDING", createdAt: { lt: new Date(now.getTime() - PENDING_ROBOT_MAX_AGE_MS) } },
    select: { id: true }
  });
  if (stale.length > 0) {
    await prisma.registryRobot.updateMany({ where: { id: { in: stale.map((r) => r.id) } }, data: { status: "REVOKING" } });
    await deleteRobotRows(stale.map((r) => r.id), "pending_timeout");
    result.pendingSwept = stale.length;
  }
  const revoking = await prisma.registryRobot.findMany({ where: { status: "REVOKING" }, select: { id: true } });
  if (revoking.length > 0) {
    if ((await deleteRobotRows(revoking.map((r) => r.id), "sweeper_retry")) === "pending") result.errors += 1;
    result.revokingRetried = revoking.length;
  }
  const projects = await prisma.registryProject.findMany({ select: { id: true, name: true } });
  for (const project of projects) {
    try {
      const inHarbor = await listProjectRobots(project.name);
      // Read AFTER the Harbor list: a robot that is in the list was created after its PENDING row, so this read sees the row.
      const current = await prisma.registryProject.findUnique({ where: { id: project.id } });
      const live = await prisma.registryRobot.findMany({
        where: { registryProjectId: project.id, status: { in: ["PENDING", "ACTIVE"] } },
        select: { harborName: true }
      });
      const keep = new Set(live.map((r) => shortName(r.harborName)));
      const pendingOwner = live.some((r) => r.harborName === "pending");
      for (const robot of inHarbor) {
        const short = shortName(robot.name);
        const base = { project: project.name, harborName: robot.name, harborRobotId: robot.id };
        // Harbor keeps expired robots listed forever. They cannot authenticate, so deleting them is hygiene, never an outage.
        if (robot.expiresAt && robot.expiresAt.getTime() < now.getTime()) {
          await deleteRobot(robot.id);
          await prisma.registryRobot.updateMany({
            where: { registryProjectId: project.id, harborName: robot.name, status: { in: ["ACTIVE", "REVOKING"] } },
            data: { status: "DELETED", deletedAt: now, lastError: "expired" }
          });
          result.expiredDeleted += 1;
          await safeAudit({}, "registry.robot.expired_swept", "RegistryProject", project.name, { ...base, expiresAt: robot.expiresAt.toISOString() });
          continue;
        }
        // A retired study keeps no credential at all: aggregator (agg-) and push robots go too, which archive may have failed to delete.
        if (current?.status === "RETIRED" && (short.startsWith("agg-") || short.startsWith("push-") || short.startsWith("site-"))) {
          await deleteRobot(robot.id);
          result.retiredDeleted += 1;
          await safeAudit({}, "registry.robot.orphan_swept", "RegistryProject", project.name, { ...base, reason: "project_retired" });
          continue;
        }
        if (short.startsWith("site-")) {
          if (keep.has(short)) continue;
          // A PENDING row stores "pending" as its name until Harbor answers; its robot is judged by age, not here.
          if (pendingOwner) continue;
          await deleteRobot(robot.id);
          result.orphansDeleted += 1;
          await safeAudit({}, "registry.robot.orphan_swept", "RegistryProject", project.name, { ...base, purpose: "SITE_PULL", reason: "no_live_record" });
        } else if (!short.startsWith("push-") && !short.startsWith("agg-")) {
          result.unexpected += 1;
          await safeAudit({}, "registry.robot.unexpected", "RegistryProject", project.name, base);
        }
      }
    } catch {
      result.errors += 1;
    }
  }
  return result;
}
