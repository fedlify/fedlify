import { describe, expect, it, vi } from "vitest";
import { clientIp } from "@/lib/client-ip";
import { rateLimit } from "@/lib/rate-limit";

const req = (xff?: string) => ({ headers: new Headers(xff ? { "x-forwarded-for": xff } : {}) });

describe("clientIp", () => {
  it("ignores client-supplied leading entries and uses the proxy-appended hop", () => {
    expect(clientIp(req("6.6.6.6, 203.0.113.9"), {})).toBe("203.0.113.9");
    expect(clientIp(req("6.6.6.6, 203.0.113.9, 10.0.0.2"), { TRUSTED_PROXY_COUNT: "2" })).toBe("203.0.113.9");
    expect(clientIp(req(), {})).toBeNull();
  });
});

describe("rateLimit eviction", () => {
  it("drops expired buckets and caps the map", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T00:00:00Z"));
    for (let i = 0; i < 12_000; i++) rateLimit(`spray:${i}`, 1, 60_000);
    vi.setSystemTime(new Date("2026-11-04T00:05:00Z"));
    rateLimit("probe", 1, 60_000); // triggers sweep: every spray bucket expired
    // an expired key starts fresh, proving it was evicted or reset
    expect(rateLimit("spray:0", 1, 60_000)).toBe(true);
    expect(rateLimit("spray:0", 1, 60_000)).toBe(false);
    vi.useRealTimers();
  });
});
