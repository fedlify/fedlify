import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PUBLISHED_RUNNER_SCRIPT } from "@/lib/site-runner-script";

// Runs the generated runner under real bash (macOS /bin/bash is 3.2) against fake docker/curl/nc, never the real ones.
const hasBash = existsSync("/bin/bash");
const SECRET_TOKEN = "tok-SECRET-0123456789abcdefghijkl";
const SECRET_PASSWORD = "regpass-SECRET-xyz";

let root: string;
let kit: string;
let bin: string;
const bashes = [...new Set(["/bin/bash", "bash"])];

function fake(name: string, body: string) {
  writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(path.join(bin, name), 0o755);
}

function run(args: string[], env: Record<string, string> = {}, shell = "/bin/bash") {
  return spawnSync(shell, ["fedlify-runner.sh", ...args], {
    cwd: kit,
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root, FAKE_STATE: "running", FAKE_HEALTH: "healthy", ...env } as unknown as NodeJS.ProcessEnv
  });
}

function setupDocker() {
  fake(
    "docker",
    `case "$1 $2" in
  "compose version") echo "2.29.1"; exit 0;;
  "compose ps") echo cid123; exit 0;;
  "compose logs") printf 'INFO fine\\nERROR failed to read "patient_77.csv" row {"age": 71} at /data/x.csv user a@b.org token=abcdefghijklmnopqrstuvwxyz0123 id 1234567\\n'; exit 0;;
  "compose up") [ -n "$FAKE_COMPOSE_LOG" ] && echo "COMPOSE_FILE=$COMPOSE_FILE" >> "$FAKE_COMPOSE_LOG"; exit 0;;
  "compose down"|"compose pull") exit 0;;
  "info --format") case "$3" in *Runtimes*) if [ -n "$FAKE_NVIDIA_RUNTIME" ]; then echo '{"runc":{},"nvidia":{}}'; else echo '{"runc":{}}'; fi;; *) echo 8589934592;; esac; exit 0;;
esac
[ "$1" = "info" ] && exit 0
[ "$1" = "login" ] && { [ -n "$FAKE_LOGIN_ARGS" ] && echo "$@" > "$FAKE_LOGIN_ARGS"; if [ -n "$FAKE_LOGIN_STDIN" ]; then cat > "$FAKE_LOGIN_STDIN"; else cat >/dev/null; fi; exit 0; }
[ "$1" = "logout" ] && exit 0
if [ "$1" = "inspect" ]; then
  case "$3" in
    *State.Status*) echo "$FAKE_STATE";;
    *Health*) echo "$FAKE_HEALTH";;
    *RestartCount*) echo 2;;
    *Config.Image*) echo "harbor.example/study@sha256:abc";;
  esac
  exit 0
fi
case "$1" in version) echo 27.0.0; exit 0;; esac
exit 0`
  );
  fake("nc", `[ -n "$FAKE_NC_LOG" ] && echo "$@" >> "$FAKE_NC_LOG"; [ "$FAKE_NC" = "fail" ] && exit 1; exit 0`);
  fake("getent", `exit 0`);
  fake("nvidia-smi", `[ -n "$FAKE_GPUS" ] && { echo "GPU 0: Fake GPU (UUID: GPU-x)"; exit 0; }; exit 9`);
  fake("curl", `echo "$@" >> "$FAKE_CURL_ARGS"; cat > "$FAKE_CURL_STDIN"; printf '{"desiredImageDigest":null}\\n201'`);
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "fedlify-runner-"));
  kit = path.join(root, "kit");
  bin = path.join(root, "bin");
  mkdirSync(path.join(kit, "nvflare/startup"), { recursive: true });
  mkdirSync(path.join(kit, "data"));
  mkdirSync(bin);
  writeFileSync(path.join(kit, "nvflare/startup/fed_client.json"), "{}");
  writeFileSync(path.join(kit, "data/a.csv"), "age\n70\n");
  writeFileSync(
    path.join(kit, ".env"),
    [
      "FEDLIFY_HEARTBEAT_ENDPOINT=https://app.example/api/v1/sites/s1/heartbeat",
      "FEDLIFY_STUDY_IMAGE=harbor.example/study@sha256:abc",
      "FEDLIFY_DATA_DIR=./data",
      "FEDLIFY_REGISTRY=harbor.example",
      "NVFLARE_CLIENT_NAME=site_1",
      "NVFLARE_SERVER=agg.example:443",
      ""
    ].join("\n")
  );
  mkdirSync(path.join(kit, ".fedlify"), { recursive: true });
  writeFileSync(path.join(kit, ".fedlify/registry-credential"), `robot\n${SECRET_PASSWORD}\n`, { mode: 0o600 });
  writeFileSync(path.join(kit, "fedlify-runner.sh"), PUBLISHED_RUNNER_SCRIPT);
  chmodSync(path.join(kit, "fedlify-runner.sh"), 0o755);
  setupDocker();
});

