import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getPs1 } from "@/app/get-ready/preflight.ps1/route";
import { GET as getSh } from "@/app/get-ready/preflight.sh/route";
import GetReadyPage from "@/app/get-ready/page";
import { ARCHITECTURE_STATEMENT, GPU_STATEMENT, OS_GUIDES } from "@/lib/get-ready";
import { PREFLIGHT_PS1, PREFLIGHT_PS1_SHA256, PREFLIGHT_SH, PREFLIGHT_SH_SHA256, sha256 } from "@/lib/site-preflight-script";

// preflight.sh runs for real under bash against fake tools. preflight.ps1 is only checked statically: no PowerShell here.
const bashes = [...new Set(["/bin/bash", "bash"])];
let root: string;
let bin: string;
let work: string;

function fake(name: string, body: string) {
  writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(path.join(bin, name), 0o755);
}
function run(args: string[], env: Record<string, string> = {}, shell = "/bin/bash", pathDirs = `${bin}:/usr/bin:/bin`) {
  return spawnSync(shell, [path.join(root, "preflight.sh"), ...args], { cwd: work, encoding: "utf8", env: { PATH: pathDirs, HOME: root, ...env } as unknown as NodeJS.ProcessEnv });
}
const check = (out: string, id: string) => JSON.parse(out).checks.find((c: { id: string }) => c.id === id);

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "fedlify-preflight-"));
  bin = path.join(root, "bin");
  work = path.join(root, "work");
  mkdirSync(bin);
  mkdirSync(work);
  writeFileSync(path.join(root, "preflight.sh"), PREFLIGHT_SH, { mode: 0o755 });
  fake("docker", `case "$1 $2" in "compose version") echo 2.29.1; exit 0;; "info --format") case "$3" in *Runtimes*) echo '{"runc":{}}';; *) echo 8589934592;; esac; exit 0;; esac
[ "$1" = "info" ] && exit 0; exit 0`);
  fake("nc", `echo "$@" >> "$FAKE_NC_LOG"; [ "$FAKE_NC" = "fail" ] && exit 1; exit 0`);
  fake("getent", `[ "$2" = "unresolvable.example" ] && exit 2; exit 0`);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("preflight.sh", { timeout: 30_000 }, () => {
  it("parses under every bash", () => {
    for (const shell of bashes) execFileSync(shell, ["-n", path.join(root, "preflight.sh")]);
  });

  for (const shell of bashes) {
    it(`needs no Docker and no kit: with Docker missing it still reports, fails on docker and exits 1 (${shell})`, () => {
      const res = run(["--json"], {}, shell, "/usr/bin:/bin");
      expect(res.status).toBe(1);
      const report = JSON.parse(res.stdout);
      expect(report.ok).toBe(false);
      expect(check(res.stdout, "docker").status).toBe("fail");
      expect(check(res.stdout, "compose").status).toBe("warn");
      for (const id of ["platform", "architecture", "disk", "ram", "aggregator", "registry", "gpu"]) expect(report.checks.map((c: { id: string }) => c.id)).toContain(id);
    });
  }

  it("passes against a healthy fake Docker and probes only the hosts it was given, on 443 by default", () => {
    const log = path.join(root, "nc.log");
    rmSync(log, { force: true });
    const res = run(["--json", "--aggregator", "study.example", "--registry", "https://reg.example:5000/v2/"], { FAKE_NC_LOG: log });
    expect(res.status, res.stdout).toBe(0);
    expect(check(res.stdout, "docker").status).toBe("pass");
    expect(check(res.stdout, "compose").status).toBe("pass");
    expect(check(res.stdout, "aggregator").detail).toContain("study.example:443");
    expect(check(res.stdout, "registry").detail).toContain("reg.example:5000");
    expect(readFileSync(log, "utf8").trim().split("\n").sort()).toEqual(["-z -w 5 reg.example 5000", "-z -w 5 study.example 443"]);
  });

  it("fails when the aggregator port is blocked or the name does not resolve, in both output modes", () => {
    const blocked = run(["--json", "--aggregator", "study.example"], { FAKE_NC: "fail", FAKE_NC_LOG: path.join(root, "nc2.log") });
    expect(blocked.status).toBe(1);
    expect(check(blocked.stdout, "aggregator").status).toBe("fail");
    const nodns = run(["--aggregator", "unresolvable.example"], { FAKE_NC_LOG: path.join(root, "nc3.log") });
    expect(nodns.status).toBe(1);
    expect(nodns.stdout).toContain("[fail] aggregator: cannot resolve unresolvable.example");
    expect(nodns.stdout).toContain("Nothing was sent or saved");
  });

  it("treats a hostile host argument as data: rejected by name, nothing executed, nothing probed", () => {
    const log = path.join(root, "nc4.log");
    rmSync(log, { force: true });
    for (const bad of ["a.example;touch pwned", "$(touch pwned).example", "a.example`touch pwned`", "a b", "a.example|id"]) {
      const res = run(["--json", "--aggregator", bad], { FAKE_NC_LOG: log });
      expect(check(res.stdout, "aggregator").status, bad).toBe("fail");
      expect(check(res.stdout, "aggregator").detail).toContain("not a valid host name");
    }
    expect(existsSync(path.join(work, "pwned"))).toBe(false);
    expect(existsSync(log)).toBe(false);
  });

  it("is read-only: it writes no file and sends nothing but the probes", () => {
    const before = readdirSync(work);
    run(["--json", "--aggregator", "study.example"], { FAKE_NC_LOG: path.join(root, "nc5.log") });
    expect(readdirSync(work)).toEqual(before);
    // No network tool other than nc (and curl only as nc's fallback with no data) appears in the script.
    expect(PREFLIGHT_SH).not.toMatch(/curl[^\n]*(-d|--data|-T|-F|--upload)|\bwget\b|\bscp\b|\bssh\b|\bsendmail\b|\bmail\b/);
    expect(PREFLIGHT_SH).not.toMatch(/site-token|registry-credential|FEDLIFY_SITE|^\s*(\.|source) .*\.env/m);
  });

  it("counts csv files in a data folder without reading them, and fails on a missing folder", () => {
    const data = path.join(root, "data");
    mkdirSync(data);
    writeFileSync(path.join(data, "a.csv"), "SECRET-CELL-VALUE\n");
    const ok = run(["--json", "--data", data]);
    expect(check(ok.stdout, "data").detail).toContain("1 csv");
    expect(ok.stdout).not.toContain("SECRET-CELL-VALUE");
    expect(check(run(["--json", "--data", path.join(root, "nope")]).stdout, "data").status).toBe("fail");
  });

  it("warns on ARM about the amd64-only image", () => {
    fake("uname", `[ "$1" = "-m" ] && { echo arm64; exit 0; }; exec /usr/bin/uname "$@"`);
    try {
      const res = run(["--json"]);
      expect(check(res.stdout, "architecture").status).toBe("warn");
      expect(check(res.stdout, "architecture").detail).toContain("amd64 only");
    } finally {
      rmSync(path.join(bin, "uname"));
    }
  });

  it("reports a GPU without the container toolkit honestly, and treats GPU as optional", () => {
    fake("nvidia-smi", `echo "GPU 0: Fake"`);
    try {
      const res = run(["--json"]);
      expect(res.status).toBe(0);
      expect(check(res.stdout, "gpu").detail).toContain("toolkit was not detected");
    } finally {
      rmSync(path.join(bin, "nvidia-smi"));
    }
  });

  it("rejects unknown options", () => {
    expect(run(["--upload-everything"]).status).toBe(2);
  });
});

