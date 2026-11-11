import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time check of "Authorization: Bearer <token>". Both sides are hashed so length never leaks. */
export function bearerAuthorized(header: string | undefined, token: string | undefined): boolean {
  if (!token || !header) return false;
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(`Bearer ${token}`).digest();
  return timingSafeEqual(a, b);
}
