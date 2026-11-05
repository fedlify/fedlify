// The published-kit runner script, kept as a template string so the join-package route can zip it without file I/O.
// Edit the script text here; tests/site-runner.test.ts runs it under bash against a fake docker.
export const PUBLISHED_RUNNER_SCRIPT = `#!/usr/bin/env bash
# Fedlify site runner (bash 3.2+ on macOS and Linux).
# Secrets: .env holds no secret. The registry credential is .fedlify/registry-credential (0600) and the site token is
# .fedlify/site-token (0600); both are read by this script only, and passwords reach docker/curl on stdin.
# usage: ./fedlify-runner.sh preflight [--json] | start | stop | status [--json] | logs | update [--show] [--confirm-version V --confirm-digest HEX] | logout | support-bundle [--include-logs]
set -euo pipefail
cd "$(dirname "$0")"
SELF="$PWD/$(basename "$0")"
RUNNER_VERSION="fedlify-site-kit-6"
STATE_DIR=".fedlify"
TOKEN_FILE="$STATE_DIR/site-token"
CRED_FILE="$STATE_DIR/registry-credential"
AGENT_PID="$STATE_DIR/agent.pid"
LAST_BEAT="$STATE_DIR/last-heartbeat"
BEAT_SECONDS=30

die() { echo "fedlify-runner: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
jstr() { printf '%s' "$1" | tr -d '\\000-\\037' | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'; }
set_env() { # set_env KEY VALUE  (rewrites .env in place)
  local tmp; tmp="$(mktemp)"
  grep -v "^$1=" .env > "$tmp" || true
  printf '%s=%s\\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
}
load_env() {
  if [ -f .env ]; then set -a; . ./.env; set +a; fi
  FEDLIFY_DATA_DIR="\${FEDLIFY_DATA_DIR:-./data}"
  FEDLIFY_REGISTRY="\${FEDLIFY_REGISTRY:-}"
  NVFLARE_SERVER="\${NVFLARE_SERVER:-}"
  FEDLIFY_HEARTBEAT_ENDPOINT="\${FEDLIFY_HEARTBEAT_ENDPOINT:-}"
  FEDLIFY_STUDY_IMAGE="\${FEDLIFY_STUDY_IMAGE:-}"
  FEDLIFY_GPU="\${FEDLIFY_GPU:-off}"
  FEDLIFY_IMAGE_ARCHES="\${FEDLIFY_IMAGE_ARCHES:-amd64}"
  select_compose_files
}
need_kit() {
  [ -f .env ] || die "run this from the extracted kit folder (.env not found)."
  [ -d nvflare/startup ] || die "nvflare/startup is missing; download a new kit from Fedlify."
}
need_docker() {
  have docker || die "Docker is required: https://docs.docker.com/get-docker/"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required."
}

# ---- site token: a 0600 file, never .env and never on a command line --------------------------------------------
read_token() {
  if [ -n "\${FEDLIFY_SITE_TOKEN:-}" ]; then printf '%s' "$FEDLIFY_SITE_TOKEN"; return 0; fi
  if [ -n "\${FEDLIFY_SITE_TOKEN_FILE:-}" ] && [ -r "$FEDLIFY_SITE_TOKEN_FILE" ]; then tr -d '\\r\\n' < "$FEDLIFY_SITE_TOKEN_FILE"; return 0; fi
  if [ -r "$TOKEN_FILE" ]; then tr -d '\\r\\n' < "$TOKEN_FILE"; return 0; fi
  return 1
}
have_token() { [ -n "$(read_token 2>/dev/null || true)" ]; }
store_token() { # persist a token given through the environment
  if [ -n "\${FEDLIFY_SITE_TOKEN:-}" ]; then
    mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
    ( umask 077; printf '%s' "$FEDLIFY_SITE_TOKEN" > "$TOKEN_FILE" )
    chmod 600 "$TOKEN_FILE"
  fi
}

# ---- registry credential: a 0600 file inside the unlocked kit (or, for scripts, the environment); never .env ------
read_registry_cred() { # sets REG_USER and REG_PASS ; returns 0 only if both are present
  REG_USER="\${FEDLIFY_REGISTRY_USERNAME:-}"; REG_PASS="\${FEDLIFY_REGISTRY_PASSWORD:-}"
  if [ -z "$REG_USER" ] || [ -z "$REG_PASS" ]; then
    REG_USER=""; REG_PASS=""
    if [ -r "$CRED_FILE" ]; then { IFS= read -r REG_USER || true; IFS= read -r REG_PASS || true; } < "$CRED_FILE"; fi
  fi
  [ -n "$REG_USER" ] && [ -n "$REG_PASS" ]
}
registry_login() { # the password goes to docker on stdin, never on a command line
  read_registry_cred || die "no registry credential: expected $CRED_FILE (shipped inside the unlocked kit). Unlock a fresh kit from Fedlify."
  printf '%s' "$REG_PASS" | docker login "$FEDLIFY_REGISTRY" -u "$REG_USER" --password-stdin >/dev/null
}

# ---- observation: facts only, never data -------------------------------------------------------------------------
csv_count() {
  if [ -d "$FEDLIFY_DATA_DIR" ]; then find "$FEDLIFY_DATA_DIR" -maxdepth 2 -type f -iname '*.csv' 2>/dev/null | wc -l | tr -d ' '; else echo 0; fi
}
disk_free_gb() { df -Pk . 2>/dev/null | awk 'NR==2 {print int($4/1048576)}'; }
ram_gb() {
  local bytes=""
  if have docker; then bytes="$(docker info --format '{{.MemTotal}}' 2>/dev/null || true)"; fi
  case "$bytes" in ''|*[!0-9]*) echo ""; return 0;; esac
  echo $((bytes / 1073741824))
}
gpu_count() {
  if have nvidia-smi; then nvidia-smi -L 2>/dev/null | grep -c '^GPU' || true; else echo 0; fi
}
gpu_toolkit() { have docker && docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"'; }
# GPU is opt-in. FEDLIFY_GPU=off (default) never touches it. auto|on request it, and it is enabled only when an NVIDIA GPU
# (nvidia-smi) and the container toolkit (an nvidia runtime in docker info) are both detected and the GPU compose file exists.
GPU_ACTIVE=0
select_compose_files() {
  GPU_ACTIVE=0
  case "$FEDLIFY_GPU" in
    off|"") ;;
    auto|on)
      if [ -f docker-compose.gpu.yml ] && [ "$(gpu_count)" -gt 0 ] && gpu_toolkit; then
        GPU_ACTIVE=1
        export COMPOSE_FILE="docker-compose.yml:docker-compose.gpu.yml"
      fi ;;
    *) die "FEDLIFY_GPU must be off, auto or on (it is: $FEDLIFY_GPU)" ;;
  esac
}
observe() { # sets OBS_* ; docker health is the source of truth
  OBS_CONTAINER="missing"; OBS_HEALTH="none"; OBS_RESTARTS=0; OBS_IMAGE=""
  have docker || return 0
  local cid
  cid="$(docker compose ps -a -q nvflare-client 2>/dev/null | head -n 1 || true)"
  [ -n "$cid" ] || return 0
  OBS_CONTAINER="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)"
  OBS_HEALTH="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo none)"
  OBS_RESTARTS="$(docker inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null || echo 0)"
  OBS_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true)"
  case "$OBS_RESTARTS" in ''|*[!0-9]*) OBS_RESTARTS=0;; esac
}
derive_status() { # CONNECTED | DEGRADED | OFFLINE from container state, health and data
  case "$OBS_CONTAINER" in
    running)
      case "$OBS_HEALTH" in
        healthy|none) ;;
        *) echo DEGRADED; return 0;;
      esac
      if [ ! -d "$FEDLIFY_DATA_DIR" ] || [ "$(csv_count)" = "0" ]; then echo DEGRADED; return 0; fi
      echo CONNECTED ;;
    restarting) echo DEGRADED ;;
    *) echo OFFLINE ;;
  esac
}
last_beat() { if [ -f "$LAST_BEAT" ]; then cat "$LAST_BEAT"; else echo "never"; fi; }

# ---- heartbeat ---------------------------------------------------------------------------------------------------
heartbeat_body() { # heartbeat_body STATUS
  local data_present=false
  if [ -d "$FEDLIFY_DATA_DIR" ]; then data_present=true; fi
  printf '{"status":"%s","version":"%s","metadata":{"runner":"%s","agent":"host","imageDigest":"%s","container":"%s","health":"%s","restarts":%s,"dataDirPresent":%s,"csvCount":%s,"diskFreeGb":%s,"gpuCount":%s}}' \\
    "$1" "$RUNNER_VERSION" "$RUNNER_VERSION" "$(jstr "\${OBS_IMAGE:-$FEDLIFY_STUDY_IMAGE}")" "$(jstr "$OBS_CONTAINER")" "$(jstr "$OBS_HEALTH")" \\
    "$OBS_RESTARTS" "$data_present" "$(csv_count)" "$(disk_free_gb || echo 0)" "$(gpu_count)"
}
post_beat() { # post_beat STATUS ; sets BEAT_HTTP and BEAT_RESPONSE ; returns 0 only on HTTP 201
  BEAT_HTTP="000"; BEAT_RESPONSE=""
  local tok body out
  tok="$(read_token 2>/dev/null || true)"
  [ -n "$tok" ] || return 2
  [ -n "$FEDLIFY_HEARTBEAT_ENDPOINT" ] || return 2
  body="$(heartbeat_body "$1")"
  # The token goes to curl on stdin (-K -), so it never appears in the process list.
  out="$(printf 'header = "x-site-token: %s"\\n' "$tok" | curl -sS -m 20 -K - -X POST "$FEDLIFY_HEARTBEAT_ENDPOINT" \\
    -H 'content-type: application/json' -d "$body" -w '\\n%{http_code}' 2>/dev/null)" || out=""
  if [ -n "$out" ]; then
    BEAT_HTTP="$(printf '%s' "$out" | tail -n 1)"
    BEAT_RESPONSE="$(printf '%s' "$out" | sed '$d')"
  fi
  mkdir -p "$STATE_DIR"
  printf '%s HTTP %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BEAT_HTTP" > "$LAST_BEAT"
  [ "$BEAT_HTTP" = "201" ]
}
beat_field() { # beat_field NAME: a top-level string field of the last heartbeat response ("" when absent or null)
  printf '%s' "$BEAT_RESPONSE" | sed -n 's/.*"'"$1"'":"\\([^"]*\\)".*/\\1/p' | head -n 1
}
repo_path() { # host/project/repo of an image reference, digest and tag removed (used to see whether the pull credential still reaches it)
  local r="\${1%%@*}"
  case "\${r##*/}" in *:*) r="\${r%:*}";; esac
  printf '%s' "$r"
}
agent_running() { [ -f "$AGENT_PID" ] && kill -0 "$(cat "$AGENT_PID" 2>/dev/null)" 2>/dev/null; }
agent_loop() { # foreground heartbeat loop; used by start (in the background) and by a systemd unit
  load_env
  have_token || die "no site token: set FEDLIFY_SITE_TOKEN or FEDLIFY_SITE_TOKEN_FILE, or run start once."
  if agent_running && [ "$(cat "$AGENT_PID")" != "$$" ]; then die "an agent is already running (pid $(cat "$AGENT_PID"))."; fi
  mkdir -p "$STATE_DIR"
  echo $$ > "$AGENT_PID"
  trap 'rm -f "$AGENT_PID"; exit 0' TERM INT
  local previous="" st
  while true; do
    load_env # an update rewrites FEDLIFY_STUDY_IMAGE in .env; re-read it so this long-running agent never reports a stale image
    observe
    st="$(derive_status)"
    post_beat "$st" || true
    if [ "$BEAT_HTTP" != "$previous" ]; then echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) heartbeat status=$st http=$BEAT_HTTP"; previous="$BEAT_HTTP"; fi
    sleep "$BEAT_SECONDS" &
    wait $! || true
  done
}
start_agent() {
  # Windows (WSL) launchers run the agent in the foreground themselves, because background jobs can end when WSL idles.
  [ "\${FEDLIFY_NO_BG_AGENT:-}" = "1" ] && return 0
  agent_running && return 0
  mkdir -p "$STATE_DIR"
  nohup "$SELF" agent >> "$STATE_DIR/agent.log" 2>&1 < /dev/null &
  echo $! > "$AGENT_PID"
}
stop_agent() {
  if agent_running; then kill "$(cat "$AGENT_PID")" 2>/dev/null || true; fi
  rm -f "$AGENT_PID"
}

# ---- preflight ---------------------------------------------------------------------------------------------------
CHECKS=""; FAILS=0; WARNS=0; JSON_OUT=0
add_check() { # add_check ID pass|warn|fail DETAIL
  CHECKS="$CHECKS\${CHECKS:+,}{\\"id\\":\\"$1\\",\\"status\\":\\"$2\\",\\"detail\\":\\"$(jstr "$3")\\"}"
  if [ "$2" = "fail" ]; then FAILS=$((FAILS + 1)); fi
  if [ "$2" = "warn" ]; then WARNS=$((WARNS + 1)); fi
  if [ "$JSON_OUT" != "1" ]; then printf '  [%s] %s: %s\\n' "$2" "$1" "$3"; fi
}
resolves() {
  if have getent && getent hosts "$1" >/dev/null 2>&1; then return 0; fi
  if have dscacheutil && dscacheutil -q host -a name "$1" 2>/dev/null | grep -q 'ip_address'; then return 0; fi
  if have nslookup && nslookup "$1" >/dev/null 2>&1; then return 0; fi
  if have host && host "$1" >/dev/null 2>&1; then return 0; fi
  return 1
}
reachable() { # reachable HOST PORT
  if have nc; then nc -z -w 5 "$1" "$2" >/dev/null 2>&1; return $?; fi
  if have curl; then
    local rc=0
    curl -sS -m 6 -o /dev/null "https://$1:$2/" >/dev/null 2>&1 || rc=$?
    case "$rc" in 6|7|28) return 1;; *) return 0;; esac
  fi
  return 1
}
registry_endpoint() { # FEDLIFY_REGISTRY may be host, host:port, or carry a scheme and path; print host:port (default 443)
  local r="\${FEDLIFY_REGISTRY:-}"
  r="\${r#*://}"; r="\${r%%/*}"
  case "$r" in ''|*:*) ;; *) r="$r:443" ;; esac
  printf '%s' "$r"
}
check_endpoint() { # check_endpoint ID HOST:PORT
  local host port
  host="\${2%%:*}"; port="\${2##*:}"
  if [ "$host" = "$2" ] || [ -z "$port" ]; then port=443; fi
  if [ -z "$host" ]; then add_check "$1" warn "not configured in .env"; return 0; fi
  if ! resolves "$host"; then add_check "$1" fail "cannot resolve $host (check DNS or VPN; a just-published study can take a few minutes)"; return 0; fi
  if reachable "$host" "$port"; then add_check "$1" pass "$host:$port reachable"; else add_check "$1" fail "$host:$port is not reachable (outbound $port must be allowed)"; fi
}
preflight_run() {
  load_env
  CHECKS=""; FAILS=0; WARNS=0
  [ "$JSON_OUT" = "1" ] || echo "Fedlify preflight ($RUNNER_VERSION)"
  local docker_ok=0 v mem free n arch
  if have docker; then
    if docker info >/dev/null 2>&1; then docker_ok=1; add_check docker pass "Docker engine reachable"
    else add_check docker fail "Docker is installed but the engine is not running or you lack permission"; fi
  else add_check docker fail "Docker not found: https://docs.docker.com/get-docker/"; fi
  if [ "$docker_ok" = "1" ]; then
    v="$(docker compose version --short 2>/dev/null || true)"
    case "$v" in
      '') add_check compose fail "Docker Compose v2 plugin not found" ;;
      v2.*|2.*|v[3-9]*|[3-9]*) add_check compose pass "Compose $v" ;;
      *) add_check compose fail "Compose $v is too old; v2 is required" ;;
    esac
  else add_check compose fail "cannot check without Docker"; fi
  if [ -f .env ]; then add_check kit_env pass ".env present"; else add_check kit_env fail ".env missing: run from the extracted kit folder"; fi
  if [ -f nvflare/startup/fed_client.json ]; then add_check kit_nvflare pass "NVFLARE client kit present"; else add_check kit_nvflare fail "nvflare/startup/fed_client.json missing: download a new kit"; fi
  if read_registry_cred; then add_check registry_credential pass "registry credential available"; else add_check registry_credential warn "no registry credential at $CRED_FILE; start and update cannot pull the image"; fi
  if have_token; then add_check site_token pass "site token available"; else add_check site_token warn "no site token yet; start needs FEDLIFY_SITE_TOKEN or FEDLIFY_SITE_TOKEN_FILE"; fi
  if [ -d "$FEDLIFY_DATA_DIR" ]; then
    n="$(csv_count)"
    add_check data_dir pass "data folder present"
    if [ "$n" = "0" ]; then add_check data_csv warn "no .csv files found in the data folder yet"; else add_check data_csv pass "$n csv file(s)"; fi
  else add_check data_dir fail "FEDLIFY_DATA_DIR does not exist; edit .env to point at this site's extract"; fi
  free="$(disk_free_gb || echo 0)"
  case "$free" in ''|*[!0-9]*) add_check disk warn "could not read free disk space" ;;
    *) if [ "$free" -lt 5 ]; then add_check disk fail "\${free} GB free on the kit volume; need at least 5 GB for images"
       elif [ "$free" -lt 20 ]; then add_check disk warn "\${free} GB free on the kit volume; 20 GB or more recommended"
       else add_check disk pass "\${free} GB free on the kit volume"; fi ;;
  esac
  mem="$(ram_gb)"
  if [ -z "$mem" ]; then add_check ram warn "could not read memory available to Docker"
  elif [ "$mem" -lt 2 ]; then add_check ram fail "Docker has \${mem} GB RAM; at least 2 GB required (raise it in Docker Desktop settings)"
  elif [ "$mem" -lt 4 ]; then add_check ram warn "Docker has \${mem} GB RAM; 4 GB or more recommended"
  else add_check ram pass "Docker has \${mem} GB RAM"; fi
  check_endpoint aggregator "$NVFLARE_SERVER"
  check_endpoint registry "$(registry_endpoint)"
  add_check agent_persistence warn "the heartbeat agent started by start does not survive a host reboot; run ./fedlify-runner.sh agent-unit for a systemd unit, or re-run start after a reboot"
  n="$(gpu_count)"
  case "$FEDLIFY_GPU" in
    auto|on)
      if [ "$GPU_ACTIVE" = "1" ]; then add_check gpu pass "GPU requested and detected ($n NVIDIA GPU(s) plus the container toolkit): the GPU compose reservation is enabled"
      elif [ "$FEDLIFY_GPU" = "on" ]; then add_check gpu fail "FEDLIFY_GPU=on but no NVIDIA GPU with the container toolkit was detected (nvidia-smi and an nvidia runtime in docker info are both needed)"
      else add_check gpu warn "FEDLIFY_GPU=auto but no NVIDIA GPU with the container toolkit was detected; running on CPU"; fi ;;
    *)
      if [ "$n" -gt 0 ]; then add_check gpu pass "$n NVIDIA GPU(s) detected; GPU use is off, CPU is the default (set FEDLIFY_GPU=auto in .env to request it; needs a CUDA study image)"
      else add_check gpu pass "no GPU detected; runs on CPU"; fi ;;
  esac
  arch="$(uname -m)"
  case "$arch" in
    arm64|aarch64)
      case ",$FEDLIFY_IMAGE_ARCHES," in
        *,arm64,*) add_check platform pass "$(uname -s) $arch; the study image lists arm64 (not verified on this machine)" ;;
        *) add_check platform warn "$(uname -s) $arch, but the study image is published for $FEDLIFY_IMAGE_ARCHES only: Docker will run it under emulation, which is slower and not verified" ;;
      esac ;;
    *) add_check platform pass "$(uname -s) $arch" ;;
  esac
  case "$(uname -r)" in
    *[Mm]icrosoft*|*WSL*)
      case "$PWD" in
        /mnt/?/*) add_check wsl warn "running in WSL on a Windows drive: file modes (0600/0700) are not enforced here; protection comes from the Windows folder permissions. Heartbeats stop if WSL shuts down while idle" ;;
        *) add_check wsl pass "running in WSL on the Linux file system" ;;
      esac ;;
  esac
  PREFLIGHT_OK=true; if [ "$FAILS" -gt 0 ]; then PREFLIGHT_OK=false; fi
  if [ "$JSON_OUT" = "1" ]; then
    printf '{"ok":%s,"runnerVersion":"%s","failed":%s,"warnings":%s,"checks":[%s]}\\n' "$PREFLIGHT_OK" "$RUNNER_VERSION" "$FAILS" "$WARNS" "$CHECKS"
  else
    echo "Result: $FAILS failed, $WARNS warning(s)."
  fi
  [ "$FAILS" -eq 0 ]
}

# ---- status ------------------------------------------------------------------------------------------------------
status_run() {
  load_env
  observe
  local st token_present=false agent=false data_present=false
  st="$(derive_status)"
  if have_token; then token_present=true; fi
  if agent_running; then agent=true; fi
  if [ -d "$FEDLIFY_DATA_DIR" ]; then data_present=true; fi
  if [ "$JSON_OUT" = "1" ]; then
    printf '{"runnerVersion":"%s","status":"%s","container":"%s","health":"%s","restarts":%s,"image":"%s","tokenPresent":%s,"agentRunning":%s,"dataDirPresent":%s,"csvCount":%s,"diskFreeGb":%s,"gpuCount":%s,"gpuRequested":"%s","gpuActive":%s,"lastHeartbeat":"%s"}\\n' \\
      "$RUNNER_VERSION" "$st" "$(jstr "$OBS_CONTAINER")" "$(jstr "$OBS_HEALTH")" "$OBS_RESTARTS" "$(jstr "\${OBS_IMAGE:-$FEDLIFY_STUDY_IMAGE}")" \\
      "$token_present" "$agent" "$data_present" "$(csv_count)" "$(disk_free_gb || echo 0)" "$(gpu_count)" "$(jstr "$FEDLIFY_GPU")" "$([ "$GPU_ACTIVE" = "1" ] && echo true || echo false)" "$(jstr "$(last_beat)")"
  else
    echo "Status:         $st"
    echo "Client:         $OBS_CONTAINER (health: $OBS_HEALTH, restarts: $OBS_RESTARTS)"
    echo "Heartbeat agent: $([ "$agent" = true ] && echo running || echo not running); last beat: $(last_beat)"
    echo "Site token:     $([ "$token_present" = true ] && echo present || echo missing)"
    echo "Data folder:    $([ "$data_present" = true ] && echo "present, $(csv_count) csv file(s)" || echo missing)"
  fi
}

# ---- support bundle: allowlist only ------------------------------------------------------------------------------
redact_log() { # lowercase, drop quoted strings, paths, emails, ids, long tokens and secret-looking values
  tr 'A-Z' 'a-z' | sed -E \\
    -e "s/\\"[^\\"]*\\"/\\"<str>\\"/g" \\
    -e "s/'[^']*'/'<str>'/g" \\
    -e 's#/[a-z0-9_./-]+#<path>#g' \\
    -e 's/[a-z0-9._%+-]+@[a-z0-9.-]+/<email>/g' \\
    -e 's/((token|password|passwd|secret|key|authorization|bearer)[a-z_]*[=: ]+)[^ ]+/\\1<redacted>/g' \\
    -e 's/[a-z0-9_-]{24,}/<redacted>/g' \\
    -e 's/[0-9]{5,}/<n>/g' | cut -c1-200
}
support_bundle() {
  local include_logs=0 stamp work dir out
  case "\${1:-}" in "") ;; --include-logs) include_logs=1 ;; *) die "usage: $0 support-bundle [--include-logs]";; esac
  load_env
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  work="$(mktemp -d)"
  dir="$work/fedlify-support-$stamp"
  mkdir -p "$dir"
  {
    echo "runner=$RUNNER_VERSION"
    echo "os=$(uname -s) $(uname -r) $(uname -m)"
    echo "bash=$BASH_VERSION"
    if have docker; then
      echo "docker=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unavailable)"
      echo "compose=$(docker compose version --short 2>/dev/null || echo unavailable)"
    else echo "docker=not installed"; fi
  } > "$dir/environment.txt"
  # Only these .env keys are copied; registry credentials, the token and the data path are never read here.
  {
    echo "NVFLARE_CLIENT_NAME=\${NVFLARE_CLIENT_NAME:-}"
    echo "NVFLARE_SERVER=\${NVFLARE_SERVER:-}"
    echo "FEDLIFY_REGISTRY=\${FEDLIFY_REGISTRY:-}"
    echo "FEDLIFY_STUDY_IMAGE=\${FEDLIFY_STUDY_IMAGE:-}"
  } > "$dir/config.txt"
  JSON_OUT=1; preflight_run > "$dir/preflight.json" 2>/dev/null || true
  status_run > "$dir/status.json" 2>/dev/null || true
  if have docker; then docker compose ps -a > "$dir/compose-ps.txt" 2>&1 || true; fi
  if [ "$include_logs" = "1" ] && have docker; then
    docker compose logs --no-color --tail 500 nvflare-client 2>&1 \\
      | grep -Ei 'warn|error|critical|fatal|exception|traceback' | tail -n 200 | redact_log > "$dir/client-log-redacted.txt" || true
  fi
  cat > "$dir/README.txt" <<'EOT'
Fedlify support bundle. Built from an allowlist of facts: versions, preflight and status results, the
container state, and four non-secret configuration values. It contains no data files, no site token,
no registry credentials, no NVFLARE keys or certificates, and no data folder path.
Logs are included only if you passed --include-logs, and then only warning and error lines with quoted
text, paths, emails, ids and secret-looking values removed. Read every file before you send it.
Nothing is uploaded by this command; send the archive yourself.
EOT
  out="$PWD/fedlify-support-$stamp.tar.gz"
  ( umask 077; tar -czf "$out" -C "$work" "fedlify-support-$stamp" )
  echo "Support bundle written: $out"
  echo "Contents (review before sending):"
  ( cd "$work/fedlify-support-$stamp" && ls -1 | sed 's/^/  /' )
  rm -rf "$work"
}

# ---- commands ----------------------------------------------------------------------------------------------------
case "\${1:-}" in
  preflight)
    case "\${2:-}" in "") ;; --json) JSON_OUT=1 ;; *) die "usage: $0 preflight [--json]";; esac
    preflight_run ;;
  start)
    need_kit; need_docker; load_env
    have_token || die "set the site token: FEDLIFY_SITE_TOKEN=<token shown once in Fedlify> ./fedlify-runner.sh start"
    [ -d "$FEDLIFY_DATA_DIR" ] || die "FEDLIFY_DATA_DIR does not exist; edit .env to point at this site's extract."
    if [ "$FEDLIFY_GPU" = "on" ] && [ "$GPU_ACTIVE" != "1" ]; then die "FEDLIFY_GPU=on but no NVIDIA GPU with the container toolkit was detected. Fix that or set FEDLIFY_GPU=off."; fi
    if [ "$FEDLIFY_GPU" = "auto" ] && [ "$GPU_ACTIVE" != "1" ]; then echo "Note: FEDLIFY_GPU=auto but no usable GPU was detected; starting on CPU."; fi
    store_token
    registry_login
    docker compose pull --quiet
    docker compose up -d
    start_agent
    echo "Note: the heartbeat agent does not survive a host reboot. The client container restarts by itself, but until you re-run start"
    echo "(or install the unit printed by: ./fedlify-runner.sh agent-unit) the site shows OFFLINE after about 90 seconds."
    echo "Started. Heartbeats go to Fedlify every \${BEAT_SECONDS}s. Check: ./fedlify-runner.sh status" ;;
  stop)
    need_kit; need_docker; load_env
    docker compose down
    observe; post_beat OFFLINE || true
    stop_agent
    echo "Stopped." ;;
  status)
    case "\${2:-}" in "") ;; --json) JSON_OUT=1 ;; *) die "usage: $0 status [--json]";; esac
    status_run ;;
  logs) need_kit; need_docker; load_env; docker compose logs -f --tail 100 nvflare-client ;;
  agent) agent_loop ;;
  agent-unit) # print a systemd unit so the heartbeat agent survives reboots; review it, then install it yourself
    case "$PWD$SELF" in *'"'*|*'\\'*|*'$'*) die "this folder path holds a quote, backslash or dollar sign, which a systemd unit cannot carry safely. Move the kit to a plain path." ;; esac
    UNIT_PWD="$(printf '%s' "$PWD" | sed 's/%/%%/g')"; UNIT_SELF="$(printf '%s' "$SELF" | sed 's/%/%%/g')"
    echo "# Save as /etc/systemd/system/fedlify-agent.service, then: systemctl daemon-reload && systemctl enable --now fedlify-agent"
    echo "# The site token is read from $PWD/$STATE_DIR/site-token; the service user must be able to read it."
    if [ "$(id -u)" -eq 0 ]; then echo "# Running as root: the unit will run as root. Prefer a dedicated account: add User=<name> and give it read access to the token file."; fi
    printf '[Unit]\\nDescription=Fedlify site heartbeat agent\\nAfter=docker.service network-online.target\\nWants=network-online.target\\n\\n'
    printf '[Service]\\n'
    if [ "$(id -u)" -ne 0 ]; then printf 'User=%s\\n' "$(id -un)"; fi
    printf 'WorkingDirectory=%s\\nEnvironment="FEDLIFY_SITE_TOKEN_FILE=%s/%s/site-token"\\nExecStart="%s" agent\\nRestart=always\\nRestartSec=15\\n\\n' "$UNIT_PWD" "$UNIT_PWD" "$STATE_DIR" "$UNIT_SELF"
    printf '[Install]\\nWantedBy=multi-user.target\\n' ;;
  support-bundle) shift; support_bundle "$@" ;;
  update) # move this site to the image the study published; confirmation of digest AND pipeline version is required
    shift
    CONFIRM_DIGEST=""; CONFIRM_VERSION=""; SHOW_ONLY=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --show) SHOW_ONLY=1; shift ;;
        --confirm-digest) [ $# -ge 2 ] || die "--confirm-digest needs a value"; CONFIRM_DIGEST="$2"; shift 2 ;;
        --confirm-version) [ $# -ge 2 ] || die "--confirm-version needs a value"; CONFIRM_VERSION="$2"; shift 2 ;;
        *) die "usage: $0 update [--show] [--confirm-version <version> --confirm-digest <first 12 or more hex characters of the digest>]" ;;
      esac
    done
    need_kit; need_docker; load_env
    have_token || die "no site token available."
    observe
    post_beat "$(derive_status)" || die "Fedlify did not accept the heartbeat (HTTP $BEAT_HTTP)."
    # The new digest and its pipeline version come from the server in the heartbeat response, never from this machine's files.
    desired="$(beat_field desiredImageDigest)"
    version="$(beat_field desiredPipelineVersion)"
    if [ -z "$desired" ]; then echo "Nothing is published for this study yet; nothing to update."; exit 0; fi
    printf '%s' "$desired" | grep -Eq '^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$' || die "the server sent an image reference that is not a digest reference; refusing to use it."
    want_hex="\${desired##*sha256:}"
    running="\${OBS_IMAGE:-$FEDLIFY_STUDY_IMAGE}"
    case "$running" in *"sha256:$want_hex"*) echo "Already on the published version (sha256:\${want_hex:0:12})."; exit 0 ;; esac
    # A per-site pull credential covers one registry project. If the study image moved to another, an update cannot work.
    current_path="$(repo_path "$FEDLIFY_STUDY_IMAGE")"; new_path="$(repo_path "$desired")"
    if [ -n "$current_path" ] && [ "$current_path" != "$new_path" ]; then
      die "the published image moved from $current_path to $new_path, and this kit's registry credential only covers the old location. Nothing was changed. Download a new site kit in Fedlify, open it with its passphrase, and run start from the new kit folder."
    fi
    printf '%s' "$version" | grep -Eq '^[A-Za-z0-9._+-]{1,64}$' || die "the server did not report a usable pipeline version, so the update cannot be confirmed. Nothing was changed. Try again after the next heartbeat."
    echo "A newer study image is published."
    echo "  Running now:      \${running:-unknown}"
    echo "  Published:        $desired"
    echo "  Pipeline version: $version"
    if [ "$SHOW_ONLY" = "1" ]; then echo "desiredDigest=$desired"; echo "desiredVersion=$version"; exit 0; fi
    if [ -z "$CONFIRM_DIGEST" ] && [ -z "$CONFIRM_VERSION" ] && [ -t 0 ]; then
      printf 'Type the pipeline version (%s) to confirm: ' "$version"; read -r CONFIRM_VERSION
      printf 'Type the first 12 characters of the new digest (%s): ' "\${want_hex:0:12}"; read -r CONFIRM_DIGEST
    fi
    if [ -z "$CONFIRM_DIGEST" ] || [ -z "$CONFIRM_VERSION" ]; then
      die "update replaces the running image, so it needs both confirmations. Nothing was changed. Re-run: $0 update --confirm-version $version --confirm-digest \${want_hex:0:12}"
    fi
    got_hex="\${CONFIRM_DIGEST#sha256:}"
    printf '%s' "$got_hex" | grep -Eq '^[0-9a-f]{12,64}$' || die "--confirm-digest must be at least 12 hex characters of the digest. Nothing was changed."
    case "$want_hex" in "$got_hex"*) ;; *) die "the confirmed digest does not match the published one (sha256:\${want_hex:0:12}...). Nothing was changed." ;; esac
    [ "$CONFIRM_VERSION" = "$version" ] || die "the confirmed pipeline version does not match the published one ($version). Nothing was changed."
    # Same project, so the kit's own credential file still applies: log in again from it (idempotent; covers a prior docker logout).
    # The password goes to docker on stdin, and nothing here writes a credential to .env.
    registry_login
    previous_image="$FEDLIFY_STUDY_IMAGE"
    export FEDLIFY_STUDY_IMAGE="$desired"
    docker compose pull --quiet || die "could not pull $desired. If the registry answered unauthorized, this site's credential expired or was revoked: download a fresh kit from Fedlify. .env was not changed."
    set_env FEDLIFY_STUDY_IMAGE "$desired"
    if ! docker compose up -d; then
      # Roll back: put the previous digest back in .env so a rerun does not claim the site is current, and try to restore the old container.
      if [ -n "$previous_image" ]; then
        set_env FEDLIFY_STUDY_IMAGE "$previous_image"
        export FEDLIFY_STUDY_IMAGE="$previous_image"
        docker compose up -d >/dev/null 2>&1 || true
      fi
      die "starting the new image failed. .env was restored to the previous image (\${previous_image:-none}) and a restart of it was attempted. Run status, then retry update."
    fi
    observe; post_beat "$(derive_status)" || true
    echo "Updated to $desired (pipeline version $version). The next heartbeat reports it to Fedlify." ;;
  logout)
    load_env
    if agent_running; then observe; post_beat OFFLINE || true; fi
    stop_agent
    if have docker && [ -n "$FEDLIFY_REGISTRY" ]; then docker logout "$FEDLIFY_REGISTRY" >/dev/null 2>&1 || true; fi
    rm -f "$TOKEN_FILE" "$LAST_BEAT" "$CRED_FILE"
    echo "Logged out: site token and registry credential files removed, heartbeat agent stopped, registry login cleared."
    echo "Running containers are not affected (use stop). The NVFLARE keys stay in nvflare/; delete this folder when the site leaves."
    echo "Revoke or rotate this kit in Fedlify if the machine is shared or lost." ;;
  *) die "usage: $0 preflight [--json] | start | stop | status [--json] | logs | update [--confirm-version V --confirm-digest HEX] | logout | agent-unit | support-bundle [--include-logs]" ;;
esac
`;
