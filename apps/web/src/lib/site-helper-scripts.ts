// Scripts for the optional local helper UI, the Windows launcher, and headless unlock. They travel in the plaintext OUTER
// zip (the helper has to run before the kit can be unlocked) except FEDLIFY_RUNNER_PS1, which is inside the encrypted kit.
// Nothing here is secret. tests/site-helper-scripts.test.ts runs the bash scripts against fake docker and a fake runner.
// Every PowerShell script is UNVERIFIED: this repository has no PowerShell and no Windows machine to run it on.

/** A published image reference must be pinned by digest; anything else is refused so a mutable tag never ships. */
export function isPinnedImage(ref: string | undefined): ref is string {
  return typeof ref === "string" && /^[a-z0-9][a-z0-9./_:-]*@sha256:[0-9a-f]{64}$/.test(ref);
}

export const HELPER_PORT_DEFAULT = 8765;

export function helperComposeYml(): string {
  return [
    "# Fedlify site helper: optional local UI, compose profile \"ui\". It publishes ONE port, on 127.0.0.1 only.",
    "# It never mounts the Docker socket and its code contains no outbound network calls. That is NOT enforced by Docker: the service",
    "# sits on the default bridge network (Docker cannot publish a port for a container on an internal-only network), so only the",
    "# code, not a firewall, keeps data in. Start it with ./start-helper.sh (or start-helper.ps1 on Windows).",
    "name: fedlify-helper",
    "services:",
    "  helper:",
    "    image: ${FEDLIFY_HELPER_IMAGE:?set by start-helper.sh}",
    "    profiles: [\"ui\"]",
    "    user: \"${FEDLIFY_UID:-1000}:${FEDLIFY_GID:-1000}\"",
    "    restart: \"no\"",
    "    ports:",
    `      - "127.0.0.1:\${FEDLIFY_HELPER_PORT:-${HELPER_PORT_DEFAULT}}:${HELPER_PORT_DEFAULT}"`,
    "    environment:",
    "      FEDLIFY_HELPER_CONTAINER: \"1\"",
    "      FEDLIFY_HELPER_PUBLIC_PORT: \"${FEDLIFY_HELPER_PORT:-8765}\"",
    "    read_only: true",
    "    cap_drop: [ALL]",
    "    security_opt: [\"no-new-privileges:true\"]",
    "    mem_limit: 1g",
    "    pids_limit: 128",
    "    tmpfs:",
    "      - /tmp",
    "    volumes:",
    "      # start-helper.sh sets FEDLIFY_SEL_RO=,z and FEDLIFY_SEL_RW=:z only when SELinux is enforcing (Fedora, RHEL), so bind mounts are labelled there.",
    "      - \"./kit.zip.age:/in/kit.zip.age:ro${FEDLIFY_SEL_RO:-}\"",
    "      - \"./data:/data:ro${FEDLIFY_SEL_RO:-}\"",
    "      - \"./helper-state/kit:/kit${FEDLIFY_SEL_RW:-}\"",
    "      - \"./helper-state/queue:/queue${FEDLIFY_SEL_RW:-}\"",
    "    logging:",
    "      driver: json-file",
    "      options:",
    "        max-size: \"1m\"",
    "        max-file: \"2\"",
    ""
  ].join("\n");
}

