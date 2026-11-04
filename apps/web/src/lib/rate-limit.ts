const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
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
