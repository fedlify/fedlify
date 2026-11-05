import { type SiteImageState, updateNeedsNewKit } from "@/lib/site-image";

export type KitState = "NOT_RELEASED" | "RELEASED" | "OUTDATED";

/**
 * Kit state for the Sites table: no active kit, a usable kit, or one that must be replaced. A kit is OUTDATED only when
 * the study image moved to a registry location its credential cannot reach. A code-only publish keeps the path and needs
 * no new kit (the site runs `update`); whether the site runs the current image is the separate imageState.
 */
export function kitState(kit: { imageDigest: string | null } | null | undefined, aggregatorDigest: string | null | undefined): KitState {
  if (!kit) return "NOT_RELEASED";
  if (updateNeedsNewKit(kit.imageDigest, aggregatorDigest)) return "OUTDATED";
  return "RELEASED";
}

export type SiteOverviewRow = {
  studySiteId: string;
  code: string;
  name: string;
  institutionName: string;
  readiness: string;
  kitState: KitState;
  /** What the site's runner last reported against the published image. UNKNOWN = nothing published to compare with. */
  imageState: SiteImageState;
  /** Steps to fix an OUTDATED or NOT_REPORTED site; empty otherwise. */
  imageFix: string[];
  connection: string;
  lastHeartbeatAt: string | null;
};

export function formatHeartbeat(value: string | null, now = Date.now()): string {
  if (!value) return "Never";
  const seconds = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}
