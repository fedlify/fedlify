import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { zipFiles } from "@/lib/archive";
import { buildOuterKitFiles, outerKitModes } from "@/lib/site-kit";
import { PREFLIGHT_PS1, PREFLIGHT_SH } from "@/lib/site-preflight-script";
import { PUBLISHED_RUNNER_SCRIPT } from "@/lib/site-runner-script";
import { FEDLIFY_RUNNER_PS1, GPU_COMPOSE_YML, HELPER_BRIDGE_SH, START_HELPER_PS1, helperComposeYml, isPinnedImage, startHelperSh, unlockHeadlessSh } from "@/lib/site-helper-scripts";

// Bash scripts run for real under bash with fake docker and a fake runner. PowerShell scripts have NO runtime test here: no
// PowerShell exists on this machine, so they get static checks only and stay unverified.
const IMAGE = "ghcr.io/example/fedlify-site-helper@sha256:" + "b".repeat(64);
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const PASS = "orbit-canary-passphrase-77-xyzzy";
const bashes = [...new Set(["/bin/bash", "bash"])];

let root: string;
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
function write(file: string, body: string, m = 0o644) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, { mode: m });
  chmodSync(file, m);
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "fedlify-helper-scripts-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("pinned helper image", () => {
  it("accepts only digest-pinned references", () => {
    expect(isPinnedImage(IMAGE)).toBe(true);
    for (const bad of [undefined, "", "ghcr.io/x/y:latest", "ghcr.io/x/y", "ghcr.io/x/y@sha256:abc", `x y@sha256:${"b".repeat(64)}`, `$(id)@sha256:${"b".repeat(64)}`, `a"b@sha256:${"b".repeat(64)}`]) expect(isPinnedImage(bad as string)).toBe(false);
  });

  it("the outer zip ships the helper and headless files only with a pinned image", () => {
    const base = { siteName: "H", studyTitle: "S", encryptedKit: Buffer.from("x") };
    const kitFiles = { "fedlify-runner.sh": "#!/usr/bin/env bash\necho r\n", "docker-compose.yml": "services: {}\n", ".env": "A=1\n", ".fedlify/registry-credential": "robot\nSECRET-PW\n" };
    const plain = Object.keys(buildOuterKitFiles(base)).sort();
    expect(plain).toEqual(["README.txt", "kit.zip.age", "unlock.ps1", "unlock.sh"]);
    expect(Object.keys(buildOuterKitFiles({ ...base, helperImage: "ghcr.io/x/y:latest", kitFiles })).sort()).toEqual(plain);
    // without the kit files there is nothing to pin the runner against, so the helper is not shipped at all
    expect(Object.keys(buildOuterKitFiles({ ...base, helperImage: IMAGE })).sort()).toEqual(plain);
    expect(Object.keys(buildOuterKitFiles({ ...base, helperImage: IMAGE, kitFiles: { ".env": "A=1\n" } })).sort()).toEqual(plain);
    const withHelper = buildOuterKitFiles({ ...base, helperImage: IMAGE, kitFiles });
    expect(Object.keys(withHelper).sort()).toEqual([...plain, "docker-compose.helper.yml", "fedlify-helper-bridge.sh", "fedlify-kit-pins.txt", "start-helper.ps1", "start-helper.sh", "unlock-headless.sh"].sort());
    // pins cover what the host runs or sources, and never a secret
    const pins = String(withHelper["fedlify-kit-pins.txt"]);
    expect(pins).toContain(`${sha(kitFiles["fedlify-runner.sh"])}  fedlify-runner.sh`);
    expect(pins).toContain(`${sha(kitFiles[".env"])}  .env`);
    expect(pins).not.toContain("registry-credential");
    expect(pins).not.toContain(sha(kitFiles[".fedlify/registry-credential"]));
    expect(String(withHelper["start-helper.sh"])).toContain(`HELPER_IMAGE="${IMAGE}"`);
    expect(String(withHelper["unlock-headless.sh"])).toContain(`HELPER_IMAGE="${IMAGE}"`);
    expect(String(withHelper["README.txt"])).toContain("127.0.0.1 only");
    expect(String(withHelper["README.txt"])).toContain("WSL 2");
  });
});

describe("outer zip: scripts are executable after a real unzip", () => {
  it("unzip restores the executable bit on every script the README tells people to run directly", async () => {
    const files = buildOuterKitFiles({ siteName: "H", studyTitle: "S", encryptedKit: Buffer.from("x"), helperImage: IMAGE, kitFiles: { "fedlify-runner.sh": "#!/bin/sh\n" } });
    const dir = mkdtempSync(path.join(root, "unzip-"));
    writeFileSync(path.join(dir, "kit.zip"), await zipFiles(files, outerKitModes(files)));
    execFileSync("unzip", ["-q", path.join(dir, "kit.zip"), "-d", path.join(dir, "out")]);
    for (const f of ["unlock.sh", "start-helper.sh", "fedlify-helper-bridge.sh", "unlock-headless.sh"]) expect(statSync(path.join(dir, "out", f)).mode & 0o111, f).not.toBe(0);
    expect(statSync(path.join(dir, "out", "kit.zip.age")).mode & 0o111).toBe(0);
    expect(statSync(path.join(dir, "out", "README.txt")).mode & 0o111).toBe(0);
  });
  it("the join-package route builds the outer zip with those modes", () => {
    const route = readFileSync(path.resolve(__dirname, "../src/app/api/v1/sites/[siteId]/join-package/route.ts"), "utf8");
    expect(route).toContain("outerKitModes(outerFiles)");
    expect(route).toContain("kitFiles: startupFiles");
  });
});

