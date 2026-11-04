export type KitState = "NOT_RELEASED" | "RELEASED" | "OUTDATED";

/** Kit state for the Sites table: no active kit, a kit built from the aggregator's current image, or one whose digest differs. */
export function kitState(kit: { imageDigest: string | null } | null | undefined, aggregatorDigest: string | null | undefined): KitState {
  if (!kit) return "NOT_RELEASED";
  if (kit.imageDigest && aggregatorDigest && kit.imageDigest !== aggregatorDigest) return "OUTDATED";
  return "RELEASED";
}

export type SiteOverviewRow = {
  studySiteId: string;
  code: string;
  name: string;
  institutionName: string;
  readiness: string;
  kitState: KitState;
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
