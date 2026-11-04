/**
 * Server side of "Bring your own code". Everything here treats the imported repository as hostile text:
 *
 *  - the URL is parsed, not requested, until it passes: https only, no credentials, standard port, a host on the
 *    allowlist (github.com, and this deployment's Gitea) and never an IP literal;
 *  - the archive is fetched with a connection that re-checks every resolved address against private and reserved
 *    ranges (so a DNS answer cannot point the server at its own network), refuses redirects, and stops at a size cap;
 *  - the zip is read without extracting to disk: entry names are checked for zip-slip, symlinks are dropped, and every
 *    entry is inflated through a counting stream that stops at the per-file and total limits (zip bombs);
 *  - data-like paths are dropped, files with credentials make the import fail, and no file is ever executed,
 *    imported or interpreted. Contents are only read as strings.
 *
 * Findings name paths, never the text that matched.
 */

import { createHash } from "node:crypto";
import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import { isProhibitedDataPath } from "@/lib/data-paths";
import { alignmentReport, IMPORT_LIMITS, isZipJunk, safeImportPath, stripCommonRoot, type AlignmentReport, type RepoFile } from "@/lib/pipeline-start";
import { fileHasSecret, isDataLikePath } from "@/lib/repo-checks";

export class ImportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly paths: string[] = []
  ) {
    super(message);
    this.name = "ImportError";
  }
}

// ---- URL ----------------------------------------------------------------------------------------------------------

export type ImportSource =
  | { kind: "github"; owner: string; repo: string; ref: string | null; url: string; archiveUrl: string }
  | { kind: "gitea"; owner: string; repo: string; ref: string | null; url: string };

const NAME_PART = /^[A-Za-z0-9_.-]{1,100}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** A ref that is safe to put in a URL path and to hand to Git hosts. */
export function isSafeRef(ref: string): boolean {
  return REF.test(ref) && !ref.includes("..") && !ref.includes("//") && !ref.endsWith("/") && !ref.endsWith(".lock");
}

/**
 * Check a user-supplied repository URL and say where the code would come from. `giteaHost` is the host of this
 * deployment's Gitea (null when it is not configured). Nothing is requested here.
 */
export function parseImportUrl(input: string, ref: string | null | undefined, giteaHost: string | null): ImportSource {
  const text = input.trim();
  if (text.length === 0 || text.length > 300 || /[\s\u0000-\u001f\\]/.test(text)) throw new ImportError("That is not a valid repository URL.", 400, "invalid_url");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ImportError("That is not a valid repository URL.", 400, "invalid_url");
  }
  if (url.protocol !== "https:") throw new ImportError("Only https:// repository URLs can be imported.", 400, "url_not_https");
  if (url.username || url.password) throw new ImportError("The URL must not contain credentials.", 400, "url_has_credentials");
  if (url.port && url.port !== "443") throw new ImportError("Only the standard https port is allowed.", 400, "url_port");
  if (url.search || url.hash) throw new ImportError("Give the repository URL without a query or fragment; use the ref field for a branch, tag or commit.", 400, "invalid_url");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (net.isIP(host) || host.startsWith("[")) throw new ImportError("IP addresses are not allowed; use the repository's host name.", 400, "url_ip_literal");
  const onGithub = host === "github.com" || host === "www.github.com";
  const onGitea = Boolean(giteaHost) && host === giteaHost!.toLowerCase();
  if (!onGithub && !onGitea) throw new ImportError("Only github.com and this platform's Git server can be imported from. Upload a zip for other hosts.", 400, "host_not_allowed");

  const segments = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  let [owner, repo, ...rest] = segments;
  let pathRef: string | null = null;
  if (rest.length >= 2 && (rest[0] === "tree" || rest[0] === "src") && rest.length === 2) pathRef = decodeURIComponent(rest[1]);
  else if (rest.length >= 3 && rest[0] === "src" && (rest[1] === "branch" || rest[1] === "tag" || rest[1] === "commit") && rest.length === 3) pathRef = decodeURIComponent(rest[2]);
  else if (rest.length > 0) throw new ImportError("Use the repository's own URL (https://host/owner/repo), optionally with the ref field.", 400, "invalid_url");
  if (!owner || !repo || !NAME_PART.test(owner) || !NAME_PART.test(repo)) throw new ImportError("The URL must look like https://host/owner/repo.", 400, "invalid_url");
  const chosen = (ref?.trim() || pathRef || null) as string | null;
  if (chosen !== null && !isSafeRef(chosen)) throw new ImportError("That ref is not allowed.", 400, "invalid_ref");

  const clean = `https://${host}/${owner}/${repo}`;
  if (onGithub) {
    const refPath = chosen ? chosen.split("/").map(encodeURIComponent).join("/") : "HEAD";
    return { kind: "github", owner, repo, ref: chosen, url: clean, archiveUrl: `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip/${refPath}` };
  }
  return { kind: "gitea", owner, repo, ref: chosen, url: clean };
}