afterAll(() => {
  const pidFile = path.join(kit, ".fedlify/agent.pid");
  if (existsSync(pidFile)) {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8").trim()));
    } catch {
      // already gone
    }
  }
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasBash)("site runner script", { timeout: 30_000 }, () => {
  it("parses under bash -n", () => {
    for (const shell of bashes) execFileSync(shell, ["-n", path.join(kit, "fedlify-runner.sh")]);
  });

  for (const shell of bashes) {
    it(`preflight --json passes against a healthy fake docker (${shell})`, () => {
      const result = run(["preflight", "--json"], { FAKE_CURL_ARGS: path.join(root, "a"), FAKE_CURL_STDIN: path.join(root, "b") }, shell);
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.ok).toBe(true);
      const ids = report.checks.map((c: { id: string }) => c.id);
      for (const id of ["docker", "compose", "kit_nvflare", "data_dir", "data_csv", "disk", "ram", "aggregator", "registry", "gpu"]) expect(ids).toContain(id);
      expect(report.checks.find((c: { id: string }) => c.id === "data_csv").detail).toContain("1 csv");
      expect(result.stdout).not.toContain(SECRET_PASSWORD);
    });
  }

  it("preflight fails with exit 1 when the aggregator port is blocked, and in human mode too", () => {
    const result = run(["preflight", "--json"], { FAKE_NC: "fail" });
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c: { id: string }) => c.id === "aggregator").status).toBe("fail");
    const human = run(["preflight"], { FAKE_NC: "fail" });
    expect(human.status).toBe(1);
    expect(human.stdout).toContain("[fail] aggregator");
  });

  it("probes the registry on its own port and tolerates a scheme or path in FEDLIFY_REGISTRY", () => {
    const envFile = path.join(kit, ".env");
    const original = readFileSync(envFile, "utf8");
    try {
      for (const [value, probe] of [["reg.example:5000", "reg.example 5000"], ["https://reg.example/v2/", "reg.example 443"], ["reg.example", "reg.example 443"]]) {
        writeFileSync(envFile, `${original}\nFEDLIFY_REGISTRY=${value}\n`);
        const log = path.join(root, `nc-${probe.replace(/\W/g, "_")}.log`);
        run(["preflight", "--json"], { FAKE_NC_LOG: log });
        expect(readFileSync(log, "utf8")).toContain(probe);
        expect(readFileSync(log, "utf8")).not.toContain(":443");
      }
    } finally {
      writeFileSync(envFile, original);
    }
  });

  it("warns that the agent does not survive a reboot and prints a systemd unit", () => {
    const report = JSON.parse(run(["preflight", "--json"]).stdout);
    expect(report.checks.find((c: { id: string }) => c.id === "agent_persistence").status).toBe("warn");
    const unit = run(["agent-unit"]).stdout;
    expect(unit).toContain("[Service]");
    expect(unit).toContain("ExecStart=");
    expect(unit).toContain("Restart=always");
  });

  it("preflight fails when Docker is missing", () => {
    // PATH without the fake docker: only the minimal system dirs.
    const result = spawnSync("/bin/bash", ["fedlify-runner.sh", "preflight", "--json"], {
      cwd: kit,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: root } as unknown as NodeJS.ProcessEnv
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).checks.find((c: { id: string }) => c.id === "docker").status).toBe("fail");
  });

  it("status --json derives CONNECTED, DEGRADED and OFFLINE from docker health", () => {
    const status = (env: Record<string, string>) => JSON.parse(run(["status", "--json"], env).stdout);
    expect(status({}).status).toBe("CONNECTED");
    expect(status({ FAKE_HEALTH: "unhealthy" }).status).toBe("DEGRADED");
    expect(status({ FAKE_STATE: "restarting" }).status).toBe("DEGRADED");
    expect(status({ FAKE_STATE: "exited" }).status).toBe("OFFLINE");
    expect(status({}).csvCount).toBe(1);
    expect(status({}).tokenPresent).toBe(false);
  });

  it("sends the real status, keeps the token off argv and in a 0600 file only", () => {
    const argsFile = path.join(root, "curl-args");
    const stdinFile = path.join(root, "curl-stdin");
    const env = { FAKE_CURL_ARGS: argsFile, FAKE_CURL_STDIN: stdinFile, FAKE_HEALTH: "unhealthy", FEDLIFY_SITE_TOKEN: SECRET_TOKEN };
    // `update` posts one heartbeat and needs no background agent.
    const result = run(["update"], env);
    expect(result.status).toBe(0);
    expect(readFileSync(argsFile, "utf8")).not.toContain(SECRET_TOKEN);
    expect(readFileSync(stdinFile, "utf8")).toContain(`x-site-token: ${SECRET_TOKEN}`);
    expect(readFileSync(path.join(kit, ".env"), "utf8")).not.toContain(SECRET_TOKEN);
    // start persists the token with mode 0600 and launches the agent; stop ends it and reports OFFLINE.
    const started = run(["start"], env);
    expect(started.status).toBe(0);
    const tokenFile = path.join(kit, ".fedlify/site-token");
    expect((statSync(tokenFile).mode & 0o777).toString(8)).toBe("600");
    const stopped = run(["stop"], { ...env, FAKE_STATE: "exited" });
    expect(stopped.status).toBe(0);
    expect(existsSync(path.join(kit, ".fedlify/agent.pid"))).toBe(false);
    // The agent exits on TERM once its current step ends; allow a moment.
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      alive = spawnSync("pgrep", ["-f", `${kit}/fedlify-runner.sh agent`]).status === 0;
      if (alive) spawnSync("sleep", ["0.1"]);
    }
    expect(alive).toBe(false);
  });

  it("logs in to the registry with the credential file, password on stdin only, and never from .env", () => {
    const args = path.join(root, "login-args");
    const stdin = path.join(root, "login-stdin");
    const env = { FAKE_LOGIN_ARGS: args, FAKE_LOGIN_STDIN: stdin, FAKE_CURL_ARGS: path.join(root, "a"), FAKE_CURL_STDIN: path.join(root, "b"), FEDLIFY_SITE_TOKEN: SECRET_TOKEN };
    expect(readFileSync(path.join(kit, ".env"), "utf8")).not.toMatch(/PASSWORD|SECRET|robot/i);
    const started = run(["start"], env);
    expect(started.status).toBe(0);
    expect(readFileSync(stdin, "utf8")).toBe(SECRET_PASSWORD);
    expect(readFileSync(args, "utf8")).toContain("-u robot");
    expect(readFileSync(args, "utf8")).toContain("--password-stdin");
    expect(readFileSync(args, "utf8")).not.toContain(SECRET_PASSWORD);
    expect(started.stdout + started.stderr).not.toContain(SECRET_PASSWORD);
    run(["stop"], { ...env, FAKE_STATE: "exited" });
    // Without the file (and no environment override) start fails closed with a clear message instead of logging in blank.
    const credFile = path.join(kit, ".fedlify/registry-credential");
    const saved = readFileSync(credFile);
    rmSync(credFile);
    try {
      const missing = run(["start"], env);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("no registry credential");
      const report = JSON.parse(run(["preflight", "--json"]).stdout);
      expect(report.checks.find((c: { id: string }) => c.id === "registry_credential").status).toBe("warn");
    } finally {
      writeFileSync(credFile, saved, { mode: 0o600 });
    }
  });

  it("logout removes the token file and never prints it", () => {
    expect(existsSync(path.join(kit, ".fedlify/site-token"))).toBe(true);
    const result = run(["logout"], { FAKE_CURL_ARGS: path.join(root, "a"), FAKE_CURL_STDIN: path.join(root, "b") });
    expect(result.status).toBe(0);
    expect(existsSync(path.join(kit, ".fedlify/site-token"))).toBe(false);
    expect(existsSync(path.join(kit, ".fedlify/registry-credential"))).toBe(false);
    expect(result.stdout + result.stderr).not.toContain(SECRET_TOKEN);
  });

  it("has no unlock command in this phase", () => {
    const result = run(["unlock"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage");
    expect(result.stderr).not.toContain("unlock |");
  });

  it("support-bundle contains only allowlisted facts and no secrets or data", () => {
    const env = { FEDLIFY_SITE_TOKEN: SECRET_TOKEN, FAKE_CURL_ARGS: path.join(root, "a"), FAKE_CURL_STDIN: path.join(root, "b") };
    writeFileSync(path.join(kit, ".fedlify-dummy"), "");
    mkdirSync(path.join(kit, ".fedlify"), { recursive: true });
    writeFileSync(path.join(kit, ".fedlify/site-token"), SECRET_TOKEN);
    const result = run(["support-bundle", "--include-logs"], env);
    expect(result.status).toBe(0);
    const archive = readdirSync(kit).find((f) => f.startsWith("fedlify-support-") && f.endsWith(".tar.gz"))!;
    expect(archive).toBeTruthy();
    const out = path.join(root, "extract");
    mkdirSync(out);
    execFileSync("tar", ["-xzf", path.join(kit, archive), "-C", out]);
    const dir = path.join(out, readdirSync(out)[0]);
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["README.txt", "client-log-redacted.txt", "compose-ps.txt", "config.txt", "environment.txt", "preflight.json", "status.json"]);
    const all = files.map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
    for (const forbidden of [SECRET_TOKEN, SECRET_PASSWORD, "patient_77", "\"age\"", "a@b.org", "/data/x.csv", "abcdefghijklmnopqrstuvwxyz0123", "1234567", "robot"]) {
      expect(all.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(readFileSync(path.join(dir, "client-log-redacted.txt"), "utf8")).toContain("error failed to read");
    expect(readFileSync(path.join(dir, "config.txt"), "utf8")).toContain("NVFLARE_SERVER=agg.example:443");
    // without --include-logs there is no log file at all
    const plain = run(["support-bundle"], env);
    expect(plain.status).toBe(0);
    expect(plain.stdout).not.toContain("client-log");
  });

  describe("GPU and architecture (phase 5)", () => {
    // Earlier tests log out, which deletes the credential file; restore it so `start` can log in to the fake registry.
    beforeEach(() => {
      mkdirSync(path.join(kit, ".fedlify"), { recursive: true });
      writeFileSync(path.join(kit, ".fedlify/registry-credential"), `robot\n${SECRET_PASSWORD}\n`, { mode: 0o600 });
    });
    const envFile = () => path.join(kit, ".env");
    const withEnv = (extra: string, fn: () => void) => {
      const original = readFileSync(envFile(), "utf8");
      writeFileSync(envFile(), `${original}\n${extra}\n`);
      try {
        fn();
      } finally {
        writeFileSync(envFile(), original);
      }
    };
    const startEnv = () => ({ FEDLIFY_SITE_TOKEN: SECRET_TOKEN, FAKE_CURL_ARGS: path.join(root, "a"), FAKE_CURL_STDIN: path.join(root, "b"), FAKE_COMPOSE_LOG: path.join(root, "compose.log") });
    const check = (id: string, env: Record<string, string> = {}) => JSON.parse(run(["preflight", "--json"], env).stdout).checks.find((c: { id: string }) => c.id === id);

    it("CPU is the default: a GPU host without FEDLIFY_GPU never gets the GPU override", () => {
      rmSync(path.join(root, "compose.log"), { force: true });
      writeFileSync(path.join(kit, "docker-compose.gpu.yml"), "services: {}\n");
      const result = run(["start"], { ...startEnv(), FAKE_GPUS: "1", FAKE_NVIDIA_RUNTIME: "1" });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(path.join(root, "compose.log"), "utf8").trim()).toBe("COMPOSE_FILE=");
      expect(check("gpu", { FAKE_GPUS: "1", FAKE_NVIDIA_RUNTIME: "1" }).detail).toContain("GPU use is off");
      run(["stop"], { ...startEnv(), FAKE_STATE: "exited" });
    });

    it("FEDLIFY_GPU=auto enables the override only when the GPU AND the container toolkit are detected", () => {
      withEnv("FEDLIFY_GPU=auto", () => {
        rmSync(path.join(root, "compose.log"), { force: true });
        expect(run(["start"], { ...startEnv(), FAKE_GPUS: "1", FAKE_NVIDIA_RUNTIME: "1" }).status).toBe(0);
        expect(readFileSync(path.join(root, "compose.log"), "utf8")).toContain("COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml");
        expect(check("gpu", { FAKE_GPUS: "1", FAKE_NVIDIA_RUNTIME: "1" }).status).toBe("pass");
        expect(JSON.parse(run(["status", "--json"], { FAKE_GPUS: "1", FAKE_NVIDIA_RUNTIME: "1" }).stdout).gpuActive).toBe(true);
        run(["stop"], { ...startEnv(), FAKE_STATE: "exited" });
        // GPU present but no toolkit, toolkit but no GPU, neither: all stay on CPU with a warning, never the override.
        for (const env of [{ FAKE_GPUS: "1" }, { FAKE_NVIDIA_RUNTIME: "1" }, {}] as Record<string, string>[]) {
          rmSync(path.join(root, "compose.log"), { force: true });
          expect(run(["start"], { ...startEnv(), ...env }).status).toBe(0);
          expect(readFileSync(path.join(root, "compose.log"), "utf8").trim()).toBe("COMPOSE_FILE=");
          expect(check("gpu", env).status).toBe("warn");
          expect(JSON.parse(run(["status", "--json"], env).stdout).gpuActive).toBe(false);
          run(["stop"], { ...startEnv(), FAKE_STATE: "exited" });
        }
      });
    });

    it("FEDLIFY_GPU=on fails closed instead of silently falling back to CPU", () => {
      withEnv("FEDLIFY_GPU=on", () => {
        const result = run(["start"], startEnv());
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("FEDLIFY_GPU=on");
        expect(check("gpu").status).toBe("fail");
      });
    });

    it("rejects an unknown FEDLIFY_GPU value", () => {
      withEnv("FEDLIFY_GPU=yes", () => {
        const result = run(["status"]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("FEDLIFY_GPU must be off, auto or on");
      });
    });

    it("warns on an ARM host when the image lists amd64 only, and stops warning once arm64 is listed", () => {
      const uname = (arch: string) => fake("uname", `[ "$1" = "-m" ] && { echo ${arch}; exit 0; }; exec /usr/bin/uname "$@"`);
      try {
        uname("arm64");
        expect(check("platform").status).toBe("warn");
        expect(check("platform").detail).toContain("emulation");
        withEnv("FEDLIFY_IMAGE_ARCHES=amd64,arm64", () => expect(check("platform").status).toBe("pass"));
        uname("x86_64");
        expect(check("platform").status).toBe("pass");
      } finally {
        rmSync(path.join(bin, "uname"), { force: true });
      }
    });

    it("FEDLIFY_NO_BG_AGENT=1 (used by the Windows wrapper) starts no background agent", () => {
      const result = run(["start"], { ...startEnv(), FEDLIFY_NO_BG_AGENT: "1" });
      expect(result.status).toBe(0);
      expect(existsSync(path.join(kit, ".fedlify/agent.pid"))).toBe(false);
      run(["stop"], { ...startEnv(), FAKE_STATE: "exited" });
    });
  });
});
