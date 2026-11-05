// Unlock scripts shipped in the OUTER (plaintext) zip next to kit.zip.age. They cannot be inside the encrypted part.
// tests/site-unlock.test.ts runs UNLOCK_SH under bash with a stand-in for age and docker.
// Source of truth is this file (the template text below); keep the pinned image identical in both scripts.

/**
 * Public image used when age is not installed: alpine 3.22 multi-arch index, resolved with
 * `docker buildx imagetools inspect docker.io/library/alpine:3.22` and checked with
 * `docker manifest inspect docker.io/library/alpine@<digest>` on 2026-11-04. No public image ships age, so inside the
 * container the script installs the exact package version below and then refuses to run `age` unless the binary matches
 * the sha256 recorded here per architecture (measured on 2026-11-04 by running that package in this image). A different
 * mirror payload therefore fails with exit 71 before the passphrase is typed.
 */
export const AGE_DOCKER_IMAGE = "docker.io/library/alpine@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f";
export const AGE_APK_VERSION = "age=1.2.1-r10";
export const AGE_SHA256_X86_64 = "fc2cbe5274f9a2e3ef6f83f89b76c5c89151403dd3fdc6f3613305c2fb82a809";
export const AGE_SHA256_AARCH64 = "7d644ed264ecee506278210e935ae81c2414b4818e5df55b7c19e9e5767b4d28";

// Runs inside the container (sh). Only single quotes, so the same text survives bash and Windows PowerShell 5.1.
// Exit codes: 70 package install failed (network), 71 binary does not match the pinned hash, else age's own status
// (1 = wrong passphrase or modified file). $0 and $1 are the host uid and gid.
export const AGE_CONTAINER_SCRIPT = [
  `apk add --no-cache -q ${AGE_APK_VERSION} >/dev/null 2>&1 || exit 70`,
  `case $(uname -m) in x86_64) want=${AGE_SHA256_X86_64};; aarch64) want=${AGE_SHA256_AARCH64};; *) exit 71;; esac`,
  `printf '%s  /usr/bin/age\\n' $want | sha256sum -c >/dev/null 2>&1 || exit 71`,
  `age -d -o /work/kit.zip /in/kit.zip.age || exit 1`,
  `chown $0:$1 /work/kit.zip 2>/dev/null || true`
].join("\n");

