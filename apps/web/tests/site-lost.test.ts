import { describe, expect, it } from "vitest";
import { classifySite, decideSiteLost, type LostSiteEntry, type SiteSignal, siteLostMaxGapMs, siteLostTimeoutMs } from "@/lib/site-lost";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const MIN = 60_000;
const fresh = new Date(NOW - 10_000);
const old = new Date(NOW - 10 * MIN);
const sig = (over: Partial<SiteSignal> = {}): SiteSignal => ({ code: "A", clientName: "site-A", listedByAggregator: true, lastHeartbeatAt: fresh, lastHeartbeatStatus: "CONNECTED", ...over });
const decide = (signals: SiteSignal[], previous: { entries: LostSiteEntry[]; seenAt: Date | null } | null, over = {}) =>
  decideSiteLost({ signals, previous, now: NOW, timeoutMs: 10 * MIN, maxGapMs: 5 * MIN, ...over });
const entry = (over: Partial<LostSiteEntry> = {}): LostSiteEntry => ({ code: "A", clientName: "site-A", state: "down", reason: "r", since: new Date(NOW - 11 * MIN).toISOString(), ...over });

describe("classifySite", () => {
  it("is healthy with a fresh heartbeat and an aggregator listing", () => {
    expect(classifySite(sig(), NOW)).toBeNull();
  });
  it("is down when the runner reported OFFLINE, even while the aggregator still lists the client", () => {
    expect(classifySite(sig({ lastHeartbeatStatus: "OFFLINE" }), NOW)?.state).toBe("down");
  });
  it("is down only when heartbeats are stale AND the aggregator no longer lists it", () => {
    expect(classifySite(sig({ lastHeartbeatAt: old, listedByAggregator: false }), NOW)?.state).toBe("down");
    expect(classifySite(sig({ lastHeartbeatAt: null, listedByAggregator: false }), NOW)?.state).toBe("down");
  });
  it("only warns when the heartbeat agent is silent but the aggregator lists the client (a dead agent is not a dead site)", () => {
    expect(classifySite(sig({ lastHeartbeatAt: old }), NOW)?.state).toBe("silent");
  });
  it("only warns when heartbeats are fine but the aggregator does not list it", () => {
    expect(classifySite(sig({ listedByAggregator: false }), NOW)?.state).toBe("not_connected");
  });
});

describe("decideSiteLost", () => {
  it("never aborts on a first observation: warns and starts the clock", () => {
    const decision = decide([sig({ lastHeartbeatStatus: "OFFLINE" })], null);
    expect(decision.entries).toHaveLength(1);
    expect(decision.newlyAffected).toEqual(["A"]);
    expect(decision.abortFor).toEqual([]);
  });
  it("does not abort a site that has been down for less than the timeout", () => {
    const previous = { entries: [entry({ since: new Date(NOW - 3 * MIN).toISOString() })], seenAt: new Date(NOW - 30_000) };
    const decision = decide([sig({ lastHeartbeatStatus: "OFFLINE" })], previous);
    expect(decision.abortFor).toEqual([]);
    expect(decision.newlyAffected).toEqual([]);
  });
  it("aborts a site that stayed down across the whole timeout with continuous observation", () => {
    const previous = { entries: [entry()], seenAt: new Date(NOW - 30_000) };
    const decision = decide([sig({ lastHeartbeatStatus: "OFFLINE" })], previous);
    expect(decision.abortFor.map((e) => e.code)).toEqual(["A"]);
  });
  it("restarts the clock after a gap in observation instead of aborting on stale state", () => {
    const previous = { entries: [entry()], seenAt: new Date(NOW - 30 * MIN) };
    const decision = decide([sig({ lastHeartbeatStatus: "OFFLINE" })], previous);
    expect(decision.abortFor).toEqual([]);
    expect(new Date(decision.entries[0].since).getTime()).toBe(NOW);
  });
  it("never aborts for warn-only states, however long they last", () => {
    const previous = { entries: [entry({ state: "silent" }), entry({ code: "B", clientName: "site-B", state: "not_connected" })], seenAt: new Date(NOW - 30_000) };
    const decision = decide([sig({ lastHeartbeatAt: old }), sig({ code: "B", clientName: "site-B", listedByAggregator: false })], previous);
    expect(decision.entries.map((e) => e.state)).toEqual(["silent", "not_connected"]);
    expect(decision.abortFor).toEqual([]);
  });
  it("restarts a site's clock when its state class changes (silent -> down)", () => {
    const previous = { entries: [entry({ state: "silent" })], seenAt: new Date(NOW - 30_000) };
    const decision = decide([sig({ lastHeartbeatStatus: "OFFLINE" })], previous);
    expect(decision.abortFor).toEqual([]);
    expect(new Date(decision.entries[0].since).getTime()).toBe(NOW);
  });
  it("reports recovery once, and clears the episode", () => {
    const previous = { entries: [entry()], seenAt: new Date(NOW - 30_000) };
    const decision = decide([sig()], previous);
    expect(decision).toMatchObject({ entries: [], recovered: true, abortFor: [] });
    expect(decide([sig()], null).recovered).toBe(false);
  });
  it("timeout and gap are configurable with safe floors", () => {
    expect(siteLostTimeoutMs({ FEDLIFY_SITE_LOST_TIMEOUT_MS: "120000" } as never)).toBe(120_000);
    expect(siteLostTimeoutMs({ FEDLIFY_SITE_LOST_TIMEOUT_MS: "5" } as never)).toBe(600_000);
    expect(siteLostTimeoutMs({} as never)).toBe(600_000);
    expect(siteLostMaxGapMs({ FEDLIFY_SITE_LOST_MAX_GAP_MS: "90000" } as never)).toBe(90_000);
  });
});
