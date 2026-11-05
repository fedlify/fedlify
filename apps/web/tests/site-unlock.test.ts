import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { zipFiles } from "@/lib/archive";
import { buildOuterKitFiles } from "@/lib/site-kit";
import { AGE_APK_VERSION, AGE_CONTAINER_SCRIPT, AGE_DOCKER_IMAGE, AGE_SHA256_AARCH64, AGE_SHA256_X86_64, UNLOCK_PS1, UNLOCK_SH } from "@/lib/site-unlock-script";

// Runs unlock.sh under real bash (macOS /bin/bash is 3.2) with stand-ins for `age` and `docker`. The stand-ins model the
// observable behaviour of age -d: success writes the plaintext, a wrong passphrase exits 1 WITHOUT writing anything, and a
// tampered file writes a partial plaintext and then exits 1 (the worst case for "no partial output").
// The passphrase is not an input of this test at all: age reads it from the terminal, which is the property under test.
const bashes = [...new Set(["/bin/bash", "/opt/homebrew/bin/bash", "bash"])].filter((b) => b === "bash" || existsSync(b));

let root: string;
let work: string;
let bin: string;
let innerZip: Buffer;

function fake(name: string, body: string) {
  writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(path.join(bin, name), 0o755);
}

// $FAKE_AGE_MODE: ok | wrong | tamper | garbage
const AGE_BODY = `
# args: -d -o OUT IN
[ "$1" = "-d" ] && [ "$2" = "-o" ] || { echo "bad args" >&2; exit 2; }
echo "$@" >> "$FAKE_LOG"
out="$3"; in="$4"
case "$FAKE_AGE_MODE" in
  ok) cp "$in" "$out"; exit 0;;
  wrong) echo "age: error: incorrect passphrase" >&2; exit 1;;
  tamper) head -c 100 "$in" > "$out"; echo "age: error: file modified" >&2; exit 1;;
  garbage) echo "not a zip" > "$out"; exit 0;;
esac
exit 3`;

function setupWork(zipBody: Buffer = innerZip) {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, "unlock.sh"), UNLOCK_SH, { mode: 0o755 });
  writeFileSync(path.join(work, "kit.zip.age"), zipBody); // the stand-in "decrypts" by copying, so the fixture is the plaintext zip
}

function unlock(shell: string, args: string[] = [], env: Record<string, string> = {}, extraPath = bin) {
  return spawnSync(shell, [path.join(work, "unlock.sh"), ...args], {
    cwd: work,
    encoding: "utf8",
    env: { PATH: `${extraPath}:/usr/bin:/bin`, HOME: root, FAKE_LOG: path.join(root, "calls.log"), ...env } as unknown as NodeJS.ProcessEnv
  });
}

