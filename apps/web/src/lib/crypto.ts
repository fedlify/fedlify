import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacSha256(secret: string, value: string | Buffer): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function verifyHmacSignature(secret: string, body: string, signature: string | null): boolean {
  if (!signature || !secret) return false;
  const expected = hmacSha256(secret, body);
  const cleanSignature = signature.replace(/^sha256=/, "");
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(cleanSignature, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  const salt = process.env.NEXTAUTH_SECRET ?? "fedlify-dev";
  return hmacSha256(salt, ip);
}

/** Constant-time comparison of two strings (compared as UTF-8 bytes; unequal lengths are simply unequal). */
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
