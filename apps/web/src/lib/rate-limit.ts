const buckets = new Map<string, { count: number; resetAt: number }>();
const MAX_BUCKETS = 10_000;
const SWEEP_EVERY_MS = 30_000;
let lastSweep = 0;

/** Drop expired buckets, then, if still over the cap, the oldest ones. Keeps memory bounded under key-spraying. */
function evict(now: number) {
  if (now - lastSweep < SWEEP_EVERY_MS && buckets.size <= MAX_BUCKETS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  for (const key of buckets.keys()) {
    if (buckets.size <= MAX_BUCKETS) break;
    buckets.delete(key); // Map iterates in insertion order: oldest first
  }
}

/** With `consume: false` the call only checks whether the key is still under its limit. */
export function rateLimit(key: string, limit: number, windowMs: number, options: { consume?: boolean } = {}): boolean {
  const now = Date.now();
  evict(now);
  const consume = options.consume !== false;
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    if (consume) buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= limit) return false;
  if (consume) current.count += 1;
  return true;
}

/** Give back one unit of budget taken by a consuming `rateLimit` call (e.g. an attempt that turned out to be legitimate). */
/** Tests only: forget every counter. */
export function __resetRateLimitsForTests(): void {
  buckets.clear();
}

export function refundRateLimit(key: string): void {
  const current = buckets.get(key);
  if (!current) return;
  current.count -= 1;
  if (current.count <= 0) buckets.delete(key);
}

const slots = new Map<string, number>();

/** Per-process concurrency cap. Returns a release function, or null when `max` are already in flight. */
export function acquireSlot(key: string, max: number): (() => void) | null {
  const current = slots.get(key) ?? 0;
  if (current >= max) return null;
  slots.set(key, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (slots.get(key) ?? 1) - 1;
    if (next <= 0) slots.delete(key);
    else slots.set(key, next);
  };
}