export const HELPER_BRIDGE_SH = `#!/usr/bin/env bash
# Fedlify helper bridge. Runs on the HOST (macOS, Linux, or inside WSL 2 on Windows). The helper container cannot run
# commands: it drops a request file holding ONE fixed word into helper-state/queue/requests, and this script maps that word
# to a runner command from the list below, runs it in the unlocked kit, and writes the result back. Anything else is refused.
#
# The container is NOT trusted. It can write anything into the two folders it mounts (helper-state/kit and helper-state/queue):
#  - A kit it unlocked is COPIED to a host-only folder first and adopted only if it holds no link or special file and the
#    runner, compose files and .env match the sha256 pins in fedlify-kit-pins.txt (shipped in the plaintext zip, outside any
#    mount). A compromised helper therefore cannot make the host run code of its choosing.
#  - Every file the host writes into the queue goes through safe_write, which removes a planted symlink and refuses to follow one.
#  - Command output is captured in a host-only folder, and the runner gets no token, password or passphrase variable.
# usage: ./fedlify-helper-bridge.sh        (FEDLIFY_BRIDGE_ONCE=1 does a single pass and exits; used by tests)
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="$HERE/helper-state"
Q="$STATE/queue"
PRIVATE="$STATE/private"
STAGED="$STATE/kit/fedlify-site-kit"
KIT="$HERE/fedlify-site-kit"
PINS="$HERE/fedlify-kit-pins.txt"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) bridge: $*"; }
safe_write() { # safe_write DEST   stdin -> DEST; a symlink at DEST is removed, never followed (noclobber refuses to open one)
  rm -f "$1" 2>/dev/null || true
  ( set -C; cat > "$1" ) 2>/dev/null || true
}
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
map_cmd() { # fixed list: the only things a browser can cause to run
  case "$1" in
    preflight) echo "preflight --json" ;;
    status) echo "status --json" ;;
    start) echo "start" ;;
    stop) echo "stop" ;;
    update) echo "update --show" ;; # plan only: a confirmed update needs a typed digest and version, so it is run from a terminal
    logout) echo "logout" ;;
    support-bundle) echo "support-bundle" ;;
    support-bundle-logs) echo "support-bundle --include-logs" ;;
    *) return 1 ;;
  esac
}
is_mutating() { case "$1" in start|stop|update|logout) return 0 ;; *) return 1 ;; esac; }

verify_copy() { # verify_copy DIR: only regular files and folders, and every pinned file matches its sha256
  local d="$1" line want path got runner=0
  [ -f "$PINS" ] || { log "refusing the kit: $PINS is missing, so nothing can be verified"; return 1; }
  if [ -n "$(find "$d" ! -type f ! -type d -print | head -n 1)" ]; then log "refusing the kit: it holds a link or special file"; return 1; fi
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    want="\${line%%  *}"; path="\${line#*  }"
    case "$path" in ""|/*|*..*|*[!A-Za-z0-9._/-]*) log "refusing the kit: bad entry in the pin file"; return 1 ;; esac
    [ -f "$d/$path" ] || { log "refusing the kit: $path is missing"; return 1; }
    got="$(sha256_of "$d/$path")"
    [ "$got" = "$want" ] || { log "refusing the kit: $path does not match its pin"; return 1; }
    [ "$path" != "fedlify-runner.sh" ] || runner=1
  done < "$PINS"
  [ "$runner" = "1" ] || { log "refusing the kit: the runner is not pinned"; return 1; }
}
adopt_kit() { # copy a freshly unlocked kit out of the shared mount, verify the COPY, then point it at ./data
  [ -d "$STAGED" ] && [ ! -L "$STAGED" ] && [ ! -e "$KIT" ] || return 0
  case "$HERE" in *"'"*) log "refusing: this folder path contains a single quote"; return 0 ;; esac
  local work="$PRIVATE/adopt.$$"
  rm -rf "$work"; mkdir -p "$PRIVATE"; chmod 700 "$PRIVATE"
  if ! cp -R "$STAGED" "$work" 2>/dev/null; then log "could not copy the staged kit"; rm -rf "$work"; return 0; fi
  if ! verify_copy "$work"; then rm -rf "$work" "$STAGED"; return 0; fi
  find "$work" -type d -exec chmod 700 {} +
  find "$work" -type f -exec chmod 600 {} +
  chmod 700 "$work/fedlify-runner.sh"
  mv "$work" "$KIT"
  rm -rf "$STAGED"
  if [ -f "$KIT/.env" ]; then
    local tmp; tmp="$(mktemp)"
    grep -v '^FEDLIFY_DATA_DIR=' "$KIT/.env" > "$tmp" || true
    printf "FEDLIFY_DATA_DIR='%s/data'\\n" "$HERE" >> "$tmp"
    cat "$tmp" > "$KIT/.env"; rm -f "$tmp"
  fi
  echo unlocked | safe_write "$Q/unlocked"
  log "kit adopted from the helper mount (verified against fedlify-kit-pins.txt)"
}
install_token() { # the helper saved the token typed in the browser as a 0600 file; move it into the kit
  [ -f "$Q/site-token" ] && [ ! -L "$Q/site-token" ] && [ -d "$KIT" ] || return 0
  mkdir -p "$KIT/.fedlify"; chmod 700 "$KIT/.fedlify"
  rm -f "$KIT/.fedlify/site-token"
  mv "$Q/site-token" "$KIT/.fedlify/site-token"; chmod 600 "$KIT/.fedlify/site-token"
  echo installed | safe_write "$Q/token-installed"
}
put_out() { printf '%s\\n' "$2" | safe_write "$Q/results/$1.out"; } # put_out ID TEXT
finish() { # finish ID RC  (output already in $Q/results/ID.out)
  printf '%s\\n' "$2" | safe_write "$Q/results/$1.rc.tmp"; mv "$Q/results/$1.rc.tmp" "$Q/results/$1.rc"; rm -f "$Q/results/$1.running"
}
guard_dirs() { # the container could replace a queue folder with a symlink to somewhere else
  local d
  for d in requests results out; do
    if [ -L "$Q/$d" ]; then rm -f "$Q/$d"; fi
    mkdir -p "$Q/$d"
  done
  mkdir -p "$PRIVATE"; chmod 700 "$PRIVATE"
}
run_request() { # run_request CLAIMED_FILE
  local f="$1" id cmd args rc=0 lock="" v
  id="$(basename "$f" .cmd.claimed)"
  case "$id" in *[!a-f0-9]*|"") rm -f "$f"; return 0 ;; esac
  [ "\${#id}" -eq 16 ] || { rm -f "$f"; return 0; }
  cmd="$(head -n 1 "$f" | tr -d '\\r\\n')"; rm -f "$f"
  if ! args="$(map_cmd "$cmd")"; then put_out "$id" "command not allowed"; finish "$id" 64; return 0; fi
  echo "$cmd" | safe_write "$Q/results/$id.running"
  if [ ! -x "$KIT/fedlify-runner.sh" ]; then put_out "$id" "The kit is not unlocked yet."; finish "$id" 66; return 0; fi
  if is_mutating "$cmd"; then
    if mkdir "$Q/lock.d" 2>/dev/null; then lock="$Q/lock.d"; else put_out "$id" "Another start, stop or update is running."; finish "$id" 75; return 0; fi
  fi
  install_token
  # The runner gets no secret from this process: drop anything that looks like a token, password, passphrase or secret.
  local scrub=(-u FEDLIFY_SITE_TOKEN)
  while IFS= read -r v; do [ -z "$v" ] || scrub+=(-u "$v"); done < <(env | sed -nE 's/^([A-Za-z0-9_]*(TOKEN|PASSWORD|PASSPHRASE|SECRET)[A-Za-z0-9_]*)=.*/\\1/p')
  local full="$PRIVATE/$id.full"; rm -f "$full"
  # shellcheck disable=SC2086  # $args is one of the fixed strings above and is meant to split into words
  ( cd "$KIT" && env "\${scrub[@]}" ./fedlify-runner.sh $args ) > "$full" 2>&1 || rc=$?
  [ -z "$lock" ] || rmdir "$lock" 2>/dev/null || true
  if [ "$rc" -eq 0 ]; then
    case "$cmd" in support-bundle*) guard_dirs; for b in "$KIT"/fedlify-support-*.tar.gz; do [ -f "$b" ] && mv "$b" "$Q/out/"; done ;; esac
  fi
  head -c 65536 "$full" | safe_write "$Q/results/$id.out"; rm -f "$full"
  finish "$id" "$rc"
}
pass() {
  guard_dirs
  adopt_kit
  install_token
  local f
  for f in "$Q"/requests/*.cmd; do
    [ -e "$f" ] || continue
    mv "$f" "$f.claimed" 2>/dev/null || continue
    run_request "$f.claimed" &
    [ "\${FEDLIFY_BRIDGE_ONCE:-}" = "1" ] && wait || true
  done
  find "$Q/results" -type f -mmin +60 -delete 2>/dev/null || true
}

mkdir -p "$Q/requests" "$Q/results" "$Q/out" "$PRIVATE"; chmod 700 "$PRIVATE"
[ "\${FEDLIFY_BRIDGE_ONCE:-}" = "1" ] && { pass; wait; exit 0; }
echo $$ > "$STATE/bridge.pid"
trap 'rm -f "$STATE/bridge.pid"; exit 0' INT TERM
log "waiting for requests from the helper (stop with ./start-helper.sh stop)"
while true; do pass; sleep 1; done
`;