describe("preflight.ps1 (static only; never run, so unverified)", () => {
  it("is marked unverified and checks WSL 2, Docker Desktop, Docker inside WSL and Compose v2", () => {
    expect(PREFLIGHT_PS1).toContain("UNVERIFIED");
    for (const id of ["wsl2", "docker_desktop", "docker_in_wsl", "compose", "disk", "ram", "aggregator", "registry", "gpu", "architecture"]) expect(PREFLIGHT_PS1).toContain(`'${id}'`);
    expect(PREFLIGHT_PS1).toContain("WSL integration");
  });
  it("sends nothing, writes nothing, needs no secret", () => {
    expect(PREFLIGHT_PS1).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|Invoke-Expression|\biex\b|Out-File|Set-Content|Add-Content|New-Item|Export-|WebClient|curl/i);
    expect(PREFLIGHT_PS1).not.toMatch(/site-token|registry-credential|FEDLIFY_SITE|Get-Content|SecureString/i);
    expect(PREFLIGHT_PS1).toContain("[a-z]+://"); // scheme stripped, host validated against an allowlist pattern
    expect(PREFLIGHT_PS1).toContain("^[A-Za-z0-9._-]+$");
  });
  it("has balanced brackets (a crude parse check, because there is no PowerShell here)", () => {
    const code = PREFLIGHT_PS1.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").replace(/'(?:[^'\n]|'')*'/g, "''").replace(/"(?:[^"\n`]|`.)*"/g, '""');
    for (const [o, c] of [["{", "}"], ["(", ")"], ["[", "]"]]) expect(code.split(o).length).toBe(code.split(c).length);
  });
});

