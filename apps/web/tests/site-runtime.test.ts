import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { summarizeSiteRuntime } from "@/lib/site-runtime";

const now = Date.parse("2026-11-10T12:00:00Z");
const sha = (c: string) => `harbor.example/x/y@sha256:${c.repeat(64)}`;
const base = {
  code: "ha",
  clientName: "site-ha",
  deployment: { status: "ACTIVE", hostname: "h.fedlify.com", imageDigest: sha("a") },
  liveVersion: { id: "v", version: "v1", gitCommit: "abc" },
  activeKit: { imageDigest: sha("a"), expiresAt: "2026-11-12T00:00:00Z" },
  heartbeat: { createdAt: "2026-11-10T11:59:50Z", metadata: { imageDigest: sha("a"), csvCount: 1, container: "running" } },
  listedByAggregator: true,
  now
};
const status = (r: ReturnType<typeof summarizeSiteRuntime>, key: string) => r.stages.find((s) => s.key === key)!;

describe("summarizeSiteRuntime", () => {
  it("is all green with no next step when the site is up to date and connected", () => {
    const r = summarizeSiteRuntime(base);
    expect(r.connected).toBe(true);
    expect(r.nextStep).toBeNull();
    expect(r.stages.every((s) => s.tone === "ok")).toBe(true);
  });
  it("names a silent runner as the cause even though the aggregator still lists the client", () => {
    const r = summarizeSiteRuntime({ ...base, heartbeat: { ...base.heartbeat, createdAt: "2026-11-10T05:00:00Z" } });
    expect(r.connected).toBe(false);
    expect(status(r, "runner")).toMatchObject({ tone: "error" });
    expect(r.nextStep).toContain("fedlify-runner.sh start");
  });
  it("flags missing data files", () => {
    const r = summarizeSiteRuntime({ ...base, heartbeat: { ...base.heartbeat, metadata: { imageDigest: sha("a"), csvCount: 0 } } });
    expect(status(r, "runner").status).toContain("no data");
    expect(r.nextStep).toContain("data");
  });
  it("asks for update when the site runs an older image", () => {
    const r = summarizeSiteRuntime({ ...base, heartbeat: { ...base.heartbeat, metadata: { imageDigest: sha("b"), csvCount: 1 } } });
    expect(r.imageState).toBe("OUTDATED");
    expect(r.nextStep).toContain("update");
    expect(r.imageFix.length).toBeGreaterThan(0);
  });
  it("asks for a kit first, and stays neutral when nothing is published", () => {
    expect(summarizeSiteRuntime({ ...base, activeKit: null, heartbeat: null }).nextStep).toContain("startup kit");
    const r = summarizeSiteRuntime({ ...base, deployment: null, liveVersion: null, listedByAggregator: null, heartbeat: null, activeKit: null });
    expect(r.connected).toBeNull();
    expect(r.nextStep).toBeNull();
    expect(status(r, "connection").status).toBe("Nothing published");
  });
});
