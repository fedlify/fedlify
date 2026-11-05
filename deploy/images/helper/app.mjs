// Fedlify site helper: a thin local web shell over the runner CLI. No framework, no outbound network code.
// It never touches Docker (no docker.sock). Commands go to the host-side bridge as fixed words in a queue folder.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { profileDataDir } from "./data-profile.mjs";
import {
  BUNDLE_NAME, REQUEST_ID, SECURITY_HEADERS, checkHost, checkOrigin, isAllowedCommand, newToken, parseCookies, tokenEquals
} from "./security.mjs";
import { UnlockError, unlockKit } from "./unlock.mjs";

const SESSION_COOKIE = "fh_session";
const SESSION_MS = 8 * 60 * 60 * 1000;
const LINK_MS = 15 * 60 * 1000;
const MUTATING = new Set(["start", "stop", "update", "logout"]);
const here = path.dirname(new URL(import.meta.url).pathname);
const STATIC = { "/": ["index.html", "text/html; charset=utf-8"], "/app.js": ["app.js", "text/javascript; charset=utf-8"], "/style.css": ["style.css", "text/css; charset=utf-8"] };

/**
 * @param {{encPath:string, kitParent:string, queueDir:string, dataDir:string, publicPort:number|string, publicDir?:string}} opts
 * `linkToken` is the one-time token for the first visit; the caller delivers it through a 0600 file, never a log line.
 */
