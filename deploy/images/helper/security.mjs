// Request-hardening rules for the Fedlify site helper. Pure functions, no I/O, so tests/helper-app.test.ts can drive them.
// Threat: a service on 127.0.0.1 is reachable from any web page the user visits (cross-site requests) and, through DNS
// rebinding, a hostile name that resolves to 127.0.0.1 can read it. Defences, all required:
//   1. Host header must be exactly a loopback literal (or localhost) with the published port. Rebinding sends the
//      attacker's own name in Host, so it is refused before anything else.
//   2. A session cookie (HttpOnly, SameSite=Strict) obtained by exchanging a one-time link token. A cross-site request does not carry it.
//   3. State-changing requests need an Origin header equal to our own origin, a JSON content type and a custom header.
//   4. Non-loopback bind is refused unless explicitly overridden (and then a warning is printed).
import { randomBytes, timingSafeEqual } from "node:crypto";

/** The only commands a browser can ask the host-side bridge to run. The bridge re-validates this same list on the host. */
export const ALLOWED_COMMANDS = Object.freeze(["preflight", "status", "start", "stop", "update", "logout", "support-bundle", "support-bundle-logs"]);
export const REQUEST_ID = /^[a-f0-9]{16}$/;
export const BUNDLE_NAME = /^fedlify-support-[0-9]{8}T[0-9]{6}Z\.tar\.gz$/;
export const MIN_CELL = 10;

export function isAllowedCommand(name) {
  return typeof name === "string" && ALLOWED_COMMANDS.includes(name);
}

export function allowedHosts(publicPort) {
  const p = String(publicPort);
  return new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]);
}

export function checkHost(hostHeader, publicPort) {
  return typeof hostHeader === "string" && allowedHosts(publicPort).has(hostHeader.toLowerCase());
}

export function allowedOrigins(publicPort) {
  return new Set([...allowedHosts(publicPort)].map((h) => `http://${h}`));
}

export function checkOrigin(originHeader, publicPort) {
  return typeof originHeader === "string" && allowedOrigins(publicPort).has(originHeader.toLowerCase());
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Decide whether the server may listen on `address`. Loopback always. Anything else only inside our container (where the
 * compose file publishes the port on 127.0.0.1 only) or with an explicit override, which returns a warning to print.
 */
export function checkBindAddress(address, env = {}) {
  if (LOOPBACK.has(address)) return { ok: true };
  if (env.FEDLIFY_HELPER_ALLOW_REMOTE === "1") {
    return { ok: true, warning: `WARNING: listening on ${address}. Anyone who can reach this port can try the one-time link. Use only on a network you control.` };
  }
  if (env.FEDLIFY_HELPER_CONTAINER === "1") return { ok: true };
  return { ok: false, reason: `refusing to listen on ${address}: only loopback is allowed (set FEDLIFY_HELPER_ALLOW_REMOTE=1 to override at your own risk)` };
}

export function newToken(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

export function tokenEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Small-cell suppression: counts under MIN_CELL are shown as "<10". Zero stays zero (it identifies nobody). */
export function suppress(n) {
  return n > 0 && n < MIN_CELL ? `<${MIN_CELL}` : n;
}

export const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
});