/** The image reference is baked in at kit creation; it must be pinned by digest (checked by the caller). */
export function startHelperSh(image: string): string {
  return `#!/usr/bin/env bash
# Start the Fedlify site helper (optional local UI) and the host-side bridge. macOS and Linux; Windows uses start-helper.ps1.
# usage: ./start-helper.sh [--foreground]    start the helper; --foreground keeps the bridge in this terminal
#        ./start-helper.sh stop              stop the bridge and the helper container
set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"
HELPER_IMAGE="${image}"
COMPOSE=(docker compose -f docker-compose.helper.yml --profile ui)
die() { echo "start-helper: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

if [ "\${1:-}" = "stop" ]; then
  if [ -f helper-state/bridge.pid ]; then kill "$(cat helper-state/bridge.pid)" 2>/dev/null || true; rm -f helper-state/bridge.pid; fi
  rm -f helper-state/open-link.html
  export FEDLIFY_HELPER_IMAGE="$HELPER_IMAGE"
  "\${COMPOSE[@]}" down 2>/dev/null || true
  echo "Helper stopped. Your kit and any running client container are not affected."
  exit 0
fi
FOREGROUND=0
case "\${1:-}" in "") ;; --foreground) FOREGROUND=1 ;; *) die "usage: $0 [--foreground | stop]" ;; esac

have docker || die "Docker is required. See the Get ready page for your system."
docker info >/dev/null 2>&1 || die "Docker is installed but not running (or you lack permission). Start Docker Desktop / the docker service and try again."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required."
[ -f kit.zip.age ] || die "kit.zip.age is not next to this script."

PORT="\${FEDLIFY_HELPER_PORT:-${HELPER_PORT_DEFAULT}}"
case "$PORT" in ''|*[!0-9]*) die "FEDLIFY_HELPER_PORT must be a number." ;; esac
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "FEDLIFY_HELPER_PORT must be between 1024 and 65535."

umask 077
mkdir -p data helper-state/kit helper-state/queue/requests helper-state/queue/results helper-state/queue/out
chmod 700 helper-state
rm -f helper-state/queue/helper-link helper-state/open-link.html
SEL_RW=""; SEL_RO=""
if have getenforce && [ "$(getenforce 2>/dev/null)" = "Enforcing" ]; then SEL_RW=":z"; SEL_RO=",z"; fi # SELinux hosts need labelled mounts
export FEDLIFY_HELPER_IMAGE="$HELPER_IMAGE" FEDLIFY_UID="$(id -u)" FEDLIFY_GID="$(id -g)" FEDLIFY_HELPER_PORT="$PORT" FEDLIFY_SEL_RW="$SEL_RW" FEDLIFY_SEL_RO="$SEL_RO"

# Recreate so every start gets a fresh one-time link. The helper writes the link to a 0600 file; it is not logged.
"\${COMPOSE[@]}" up -d --force-recreate >/dev/null
URL=""
for _ in $(seq 1 60); do
  if [ -s helper-state/queue/helper-link ]; then URL="$(head -n 1 helper-state/queue/helper-link)"; break; fi
  sleep 0.5
done
rm -f helper-state/queue/helper-link
[ -n "$URL" ] || die "the helper did not start. Check: docker compose -f docker-compose.helper.yml --profile ui logs"
case "$URL" in "http://127.0.0.1:$PORT/?t="*) ;; *) die "the helper printed an unexpected address; not opening it." ;; esac

echo "Put your site's CSV extract in: $HERE/data   (it is mounted read-only and never leaves this machine)"
echo "FEDLIFY_HELPER_URL=$URL"
echo "Open that link in your browser. It works once, on this computer only."
# The browser is given a private 0600 file that redirects to the link, never the link itself: a command line is visible to every
# other account on the machine (ps), and the link is a session for 15 minutes. The URL was checked above to be hex and loopback only.
if [ -z "\${FEDLIFY_NO_BROWSER:-}" ]; then
  LINKFILE="$HERE/helper-state/open-link.html"
  printf '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=%s"><title>Fedlify helper</title><a href="%s">Open the Fedlify helper</a>\\n' "$URL" "$URL" > "$LINKFILE"
  if have open; then open "$LINKFILE" >/dev/null 2>&1 || true
  elif have xdg-open; then xdg-open "$LINKFILE" >/dev/null 2>&1 || true; fi
fi

if [ "$FOREGROUND" = "1" ]; then
  echo "Keep this window open while you use the helper. Press Ctrl+C to stop."
  exec bash "$HERE/fedlify-helper-bridge.sh"
fi
if [ -f helper-state/bridge.pid ] && kill -0 "$(cat helper-state/bridge.pid)" 2>/dev/null; then
  echo "Bridge already running."
else
  nohup bash "$HERE/fedlify-helper-bridge.sh" >> helper-state/bridge.log 2>&1 < /dev/null &
  echo $! > helper-state/bridge.pid
fi
echo "Stop later with: ./start-helper.sh stop"
`;
}

