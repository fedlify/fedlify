import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { AddressInfo, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zipFiles } from "@/lib/archive";
import { encryptKit } from "@/lib/kit-crypto";

// Drives the REAL helper server (deploy/images/helper) over loopback HTTP, including requests that a DNS-rebinding or
// cross-site page would send. The helper sources are copied to a temp dir with a node_modules link, because deploy/ has no
// node_modules of its own outside the image build.
const helperSrc = path.resolve(__dirname, "../../../deploy/images/helper");
const PASSPHRASE = "correct-horse-battery-staple-pass";
const SECRET_NAME = "ZZ-PATIENT-NAME-CANARY";

let root: string;
let helperDir: string;
let port: number;
let mod: { createHelperApp: (o: Record<string, unknown>) => { server: http.Server; linkUrl: (h?: string) => string } };
let security: Record<string, (...a: never[]) => unknown> & { ALLOWED_COMMANDS: string[] };
let app: { server: http.Server; linkUrl: (h?: string) => string };
let dirs: { enc: string; kitParent: string; queue: string; data: string };
let cookie = "";

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };
function call(method: string, url: string, opts: { headers?: Record<string, string>; body?: unknown; host?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      { host: "127.0.0.1", port, path: url, method, headers: { host: opts.host ?? `127.0.0.1:${port}`, ...(payload ? { "content-length": String(Buffer.byteLength(payload)) } : {}), ...opts.headers } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const origin = () => `http://127.0.0.1:${port}`;
const authed = (extra: Record<string, string> = {}) => ({ cookie, ...extra });
const postHeaders = (extra: Record<string, string> = {}) => authed({ origin: origin(), "content-type": "application/json", "x-fedlify-helper": "1", ...extra });
const post = (url: string, body: unknown, extra: Record<string, string> = {}) => call("POST", url, { headers: postHeaders(extra), body });
const get = (url: string) => call("GET", url, { headers: authed() });

async function freePort() {
  return new Promise<number>((resolve) => {
    const s = createNetServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

async function kitZip(files: Record<string, string>) {
  return zipFiles(files);
}
const goodKit = () => ({ "fedlify-runner.sh": "#!/usr/bin/env bash\necho runner\n", ".env": "FEDLIFY_DATA_DIR=./data\n", ".fedlify/registry-credential": "robot\nregistry-secret-value\n", "nvflare/startup/fed_client.json": "{}" });

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fedlify-helper-"));
  helperDir = path.join(root, "helper");
  cpSync(helperSrc, helperDir, { recursive: true, filter: (src) => !src.includes("node_modules") });
  symlinkSync(path.resolve(__dirname, "../node_modules"), path.join(helperDir, "node_modules"));
  mod = await import(/* @vite-ignore */ pathToFileURL(path.join(helperDir, "app.mjs")).href);
  security = await import(/* @vite-ignore */ pathToFileURL(path.join(helperDir, "security.mjs")).href);
  port = await freePort();
  dirs = { enc: path.join(root, "kit.zip.age"), kitParent: path.join(root, "kit"), queue: path.join(root, "queue"), data: path.join(root, "data") };
  for (const d of [dirs.kitParent, path.join(dirs.queue, "requests"), path.join(dirs.queue, "results"), path.join(dirs.queue, "out"), dirs.data]) mkdirSync(d, { recursive: true });
  writeFileSync(dirs.enc, await encryptKit(await kitZip(goodKit()), PASSPHRASE, 10));
  app = mod.createHelperApp({ encPath: dirs.enc, kitParent: dirs.kitParent, queueDir: dirs.queue, dataDir: dirs.data, publicPort: port });
  await new Promise<void>((ok) => app.server.listen(port, "127.0.0.1", ok));
});
afterAll(async () => {
  await new Promise((ok) => app.server.close(ok));
  rmSync(root, { recursive: true, force: true });
});

describe("helper: Host header, rebinding and cross-site protection", () => {
  it("answers 421 to any Host that is not a loopback name with the published port, even with a valid session", async () => {
    const link = new URL(app.linkUrl());
    const ok = await call("GET", `/${link.search}`);
    expect(ok.status).toBe(303);
    cookie = String(ok.headers["set-cookie"]).split(";")[0]!;
    for (const host of [`evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `localhost.evil.example:${port}`, `127.0.0.1:${port + 1}`, "127.0.0.1", `0.0.0.0:${port}`, `[::2]:${port}`]) {
      const res = await call("GET", "/api/state", { headers: authed(), host });
      expect(res.status, `Host ${JSON.stringify(host)}`).toBe(421);
      expect(res.body).not.toContain("unlocked");
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) expect((await call("GET", "/api/state", { headers: authed(), host })).status).toBe(200);
  });

  it("refuses the one-time link when the Host is wrong, and never lets it be replayed", async () => {
    // A fresh app so this test owns an unused link.
    const p2 = await freePort();
    const second = mod.createHelperApp({ encPath: dirs.enc, kitParent: dirs.kitParent, queueDir: dirs.queue, dataDir: dirs.data, publicPort: p2 });
    await new Promise<void>((ok) => second.server.listen(p2, "127.0.0.1", ok));
    const search = new URL(second.linkUrl()).search;
    const raw = (host: string, p: string) =>
      new Promise<number>((resolve, reject) => http.get({ host: "127.0.0.1", port: p2, path: p, headers: { host } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }).on("error", reject));
    expect(await raw(`attacker.example:${p2}`, `/${search}`)).toBe(421);
    expect(await raw(`127.0.0.1:${p2}`, "/?t=" + "0".repeat(64))).toBe(403);
    expect(await raw(`127.0.0.1:${p2}`, `/${search}`)).toBe(303);
    expect(await raw(`127.0.0.1:${p2}`, `/${search}`)).toBe(403); // used once
    expect(second.server.listening).toBe(true);
    await new Promise((ok) => second.server.close(ok));
  });

  it("serves nothing to a request without a session, and sets a strict cookie and security headers", async () => {
    expect((await call("GET", "/")).status).toBe(401);
    expect((await call("GET", "/api/state")).status).toBe(401);
    expect((await call("POST", "/api/run", { headers: { origin: origin(), "content-type": "application/json", "x-fedlify-helper": "1" }, body: { command: "status" } })).status).toBe(401);
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["content-security-policy"]).not.toContain("unsafe-inline");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).not.toMatch(/<script>[^<]/); // no inline script
  });

  it("the session cookie is HttpOnly and SameSite=Strict", async () => {
    const p3 = await freePort();
    const third = mod.createHelperApp({ encPath: dirs.enc, kitParent: dirs.kitParent, queueDir: dirs.queue, dataDir: dirs.data, publicPort: p3 });
    await new Promise<void>((ok) => third.server.listen(p3, "127.0.0.1", ok));
    const header = await new Promise<string>((resolve, reject) =>
      http.get({ host: "127.0.0.1", port: p3, path: `/${new URL(third.linkUrl()).search}`, headers: { host: `127.0.0.1:${p3}` } }, (r) => { r.resume(); resolve(String(r.headers["set-cookie"])); }).on("error", reject)
    );
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
    await new Promise((ok) => third.server.close(ok));
  });

  it("refuses cross-site fetches and POSTs without our own Origin, JSON type and custom header", async () => {
    expect((await call("GET", "/api/state", { headers: authed({ "sec-fetch-site": "cross-site" }) })).status).toBe(403);
    expect((await call("GET", "/api/state", { headers: authed({ "sec-fetch-site": "same-site" }) })).status).toBe(403);
    expect((await call("GET", "/api/state", { headers: authed({ "sec-fetch-site": "same-origin" }) })).status).toBe(200);
    const body = { command: "status" };
    const base = { "content-type": "application/json", "x-fedlify-helper": "1" };
    expect((await call("POST", "/api/run", { headers: authed(base), body })).status).toBe(403); // no Origin (curl, some proxies)
    for (const o of ["http://evil.example", `http://evil.example:${port}`, `https://127.0.0.1:${port}`, `http://127.0.0.1.evil.example:${port}`, "null"]) {
      expect((await call("POST", "/api/run", { headers: authed({ ...base, origin: o }), body })).status, o).toBe(403);
    }
    expect((await call("POST", "/api/run", { headers: authed({ origin: origin(), "x-fedlify-helper": "1", "content-type": "text/plain" }), body })).status).toBe(415);
    expect((await call("POST", "/api/run", { headers: authed({ origin: origin(), "content-type": "application/json" }), body })).status).toBe(415);
    expect(existsSync(path.join(dirs.queue, "unlocked"))).toBe(false);
    expect(readdirSync(path.join(dirs.queue, "requests"))).toEqual([]);
  });

  it("limits request bodies", async () => {
    const res = await post("/api/unlock", { passphrase: "x".repeat(20000) });
    expect(res.status).toBe(413);
  });
});

describe("helper: security rules as pure functions", () => {
  it("bind rules: loopback always, anything else only in our container or with an explicit override that warns", () => {
    const check = security.checkBindAddress as unknown as (a: string, e?: Record<string, string>) => { ok: boolean; warning?: string; reason?: string };
    expect(check("127.0.0.1").ok).toBe(true);
    expect(check("::1").ok).toBe(true);
    for (const addr of ["0.0.0.0", "::", "192.168.1.5"]) {
      expect(check(addr, {}).ok).toBe(false);
      expect(check(addr, {}).reason).toContain("only loopback");
    }
    expect(check("0.0.0.0", { FEDLIFY_HELPER_ALLOW_REMOTE: "1" }).warning).toContain("WARNING");
    expect(check("0.0.0.0", { FEDLIFY_HELPER_CONTAINER: "1" }).ok).toBe(true);
  });

  it("the command allowlist is exactly the runner commands the bridge maps", () => {
    expect([...security.ALLOWED_COMMANDS].sort()).toEqual(["logout", "preflight", "start", "status", "stop", "support-bundle", "support-bundle-logs", "update"]);
    const isAllowed = security.isAllowedCommand as unknown as (c: unknown) => boolean;
    for (const bad of ["unlock", "shell", "start; id", "START", "", null, 7, ["start"], "status\nstart"]) expect(isAllowed(bad)).toBe(false);
  });

  it("small cells under 10 are suppressed, zero is not", () => {
    const suppress = security.suppress as unknown as (n: number) => number | string;
    expect(suppress(0)).toBe(0);
    expect(suppress(1)).toBe("<10");
    expect(suppress(9)).toBe("<10");
    expect(suppress(10)).toBe(10);
  });
});

describe("helper: commands go to the bridge as one fixed word", () => {
  it("refuses anything outside the allowlist and anything before unlock", async () => {
    for (const command of ["rm -rf /", "start; touch /tmp/pwned", "unlock", "docker", 7, undefined]) {
      expect((await post("/api/run", { command })).status).toBe(400);
    }
    expect((await post("/api/run", { command: "status" })).status).toBe(409);
    expect(readdirSync(path.join(dirs.queue, "requests"))).toEqual([]);
  });

  it("after unlock writes a 0600 request holding only the word, allows one start at a time, and returns results by id", async () => {
    writeFileSync(path.join(dirs.queue, "unlocked"), "");
    const first = await post("/api/run", { command: "start" });
    expect(first.status).toBe(202);
    const id = JSON.parse(first.body).id as string;
    expect(id).toMatch(/^[a-f0-9]{16}$/);
    const file = path.join(dirs.queue, "requests", `${id}.cmd`);
    expect(readFileSync(file, "utf8")).toBe("start\n");
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect((await post("/api/run", { command: "stop" })).status).toBe(409); // a start is still pending
    expect((await post("/api/run", { command: "status" })).status).toBe(202); // read-only commands are never blocked
    expect(JSON.parse((await get(`/api/result/${id}`)).body)).toEqual({ done: false });
    writeFileSync(path.join(dirs.queue, "results", `${id}.out`), "Started.\n");
    writeFileSync(path.join(dirs.queue, "results", `${id}.rc`), "0\n");
    expect(JSON.parse((await get(`/api/result/${id}`)).body)).toEqual({ done: true, exit: 0, output: "Started.\n" });
    expect((await get("/api/result/..%2f..%2fetc%2fpasswd")).status).toBe(404);
    expect((await get("/api/result/ABCDEF0123456789")).status).toBe(404);
    for (const f of readdirSync(path.join(dirs.queue, "requests"))) rmSync(path.join(dirs.queue, "requests", f));
    rmSync(path.join(dirs.queue, "unlocked"));
  });
});

describe("helper: unlock", () => {
  it("wrong passphrase writes nothing and says so; five misses trigger a pause; no response or file ever holds the passphrase", async () => {
    const wrong = await post("/api/unlock", { passphrase: "this-is-not-the-passphrase" });
    expect(wrong.status).toBe(403);
    expect(JSON.parse(wrong.body).error).toBe("decrypt_failed");
    expect(readdirSync(dirs.kitParent)).toEqual([]);
    expect((await post("/api/unlock", { passphrase: "short" })).status).toBe(400);
    for (let i = 0; i < 3; i++) await post("/api/unlock", { passphrase: `still-wrong-passphrase-${i}` });
    expect((await post("/api/unlock", { passphrase: "wrong-again-xxxxxxx" })).status).toBe(403);
    const limited = await post("/api/unlock", { passphrase: PASSPHRASE }); // even the right one waits: it is a rate limit, not an oracle
    expect(limited.status).toBe(429);
    expect(readdirSync(dirs.kitParent)).toEqual([]);
  });

  it("a burst of concurrent guesses cannot get past the five-attempt limit", async () => {
    const p = await freePort();
    const burst = mod.createHelperApp({ encPath: dirs.enc, kitParent: path.join(root, "kit-burst"), queueDir: dirs.queue, dataDir: dirs.data, publicPort: p });
    mkdirSync(path.join(root, "kit-burst"), { recursive: true });
    await new Promise<void>((ok) => burst.server.listen(p, "127.0.0.1", ok));
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => http.get({ host: "127.0.0.1", port: p, path: `/${new URL(burst.linkUrl()).search}`, headers: { host: `127.0.0.1:${p}` } }, (r) => { r.resume(); resolve(r.headers); }).on("error", reject));
    const cookie2 = String(headers["set-cookie"]).split(";")[0]!;
    const guess = (i: number) =>
      new Promise<number>((resolve, reject) => {
        const payload = JSON.stringify({ passphrase: `burst-wrong-passphrase-${i}` });
        const req = http.request({ host: "127.0.0.1", port: p, path: "/api/unlock", method: "POST", headers: { host: `127.0.0.1:${p}`, cookie: cookie2, origin: `http://127.0.0.1:${p}`, "content-type": "application/json", "x-fedlify-helper": "1", "content-length": String(Buffer.byteLength(payload)) } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on("error", reject);
        req.end(payload);
      });
    const statuses = await Promise.all(Array.from({ length: 16 }, (_, i) => guess(i)));
    expect(statuses.filter((c) => c === 403).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((c) => c === 429).length).toBeGreaterThanOrEqual(11);
    expect(statuses.every((c) => c === 403 || c === 429)).toBe(true);
    await new Promise((ok) => burst.server.close(ok));
  });

  it("a fresh helper unlocks with the right passphrase into 0700/0600 and leaves no staging directory", async () => {
    const p = await freePort();
    const kitParent = path.join(root, "kit2");
    mkdirSync(kitParent);
    const fresh = mod.createHelperApp({ encPath: dirs.enc, kitParent, queueDir: dirs.queue, dataDir: dirs.data, publicPort: p });
    await new Promise<void>((ok) => fresh.server.listen(p, "127.0.0.1", ok));
    const cookie2 = await new Promise<string>((resolve, reject) =>
      http.get({ host: "127.0.0.1", port: p, path: `/${new URL(fresh.linkUrl()).search}`, headers: { host: `127.0.0.1:${p}` } }, (r) => { r.resume(); resolve(String(r.headers["set-cookie"]).split(";")[0]!); }).on("error", reject)
    );
    const send = (body: unknown) =>
      new Promise<Res>((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request({ host: "127.0.0.1", port: p, path: "/api/unlock", method: "POST", headers: { host: `127.0.0.1:${p}`, cookie: cookie2, origin: `http://127.0.0.1:${p}`, "content-type": "application/json", "x-fedlify-helper": "1", "content-length": String(Buffer.byteLength(payload)) } }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
        });
        req.on("error", reject);
        req.end(payload);
      });
    const ok = await send({ passphrase: PASSPHRASE });
    expect(ok.status).toBe(200);
    expect(ok.body).not.toContain(PASSPHRASE);
    expect(readdirSync(kitParent)).toEqual(["fedlify-site-kit"]);
    const kit = path.join(kitParent, "fedlify-site-kit");
    const mode = (f: string) => (statSync(path.join(kit, f)).mode & 0o777).toString(8);
    expect(mode("")).toBe("700");
    expect(mode(".fedlify")).toBe("700");
    expect(mode("nvflare/startup")).toBe("700");
    expect(mode(".fedlify/registry-credential")).toBe("600");
    expect(mode("nvflare/startup/fed_client.json")).toBe("600");
    expect(mode("fedlify-runner.sh")).toBe("700");
    expect((await send({ passphrase: PASSPHRASE })).status).toBe(400); // never overwrites an existing kit
    // The passphrase is in no file under the temp tree (including the queue the host bridge reads).
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(full);
        else if (readFileSync(full).includes(PASSPHRASE)) hits.push(full);
      }
    };
    walk(root);
    expect(hits).toEqual([]);
    await new Promise((done) => fresh.server.close(done));
  });

  it("rejects a decrypted archive with a path-traversal entry and one that is not a kit, writing nothing", async () => {
    const { unlockKit } = (await import(/* @vite-ignore */ pathToFileURL(path.join(helperDir, "unlock.mjs")).href)) as { unlockKit: (o: Record<string, unknown>) => Promise<unknown> };
    for (const [files, code] of [
      [{ ...goodKit(), "../escape.txt": "x" }, "unsafe_path"],
      [{ "readme.txt": "not a kit" }, "not_a_kit"]
    ] as const) {
      const parent = mkdtempSync(path.join(root, "slip-"));
      const enc = path.join(parent, "kit.zip.age");
      writeFileSync(enc, await encryptKit(await kitZip(files as Record<string, string>), PASSPHRASE, 10));
      await expect(unlockKit({ encPath: enc, parent, passphrase: PASSPHRASE })).rejects.toMatchObject({ code });
      expect(readdirSync(parent).filter((n) => n !== "kit.zip.age")).toEqual([]);
      expect(existsSync(path.join(parent, "escape.txt"))).toBe(false);
    }
  });
});

describe("helper: site token", () => {
  it("is stored as a 0600 file for the host bridge, never echoed, and obviously bad input is refused", async () => {
    const token = "site-token-CANARY-0123456789abcdef";
    const res = await post("/api/token", { token });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(token);
    const file = path.join(dirs.queue, "site-token");
    expect(readFileSync(file, "utf8")).toBe(token);
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect(JSON.parse((await get("/api/state")).body).tokenSaved).toBe(true);
    rmSync(file);
    for (const bad of ["short", "has spaces in the middle of it xxxxxxxxx", "x".repeat(600), 5, undefined]) expect((await post("/api/token", { token: bad })).status).toBe(400);
    expect(existsSync(file)).toBe(false);
  });
});

describe("helper: your data shows no row-level values", () => {
  it("returns schema, suppressed counts and name flags only", async () => {
    const rows = ["patientunitstayid,age,sex,hospital_unit,note,empty_col"];
    for (let i = 0; i < 30; i++) rows.push(`${1000 + i},${40 + i},${i % 2 ? "F" : "M"},${i < 3 ? "RARE" : "ICU"},${i === 5 ? SECRET_NAME : "ok"},`);
    writeFileSync(path.join(dirs.data, "site.csv"), rows.join("\n") + "\n");
    writeFileSync(path.join(dirs.data, "tiny.csv"), "age\n1\n2\n3\n");
    const res = await get("/api/data");
    const data = JSON.parse(res.body);
    expect(res.body).not.toContain(SECRET_NAME);
    expect(res.body).not.toContain("1007"); // an identifier value
    const site = data.files.find((f: { file: string }) => f.file === "site.csv");
    expect(site.rows).toBe(30);
    const col = (name: string) => site.columns.find((c: { name: string }) => c.name === name);
    expect(col("patientunitstayid").nameCheck).toBe("forbidden");
    expect(data.flagged).toEqual([{ file: "site.csv", column: "patientunitstayid", problem: "forbidden" }]);
    expect(col("age").type).toBe("numeric");
    expect(col("sex").categories).toHaveLength(2);
    expect(col("sex").categories.map((c: { label: string }) => c.label).sort()).toEqual(["F", "M"]);
    expect(col("hospital_unit").categories).toBeUndefined(); // RARE has 3 rows: a category under 10 hides the whole list
    expect(col("note").categories).toBeUndefined(); // one distinct value is rare and would reveal it
    expect(col("empty_col").type).toBe("empty");
    expect(data.files.find((f: { file: string }) => f.file === "tiny.csv").rows).toBe("<10");
  });
});

describe("helper: support bundles", () => {
  it("lists and serves only files with the bundle name pattern from the out folder", async () => {
    const name = "fedlify-support-20261105T101500Z.tar.gz";
    writeFileSync(path.join(dirs.queue, "out", name), "not really a tarball");
    writeFileSync(path.join(dirs.queue, "out", "secret.txt"), "nope");
    expect(JSON.parse((await get("/api/bundles")).body).bundles).toEqual([{ name, bytes: 20 }]);
    const dl = await get(`/api/bundle/${name}`);
    expect(dl.status).toBe(200);
    expect(dl.headers["content-disposition"]).toContain(name);
    for (const bad of ["secret.txt", "..%2fsecret.txt", "..%2f..%2fetc%2fpasswd", "fedlify-support-1.tar.gz"]) expect((await get(`/api/bundle/${bad}`)).status, bad).toBe(404);
    expect((await get(`/api/bundle/${name}/file?name=../../etc/passwd`)).status).toBeGreaterThanOrEqual(400);
  });
});

describe("helper: server process", () => {
  it("refuses a non-loopback bind outside the container, and delivers the one-time link through a 0600 file, not a log", async () => {
    const refused = await new Promise<{ code: number | null; err: string }>((resolve) => {
      const child = spawn(process.execPath, ["server.mjs"], { cwd: helperDir, env: { PATH: process.env.PATH ?? "", FEDLIFY_HELPER_BIND: "0.0.0.0", FEDLIFY_QUEUE_DIR: path.join(root, "q-refused") } as unknown as NodeJS.ProcessEnv });
      let err = "";
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (code) => resolve({ code, err }));
    });
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("only loopback");
    expect(existsSync(path.join(root, "q-refused"))).toBe(false);

    const p = await freePort();
    const queue = path.join(root, "q-live");
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: helperDir,
      env: { PATH: process.env.PATH ?? "", FEDLIFY_HELPER_LISTEN_PORT: String(p), FEDLIFY_QUEUE_DIR: queue, FEDLIFY_KIT_FILE: dirs.enc, FEDLIFY_KIT_PARENT: dirs.kitParent, FEDLIFY_DATA_PATH: dirs.data } as unknown as NodeJS.ProcessEnv
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    try {
      for (let i = 0; i < 100 && !out.includes("listening"); i++) await new Promise((ok) => setTimeout(ok, 50));
      expect(out).toContain("listening on 127.0.0.1");
      const linkFile = path.join(queue, "helper-link");
      expect((statSync(linkFile).mode & 0o777).toString(8)).toBe("600");
      const link = readFileSync(linkFile, "utf8").trim();
      expect(link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${p}/\\?t=[0-9a-f]{64}$`));
      expect(out).not.toContain(link.split("t=")[1]!);
    } finally {
      child.kill();
    }
  });
});

describe("helper: no outbound network code, no docker.sock", () => {
  it("none of the helper sources can call out or reach the Docker socket", () => {
    for (const f of ["app.mjs", "server.mjs", "security.mjs", "data-profile.mjs", "unlock.mjs", "unlock-cli.mjs", "public/app.js"]) {
      const text = readFileSync(path.join(helperSrc, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
      expect(text, f).not.toMatch(/\bfetch\(.*https?:\/\/(?!127|localhost)|node:https|node:dgram|node:dns|node:net\b|http\.request|https\.|WebSocket|XMLHttpRequest|sendBeacon|docker\.sock|child_process.*docker/);
    }
    const app = readFileSync(path.join(helperSrc, "app.mjs"), "utf8");
    expect(app).toContain('execFile("tar"'); // the only process it starts, with fixed arguments and no shell
    expect(app).not.toMatch(/(?<![.\w])exec\(|\bspawn\(|execSync|shell:\s*true/);
    const browser = readFileSync(path.join(helperSrc, "public/app.js"), "utf8");
    expect(browser).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML/);
    expect(readFileSync(path.join(helperSrc, "Dockerfile"), "utf8")).not.toMatch(/docker\.sock/);
  });
});
