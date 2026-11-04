import type { NextRequest } from "next/server";

/**
 * Client IP for logging and hashing only (never as a rate-limit key). Proxies append to x-forwarded-for, so the first
 * entry is client-controlled. We count from the right: TRUSTED_PROXY_COUNT hops (default 1) are ours, the entry before
 * them is the address our outermost proxy saw.
 */
export function clientIp(request: Pick<NextRequest, "headers">, env: Record<string, string | undefined> = process.env): string | null {
  const parsed = Number.parseInt(env.TRUSTED_PROXY_COUNT ?? "1", 10);
  const trusted = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
  const hops = (request.headers.get("x-forwarded-for") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (hops.length) return hops[Math.max(0, hops.length - trusted)] ?? null;
  return request.headers.get("x-real-ip");
}
