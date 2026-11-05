/**
 * Path handling for the read-only code view. A requested path is only ever used as a lookup key into the file list of
 * the run's commit, and it is also rejected here if it could escape a repository (traversal, absolute, NUL, backslash).
 */
export function isSafeRepoPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) return false;
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return false;
  const parts = decoded.split("/");
  return !parts.some((part) => part === ".." || part === "." || part === "" || part === ".git");
}

/** A git object name for a commit: 7 to 64 hex characters. Anything else is never sent to Gitea. */
export function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value);
}