const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
const leftovers = () => readdirSync(work).filter((n) => !["unlock.sh", "kit.zip.age"].includes(n));

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fedlify-unlock-"));
  work = path.join(root, "download");
  bin = path.join(root, "bin");
  mkdirSync(bin);
  fake("age", AGE_BODY);
  innerZip = await zipFiles({
    "fedlify-runner.sh": "#!/usr/bin/env bash\necho hi\n",
    ".env": "FEDLIFY_DATA_DIR=./data\n",
    ".fedlify/registry-credential": "robot\nsecret-pass\n",
    "nvflare/startup/fed_client.json": "{}"
  });
});
beforeEach(() => {
  setupWork();
  rmSync(path.join(root, "calls.log"), { force: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("unlock scripts (static)", () => {
  it("parse, pin the same digest, and never take the passphrase from an argument, variable or file", () => {
    for (const shell of bashes) execFileSync(shell, ["-n", path.join(work, "unlock.sh")]);
    expect(AGE_DOCKER_IMAGE).toMatch(/^docker\.io\/library\/alpine@sha256:[0-9a-f]{64}$/);
    expect(UNLOCK_SH).toContain(AGE_DOCKER_IMAGE);
    expect(UNLOCK_PS1).toContain(AGE_DOCKER_IMAGE);
    for (const script of [UNLOCK_SH, UNLOCK_PS1]) {
      expect(script).not.toMatch(/read\s+-s|Read-Host|--passphrase|AGE_PASSPHRASE|FEDLIFY_PASSPHRASE|-e\s+\w*PASS/i);
      expect(script).toMatch(/restrict|chmod 700|icacls/i);
    }
    expect(UNLOCK_PS1).toContain("icacls.exe");
    expect(UNLOCK_PS1).toContain("/inheritance:r");
    expect(UNLOCK_SH).toContain("umask 077");
  });

  it("the in-container script pins the age package version and a per-architecture sha256, and is identical in both scripts", () => {
    expect(AGE_CONTAINER_SCRIPT).toContain(`apk add --no-cache -q ${AGE_APK_VERSION}`);
    expect(AGE_APK_VERSION).toMatch(/^age=\d+\.\d+\.\d+-r\d+$/);
    expect(AGE_SHA256_X86_64).toMatch(/^[0-9a-f]{64}$/);
    expect(AGE_SHA256_AARCH64).toMatch(/^[0-9a-f]{64}$/);
    expect(AGE_SHA256_X86_64).not.toBe(AGE_SHA256_AARCH64);
    expect(AGE_CONTAINER_SCRIPT).toContain(AGE_SHA256_X86_64);
    expect(AGE_CONTAINER_SCRIPT).toContain(AGE_SHA256_AARCH64);
    expect(AGE_CONTAINER_SCRIPT).toContain("sha256sum -c");
    // The hash check comes before age runs. Only single quotes, so Windows PowerShell 5.1 passes it intact.
    expect(AGE_CONTAINER_SCRIPT.indexOf("sha256sum -c")).toBeLessThan(AGE_CONTAINER_SCRIPT.indexOf("age -d"));
    expect(AGE_CONTAINER_SCRIPT).not.toContain('"');
    expect(UNLOCK_SH).toContain(AGE_CONTAINER_SCRIPT);
    expect(UNLOCK_PS1).toContain(AGE_CONTAINER_SCRIPT);
    expect(UNLOCK_SH).not.toContain("__CONTAINER_SCRIPT__");
    expect(UNLOCK_PS1).not.toContain("__CONTAINER_SCRIPT__");
    // The one digest in the scripts is the exported one.
    const digest = AGE_DOCKER_IMAGE.slice(AGE_DOCKER_IMAGE.indexOf("alpine@"));
    for (const script of [UNLOCK_SH, UNLOCK_PS1]) expect([...script.matchAll(/alpine@sha256:[0-9a-f]{64}/g)].map((m) => m[0])).toEqual([digest]);
  });

  it("outer archive holds only the encrypted kit, the two scripts and a README with no secret", async () => {
    const files = buildOuterKitFiles({ siteName: "Hospital 73", studyTitle: "HF", encryptedKit: Buffer.from("ciphertext") });
    expect(Object.keys(files).sort()).toEqual(["README.txt", "kit.zip.age", "unlock.sh", "unlock.ps1"].sort());
    const readme = String(files["README.txt"]);
    expect(readme).toContain("different channel");
    expect(readme).not.toMatch(/token|robot|password:|[a-z]+-[a-z]+-[a-z]+-[a-z]+-[a-z]+-[a-z]+-[a-z]+/i);
  });
});

for (const shell of bashes) {
  describe(`unlock.sh under ${shell}`, { timeout: 30_000 }, () => {
    it("unlocks into a private directory: 0700 directories, 0600 files, no staging left", () => {
      const result = unlock(shell, [], { FAKE_AGE_MODE: "ok" });
      expect(result.status, result.stderr).toBe(0);
      const out = path.join(work, "fedlify-site-kit");
      expect(mode(out)).toBe("700");
      expect(mode(path.join(out, ".fedlify"))).toBe("700");
      expect(mode(path.join(out, "nvflare/startup"))).toBe("700");
      expect(mode(path.join(out, ".fedlify/registry-credential"))).toBe("600");
      expect(mode(path.join(out, ".env"))).toBe("600");
      expect(mode(path.join(out, "fedlify-runner.sh"))).toBe("700");
      expect(readFileSync(path.join(out, ".fedlify/registry-credential"), "utf8")).toBe("robot\nsecret-pass\n");
      expect(leftovers()).toEqual(["fedlify-site-kit"]);
      expect(result.stdout).not.toContain("secret-pass");
    });

    it("wrong passphrase fails closed and leaves nothing", () => {
      const result = unlock(shell, [], { FAKE_AGE_MODE: "wrong" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Nothing was written");
      expect(leftovers()).toEqual([]);
    });

    it("tampered file that produced partial output fails closed and leaves nothing", () => {
      const result = unlock(shell, [], { FAKE_AGE_MODE: "tamper" });
      expect(result.status).toBe(1);
      expect(leftovers()).toEqual([]);
    });

    it("rejects output that is not a zip, and a zip that is not a Fedlify kit", async () => {
      expect(unlock(shell, [], { FAKE_AGE_MODE: "garbage" }).status).toBe(1);
      expect(leftovers()).toEqual([]);
      setupWork(await zipFiles({ "other.txt": "x" }));
      const other = unlock(shell, [], { FAKE_AGE_MODE: "ok" });
      expect(other.status).toBe(1);
      expect(other.stderr).toContain("not a Fedlify site kit");
      expect(leftovers()).toEqual([]);
    });

    it("never overwrites an existing directory", () => {
      mkdirSync(path.join(work, "fedlify-site-kit"));
      writeFileSync(path.join(work, "fedlify-site-kit/keep.txt"), "mine");
      const result = unlock(shell, [], { FAKE_AGE_MODE: "ok" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("already exists");
      expect(readFileSync(path.join(work, "fedlify-site-kit/keep.txt"), "utf8")).toBe("mine");
    });

    it("honours an output directory argument and passes only file paths to age", () => {
      const result = unlock(shell, [path.join(root, "custom-out")], { FAKE_AGE_MODE: "ok" });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(path.join(root, "custom-out/fedlify-runner.sh"))).toBe(true);
      const call = readFileSync(path.join(root, "calls.log"), "utf8").trim();
      expect(call).toMatch(/^-d -o \S+\/kit\.zip \S+\/kit\.zip\.age$/);
      rmSync(path.join(root, "custom-out"), { recursive: true, force: true });
    });

    it("without age falls back to Docker with the pinned image, no tty-less secrets, and the same fail-closed rules", () => {
      const dockerBin = path.join(root, "bin-docker");
      mkdirSync(dockerBin, { recursive: true });
      writeFileSync(
        path.join(dockerBin, "docker"),
        `#!/bin/sh
[ "$1" = "info" ] && exit 0
[ "$1" = "run" ] || exit 9
echo "$@" >> "$FAKE_LOG"
stage=""; src=""
for a in "$@"; do case "$a" in *:/work) stage="\${a%:/work}";; *:/in/kit.zip.age:ro) src="\${a%:/in/kit.zip.age:ro}";; esac; done
case "$FAKE_AGE_MODE" in
  ok) cp "$src" "$stage/kit.zip"; exit 0;;
  tamper) head -c 100 "$src" > "$stage/kit.zip"; exit 1;;
  net) exit 70;;
  sum) exit 71;;
  dockerfail) exit 125;;
  *) exit 1;;
esac
`,
        { mode: 0o755 }
      );
      const tty = { FEDLIFY_UNLOCK_SKIP_TTY_CHECK: "1" };
      const ok = unlock(shell, [], { FAKE_AGE_MODE: "ok", ...tty }, dockerBin);
      expect(ok.status, ok.stderr).toBe(0);
      expect(existsSync(path.join(work, "fedlify-site-kit/fedlify-runner.sh"))).toBe(true);
      const call = readFileSync(path.join(root, "calls.log"), "utf8");
      expect(call).toContain(AGE_DOCKER_IMAGE);
      expect(call).toContain("-it");
      expect(call).toContain("--rm");
      rmSync(path.join(work, "fedlify-site-kit"), { recursive: true, force: true });
      const bad = unlock(shell, [], { FAKE_AGE_MODE: "tamper", ...tty }, dockerBin);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("wrong passphrase");
      expect(leftovers()).toEqual([]);
      // Infrastructure failures are named as such and never blamed on the passphrase.
      for (const [fakeMode, expected] of [["net", "could not install age"], ["sum", "did not match the pinned checksum"], ["dockerfail", "Docker could not run"]] as const) {
        const result = unlock(shell, [], { FAKE_AGE_MODE: fakeMode, ...tty }, dockerBin);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expected);
        expect(result.stderr).not.toContain("wrong passphrase");
        expect(leftovers()).toEqual([]);
      }
      // Without a terminal (ssh without -t, piped stdin) the Docker route stops before running anything.
      rmSync(path.join(root, "calls.log"), { force: true });
      const noTty = unlock(shell, [], { FAKE_AGE_MODE: "ok" }, dockerBin);
      expect(noTty.status).toBe(1);
      expect(noTty.stderr).toContain("interactive terminal");
      expect(existsSync(path.join(root, "calls.log"))).toBe(false);
      expect(leftovers()).toEqual([]);
    });

    it("fails clearly when neither age nor Docker exists", () => {
      const empty = path.join(root, "bin-empty");
      mkdirSync(empty, { recursive: true });
      const result = unlock(shell, [], { FAKE_AGE_MODE: "ok" }, empty);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("neither age nor a running Docker");
      expect(leftovers()).toEqual([]);
    });
  });
}
