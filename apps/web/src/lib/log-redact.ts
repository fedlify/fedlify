// Secret masking and size cap for run logs. Shared by the capture at run end and the logs route.
const SECRET_KEY = "(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]{0,64}"; // no leading scan: a prefix like HARBOR_ stays visible, and matching stays linear on long word runs
// A value is a quoted string (spaces allowed), or the rest of the token. A quoted/JSON key ("password": "x") is covered too.
const SECRET_VALUE = `(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|\\S+)`;
const LOG_SECRET = new RegExp(
  [
    "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----",
    "Authorization[\"']?\\s*[:=]\\s*(?:Basic|Bearer|Token|Digest|Negotiate)\\s+\\S+",
    "(?:Basic|Bearer)\\s+[A-Za-z0-9._~+/=-]{8,}",
    "X-Amz-(?:Signature|Credential)=[^&\\s]+",
    ":\\/\\/[^/\\s:@]+:[^/\\s@]+@",
    `["']?${SECRET_KEY}["']?\\s*[=:]\\s*${SECRET_VALUE}`
  ].join("|"),
  "gi"
);
export const LOG_MAX_BYTES = 200_000;

/** Masks secret-looking text, then caps the size in bytes. Redaction runs first so a secret cut by the cap is still matched. */
export function redactLogText(text: string): { text: string; truncated: boolean } {
  const redacted = text.replace(LOG_SECRET, "[redacted]");
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.byteLength <= LOG_MAX_BYTES) return { text: redacted, truncated: false };
  return { text: bytes.subarray(bytes.byteLength - LOG_MAX_BYTES).toString("utf8").replace(/^\uFFFD+/, ""), truncated: true };
}