describe("public Get ready page and downloads", () => {
  it("serves exactly the tested scripts as text, with the hashes the page prints", async () => {
    const sh = getSh();
    const ps = getPs1();
    expect(await sh.text()).toBe(PREFLIGHT_SH);
    expect(await ps.text()).toBe(PREFLIGHT_PS1);
    expect(sh.headers.get("content-type")).toContain("text/x-shellscript");
    expect(ps.headers.get("content-type")).toContain("text/plain");
    for (const r of [sh, ps]) {
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-disposition")).toContain("attachment");
    }
    expect(PREFLIGHT_SH_SHA256).toBe(sha256(PREFLIGHT_SH));
    expect(PREFLIGHT_PS1_SHA256).toBe(sha256(PREFLIGHT_PS1));
    const html = renderToStaticMarkup(GetReadyPage());
    expect(html).toContain(PREFLIGHT_SH_SHA256);
    expect(html).toContain(PREFLIGHT_PS1_SHA256);
    expect(html).toContain('href="/get-ready/preflight.sh"');
    expect(html).toContain('href="/get-ready/preflight.ps1"');
  });

  it("has Windows, macOS and Linux sections and states the Windows path, the ARM limit and the GPU opt-in plainly", () => {
    expect(OS_GUIDES.map((o) => o.id)).toEqual(["windows", "macos", "linux"]);
    const html = renderToStaticMarkup(GetReadyPage());
    for (const id of ["windows", "macos", "linux", "architecture", "gpu", "headless", "helper"]) expect(html).toContain(`id="${id}"`);
    const windows = OS_GUIDES[0]!;
    expect(windows.steps.join(" ")).toContain("WSL 2");
    expect(windows.steps.join(" ")).toContain("no native PowerShell version");
    expect(windows.steps.join(" ")).toContain("WSL integration");
    expect(windows.verified).toMatch(/Not verified/);
    for (const os of OS_GUIDES) expect(os.verified).toMatch(/Not verified/);
    expect(ARCHITECTURE_STATEMENT).toContain("amd64 only");
    expect(ARCHITECTURE_STATEMENT).toContain("has not been built");
    expect(GPU_STATEMENT).toContain("CPU is the default");
    expect(GPU_STATEMENT).toContain("has not been run on a GPU host");
    expect(html).toContain("cannot install Docker for you");
  });

  it("is public: lives outside the (app) group, which holds the sign-in guard", () => {
    expect(existsSync(path.resolve(__dirname, "../src/app/get-ready/page.tsx"))).toBe(true);
    expect(existsSync(path.resolve(__dirname, "../src/app/(app)/get-ready"))).toBe(false);
  });
});