describe("helper compose file (profile ui)", () => {
  const compose = helperComposeYml();
  it("is gated by the ui profile, publishes one port on loopback only, and has no docker.sock", () => {
    expect(compose).toContain('profiles: ["ui"]');
    const ports = compose.split("\n").filter((l) => /^\s+- "/.test(l) && l.includes(":8765"));
    expect(ports).toHaveLength(1);
    expect(ports[0]).toContain('"127.0.0.1:${FEDLIFY_HELPER_PORT:-8765}:8765"');
    expect(compose).not.toMatch(/docker\.sock|privileged|network_mode|0\.0\.0\.0|pid: host|cap_add/);
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("cap_drop: [ALL]");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain("./data:/data:ro");
    expect(compose).toContain("./kit.zip.age:/in/kit.zip.age:ro");
  });
  it("gives the container the queue and a staging folder for the kit, never the unlocked kit's final location", () => {
    expect(compose).toContain("./helper-state/kit:/kit");
    expect(compose).toContain("./helper-state/queue:/queue");
    expect(compose).not.toMatch(/\.\/fedlify-site-kit/);
  });
  it("labels the bind mounts only through variables that start-helper.sh sets on SELinux hosts", () => {
    expect(compose).toContain("./kit.zip.age:/in/kit.zip.age:ro${FEDLIFY_SEL_RO:-}");
    expect(compose).toContain("./data:/data:ro${FEDLIFY_SEL_RO:-}");
    expect(compose).toContain("./helper-state/kit:/kit${FEDLIFY_SEL_RW:-}");
    expect(compose).toContain("./helper-state/queue:/queue${FEDLIFY_SEL_RW:-}");
    expect(compose).not.toMatch(/:z"|,z"/); // no label is hard-coded: Docker Desktop on macOS gets none
  });
  it("does not claim that Docker blocks outbound traffic, because it does not", () => {
    expect(compose).not.toMatch(/makes no outbound calls/);
    expect(compose).toContain("NOT enforced by Docker");
    expect(String(buildOuterKitFiles({ siteName: "H", studyTitle: "S", encryptedKit: Buffer.from("x"), helperImage: IMAGE, kitFiles: { "fedlify-runner.sh": "x" } })["README.txt"])).not.toContain("sends nothing anywhere");
  });
  it("the kit's own compose file does not start the helper, and GPU is a separate file", () => {
    expect(GPU_COMPOSE_YML).toContain("driver: nvidia");
    expect(compose).not.toContain("nvidia");
  });
});

for (const shell of bashes) {
  describe(`helper bridge under ${shell}`, { timeout: 30_000 }, () => {
    let here: string;
    const Q = () => path.join(here, "helper-state/queue");
    const kit = () => path.join(here, "fedlify-site-kit");
    const staged = () => path.join(here, "helper-state/kit/fedlify-site-kit");
    const FAKE_RUNNER = `#!/usr/bin/env bash
echo "$@" >> "$(dirname "$0")/calls.log"
case "$1" in
  support-bundle) : > "fedlify-support-20261105T101500Z.tar.gz"; echo "bundle written" ;;
  flood) head -c 200000 /dev/zero | tr '\\0' 'a' ;;
  fail) echo "boom" >&2; exit 3 ;;
  *) echo "ran $*" ;;
esac
`;
    const ENV_BODY = "FEDLIFY_DATA_DIR=./data\nNVFLARE_SERVER=x:443\n";
    // The pin file lives next to the bridge (outside the container's mounts), exactly as buildOuterKitFiles ships it.
    function writePins(runner = FAKE_RUNNER) {
      write(path.join(here, "fedlify-kit-pins.txt"), `${sha(runner)}  fedlify-runner.sh\n${sha(ENV_BODY)}  .env\n`);
    }
    function stageKit(runner = FAKE_RUNNER) {
      write(path.join(staged(), "fedlify-runner.sh"), runner, 0o700);
      write(path.join(staged(), ".env"), ENV_BODY, 0o600);
      writePins(runner);
    }
    const bridge = (env: Record<string, string> = {}) =>
      spawnSync(shell, [path.join(here, "fedlify-helper-bridge.sh")], { cwd: here, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: root, FEDLIFY_BRIDGE_ONCE: "1", ...env } as unknown as NodeJS.ProcessEnv });
    const request = (id: string, body: string) => write(path.join(Q(), "requests", `${id}.cmd`), body, 0o600);
    const result = (id: string) => ({ rc: readFileSync(path.join(Q(), "results", `${id}.rc`), "utf8").trim(), out: readFileSync(path.join(Q(), "results", `${id}.out`), "utf8") });
    const calls = () => (existsSync(path.join(kit(), "calls.log")) ? readFileSync(path.join(kit(), "calls.log"), "utf8").trim().split("\n") : []);
    const ID = (n: number) => n.toString(16).padStart(16, "0");

    beforeEach(() => {
      here = mkdtempSync(path.join(root, "bridge-"));
      write(path.join(here, "fedlify-helper-bridge.sh"), HELPER_BRIDGE_SH, 0o755);
      mkdirSync(path.join(here, "data"));
      for (const d of ["requests", "results", "out"]) mkdirSync(path.join(Q(), d), { recursive: true });
    });

    it("parses", () => {
      execFileSync(shell, ["-n", path.join(here, "fedlify-helper-bridge.sh")]);
    });

    it("adopts the unlocked kit out of the container's mount, points it at ./data, and marks it unlocked", () => {
      stageKit();
      expect(bridge().status).toBe(0);
      expect(existsSync(staged())).toBe(false); // the container can no longer rewrite the runner this bridge executes
      expect(existsSync(path.join(kit(), "fedlify-runner.sh"))).toBe(true);
      expect(readFileSync(path.join(kit(), ".env"), "utf8")).toContain(`FEDLIFY_DATA_DIR='${here}/data'`);
      expect(readFileSync(path.join(kit(), ".env"), "utf8")).not.toContain("./data");
      expect(existsSync(path.join(Q(), "unlocked"))).toBe(true);
    });

    it("never overwrites an adopted kit with a second staged one", () => {
      stageKit();
      bridge();
      write(path.join(kit(), "marker"), "original");
      stageKit();
      write(path.join(staged(), "fedlify-runner.sh"), "#!/bin/sh\necho EVIL\n", 0o700);
      bridge();
      expect(readFileSync(path.join(kit(), "marker"), "utf8")).toBe("original");
      expect(readFileSync(path.join(kit(), "fedlify-runner.sh"), "utf8")).toBe(FAKE_RUNNER);
    });

    it("maps each allowed word to exactly one runner command", () => {
      stageKit();
      bridge();
      const map: Record<string, string> = { preflight: "preflight --json", status: "status --json", start: "start", stop: "stop", update: "update", logout: "logout", "support-bundle": "support-bundle", "support-bundle-logs": "support-bundle --include-logs" };
      let n = 1;
      for (const [word, args] of Object.entries(map)) {
        request(ID(n), `${word}\n`);
        bridge();
        expect(result(ID(n)).rc, word).toBe("0");
        expect(calls().at(-1), word).toBe(args);
        n++;
      }
    });

    it("refuses anything else without running it: extra words, shell syntax, odd ids", () => {
      stageKit();
      bridge();
      const hostile = ["rm -rf /", "start; touch pwned", "status --json", "status\nstart", "$(touch pwned)", "START", "", "flood", "agent", "unlock", "../../etc/passwd"];
      hostile.forEach((body, i) => request(ID(100 + i), `${body}\n`));
      write(path.join(Q(), "requests", "not-an-id.cmd"), "status\n", 0o600);
      write(path.join(Q(), "requests", `${ID(7)}x.cmd`), "status\n", 0o600);
      bridge();
      for (let i = 0; i < hostile.length; i++) {
        const body = hostile[i]!;
        const first = body.split("\n")[0]!; // the bridge reads one line, so "status\nstart" is the word `status`
        if (first === "status") continue;
        expect(result(ID(100 + i)).rc, JSON.stringify(body)).toBe("64");
      }
      expect(calls().filter((c) => c !== "status --json")).toEqual([]);
      expect(existsSync(path.join(here, "pwned"))).toBe(false);
      expect(existsSync(path.join(kit(), "pwned"))).toBe(false);
      expect(readdirSync(path.join(Q(), "results")).filter((f) => f.includes("not-an-id") || f.includes("x."))).toEqual([]);
      expect(readdirSync(path.join(Q(), "requests"))).toEqual([]);
    });

    it("reports 'not unlocked' instead of running anything before there is a kit", () => {
      request(ID(1), "start\n");
      bridge();
      expect(result(ID(1))).toEqual({ rc: "66", out: "The kit is not unlocked yet.\n" });
    });

    it("moves the typed site token into the kit as a 0600 file and removes the queue copy", () => {
      stageKit();
      write(path.join(Q(), "site-token"), "tok-CANARY-0123456789abcdef", 0o600);
      bridge();
      const tokenFile = path.join(kit(), ".fedlify/site-token");
      expect(readFileSync(tokenFile, "utf8")).toBe("tok-CANARY-0123456789abcdef");
      expect(mode(tokenFile)).toBe("600");
      expect(mode(path.join(kit(), ".fedlify"))).toBe("700");
      expect(existsSync(path.join(Q(), "site-token"))).toBe(false);
      expect(existsSync(path.join(Q(), "token-installed"))).toBe(true);
    });

    it("keeps a failing command's exit code and output, caps output, and serialises start/stop", () => {
      stageKit();
      bridge();
      // the fake runner treats unknown words as 'ran'; use the lock path to prove serialisation
      mkdirSync(path.join(Q(), "lock.d"));
      request(ID(1), "stop\n");
      request(ID(2), "status\n");
      bridge();
      expect(result(ID(1)).rc).toBe("75");
      expect(result(ID(2)).rc).toBe("0"); // read-only commands are not blocked
      rmSync(path.join(Q(), "lock.d"), { recursive: true });
      write(path.join(kit(), "fedlify-runner.sh"), FAKE_RUNNER.replace('case "$1" in', 'case "$1" in\n  status) head -c 200000 /dev/zero | tr "\\\\0" "a"; exit 3 ;;'), 0o700);
      request(ID(3), "status\n");
      bridge();
      const r = result(ID(3));
      expect(r.rc).toBe("3");
      expect(Buffer.byteLength(r.out)).toBe(65536);
      expect(existsSync(path.join(Q(), "lock.d"))).toBe(false);
      expect(readdirSync(path.join(Q(), "results")).filter((f) => f.endsWith(".running") || f.endsWith(".full"))).toEqual([]);
    });

    it("hands a support bundle to the helper through the out folder and nothing else", () => {
      stageKit();
      bridge();
      request(ID(1), "support-bundle\n");
      bridge();
      expect(readdirSync(path.join(Q(), "out"))).toEqual(["fedlify-support-20261105T101500Z.tar.gz"]);
      expect(readdirSync(kit()).filter((f) => f.startsWith("fedlify-support-"))).toEqual([]);
    });

    it("passes the runner no secret in its environment, and still passes ordinary variables", () => {
      const runner = '#!/usr/bin/env bash\nenv | sort > "$(dirname "$0")/env.log"\n';
      stageKit(runner);
      bridge();
      request(ID(1), "status\n");
      bridge({ FEDLIFY_SITE_TOKEN: "canary-site-token-1", REGISTRY_PASSWORD: "canary-pw-2", MY_PASSPHRASE: "canary-pp-3", SOME_SECRET_KEY: "canary-sec-4", DOCKER_HOST: "unix:///keep/me" });
      const log = readFileSync(path.join(kit(), "env.log"), "utf8");
      expect(log).not.toMatch(/canary-/);
      expect(log).not.toContain("FEDLIFY_SITE_TOKEN");
      expect(log).toContain("DOCKER_HOST=unix:///keep/me");
    });

    it("refuses a staged kit whose runner does not match the pin: it is not adopted, not run, and removed", () => {
      stageKit();
      write(path.join(staged(), "fedlify-runner.sh"), "#!/usr/bin/env bash\necho pwned-by-staged-runner > ../../../victim.txt\n", 0o700);
      request(ID(1), "status\n");
      const res = bridge();
      expect(res.stdout).toContain("does not match its pin");
      expect(existsSync(kit())).toBe(false);
      expect(existsSync(staged())).toBe(false);
      expect(existsSync(path.join(here, "victim.txt"))).toBe(false);
      expect(result(ID(1)).rc).toBe("66");
      expect(existsSync(path.join(Q(), "unlocked"))).toBe(false);
    });

    it("refuses a staged kit whose .env was changed, because the runner sources it", () => {
      stageKit();
      write(path.join(staged(), ".env"), ENV_BODY + "touch pwned\n", 0o600);
      bridge();
      expect(existsSync(kit())).toBe(false);
    });

    it("refuses to adopt anything when the pin file is missing", () => {
      stageKit();
      rmSync(path.join(here, "fedlify-kit-pins.txt"));
      expect(bridge().stdout).toContain("pin");
      expect(existsSync(kit())).toBe(false);
    });

    it("refuses a staged kit that holds a symlink, even when every pinned file matches", () => {
      stageKit();
      symlinkSync("/etc/passwd", path.join(staged(), "innocent.txt"));
      expect(bridge().stdout).toContain("link or special file");
      expect(existsSync(kit())).toBe(false);
    });

    it("does not write through a symlink the container planted in the queue (the reported overwrite)", () => {
      stageKit();
      const victim = path.join(here, "victim.txt");
      writeFileSync(victim, "precious");
      const id = "0123456789abcdef";
      for (const name of [`${id}.full`, `${id}.out`, `${id}.rc.tmp`, `${id}.running`, "unlocked", "token-installed"]) {
        mkdirSync(path.join(Q(), "results"), { recursive: true });
        symlinkSync(victim, path.join(name.startsWith(id) ? path.join(Q(), "results") : Q(), name));
      }
      request(id, "status\n");
      write(path.join(Q(), "site-token"), "tok-CANARY-0123456789abcdef", 0o600);
      expect(bridge().status).toBe(0);
      expect(readFileSync(victim, "utf8")).toBe("precious");
      expect(result(id).rc).toBe("0");
    });

    it("installs no token that is a symlink (it would send an arbitrary file to Fedlify)", () => {
      stageKit();
      bridge();
      writeFileSync(path.join(here, "secret-file"), "SSH-PRIVATE-KEY");
      symlinkSync(path.join(here, "secret-file"), path.join(Q(), "site-token"));
      bridge();
      expect(existsSync(path.join(kit(), ".fedlify/site-token"))).toBe(false);
    });

    it("replaces a queue folder that the container turned into a symlink", () => {
      stageKit();
      bridge();
      const elsewhere = path.join(here, "elsewhere");
      mkdirSync(elsewhere);
      rmSync(path.join(Q(), "results"), { recursive: true });
      symlinkSync(elsewhere, path.join(Q(), "results"));
      request(ID(5), "status\n");
      bridge();
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(result(ID(5)).rc).toBe("0");
    });
  });
}