/** Host name of a configured base URL, or null. */
export function hostOf(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// ---- addresses ----------------------------------------------------------------------------------------------------

function v4Parts(address: string): number[] | null {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function blockedV4([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function expandV6(address: string): number[] | null {
  let text = address.toLowerCase().split("%")[0];
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = v4Parts(tail[1]);
    if (!v4) return null;
    text = text.slice(0, -tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const back = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - back.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...back].map((group) => parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/** True for every address a public archive host must never resolve to (private, loopback, link-local, reserved). Unparseable input is blocked. */
export function isBlockedAddress(address: string): boolean {
  const kind = net.isIP(address);
  if (kind === 4) {
    const parts = v4Parts(address);
    return !parts || blockedV4(parts);
  }
  if (kind === 6) {
    const g = expandV6(address);
    if (!g) return true;
    const embedded = (hi: number, lo: number) => blockedV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
    if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return true; // :: and ::1
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return embedded(g[6], g[7]); // v4-mapped and v4-compatible
    if (g[0] === 0x64 && g[1] === 0xff9b) return embedded(g[6], g[7]); // NAT64
    if (g[0] === 0x2002) return embedded(g[1], g[2]); // 6to4
    if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
    return false;
  }
  return true;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;
type Resolver = (hostname: string, options: dns.LookupAllOptions, callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => void;

/** A `lookup` for https.request that fails when any resolved address is blocked, so the address checked is the address used. */
export function guardedLookup(resolver: Resolver = dns.lookup as unknown as Resolver) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
    resolver(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = addresses ?? [];
      if (list.length === 0 || list.some((entry) => isBlockedAddress(entry.address))) {
        const blocked = new Error("The host resolves to a private or reserved address.") as NodeJS.ErrnoException;
        blocked.code = "EBLOCKED";
        return callback(blocked);
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

// ---- fetch --------------------------------------------------------------------------------------------------------

const ARCHIVE_HOSTS = new Set(["codeload.github.com"]);

/**
 * Download a public archive over https. No redirects (a redirect could lead anywhere), no credentials, only hosts that
 * are archive endpoints, every connection address checked, bounded in bytes and time.
 */
export function fetchPublicArchive(archiveUrl: string, options: { maxBytes?: number; timeoutMs?: number; deadlineMs?: number; lookup?: ReturnType<typeof guardedLookup> } = {}): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? IMPORT_LIMITS.maxZipBytes;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadlineMs = options.deadlineMs ?? 30_000;
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(archiveUrl);
    } catch {
      return reject(new ImportError("Invalid archive URL.", 400, "invalid_url"));
    }
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !ARCHIVE_HOSTS.has(url.hostname)) {
      return reject(new ImportError("The archive host is not allowed.", 400, "host_not_allowed"));
    }
    // `timeout` below is only a socket idle timeout; this is the overall deadline for the whole download, so a host
    // that trickles bytes cannot hold the connection and the buffer open.
    const deadline = setTimeout(() => fail(new ImportError("The download took too long.", 504, "fetch_timeout")), deadlineMs);
    const fail = (error: ImportError) => {
      clearTimeout(deadline);
      request.destroy();
      reject(error);
    };
    const request = https.request(
      url,
      { method: "GET", headers: { accept: "application/zip", "user-agent": "fedlify-import" }, lookup: (options.lookup ?? guardedLookup()) as never, agent: false, timeout: timeoutMs },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) return fail(new ImportError("The host tried to redirect the download, which is not allowed.", 502, "redirect_blocked"));
        if (status === 404) return fail(new ImportError("The repository or ref was not found, or it is not public.", 404, "source_not_found"));
        if (status < 200 || status >= 300) return fail(new ImportError(`The host answered with status ${status}.`, 502, "fetch_failed"));
        const declared = Number(response.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) return fail(new ImportError(`The archive is larger than ${Math.floor(maxBytes / 1024 / 1024)} MB.`, 413, "archive_too_large"));
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) return fail(new ImportError(`The archive is larger than ${Math.floor(maxBytes / 1024 / 1024)} MB.`, 413, "archive_too_large"));
          chunks.push(chunk);
        });
        response.on("end", () => {
          clearTimeout(deadline);
          resolve(Buffer.concat(chunks));
        });
        response.on("error", () => fail(new ImportError("The download was interrupted.", 502, "fetch_failed")));
      }
    );
    request.on("timeout", () => fail(new ImportError("The download timed out.", 504, "fetch_timeout")));
    request.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(deadline);
      reject(error.code === "EBLOCKED" ? new ImportError("That host is not allowed.", 400, "host_not_allowed") : new ImportError("Could not download the repository.", 502, "fetch_failed"));
    });
    request.end();
  });
}