/**
 * Windows launcher for the helper. Real Windows path = WSL 2 + Docker Desktop with WSL integration: PowerShell is only a
 * launcher that runs the same bash scripts inside WSL. There is no native Windows runner. UNVERIFIED on a real Windows machine.
 */
export const START_HELPER_PS1 = `# Fedlify site helper launcher for Windows (PowerShell 5.1 or 7). UNVERIFIED: never run on a real Windows machine.
# What this is: a launcher. The helper and the runner are bash programs; on Windows they run inside WSL 2, and Docker Desktop
# must have WSL integration turned on for that distribution. There is no native PowerShell runner.
# usage: powershell -ExecutionPolicy Bypass -File .\\start-helper.ps1          start, keep this window open
#        powershell -ExecutionPolicy Bypass -File .\\start-helper.ps1 -Stop    stop
param([switch]$Stop)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  throw 'WSL 2 is required. Open the Fedlify "Get ready" page and follow the Windows steps, then run this again.'
}
$mode = if ($Stop) { 'stop' } else { '--foreground' }
if (-not $Stop) { Write-Host 'Keep this window open while you use the helper. Close it (or press Ctrl+C) to stop the bridge.' }
# wsl.exe --cd accepts a Windows path. Output lines are scanned for the one-time loopback link; the browser is then given the
# private open-link.html file that start-helper.sh wrote (not the link: a command line is visible to other accounts).
# Windows PowerShell 5.1 turns the first stderr line of a native command into a terminating error when 2>&1 is combined with
# $ErrorActionPreference = 'Stop' (docker prints progress on stderr), so the preference is relaxed for this one call.
$linkFile = Join-Path $PSScriptRoot 'helper-state\open-link.html'
$ErrorActionPreference = 'Continue'
& wsl.exe --cd "$PSScriptRoot" -e bash ./start-helper.sh $mode 2>&1 | ForEach-Object {
  "$_"
  if ("$_" -match '^FEDLIFY_HELPER_URL=http://127\\.0\\.0\\.1:\\d{4,5}/\\?t=[0-9a-f]{64}$' -and (Test-Path $linkFile)) { Start-Process $linkFile }
}
$exitCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
exit $exitCode
`;