export function createHelperApp(opts) {
  const publicDir = opts.publicDir ?? path.join(here, "public");
  const sessions = new Map();
  let linkToken = newToken();
  const linkExpires = Date.now() + LINK_MS;
  let failedUnlocks = [];
  let unlockBusy = false;

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(body);
  };
  const json = (res, status, value) => send(res, status, JSON.stringify(value), { "content-type": "application/json; charset=utf-8" });

  function sessionValid(req) {
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!id) return false;
    const expires = sessions.get(id);
    if (!expires || expires < Date.now()) { sessions.delete(id); return false; }
    return true;
  }

  async function readJson(req, limit = 8192) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error("too large"), { status: 413 });
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      throw Object.assign(new Error("bad json"), { status: 400 });
    }
  }

  const exists = (p) => stat(p).then(() => true, () => false);
  const q = (...parts) => path.join(opts.queueDir, ...parts);

  async function state() {
    const unlocked = await exists(q("unlocked"));
    const staged = await exists(path.join(opts.kitParent, "fedlify-site-kit"));
    return { unlocked, staged, tokenSaved: (await exists(q("token-installed"))) || (await exists(q("site-token"))) };
  }

  async function enqueue(command) {
    if (MUTATING.has(command)) {
      for (const f of await readdir(q("requests")).catch(() => [])) if (/\.cmd$/.test(f)) {
        const body = (await readFile(q("requests", f), "utf8").catch(() => "")).trim();
        if (MUTATING.has(body)) return null;
      }
      for (const f of await readdir(q("results")).catch(() => [])) {
        const id = f.replace(/\.running$/, "");
        if (f.endsWith(".running") && !(await exists(q("results", `${id}.rc`)))) {
          const kind = (await readFile(q("results", f), "utf8").catch(() => "")).trim();
          if (MUTATING.has(kind)) return null;
        }
      }
    }
    const id = randomBytes(8).toString("hex");
    const tmp = q("requests", `.${id}.tmp`);
    await writeFile(tmp, `${command}\n`, { mode: 0o600 });
    await rename(tmp, q("requests", `${id}.cmd`));
    return id;
  }

  function tarRun(args) {
    return new Promise((resolve, reject) => {
      execFile("tar", args, { maxBuffer: 2 * 1024 * 1024, timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
  }

  async function handle(req, res) {
    // 1. Host header first: DNS rebinding arrives with the attacker's own name here.
    if (!checkHost(req.headers.host, opts.publicPort)) return send(res, 421, "Misdirected request: unexpected Host header.", { "content-type": "text/plain" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const site = req.headers["sec-fetch-site"];
    if (site && !["same-origin", "none"].includes(String(site))) return send(res, 403, "Cross-site request refused.", { "content-type": "text/plain" });

    // One-time link: exchange for a session cookie, then drop the token from the URL.
    if (method === "GET" && url.pathname === "/" && url.searchParams.has("t")) {
      const given = url.searchParams.get("t");
      if (linkToken && Date.now() < linkExpires && tokenEquals(given, linkToken)) {
        linkToken = null;
        const id = newToken();
        sessions.set(id, Date.now() + SESSION_MS);
        return send(res, 303, "", { location: "/", "set-cookie": `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
      }
      return send(res, 403, "This link was already used or has expired. Run start-helper again to get a new one.", { "content-type": "text/plain" });
    }

    if (method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      if (url.pathname === "/" && !sessionValid(req)) {
        return send(res, 401, "Open the link printed by start-helper to use this page.", { "content-type": "text/plain; charset=utf-8" });
      }
      return send(res, 200, await readFile(path.join(publicDir, file)), { "content-type": type });
    }

    if (!url.pathname.startsWith("/api/")) return send(res, 404, "Not found", { "content-type": "text/plain" });
    if (!sessionValid(req)) return json(res, 401, { error: "no_session" });

    if (method !== "GET") {
      if (!checkOrigin(req.headers.origin, opts.publicPort)) return json(res, 403, { error: "bad_origin" });
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json") || req.headers["x-fedlify-helper"] !== "1") return json(res, 415, { error: "bad_request_type" });
    }

    try {
      if (method === "GET" && url.pathname === "/api/state") return json(res, 200, await state());

      if (method === "POST" && url.pathname === "/api/unlock") {
        const now = Date.now();
        failedUnlocks = failedUnlocks.filter((t) => now - t < 60_000);
        if (failedUnlocks.length >= 5) return json(res, 429, { error: "too_many_attempts", message: "Too many wrong attempts. Wait a minute." });
        // One decrypt at a time: the limit above is read before the decrypt and written after it fails, so concurrent requests
        // would all pass the check. The flag is claimed before any await.
        if (unlockBusy) return json(res, 429, { error: "too_many_attempts", message: "Another unlock attempt is still running. Wait a moment." });
        unlockBusy = true;
        try {
          const body = await readJson(req);
          try {
            await unlockKit({ encPath: opts.encPath, parent: opts.kitParent, passphrase: body.passphrase });
          } catch (error) {
            if (error instanceof UnlockError) {
              if (error.code === "decrypt_failed") failedUnlocks.push(Date.now());
              return json(res, error.code === "decrypt_failed" ? 403 : 400, { error: error.code, message: error.message });
            }
            throw error;
          }
        } finally {
          unlockBusy = false;
        }
        return json(res, 200, { ok: true });
      }

      if (method === "POST" && url.pathname === "/api/token") {
        const body = await readJson(req);
        const token = typeof body.token === "string" ? body.token.trim() : "";
        if (token.length < 16 || token.length > 512 || /\s/.test(token)) return json(res, 400, { error: "bad_token", message: "That does not look like a site token." });
        await mkdir(opts.queueDir, { recursive: true });
        const tmp = q(".site-token.tmp");
        await writeFile(tmp, token, { mode: 0o600 });
        await rename(tmp, q("site-token"));
        return json(res, 200, { ok: true });
      }

      if (method === "POST" && url.pathname === "/api/run") {
        const body = await readJson(req);
        if (!isAllowedCommand(body.command)) return json(res, 400, { error: "command_not_allowed" });
        if (!(await exists(q("unlocked")))) return json(res, 409, { error: "not_unlocked", message: "Unlock the kit first." });
        const id = await enqueue(body.command);
        if (!id) return json(res, 409, { error: "busy", message: "Another start, stop or update is still running." });
        return json(res, 202, { id });
      }

      const result = /^\/api\/result\/([a-f0-9]{16})$/.exec(url.pathname);
      if (method === "GET" && result) {
        const id = result[1];
        if (!REQUEST_ID.test(id)) return json(res, 400, { error: "bad_id" });
        if (await exists(q("results", `${id}.rc`))) {
          const rc = Number((await readFile(q("results", `${id}.rc`), "utf8")).trim());
          const output = await readFile(q("results", `${id}.out`), "utf8").catch(() => "");
          return json(res, 200, { done: true, exit: Number.isFinite(rc) ? rc : 1, output });
        }
        return json(res, 200, { done: false });
      }

      if (method === "GET" && url.pathname === "/api/data") return json(res, 200, await profileDataDir(opts.dataDir));

      if (method === "GET" && url.pathname === "/api/bundles") {
        const names = (await readdir(q("out")).catch(() => [])).filter((n) => BUNDLE_NAME.test(n)).sort().reverse();
        const items = [];
        for (const name of names.slice(0, 10)) items.push({ name, bytes: (await stat(q("out", name))).size });
        return json(res, 200, { bundles: items });
      }

      const bundle = /^\/api\/bundle\/([^/]+)(\/files|\/file)?$/.exec(url.pathname);
      if (method === "GET" && bundle) {
        const name = decodeURIComponent(bundle[1]);
        if (!BUNDLE_NAME.test(name) || !(await exists(q("out", name)))) return json(res, 404, { error: "no_such_bundle" });
        const file = q("out", name);
        if (!bundle[2]) return send(res, 200, await readFile(file), { "content-type": "application/gzip", "content-disposition": `attachment; filename="${name}"` });
        const members = (await tarRun(["-tzf", file])).split("\n").filter((m) => m && !m.endsWith("/"));
        if (bundle[2] === "/files") return json(res, 200, { files: members });
        const member = url.searchParams.get("name") ?? "";
        if (!members.includes(member)) return json(res, 404, { error: "no_such_file" });
        return json(res, 200, { name: member, text: (await tarRun(["-xzOf", file, member])).slice(0, 65536) });
      }

      return json(res, 404, { error: "not_found" });
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 500;
      return json(res, status, { error: status === 500 ? "internal" : "bad_request" });
    }
  }

  const server = createServer((req, res) => { handle(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: "internal" }); }); });
  return {
    server,
    /** The first-visit link. Written to a 0600 file by server.mjs; tests read it directly. */
    linkUrl: (host = "127.0.0.1") => `http://${host}:${opts.publicPort}/?t=${linkToken}`,
    sessionCount: () => sessions.size
  };
}