export const UNLOCK_SH = `#!/usr/bin/env bash
# Fedlify site kit: unlock. Works with bash 3.2 (macOS) and newer, on macOS and Linux.
# usage: ./unlock.sh [output-directory]      (default: ./fedlify-site-kit, must not exist yet)
#
# Decrypts kit.zip.age (age passphrase mode) into a private directory (0700 directories, 0600 files).
# The passphrase is typed at age's own prompt on your terminal. It is never a command-line argument, an environment
# variable or a file, so it cannot be read from the process list of this or any other process.
# Wrong passphrase or a modified file: nothing is left behind. Needs \`unzip\`, and either \`age\` or Docker.
set -euo pipefail
umask 077

# Public image pinned by content digest (alpine 3.22, multi-arch index). The container installs a pinned age package
# and checks its sha256 before running it (see AGE_CONTAINER_SCRIPT in site-unlock-script.ts).
AGE_IMAGE="docker.io/library/alpine@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f"

die() { echo "unlock: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/kit.zip.age"
OUT="\${1:-$HERE/fedlify-site-kit}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac

[ -f "$SRC" ] || die "kit.zip.age not found next to this script."
[ ! -e "$OUT" ] || die "$OUT already exists. Move it away or choose another directory: ./unlock.sh <new-directory>"
have unzip || die "unzip is required (macOS and most Linux have it; otherwise: apt install unzip)."

OUT_PARENT="$(dirname "$OUT")"
[ -d "$OUT_PARENT" ] && [ -w "$OUT_PARENT" ] || die "cannot write to $OUT_PARENT."

# Everything happens in a private staging directory next to the target. It is removed on every exit path, and the
# final directory appears only by one rename after the archive decrypted, passed its integrity test and was unpacked.
STAGE="$(mktemp -d "$OUT_PARENT/.fedlify-unlock.XXXXXX")" || die "cannot create a private working directory."
chmod 700 "$STAGE"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT
trap 'echo >&2; echo "unlock: interrupted, nothing was written." >&2; exit 130' INT TERM HUP

decrypted=0
if have age; then
  echo "Using local age. Enter the passphrase you received separately from this file."
  if age -d -o "$STAGE/kit.zip" "$SRC"; then decrypted=1; fi
  [ "$decrypted" = "1" ] || die "decryption failed (see age's message above): wrong passphrase, or the file was modified or damaged. Nothing was written."
elif have docker && docker info >/dev/null 2>&1; then
  if [ -z "\${FEDLIFY_UNLOCK_SKIP_TTY_CHECK:-}" ] && { [ ! -t 0 ] || [ ! -t 1 ]; }; then
    die "the Docker route needs an interactive terminal to type the passphrase (over ssh use: ssh -t). Nothing was written."
  fi
  echo "age is not installed; using Docker with a pinned public image (needs internet to install a pinned age inside the container)."
  echo "Enter the passphrase you received separately from this file."
  read -r -d '' CONTAINER_SCRIPT <<'FEDLIFY_EOS' || true
__CONTAINER_SCRIPT__
FEDLIFY_EOS
  rc=0
  docker run --rm -it --pull=missing -v "$STAGE:/work" -v "$SRC:/in/kit.zip.age:ro" "$AGE_IMAGE" \\
    sh -c "$CONTAINER_SCRIPT" "$(id -u)" "$(id -g)" || rc=$?
  case "$rc" in
    0) decrypted=1 ;;
    70) die "could not install age inside the container (no internet, or the package mirror is unavailable). Your passphrase was not checked. Nothing was written." ;;
    71) die "the age binary in the container did not match the pinned checksum, so it was not run. Do not retry on this network. Nothing was written." ;;
    125|126|127) die "Docker could not run the container (image pull, mount or permission problem; see Docker's message above). Your passphrase was not checked. Nothing was written." ;;
    *) die "decryption failed: wrong passphrase, or the file was modified or damaged. Nothing was written." ;;
  esac
else
  die "neither age nor a running Docker was found. Install age (brew install age | apt install age | https://github.com/FiloSottile/age) or Docker, then run this again."
fi

[ -s "$STAGE/kit.zip" ] || die "decryption produced no data. Nothing was written."
unzip -tq "$STAGE/kit.zip" >/dev/null 2>&1 || die "the decrypted archive is damaged. Nothing was written."

mkdir "$STAGE/out"
unzip -q -d "$STAGE/out" "$STAGE/kit.zip" || die "could not unpack the kit. Nothing was written."
rm -f "$STAGE/kit.zip"
[ -f "$STAGE/out/fedlify-runner.sh" ] || die "this archive is not a Fedlify site kit. Nothing was written."

find "$STAGE/out" -type d -exec chmod 700 {} +
find "$STAGE/out" -type f -exec chmod 600 {} +
chmod 700 "$STAGE/out/fedlify-runner.sh"
mv "$STAGE/out" "$OUT" || die "could not move the kit into place. Nothing was written."

echo
echo "Unlocked: $OUT (only your account can read it)"
echo "Next:"
echo "  cd \\"$OUT\\""
echo "  cat README.md   # the commands for this kit (published kits: preflight, then start with the token shown once)"
echo "Keep kit.zip.age only as long as you need it; the passphrase must not be stored with it."
`.replace("__CONTAINER_SCRIPT__", () => AGE_CONTAINER_SCRIPT);