// ---- zip ----------------------------------------------------------------------------------------------------------

type ZipEntryLike = {
  name: string;
  dir: boolean;
  unsafeOriginalName?: string;
  unixPermissions?: number | string | null;
  _data?: { uncompressedSize?: number };
  internalStream: (type: "uint8array") => { on: (event: string, handler: (arg?: never) => void) => unknown; pause: () => void; resume: () => void };
};

export const ZIP_ENTRY_CAP = 1000;

/** Inflate one entry through a counting stream; null when it exceeds `limit` (inflation stops there). */
function inflateWithin(entry: ZipEntryLike, limit: number, budget: { left: number }): Promise<Uint8Array | null> {
  const declared = entry._data?.uncompressedSize;
  if (typeof declared === "number" && declared > limit) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;
    const stream = entry.internalStream("uint8array");
    stream.on("data", ((chunk: Uint8Array) => {
      if (done) return;
      total += chunk.byteLength;
      budget.left -= chunk.byteLength;
      if (budget.left < 0) {
        done = true;
        stream.pause();
        return reject(new ImportError(`The archive expands to more than ${IMPORT_LIMITS.maxTotalBytes / 1024 / 1024} MB.`, 413, "archive_too_large"));
      }
      if (total > limit) {
        done = true;
        stream.pause();
        return resolve(null);
      }
      chunks.push(chunk);
    }) as never);
    stream.on("error", ((error: Error) => {
      if (!done) {
        done = true;
        reject(new ImportError(`The archive is damaged: ${error.message.slice(0, 80)}`, 422, "bad_archive"));
      }
    }) as never);
    stream.on("end", (() => {
      if (done) return;
      done = true;
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve(out);
    }) as never);
    stream.resume();
  });
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export type RawFiles = { files: RepoFile[]; skipped: string[] };

/**
 * Read a zip held in memory. Returns text files with safe relative paths. Entries that are unsafe (zip-slip), symlinks,
 * binary, or too large are skipped and listed by path. Throws ImportError on a zip bomb or too many entries.
 */
