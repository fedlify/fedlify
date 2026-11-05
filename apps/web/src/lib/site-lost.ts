import { isHeartbeatStale } from "@/lib/site-presence";

/**
 * Site-lost detection for a RUNNING run. Pure: reconcile gathers the signals (stored heartbeats, the aggregator's client
 * list) and persists the result; nothing here reads a clock or a database.
 *
 * States, from strongest to weakest evidence:
 *  - down:          the runner reported OFFLINE (its client container is not running), or its heartbeats stopped AND the
 *                   aggregator no longer lists the client. Only "down" can run the abort clock.
 *  - silent:        heartbeats stopped but the aggregator still lists the client. Often just the heartbeat agent dying
 *                   after a host reboot while the container keeps training, so it warns and never aborts.
 *  - not_connected: heartbeats are fine but the aggregator does not list the client (network flap, client restarting).
 *                   Warns only; NVFLARE applies its own min-clients rule.
 */
export type SiteLostState = "down" | "silent" | "not_connected";

export type SiteSignal = {
  code: string;
  clientName: string;
  listedByAggregator: boolean;
  lastHeartbeatAt: Date | null;
  lastHeartbeatStatus: string | null;
};

export type LostSiteEntry = { code: string; clientName: string; state: SiteLostState; reason: string; since: string };

export function classifySite(signal: SiteSignal, now: number): { state: SiteLostState; reason: string } | null {
  const reportedOffline = signal.lastHeartbeatStatus === "OFFLINE";
  const silent = !signal.lastHeartbeatAt || isHeartbeatStale(signal.lastHeartbeatAt, now);
  if (reportedOffline) return { state: "down", reason: "its runner reported OFFLINE (the client container is not running)" };
  if (silent && !signal.listedByAggregator) return { state: "down", reason: "it stopped sending heartbeats and is no longer connected to the aggregator" };
  if (silent) return { state: "silent", reason: "it stopped sending heartbeats, but the aggregator still lists it" };
  if (!signal.listedByAggregator) return { state: "not_connected", reason: "the aggregator does not list it as connected" };
  return null;
}

export type SiteLostDecision = {
  /** Entries to persist (empty = no episode). Each carries when its current state began. */
  entries: LostSiteEntry[];
  /** True when there were stored entries, so a recovery event is due. */
  recovered: boolean;
  /** Codes that newly entered the episode; an event is due for them. */
  newlyAffected: string[];
  /** Sites that have been continuously "down" for the whole timeout. Non-empty means abort. */
  abortFor: LostSiteEntry[];
};

/**
 * Applies the rules on top of the stored episode.
 * - Continuity: stored entries count only if the last evaluation that saw a problem was at most `maxGapMs` ago. After a
 *   longer gap (nobody looked, the aggregator was unreadable) the clock restarts, so a stale record can never abort a run.
 * - A site's clock restarts whenever its state changes class (down vs not down).
 * - Abort needs a site that was "down" at every evaluation across `timeoutMs`; one observation never aborts.
 */
export function decideSiteLost(input: {
  signals: SiteSignal[];
  previous: { entries: LostSiteEntry[]; seenAt: Date | null } | null;
  now: number;
  timeoutMs: number;
  maxGapMs: number;
}): SiteLostDecision {
  const { now } = input;
  const continuous = Boolean(input.previous?.seenAt && now - input.previous.seenAt.getTime() <= input.maxGapMs);
  const before = new Map((continuous ? input.previous!.entries : []).map((entry) => [entry.code, entry]));
  const entries: LostSiteEntry[] = [];
  for (const signal of input.signals) {
    const verdict = classifySite(signal, now);
    if (!verdict) continue;
    const prior = before.get(signal.code);
    const sameClass = prior && (prior.state === "down") === (verdict.state === "down");
    entries.push({ code: signal.code, clientName: signal.clientName, state: verdict.state, reason: verdict.reason, since: sameClass ? prior.since : new Date(now).toISOString() });
  }
  const hadEpisode = Boolean(input.previous && input.previous.entries.length > 0);
  return {
    entries,
    recovered: hadEpisode && entries.length === 0,
    newlyAffected: entries.filter((entry) => !before.has(entry.code)).map((entry) => entry.code),
    abortFor: continuous ? entries.filter((entry) => entry.state === "down" && now - new Date(entry.since).getTime() >= input.timeoutMs) : []
  };
}

export function siteLostReason(entries: LostSiteEntry[], timeoutMs: number): string {
  const minutes = Math.round(timeoutMs / 60_000);
  const list = entries.map((entry) => `${entry.clientName} (${entry.reason})`).join("; ");
  return `Run ended: ${entries.length === 1 ? "a participating site was" : "participating sites were"} lost for more than ${minutes} minute(s) and Fedlify aborted the run. Lost: ${list}.`;
}

/** FEDLIFY_SITE_LOST_TIMEOUT_MS: how long a site must stay down before the run is aborted. Default 10 minutes, minimum 1 minute. */
export function siteLostTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.FEDLIFY_SITE_LOST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 600_000;
}

/** FEDLIFY_SITE_LOST_MAX_GAP_MS: the longest silence between evaluations that still counts as continuous. Default 5 minutes. */
export function siteLostMaxGapMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.FEDLIFY_SITE_LOST_MAX_GAP_MS);
  return Number.isFinite(raw) && raw >= 30_000 ? raw : 300_000;
}