export const UNLOCK_PS1 = `# Fedlify site kit: unlock (Windows PowerShell 5.1 or PowerShell 7).
# usage: powershell -ExecutionPolicy Bypass -File .\\unlock.ps1 [-OutDir <new directory>]
#
# Decrypts kit.zip.age (age passphrase mode) into a directory only your account can access (inheritance removed, ACL
# restricted to you). The passphrase is typed at age's own prompt. It is never a command-line argument, an environment
# variable or a file. Wrong passphrase or a modified file: nothing is left behind.
# Needs age.exe on PATH, or Docker Desktop (a pinned public image is used). Windows: if the kit will run under WSL,
# unlock inside WSL with unlock.sh instead.
param([string]$OutDir = "")
$ErrorActionPreference = "Stop"

# Public image pinned by content digest (alpine 3.22, multi-arch index). The container installs a pinned age package
# and checks its sha256 before running it.
$AgeImage = "docker.io/library/alpine@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f"

function Fail([string]$Message) { throw "unlock: $Message" }

function Restrict-ToCurrentUser([string]$Path) {
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $Path /inheritance:r /grant:r "\${me}:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "could not restrict access to $Path" }
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $here "kit.zip.age"
if (-not $OutDir) { $OutDir = Join-Path $here "fedlify-site-kit" }
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
if (-not (Test-Path -LiteralPath $src)) { Fail "kit.zip.age not found next to this script." }
if (Test-Path -LiteralPath $OutDir) { Fail "$OutDir already exists. Move it away or choose another directory: .\\unlock.ps1 -OutDir <new directory>" }
$parent = Split-Path -Parent $OutDir
if (-not (Test-Path -LiteralPath $parent)) { Fail "$parent does not exist." }

$stage = Join-Path $parent (".fedlify-unlock-" + [guid]::NewGuid().ToString("N").Substring(0, 12))
$ok = $false
try {
  New-Item -ItemType Directory -Path $stage | Out-Null
  Restrict-ToCurrentUser $stage
  $zip = Join-Path $stage "kit.zip"
  $age = Get-Command age.exe -ErrorAction SilentlyContinue
  $decrypted = $false
  if ($age) {
    Write-Host "Using local age. Enter the passphrase you received separately from this file."
    & $age.Source -d -o $zip $src
    $decrypted = ($LASTEXITCODE -eq 0)
    if (-not $decrypted) { Fail "decryption failed (see age's message above): wrong passphrase, or the file was modified or damaged. Nothing was written." }
  } elseif ((Get-Command docker.exe -ErrorAction SilentlyContinue)) {
    & docker.exe info *> $null
    if ($LASTEXITCODE -ne 0) { Fail "Docker is installed but not running. Start Docker Desktop and run this again." }
    Write-Host "age is not installed; using Docker with a pinned public image (needs internet to install age inside the container)."
    Write-Host "Enter the passphrase you received separately from this file."
    if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { Fail "the Docker route needs an interactive console to type the passphrase. Run this in a normal PowerShell window. Nothing was written." }
    $containerScript = @'
__CONTAINER_SCRIPT__
'@
    $containerScript = $containerScript.Replace([string][char]13, "")
    & docker.exe run --rm -it --pull=missing -v "\${stage}:/work" -v "\${src}:/in/kit.zip.age:ro" $AgeImage sh -c $containerScript 0 0
    $rc = $LASTEXITCODE
    switch ($rc) {
      0 { $decrypted = $true }
      70 { Fail "could not install age inside the container (no internet, or the package mirror is unavailable). Your passphrase was not checked. Nothing was written." }
      71 { Fail "the age binary in the container did not match the pinned checksum, so it was not run. Do not retry on this network. Nothing was written." }
      { $_ -in 125, 126, 127 } { Fail "Docker could not run the container (image pull, mount or permission problem; see Docker's message above). Your passphrase was not checked. Nothing was written." }
      default { Fail "decryption failed: wrong passphrase, or the file was modified or damaged. Nothing was written." }
    }
  } else {
    Fail "neither age.exe nor Docker was found. Install age (winget install FiloSottile.age) or Docker Desktop, then run this again."
  }
  if (-not $decrypted) { Fail "decryption failed. Nothing was written." }
  if (-not (Test-Path -LiteralPath $zip) -or (Get-Item -LiteralPath $zip).Length -eq 0) { Fail "decryption produced no data. Nothing was written." }

  $out = Join-Path $stage "out"
  try { Expand-Archive -LiteralPath $zip -DestinationPath $out -Force } catch { Fail "the decrypted archive is damaged. Nothing was written." }
  Remove-Item -LiteralPath $zip -Force
  if (-not (Test-Path -LiteralPath (Join-Path $out "fedlify-runner.sh"))) { Fail "this archive is not a Fedlify site kit. Nothing was written." }
  Restrict-ToCurrentUser $out
  Move-Item -LiteralPath $out -Destination $OutDir
  $ok = $true
  Write-Host ""
  Write-Host "Unlocked: $OutDir (only your account can access it)"
  Write-Host "Next, in WSL or Git Bash (the runner is a bash script):"
  Write-Host "  cd <that folder>; read README.md for the commands for this kit"
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
  if (-not $ok -and (Test-Path -LiteralPath $OutDir)) { Remove-Item -LiteralPath $OutDir -Recurse -Force -ErrorAction SilentlyContinue }
}
`.replace("__CONTAINER_SCRIPT__", () => AGE_CONTAINER_SCRIPT);