export async function readZipFiles(buffer: Buffer): Promise<RawFiles> {
  if (buffer.length > IMPORT_LIMITS.maxZipBytes) throw new ImportError(`The archive is larger than ${IMPORT_LIMITS.maxZipBytes / 1024 / 1024} MB.`, 413, "archive_too_large");
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new ImportError("That is not a zip archive.", 422, "bad_archive");
  const { default: JSZip } = await import("jszip");
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch {
    throw new ImportError("The zip could not be read.", 422, "bad_archive");
  }
  const all = Object.values(zip.files) as unknown as ZipEntryLike[];
  if (all.length > ZIP_ENTRY_CAP) throw new ImportError("The archive has too many entries.", 413, "too_many_files");

  const skipped: string[] = [];
  const candidates: Array<{ entry: ZipEntryLike; original: string }> = [];
  for (const entry of all) {
    if (entry.dir) continue;
    const original = entry.unsafeOriginalName ?? entry.name;
    if (isZipJunk(original)) continue;
    const mode = Number(entry.unixPermissions ?? 0);
    if (mode && (mode & S_IFMT) === S_IFLNK) {
      skipped.push(original);
      continue;
    }
    candidates.push({ entry, original });
  }
  // The wrapper folder is worked out on the names as written, so a "../" entry cannot hide behind it.
  const stripped = stripCommonRoot(candidates.map((item) => item.original));
  const budget = { left: IMPORT_LIMITS.maxTotalBytes };
  const files: RepoFile[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const { entry, original } = candidates[index];
    const path = stripped[index];
    if (!safeImportPath(path) || !safeImportPath(original)) {
      skipped.push(original);
      continue;
    }
    // Data-like files are never inflated: only their path is kept so it can be reported and dropped.
    if (isProhibitedDataPath(path) || isDataLikePath(path)) {
      files.push({ path, content: "" });
      continue;
    }
    const bytes = await inflateWithin(entry, IMPORT_LIMITS.maxFileBytes, budget);
    if (!bytes) {
      skipped.push(path);
      continue;
    }
    try {
      files.push({ path, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
    } catch {
      skipped.push(path);
    }
    if (files.length > IMPORT_LIMITS.maxFiles * 3) throw new ImportError("The archive has too many files.", 413, "too_many_files");
  }
  return { files, skipped };
}

// ---- policy -------------------------------------------------------------------------------------------------------

export type PreparedImport = {
  files: RepoFile[];
  /** Data-like paths left out. */
  dropped: string[];
  /** Entries not read: unsafe path, symlink, binary or oversized. */
  skipped: string[];
  report: AlignmentReport;
  digest: string;
};

/**
 * Apply the import policy to files from any source (archive, Gitea, or the browser's zip reader) and build the
 * alignment report. Throws ImportError for: unsafe paths in the list, too many or too large files, credentials.
 */
export function prepareImport(input: RepoFile[], skippedBefore: string[] = []): PreparedImport {
  const skipped = [...skippedBefore];
  const kept: RepoFile[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const file of input) {
    if (!safeImportPath(file.path)) {
      skipped.push(file.path);
      continue;
    }
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    if (isProhibitedDataPath(file.path) || isDataLikePath(file.path)) {
      dropped.push(file.path);
      continue;
    }
    const bytes = Buffer.byteLength(file.content);
    if (bytes > IMPORT_LIMITS.maxFileBytes) {
      skipped.push(file.path);
      continue;
    }
    total += bytes;
    if (total > IMPORT_LIMITS.maxTotalBytes) throw new ImportError(`The repository is larger than ${IMPORT_LIMITS.maxTotalBytes / 1024 / 1024} MB of text.`, 413, "archive_too_large");
    kept.push(file);
  }
  if (kept.length === 0) throw new ImportError("The repository has no importable text files.", 422, "empty_source");
  if (kept.length > IMPORT_LIMITS.maxFiles) throw new ImportError(`The repository has more than ${IMPORT_LIMITS.maxFiles} files.`, 413, "too_many_files");

  const secretPaths = kept.filter((file) => fileHasSecret(file.path, file.content)).map((file) => file.path);
  if (secretPaths.length > 0) {
    throw new ImportError("Files that look like they contain credentials were found. Remove them, rotate the credentials, and import again.", 422, "secrets_found", secretPaths.slice(0, 10));
  }

  const report = alignmentReport(kept);
  if (dropped.length > 0) {
    report.advisory.push({ id: "dropped-data", message: `${dropped.length} data-like file${dropped.length === 1 ? " was" : "s were"} left out: pipeline repositories carry code only.`, paths: dropped.slice(0, 8) });
  }
  if (skipped.length > 0) {
    report.advisory.push({ id: "skipped", message: `${skipped.length} entr${skipped.length === 1 ? "y was" : "ies were"} not imported (unsafe path, link, binary, or over ${IMPORT_LIMITS.maxFileBytes / 1024} KB).`, paths: skipped.slice(0, 8) });
  }
  const hash = createHash("sha256");
  for (const file of [...kept].sort((a, b) => a.path.localeCompare(b.path))) hash.update(`${file.path}\0${file.content}\0`);
  return { files: kept, dropped, skipped, report, digest: hash.digest("hex") };
}