/** Headless unlock: passphrase from a file read on stdin by the helper image. Never an argument, never the environment. */
export function unlockHeadlessSh(image: string): string {
  return `#!/usr/bin/env bash
# Fedlify site kit: unattended unlock for servers (systemd, Ansible). macOS and Linux.
# usage: ./unlock-headless.sh --passphrase-file FILE [output-directory]
#
# FILE holds the passphrase and must be mode 0400 or 0600 and owned by you. It is fed to a short-lived container on STDIN
# (docker run -i ... < FILE), so the passphrase is in no argument and no environment variable of any process. The container has
# no network and mounts only the encrypted file (read-only) and a private staging folder.
# Needs Docker, unzip, and the helper image below (public, pinned by digest).
set -euo pipefail
umask 077
HELPER_IMAGE="${image}"
die() { echo "unlock-headless: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "\${1:-}" = "--passphrase-file" ] && [ -n "\${2:-}" ] || die "usage: $0 --passphrase-file FILE [output-directory]"
PASSFILE="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/kit.zip.age"
OUT="\${3:-$HERE/fedlify-site-kit}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac

[ -f "$PASSFILE" ] && [ ! -L "$PASSFILE" ] || die "$PASSFILE must be a regular file (not a symlink)."
perm="$(stat -c '%a' "$PASSFILE" 2>/dev/null || stat -f '%Lp' "$PASSFILE")"
case "$perm" in 400|600) ;; *) die "$PASSFILE has mode $perm; it must be 400 or 600 so other accounts cannot read it." ;; esac
[ "$(stat -c '%u' "$PASSFILE" 2>/dev/null || stat -f '%u' "$PASSFILE")" = "$(id -u)" ] || die "$PASSFILE must be owned by the account running this script."
[ -s "$PASSFILE" ] || die "$PASSFILE is empty."
[ -f "$SRC" ] || die "kit.zip.age not found next to this script."
[ ! -e "$OUT" ] || die "$OUT already exists. Move it away or choose another directory."
have unzip || die "unzip is required."
have docker && docker info >/dev/null 2>&1 || die "a running Docker is required."
OUT_PARENT="$(dirname "$OUT")"
[ -d "$OUT_PARENT" ] && [ -w "$OUT_PARENT" ] || die "cannot write to $OUT_PARENT."

STAGE="$(mktemp -d "$OUT_PARENT/.fedlify-unlock.XXXXXX")" || die "cannot create a private working directory."
chmod 700 "$STAGE"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT
trap 'echo >&2; echo "unlock-headless: interrupted, nothing was written." >&2; exit 130' INT TERM HUP

SEL_RW=""; SEL_RO=""
if have getenforce && [ "$(getenforce 2>/dev/null)" = "Enforcing" ]; then SEL_RW=":z"; SEL_RO=",z"; fi # SELinux hosts need labelled mounts
rc=0
docker run --rm -i --network none --pull=missing --user "$(id -u):$(id -g)" --cap-drop ALL --security-opt no-new-privileges:true \\
  -v "$STAGE:/work$SEL_RW" -v "$SRC:/in/kit.zip.age:ro$SEL_RO" "$HELPER_IMAGE" unlock-cli.mjs decrypt < "$PASSFILE" || rc=$?
case "$rc" in
  0) ;;
  3) die "the passphrase file is empty. Nothing was written." ;;
  125|126|127) die "Docker could not run the helper image (pull, mount or permission problem; see Docker's message above). Nothing was written." ;;
  *) die "decryption failed: wrong passphrase, or the file was modified or damaged. Nothing was written." ;;
esac

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
echo "Unlocked: $OUT (only your account can read it). Delete the passphrase file when you no longer need it."
`;
}

