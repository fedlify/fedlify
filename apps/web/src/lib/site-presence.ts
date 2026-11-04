import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** The site runner beats every 30 s. A site that misses three beats in a row is OFFLINE. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const MISSED_BEATS_BEFORE_OFFLINE = 3;
export const OFFLINE_AFTER_MS = HEARTBEAT_INTERVAL_MS * MISSED_BEATS_BEFORE_OFFLINE;

/** Statuses that claim the site is live. Only these can be downgraded by silence. */
const LIVE_STATUSES = ["CONNECTED", "DEGRADED"] as const;

export function isLiveStatus(status: string): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(status);
}

/** True when a site that claims to be live has not been heard from for three beat intervals. */
/**
 * The aggregator keeps a stopped client in its list until its own timeout (several minutes), so "connected" needs
 * both: the aggregator lists the client and the site's runner has reported recently.
 */
export function isSitePresent(listedByAggregator: boolean, lastHeartbeatAt: Date | string | null | undefined, now = Date.now()): boolean {
  return listedByAggregator && lastHeartbeatAt != null && !isHeartbeatStale(lastHeartbeatAt, now);
}

export function isHeartbeatStale(lastHeartbeatAt: Date | string | null | undefined, now = Date.now()): boolean {
  if (!lastHeartbeatAt) return false; // never beat: nothing to downgrade
  const at = new Date(lastHeartbeatAt).getTime();
  if (Number.isNaN(at)) return false;
  return now - at > OFFLINE_AFTER_MS;
}

/** Metadata keys a runner may report. Everything else is dropped; values must be scalars. Never row-level data. */
const METADATA_KEYS = new Set([
  "runner",
  "imageDigest",
  "container",
  "health",
  "restarts",
  "dataDirPresent",
  "csvCount",
  "diskFreeGb",
  "gpuCount",
  "agent"
]);
const MAX_METADATA_STRING = 200;

export function sanitizeHeartbeatMetadata(metadata: Record<string, unknown> | undefined): Prisma.InputJsonObject | undefined {
  if (!metadata) return undefined;
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!METADATA_KEYS.has(key)) continue;
    if (typeof value === "string") clean[key] = value.slice(0, MAX_METADATA_STRING);
    else if (typeof value === "boolean") clean[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
  }
  return Object.keys(clean).length ? clean : undefined;
}

/**
 * Lazy OFFLINE rule, called before reading site status. Any site of the study that claims CONNECTED/DEGRADED but whose
 * latest heartbeat is older than three beat intervals is moved to OFFLINE, with an observed-status row so every page
 * that reads the latest status sees it. The compare-and-set on status makes it safe under concurrent readers.
 * Returns the ids it marked. Never throws: a failure here must not break the page that asked.
 */
export async function markStaleSitesOffline(studyId: string, now = Date.now()): Promise<string[]> {
  try {
    const candidates = await prisma.site.findMany({
      where: { studyId, status: { in: [...LIVE_STATUSES] } },
      select: {
        id: true,
        nvflareClientName: true,
        studySite: { select: { id: true } },
        heartbeats: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } }
      }
    });
    const marked: string[] = [];
    for (const site of candidates) {
      if (!isHeartbeatStale(site.heartbeats[0]?.createdAt, now)) continue;
      const changed = await prisma.$transaction(async (tx) => {
        // The staleness predicate is part of the compare-and-set: a beat that landed after the read keeps the site live.
        const result = await tx.site.updateMany({
          where: {
            id: site.id,
            status: { in: [...LIVE_STATUSES] },
            heartbeats: { none: { createdAt: { gt: new Date(now - OFFLINE_AFTER_MS) } } }
          },
          data: { status: "OFFLINE" }
        });
        if (result.count === 0) return false;
        if (site.studySite) {
          await tx.studySite.update({ where: { id: site.studySite.id }, data: { participationStatus: "OFFLINE" } });
          await tx.nvflareSiteStatus.create({
            data: {
              studySiteId: site.studySite.id,
              siteId: site.id,
              nvflareClientName: site.nvflareClientName,
              status: "OFFLINE",
              details: { reason: "missed_heartbeats", missedBeats: MISSED_BEATS_BEFORE_OFFLINE }
            }
          });
        }
        return true;
      });
      if (changed) marked.push(site.id);
    }
    return marked;
  } catch (error) {
    console.warn("offline rule: could not reconcile site status", error instanceof Error ? error.message : error);
    return [];
  }
}