describe("start-helper.sh", { timeout: 30_000 }, () => {
  let here: string;
  let bin: string;
  beforeEach(() => {
    here = mkdtempSync(path.join(root, "start-"));
    bin = path.join(here, "fakebin");
    mkdirSync(bin);
    write(path.join(here, "start-helper.sh"), startHelperSh(IMAGE), 0o755);
    write(path.join(here, "fedlify-helper-bridge.sh"), HELPER_BRIDGE_SH, 0o755);
    write(path.join(here, "kit.zip.age"), "x");
    // `compose ... up` plays the container: it drops the one-time link file where the helper would.
    write(
      path.join(bin, "docker"),
      `#!/bin/sh
[ "$1" = "info" ] && exit 0
[ "$1" = "compose" ] && [ "$2" = "version" ] && { echo 2.29.1; exit 0; }
echo "$@" >> "$FAKE_LOG"
echo "IMAGE=$FEDLIFY_HELPER_IMAGE UID=$FEDLIFY_UID GID=$FEDLIFY_GID PORT=$FEDLIFY_HELPER_PORT SEL_RW=[$FEDLIFY_SEL_RW] SEL_RO=[$FEDLIFY_SEL_RO]" >> "$FAKE_LOG"
case " $* " in *" up "*) printf '%s\\n' "\${FAKE_LINK:-http://127.0.0.1:\${FEDLIFY_HELPER_PORT}/?t=$(printf 'a%.0s' $(seq 1 64))}" > helper-state/queue/helper-link;; esac
exit 0`,
      0o755
    );
  });
  const run = (args: string[], env: Record<string, string> = {}, shell = "/bin/bash") =>
    spawnSync(shell, [path.join(here, "start-helper.sh"), ...args], { cwd: here, encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, FAKE_LOG: path.join(here, "calls.log"), FEDLIFY_NO_BROWSER: "1", FEDLIFY_BRIDGE_ONCE: "1", ...env } as unknown as NodeJS.ProcessEnv });

  it("parses under every bash", () => {
    for (const shell of bashes) execFileSync(shell, ["-n", path.join(here, "start-helper.sh")]);
  });

  it("starts the ui profile with the pinned image, the host uid and a loopback port, then prints and removes the one-time link", () => {
    const res = run(["--foreground"]);
    expect(res.status, res.stderr).toBe(0);
    const log = readFileSync(path.join(here, "calls.log"), "utf8");
    expect(log).toContain("compose -f docker-compose.helper.yml --profile ui up -d --force-recreate");
    expect(log).toContain(`IMAGE=${IMAGE}`);
    expect(log).toMatch(/UID=\d+ GID=\d+ PORT=8765/);
    expect(res.stdout).toMatch(/^FEDLIFY_HELPER_URL=http:\/\/127\.0\.0\.1:8765\/\?t=a{64}$/m);
    expect(existsSync(path.join(here, "helper-state/queue/helper-link"))).toBe(false);
    expect(mode(path.join(here, "helper-state"))).toBe("700");
    expect(existsSync(path.join(here, "data"))).toBe(true);
  });

  it("refuses to open any address that is not the loopback link for the chosen port", () => {
    for (const link of ["http://evil.example:8765/?t=" + "a".repeat(64), "http://127.0.0.1:9999/?t=aa", "file:///etc/passwd"]) {
      const res = run(["--foreground"], { FAKE_LINK: link });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("unexpected address");
      expect(res.stdout).not.toContain("FEDLIFY_HELPER_URL");
    }
  });

  it("hands the browser a private redirect file, never the one-time link on a command line", () => {
    write(path.join(bin, "open"), '#!/bin/sh\necho "$@" >> "$FAKE_LOG.open"\ncp "$1" "$FAKE_LOG.copy"\n', 0o755);
    write(path.join(bin, "xdg-open"), '#!/bin/sh\necho "$@" >> "$FAKE_LOG.open"\ncp "$1" "$FAKE_LOG.copy"\n', 0o755);
    const res = run(["--foreground"], { FEDLIFY_NO_BROWSER: "" });
    expect(res.status, res.stderr).toBe(0);
    const argv = readFileSync(path.join(here, "calls.log.open"), "utf8");
    expect(argv).not.toContain("?t=");
    expect(argv).not.toMatch(/a{64}/);
    expect(argv.trim()).toBe(path.join(here, "helper-state/open-link.html"));
    const page = readFileSync(path.join(here, "helper-state/open-link.html"), "utf8");
    expect(page).toContain(`url=http://127.0.0.1:8765/?t=${"a".repeat(64)}`);
    expect(mode(path.join(here, "helper-state/open-link.html"))).toBe("600");
    expect(run(["stop"]).status).toBe(0);
    expect(existsSync(path.join(here, "helper-state/open-link.html"))).toBe(false);
  });

  it("labels the mounts only when SELinux is enforcing", () => {
    expect(run(["--foreground"]).status).toBe(0);
    expect(readFileSync(path.join(here, "calls.log"), "utf8")).toContain("SEL_RW=[] SEL_RO=[]");
    write(path.join(bin, "getenforce"), "#!/bin/sh\necho Enforcing\n", 0o755);
    rmSync(path.join(here, "calls.log"));
    expect(run(["--foreground"]).status).toBe(0);
    expect(readFileSync(path.join(here, "calls.log"), "utf8")).toContain("SEL_RW=[:z] SEL_RO=[,z]");
    write(path.join(bin, "getenforce"), "#!/bin/sh\necho Permissive\n", 0o755);
    rmSync(path.join(here, "calls.log"));
    expect(run(["--foreground"]).status).toBe(0);
    expect(readFileSync(path.join(here, "calls.log"), "utf8")).toContain("SEL_RW=[] SEL_RO=[]");
  });

  it("starts the bridge through bash, so a missing executable bit cannot stop it", () => {
    const text = startHelperSh(IMAGE);
    expect(text).toContain('exec bash "$HERE/fedlify-helper-bridge.sh"');
    expect(text).toContain('nohup bash "$HERE/fedlify-helper-bridge.sh"');
    write(path.join(here, "fedlify-helper-bridge.sh"), HELPER_BRIDGE_SH, 0o644);
    const res = run(["--foreground"]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).not.toMatch(/Permission denied/);
  });

  it("validates the port and the arguments, and stop only runs compose down", () => {
    expect(run(["--foreground"], { FEDLIFY_HELPER_PORT: "80" }).stderr).toContain("between 1024 and 65535");
    expect(run(["--foreground"], { FEDLIFY_HELPER_PORT: "8080; id" }).stderr).toContain("must be a number");
    expect(run(["--bogus"]).status).toBe(1);
    rmSync(path.join(here, "calls.log"), { force: true });
    expect(run(["stop"]).status).toBe(0);
    expect(readFileSync(path.join(here, "calls.log"), "utf8")).toContain("--profile ui down");
  });

  it("fails clearly without Docker or without the kit file", () => {
    const noDocker = spawnSync("/bin/bash", [path.join(here, "start-helper.sh"), "--foreground"], { cwd: here, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: root } as unknown as NodeJS.ProcessEnv });
    expect(noDocker.status).toBe(1);
    expect(noDocker.stderr).toContain("Docker is required");
    rmSync(path.join(here, "kit.zip.age"));
    expect(run(["--foreground"]).stderr).toContain("kit.zip.age is not next to this script");
  });
});

