import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const updateMany = vi.fn();
const studySiteUpdate = vi.fn();
const statusCreate = vi.fn();

vi.mock("@/lib/prisma", () => {
  const tx = {
    site: { updateMany: (...a: unknown[]) => updateMany(...a) },
    studySite: { update: (...a: unknown[]) => studySiteUpdate(...a) },
    nvflareSiteStatus: { create: (...a: unknown[]) => statusCreate(...a) }
  };
  return { prisma: { site: { findMany: (...a: unknown[]) => findMany(...a) }, $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } };
});

import { isHeartbeatStale, markStaleSitesOffline, OFFLINE_AFTER_MS, sanitizeHeartbeatMetadata } from "@/lib/site-presence";

const now = Date.parse("2026-11-04T12:00:00Z");
const ago = (ms: number) => new Date(now - ms);

describe("offline rule", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is three 30 s beats", () => {
    expect(OFFLINE_AFTER_MS).toBe(90_000);
    expect(isHeartbeatStale(ago(89_000), now)).toBe(false);
    expect(isHeartbeatStale(ago(91_000), now)).toBe(true);
    expect(isHeartbeatStale(null, now)).toBe(false);
  });

  it("marks only silent live sites offline, with an observed-status row", async () => {
    findMany.mockResolvedValue([
      { id: "stale", nvflareClientName: "site_1", studySite: { id: "ss1" }, heartbeats: [{ createdAt: ago(200_000) }] },
      { id: "fresh", nvflareClientName: "site_2", studySite: { id: "ss2" }, heartbeats: [{ createdAt: ago(10_000) }] },
      { id: "never", nvflareClientName: "site_3", studySite: null, heartbeats: [] }
    ]);
    updateMany.mockResolvedValue({ count: 1 });
    expect(await markStaleSitesOffline("study", now)).toEqual(["stale"]);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(studySiteUpdate).toHaveBeenCalledWith({ where: { id: "ss1" }, data: { participationStatus: "OFFLINE" } });
    expect(statusCreate.mock.calls[0][0].data).toMatchObject({ siteId: "stale", status: "OFFLINE" });
    expect(updateMany.mock.calls[0][0].where.heartbeats.none.createdAt.gt).toEqual(new Date(now - OFFLINE_AFTER_MS));
    expect(findMany.mock.calls[0][0].where.status.in).toEqual(["CONNECTED", "DEGRADED"]);
  });

  it("does nothing when another reader already flipped the site", async () => {
    findMany.mockResolvedValue([{ id: "s", nvflareClientName: "c", studySite: { id: "ss" }, heartbeats: [{ createdAt: ago(500_000) }] }]);
    updateMany.mockResolvedValue({ count: 0 });
    expect(await markStaleSitesOffline("study", now)).toEqual([]);
    expect(statusCreate).not.toHaveBeenCalled();
  });

  it("never throws into the page that asked", async () => {
    findMany.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await markStaleSitesOffline("study", now)).toEqual([]);
  });
});

describe("heartbeat metadata allowlist", () => {
  it("keeps known scalar keys and drops everything else", () => {
    expect(
      sanitizeHeartbeatMetadata({ container: "running", csvCount: 3, dataDirPresent: true, rows: [{ age: 70 }], path: "/data/x.csv", nested: { a: 1 }, diskFreeGb: Number.NaN })
    ).toEqual({ container: "running", csvCount: 3, dataDirPresent: true });
    expect(sanitizeHeartbeatMetadata({ anything: "else" })).toBeUndefined();
    expect(sanitizeHeartbeatMetadata(undefined)).toBeUndefined();
    expect((sanitizeHeartbeatMetadata({ health: "x".repeat(900) }) as { health: string }).health).toHaveLength(200);
  });
});

describe("isSitePresent", () => {
  it("needs both the aggregator listing and a recent heartbeat", async () => {
    const { isSitePresent, OFFLINE_AFTER_MS } = await import("@/lib/site-presence");
    const now = 1_000_000_000;
    expect(isSitePresent(true, new Date(now - 1000), now)).toBe(true);
    expect(isSitePresent(true, new Date(now - OFFLINE_AFTER_MS - 1), now)).toBe(false);
    expect(isSitePresent(false, new Date(now - 1000), now)).toBe(false);
    expect(isSitePresent(true, null, now)).toBe(false);
  });
});