/**
 * Inside the encrypted kit. Windows path = WSL 2: this wrapper runs the bash runner in WSL. UNVERIFIED on Windows.
 * The site token is never passed on a command line or in the environment: save-token reads it as a secure string
 * and hands it to a 0600 file in WSL over stdin.
 */
export const FEDLIFY_RUNNER_PS1 = `# Fedlify site runner for Windows (PowerShell 5.1 or 7). UNVERIFIED: never run on a real Windows machine.
# This is a wrapper, not a port. The runner is a bash script and runs inside WSL 2; Docker Desktop must have WSL integration
# turned on for that distribution. Your kit folder stays where it is (a Windows drive is fine: WSL sees it under /mnt/c).
# usage: .\\fedlify-runner.ps1 preflight [--json] | save-token | start | stop | status [--json] | logs | update | logout | support-bundle [--include-logs]
# Not offered here: agent and agent-unit (the heartbeat runs in this window after start).
param([Parameter(Position = 0)][string]$Command = '', [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
$ErrorActionPreference = 'Stop'
$allowed = @('preflight', 'save-token', 'start', 'stop', 'status', 'logs', 'update', 'logout', 'support-bundle')
if ($allowed -notcontains $Command) { Write-Host ('usage: .\\fedlify-runner.ps1 ' + ($allowed -join ' | ')); exit 1 }
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  throw 'WSL 2 is required. Follow the Windows steps on the Fedlify "Get ready" page.'
}
function Invoke-Runner([string[]]$RunnerArgs, [hashtable]$Extra = @{}) {
  $envArgs = @(); foreach ($k in $Extra.Keys) { $envArgs += ('{0}={1}' -f $k, $Extra[$k]) }
  # Out-Host prints the runner's output instead of returning it: a PowerShell function returns EVERYTHING it writes, so a bare
  # call would hand the caller an array of output lines plus the exit code. The exit code travels in $script:RunnerExit.
  & wsl.exe --cd "$PSScriptRoot" -e env @envArgs bash ./fedlify-runner.sh @RunnerArgs | Out-Host
  $script:RunnerExit = $LASTEXITCODE
}
switch ($Command) {
  'save-token' {
    $secure = Read-Host 'Site token (shown once in Fedlify)' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    # stdin only: not an argument and not an environment variable. The file is created 0600 inside WSL.
    # The script has no double quote and no backslash-quote pair, because Windows PowerShell 5.1 does not escape them for native commands.
    $plain | & wsl.exe --cd "$PSScriptRoot" -e bash -c 'umask 077; mkdir -p .fedlify; chmod 700 .fedlify; tr -d ''\\015\\012'' > .fedlify/site-token; chmod 600 .fedlify/site-token'
    $plain = $null
    Write-Host 'Saved to .fedlify/site-token inside the kit folder.'
  }
  'start' {
    # Background jobs can end when WSL idles, so the heartbeat agent runs in THIS window instead of in the background.
    Invoke-Runner (@('start') + $Rest) @{ FEDLIFY_NO_BG_AGENT = '1' }
    if ($script:RunnerExit -ne 0) { exit $script:RunnerExit }
    Write-Host 'Connected. Keep this window open: heartbeats stop when it closes (the client container keeps running). Press Ctrl+C to stop the heartbeat.'
    & wsl.exe --cd "$PSScriptRoot" -e bash ./fedlify-runner.sh agent
    exit $LASTEXITCODE
  }
  'update' {
    # Confirmation of the digest and the pipeline version happens here, in the console, because the runner inside WSL has no terminal.
    # Scripts can pass --confirm-version and --confirm-digest themselves; the runner re-checks both against the server.
    if (($Rest -contains '--confirm-digest') -or ($Rest -contains '--confirm-version') -or ($Rest -contains '--show')) { Invoke-Runner (@('update') + $Rest); exit $script:RunnerExit }
    # Native stderr merged with 2>&1 becomes a terminating error under 'Stop' in PowerShell 5.1, so relax it for this one call.
    $ErrorActionPreference = 'Continue'
    $plan = @(& wsl.exe --cd "$PSScriptRoot" -e bash ./fedlify-runner.sh update --show 2>&1 | ForEach-Object { "$_" })
    $planExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $plan | Where-Object { $_ -notmatch '^desired(Digest|Version)=' } | Out-Host
    if ($planExit -ne 0) { exit $planExit }
    $digestLine = $plan | Where-Object { $_ -match '^desiredDigest=' } | Select-Object -First 1
    $versionLine = $plan | Where-Object { $_ -match '^desiredVersion=' } | Select-Object -First 1
    if (-not $digestLine -or -not $versionLine) { exit 0 }
    $answerVersion = Read-Host 'Type the pipeline version shown above to confirm'
    $answerDigest = Read-Host 'Type the first 12 characters of the new digest'
    Invoke-Runner @('update', '--confirm-version', $answerVersion, '--confirm-digest', $answerDigest)
    exit $script:RunnerExit
  }
  default { Invoke-Runner (@($Command) + $Rest); exit $script:RunnerExit }
}
`;

export const GPU_COMPOSE_YML = [
  "# Fedlify GPU override. docker-compose.yml stays CPU. fedlify-runner.sh adds this file ONLY when .env has FEDLIFY_GPU=auto or on",
  "# AND an NVIDIA GPU (nvidia-smi) and the NVIDIA container toolkit are both detected. It needs a CUDA flavour of the study image.",
  "services:",
  "  nvflare-client:",
  "    deploy:",
  "      resources:",
  "        reservations:",
  "          devices:",
  "            - driver: nvidia",
  "              count: all",
  "              capabilities: [gpu]",
  ""
].join("\n");