describe("unlock-headless.sh", { timeout: 30_000 }, () => {
  let here: string;
  let bin: string;
  let plainZip: Buffer;
  beforeAll(async () => {
    plainZip = await zipFiles({ "fedlify-runner.sh": "#!/usr/bin/env bash\necho hi\n", ".env": "A=1\n", ".fedlify/registry-credential": "robot\nsecret\n" });
  });
  beforeEach(() => {
    here = mkdtempSync(path.join(root, "headless-"));
    bin = path.join(here, "fakebin");
    mkdirSync(bin);
    write(path.join(here, "unlock-headless.sh"), unlockHeadlessSh(IMAGE), 0o755);
    write(path.join(here, "kit.zip.age"), "ciphertext");
    write(path.join(here, "pw"), `${PASS}\n`, 0o600);
    writeFileSync(path.join(here, "plain.zip"), plainZip);
    // The fake container reads stdin like unlock-cli: right passphrase writes /work/kit.zip, wrong one exits 1, empty exits 3.
    write(
      path.join(bin, "docker"),
      `#!/bin/sh
[ "$1" = "info" ] && exit 0
[ "$1" = "run" ] || exit 9
echo "$@" > "$FAKE_ARGV"
env > "$FAKE_ENV"
cat > "$FAKE_STDIN"
stage=""; for a in "$@"; do case "$a" in *:/work|*:/work:z) stage="\${a%%:/work*}";; esac; done
want="$(cat "$FAKE_WANT")"
[ -s "$FAKE_STDIN" ] || exit 3
[ "$(tr -d '\\r\\n' < "$FAKE_STDIN")" = "$want" ] || exit 1
cp "$FAKE_ZIP" "$stage/kit.zip"
exit 0`,
      0o755
    );
    write(path.join(here, "want"), PASS);
  });
  const run = (args: string[], shell = "/bin/bash") =>
    spawnSync(shell, [path.join(here, "unlock-headless.sh"), ...args], {
      cwd: here,
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, FAKE_ARGV: path.join(here, "argv"), FAKE_ENV: path.join(here, "env"), FAKE_STDIN: path.join(here, "stdin"), FAKE_WANT: path.join(here, "want"), FAKE_ZIP: path.join(here, "plain.zip") } as unknown as NodeJS.ProcessEnv
    });
  const leftovers = () => readdirSync(here).filter((n) => !["unlock-headless.sh", "kit.zip.age", "pw", "want", "plain.zip", "fakebin", "argv", "env", "stdin"].includes(n));

  it("parses under every bash", () => {
    for (const shell of bashes) execFileSync(shell, ["-n", path.join(here, "unlock-headless.sh")]);
  });

  for (const shell of bashes) {
    it(`unlocks with the passphrase on STDIN only: not in argv, not in the environment (${shell})`, () => {
      const res = run(["--passphrase-file", path.join(here, "pw")], shell);
      expect(res.status, res.stderr).toBe(0);
      expect(readFileSync(path.join(here, "stdin"), "utf8").trim()).toBe(PASS);
      const argv = readFileSync(path.join(here, "argv"), "utf8");
      expect(argv).not.toContain(PASS);
      expect(readFileSync(path.join(here, "env"), "utf8")).not.toContain(PASS);
      expect(res.stdout + res.stderr).not.toContain(PASS);
      expect(argv).toContain(IMAGE);
      expect(argv).toContain("--network none");
      expect(argv).toContain("--rm -i ");
      expect(argv).not.toMatch(/ -it | -t /);
      expect(argv).toContain("unlock-cli.mjs decrypt");
      expect(argv).toContain(":/in/kit.zip.age:ro");
      const kit = path.join(here, "fedlify-site-kit");
      expect(mode(kit)).toBe("700");
      expect(mode(path.join(kit, ".fedlify/registry-credential"))).toBe("600");
      expect(mode(path.join(kit, "fedlify-runner.sh"))).toBe("700");
      expect(leftovers()).toEqual(["fedlify-site-kit"]);
      rmSync(kit, { recursive: true });
    });
  }

  it("refuses a passphrase file other accounts can read, a symlink, an empty file, and a wrong passphrase, leaving nothing", () => {
    chmodSync(path.join(here, "pw"), 0o644);
    const open = run(["--passphrase-file", path.join(here, "pw")]);
    expect(open.status).toBe(1);
    expect(open.stderr).toContain("must be 400 or 600");
    expect(existsSync(path.join(here, "argv"))).toBe(false); // Docker was never started
    chmodSync(path.join(here, "pw"), 0o400);
    expect(run(["--passphrase-file", path.join(here, "pw")]).status).toBe(0);
    rmSync(path.join(here, "fedlify-site-kit"), { recursive: true });
    execFileSync("ln", ["-s", path.join(here, "pw"), path.join(here, "link")]);
    expect(run(["--passphrase-file", path.join(here, "link")]).stderr).toContain("not a symlink");
    rmSync(path.join(here, "link"));
    write(path.join(here, "empty"), "", 0o600);
    expect(run(["--passphrase-file", path.join(here, "empty")]).stderr).toContain("is empty");
    write(path.join(here, "bad"), "wrong-passphrase-value\n", 0o600);
    const wrong = run(["--passphrase-file", path.join(here, "bad")]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("wrong passphrase");
    expect(leftovers().filter((n) => n !== "link" && n !== "empty" && n !== "bad")).toEqual([]);
  });

  it("labels the mounts for SELinux only when it is enforcing", () => {
    expect(run(["--passphrase-file", path.join(here, "pw")]).status).toBe(0);
    let argv = readFileSync(path.join(here, "argv"), "utf8");
    expect(argv).toMatch(/:\/work -v /);
    expect(argv).toContain(":/in/kit.zip.age:ro ");
    rmSync(path.join(here, "fedlify-site-kit"), { recursive: true });
    write(path.join(bin, "getenforce"), "#!/bin/sh\necho Enforcing\n", 0o755);
    expect(run(["--passphrase-file", path.join(here, "pw")]).status).toBe(0);
    argv = readFileSync(path.join(here, "argv"), "utf8");
    expect(argv).toContain(":/work:z -v ");
    expect(argv).toContain(":/in/kit.zip.age:ro,z ");
  });

  it("does not accept the passphrase as an argument", () => {
    const res = run([PASS]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("usage");
    expect(res.stderr).not.toContain(PASS);
    expect(existsSync(path.join(here, "argv"))).toBe(false);
  });

  it("the script text has no way to read a passphrase from argv or the environment", () => {
    const text = unlockHeadlessSh(IMAGE);
    expect(text).not.toMatch(/FEDLIFY_PASSPHRASE|AGE_PASSPHRASE|-e\s+\w*PASS|--passphrase\b(?!-file)|read\s+-s/);
    expect(text).toContain('< "$PASSFILE"');
  });
});

describe("PowerShell launchers (static checks only; never run)", () => {
  const stripped = (s: string) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").replace(/'(?:[^'\n]|'')*'/g, "''");
  for (const [name, text] of [["start-helper.ps1", START_HELPER_PS1], ["fedlify-runner.ps1", FEDLIFY_RUNNER_PS1]] as const) {
    it(`${name} is marked unverified, uses WSL, and has balanced brackets`, () => {
      expect(text).toContain("UNVERIFIED");
      expect(text).toContain("wsl.exe");
      expect(text).toMatch(/not a port|launcher/);
      const code = stripped(text).replace(/"(?:[^"\n`]|`.)*"/g, '""');
      for (const [open, close] of [["{", "}"], ["(", ")"], ["[", "]"]]) expect(code.split(open).length, `${name} ${open}`).toBe(code.split(close).length);
      expect(text).not.toMatch(/Invoke-Expression|\biex\b|DownloadString|Invoke-WebRequest|Invoke-RestMethod|Set-ExecutionPolicy|-Verb RunAs/i);
    });
  }
  it("the helper launcher opens only a loopback one-time link", () => {
    expect(START_HELPER_PS1).toContain("http://127\\.0\\.0\\.1:");
    expect(START_HELPER_PS1).toContain("[0-9a-f]{64}");
    expect(START_HELPER_PS1).toContain("--foreground");
    expect(START_HELPER_PS1).toContain("-Stop");
  });
  it("Invoke-Runner prints the runner output and returns no value, so the exit code is not an array", () => {
    const fn = FEDLIFY_RUNNER_PS1.slice(FEDLIFY_RUNNER_PS1.indexOf("function Invoke-Runner"), FEDLIFY_RUNNER_PS1.indexOf("switch ($Command)"));
    expect(fn).toContain("| Out-Host");
    expect(fn).toContain("$script:RunnerExit = $LASTEXITCODE");
    expect(fn).not.toMatch(/return\s+\$LASTEXITCODE/);
    expect(FEDLIFY_RUNNER_PS1).not.toMatch(/\$code\s*=\s*Invoke-Runner|exit \(Invoke-Runner/);
    expect(FEDLIFY_RUNNER_PS1).toContain("exit $script:RunnerExit");
  });
  it("save-token hands wsl.exe a script with no double quote (Windows PowerShell 5.1 does not escape them)", () => {
    const line = FEDLIFY_RUNNER_PS1.split("\n").find((l) => l.includes("-e bash -c"))!;
    const script = line.slice(line.indexOf("-c '") + 3);
    expect(script).not.toContain('"');
    expect(script).toContain("site-token");
    expect(script).toContain("chmod 600");
  });
  it("the helper launcher relaxes ErrorActionPreference around the native call and opens the private redirect file, not the link", () => {
    const call = START_HELPER_PS1.indexOf("& wsl.exe");
    const before = START_HELPER_PS1.slice(0, call);
    expect(before.lastIndexOf("$ErrorActionPreference = 'Continue'")).toBeGreaterThan(before.lastIndexOf("$ErrorActionPreference = 'Stop'"));
    expect(START_HELPER_PS1).toContain("open-link.html");
    expect(START_HELPER_PS1).not.toMatch(/Start-Process\s+\$Matches/);
    expect(START_HELPER_PS1).toContain("exit $exitCode");
  });
  it("the runner wrapper allowlists commands and keeps the token out of arguments and the environment", () => {
    expect(FEDLIFY_RUNNER_PS1).toContain("$allowed = @(");
    expect(FEDLIFY_RUNNER_PS1).toContain("-AsSecureString");
    expect(FEDLIFY_RUNNER_PS1).toMatch(/\$plain \| & wsl\.exe/); // over stdin
    expect(FEDLIFY_RUNNER_PS1).not.toMatch(/FEDLIFY_SITE_TOKEN\s*=|\$env:FEDLIFY_SITE_TOKEN|WSLENV/);
    expect(FEDLIFY_RUNNER_PS1).toContain("FEDLIFY_NO_BG_AGENT");
  });
});

describe("agent-unit (real runner, bash)", () => {
  const unit = (dir: string, extraEnv: Record<string, string> = {}) => {
    write(path.join(dir, "fedlify-runner.sh"), PUBLISHED_RUNNER_SCRIPT, 0o755);
    write(path.join(dir, ".env"), "NVFLARE_SERVER=x:443\n", 0o600);
    return spawnSync("/bin/bash", ["./fedlify-runner.sh", "agent-unit"], { cwd: dir, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: root, ...extraEnv } as unknown as NodeJS.ProcessEnv });
  };
  it("quotes paths so a folder with a space survives systemd word splitting, and names the user", () => {
    const dir = path.join(mkdtempSync(path.join(root, "unit-")), "my kit");
    mkdirSync(dir);
    const res = unit(dir);
    expect(res.status, res.stderr).toBe(0);
    const real = execFileSync("/bin/bash", ["-c", "cd \"$1\" && pwd -P", "_", dir], { encoding: "utf8" }).trim();
    expect(res.stdout).toContain(`ExecStart="${real}/fedlify-runner.sh" agent`);
    expect(res.stdout).toContain(`Environment="FEDLIFY_SITE_TOKEN_FILE=${real}/.fedlify/site-token"`);
    expect(res.stdout).toContain(`WorkingDirectory=${real}\n`);
    if (process.getuid && process.getuid() !== 0) expect(res.stdout).toContain(`User=${execFileSync("id", ["-un"], { encoding: "utf8" }).trim()}\n`);
    expect(res.stdout).not.toMatch(/^ExecStart=[^"]/m);
  });
  it("refuses a path that a unit file cannot carry safely and doubles percent signs", () => {
    const bad = path.join(mkdtempSync(path.join(root, "unit-")), 'a"b');
    mkdirSync(bad);
    const res = unit(bad);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("cannot carry safely");
    const pct = path.join(mkdtempSync(path.join(root, "unit-")), "100%");
    mkdirSync(pct);
    expect(unit(pct).stdout).toContain("100%%/fedlify-runner.sh");
  });
});

describe("preflight.sh arguments and help", () => {
  const run = (args: string[]) => {
    const dir = mkdtempSync(path.join(root, "pf-"));
    write(path.join(dir, "preflight.sh"), PREFLIGHT_SH, 0o755);
    return spawnSync("/bin/bash", [path.join(dir, "preflight.sh"), ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: root } as unknown as NodeJS.ProcessEnv });
  };
  it("--help prints only the comment block, never code lines", () => {
    const res = run(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("usage: ./preflight.sh");
    expect(res.stdout).not.toMatch(/^set -u|^VERSION=/m);
    expect(res.stdout).not.toContain("#");
  });
  it("a flag that takes a value refuses a missing value instead of swallowing the next flag", () => {
    for (const args of [["--aggregator", "--json"], ["--registry", "--json"], ["--data", "--json"], ["--aggregator"], ["--aggregator", ""]]) {
      const res = run(args);
      expect(res.status, args.join(" ")).toBe(2);
      expect(res.stderr).toContain("needs a value");
      expect(res.stdout).not.toContain("cannot resolve");
    }
  });
});

describe("preflight.ps1 WSL check (static)", () => {
  it("does not count Docker Desktop's own WSL distributions as a usable WSL 2 distribution", () => {
    const at = PREFLIGHT_PS1.indexOf("$userDistros");
    expect(at).toBeGreaterThan(0);
    expect(PREFLIGHT_PS1).toContain("-notmatch 'docker-desktop'");
    expect(PREFLIGHT_PS1).toMatch(/if \(\$userDistros -match/);
    expect(PREFLIGHT_PS1).not.toMatch(/if \(\$list -match/);
  });
});
