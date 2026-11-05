// Public pre-install checks, served from /get-ready/preflight.sh and /get-ready/preflight.ps1 and NOT part of the encrypted
// kit: a site has to be able to run them before it has a kit, a passphrase or Docker. They read local facts and probe DNS and TCP
// 443 for the hosts given on the command line. They send nothing, store nothing, need no token or credential, and write no file.
// tests/site-preflight.test.ts runs the bash script with fake tools. The PowerShell script has NOT been run anywhere.
import { createHash } from "node:crypto";

export const PREFLIGHT_VERSION = "fedlify-preflight-1";

export const PREFLIGHT_SH = `#!/usr/bin/env bash
# Fedlify pre-install check for macOS, Linux and WSL (bash 3.2+). Needs no Docker, no kit and no account.
# It only reads local facts and opens a TCP connection to the hosts you pass. It sends no data and writes no file.
# usage: ./preflight.sh [--json] [--aggregator HOST[:PORT]] [--registry HOST[:PORT]] [--data DIR]
#   HOST values are in the site page of Fedlify (the study server) and in the kit's .env (the registry).
set -u
VERSION="${PREFLIGHT_VERSION}"
JSON=0; AGG=""; REG=""; DATA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1 ;;
    --aggregator|--registry|--data)
      # a value is required and must not be the next flag (otherwise "--aggregator --json" would probe a host named --json)
      if [ $# -lt 2 ] || [ -z "$2" ]; then echo "option $1 needs a value (try --help)" >&2; exit 2; fi
      case "$2" in -*) echo "option $1 needs a value, got the flag $2 (try --help)" >&2; exit 2 ;; esac
      case "$1" in --aggregator) AGG="$2" ;; --registry) REG="$2" ;; *) DATA="$2" ;; esac
      shift ;;
    -h|--help) sed -n '2,/^[^#]/{/^#/p;}' "$0" | sed 's/^# \\{0,1\\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

have() { command -v "$1" >/dev/null 2>&1; }
jstr() { printf '%s' "$1" | tr -d '\\000-\\037' | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'; }
CHECKS=""; FAILS=0; WARNS=0
add() { # add ID pass|warn|fail DETAIL
  CHECKS="$CHECKS\${CHECKS:+,}{\\"id\\":\\"$1\\",\\"status\\":\\"$2\\",\\"detail\\":\\"$(jstr "$3")\\"}"
  [ "$2" = "fail" ] && FAILS=$((FAILS + 1))
  [ "$2" = "warn" ] && WARNS=$((WARNS + 1))
  if [ "$JSON" != "1" ]; then printf '  [%s] %s: %s\\n' "$2" "$1" "$3"; fi
  return 0
}
resolves() {
  if have getent && getent hosts "$1" >/dev/null 2>&1; then return 0; fi
  if have dscacheutil && dscacheutil -q host -a name "$1" 2>/dev/null | grep -q 'ip_address'; then return 0; fi
  if have nslookup && nslookup "$1" >/dev/null 2>&1; then return 0; fi
  if have host && host "$1" >/dev/null 2>&1; then return 0; fi
  return 1
}
reachable() {
  if have nc; then nc -z -w 5 "$1" "$2" >/dev/null 2>&1; return $?; fi
  if have curl; then
    local rc=0
    curl -sS -m 6 -o /dev/null "https://$1:$2/" >/dev/null 2>&1 || rc=$?
    case "$rc" in 6|7|28) return 1 ;; *) return 0 ;; esac
  fi
  return 1
}
probe() { # probe ID HOST[:PORT]
  local id="$1" target="$2" host port
  target="\${target#*://}"; target="\${target%%/*}"
  host="\${target%%:*}"; port="\${target##*:}"
  if [ "$host" = "$target" ] || [ -z "$port" ]; then port=443; fi
  case "$host" in ''|*[!A-Za-z0-9._-]*) add "$id" fail "'$2' is not a valid host name"; return 0 ;; esac
  if ! resolves "$host"; then add "$id" fail "cannot resolve $host (check DNS or VPN; a just-published study can take a few minutes)"; return 0; fi
  if reachable "$host" "$port"; then add "$id" pass "$host:$port reachable"; else add "$id" fail "$host:$port is not reachable (outbound $port must be allowed by the firewall or proxy)"; fi
}

OS="$(uname -s)"; ARCH="$(uname -m)"
add platform pass "$OS $ARCH"
case "$ARCH" in
  arm64|aarch64) add architecture warn "ARM machine: the study image is published for amd64 only unless the study page says otherwise, so Docker runs it under emulation (slower, not verified)" ;;
  x86_64|amd64) add architecture pass "amd64" ;;
  *) add architecture warn "unrecognised architecture $ARCH" ;;
esac
case "$(uname -r)" in
  *[Mm]icrosoft*|*WSL*) add wsl pass "running inside WSL" ;;
esac

DOCKER_OK=0
if have docker; then
  if docker info >/dev/null 2>&1; then DOCKER_OK=1; add docker pass "Docker engine reachable"
  else add docker fail "Docker is installed but the engine is not running, or you lack permission (Linux: add yourself to the docker group, or use sudo)"; fi
else add docker fail "Docker not found. Install it first: see the Get ready page for your system"; fi
if [ "$DOCKER_OK" = "1" ]; then
  v="$(docker compose version --short 2>/dev/null || true)"
  case "$v" in
    '') add compose fail "Docker Compose v2 plugin not found (docker compose version fails)" ;;
    v2.*|2.*|v[3-9]*|[3-9]*) add compose pass "Compose $v" ;;
    *) add compose fail "Compose $v is too old; v2 is required" ;;
  esac
else add compose warn "not checked: needs a running Docker"; fi

free="$(df -Pk "$PWD" 2>/dev/null | awk 'NR==2 {print int($4/1048576)}')"
case "$free" in
  ''|*[!0-9]*) add disk warn "could not read free disk space" ;;
  *) if [ "$free" -lt 5 ]; then add disk fail "\${free} GB free here; at least 5 GB are needed for images"
     elif [ "$free" -lt 20 ]; then add disk warn "\${free} GB free here; 20 GB or more recommended"
     else add disk pass "\${free} GB free here"; fi ;;
esac

mem=""
if [ -r /proc/meminfo ]; then mem="$(awk '/^MemTotal:/ {print int($2/1048576)}' /proc/meminfo)"
elif have sysctl; then b="$(sysctl -n hw.memsize 2>/dev/null || true)"; case "$b" in ''|*[!0-9]*) ;; *) mem=$((b / 1073741824)) ;; esac; fi
if [ "$DOCKER_OK" = "1" ]; then
  d="$(docker info --format '{{.MemTotal}}' 2>/dev/null || true)"
  case "$d" in ''|*[!0-9]*) ;; *) dm=$((d / 1073741824)); add docker_memory "$([ "$dm" -lt 2 ] && echo fail || { [ "$dm" -lt 4 ] && echo warn || echo pass; })" "Docker can use \${dm} GB (raise it in Docker Desktop settings if low; at least 2 GB, 4 GB or more recommended)" ;; esac
fi
case "$mem" in
  '') add ram warn "could not read installed memory" ;;
  *) if [ "$mem" -lt 4 ]; then add ram warn "\${mem} GB RAM installed; 8 GB or more recommended"; else add ram pass "\${mem} GB RAM installed"; fi ;;
esac

if [ -n "$AGG" ]; then probe aggregator "$AGG"; else add aggregator warn "not checked: pass --aggregator HOST (the study server shown on your site page in Fedlify)"; fi
if [ -n "$REG" ]; then probe registry "$REG"; else add registry warn "not checked: pass --registry HOST (the image registry in your kit's .env)"; fi

if [ -n "$DATA" ]; then
  if [ -d "$DATA" ]; then
    n="$(find "$DATA" -maxdepth 2 -type f -iname '*.csv' 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$n" = "0" ]; then add data warn "folder exists but holds no .csv files yet"; else add data pass "$n csv file(s) found (names only; contents are never read here)"; fi
  else add data fail "data folder not found: $DATA"; fi
fi

gpus=0
if have nvidia-smi; then gpus="$(nvidia-smi -L 2>/dev/null | grep -c '^GPU' || true)"; fi
if [ "\${gpus:-0}" -gt 0 ]; then
  if [ "$DOCKER_OK" = "1" ] && docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"'; then add gpu pass "$gpus NVIDIA GPU(s) and the container toolkit detected (optional: CPU is the default)"
  else add gpu pass "$gpus NVIDIA GPU(s) found; the NVIDIA container toolkit was not detected, so Docker cannot use them (optional: CPU is the default)"; fi
else add gpu pass "no NVIDIA GPU detected; runs on CPU (the default)"; fi

OK=true; [ "$FAILS" -gt 0 ] && OK=false
if [ "$JSON" = "1" ]; then
  printf '{"ok":%s,"version":"%s","failed":%s,"warnings":%s,"checks":[%s]}\\n' "$OK" "$VERSION" "$FAILS" "$WARNS" "$CHECKS"
else
  echo "Result: $FAILS failed, $WARNS warning(s). Nothing was sent or saved."
fi
[ "$FAILS" -eq 0 ]
`;

export const PREFLIGHT_PS1 = `# Fedlify pre-install check for Windows (PowerShell 5.1 or 7). UNVERIFIED: never run on a real Windows machine.
# Needs no Docker, no kit and no account. Reads local facts and opens a TCP connection to the hosts you pass. Sends no data, writes no file.
# On Windows the runner runs inside WSL 2 with Docker Desktop, so this checks WSL and Docker Desktop's WSL integration.
# usage: powershell -ExecutionPolicy Bypass -File .\\preflight.ps1 [-Json] [-Aggregator HOST[:PORT]] [-Registry HOST[:PORT]] [-Data DIR]
param([switch]$Json, [string]$Aggregator = '', [string]$Registry = '', [string]$Data = '')
$ErrorActionPreference = 'Continue'
$version = '${PREFLIGHT_VERSION}'
$script:checks = New-Object System.Collections.ArrayList
function Add-Check([string]$Id, [string]$Status, [string]$Detail) {
  [void]$script:checks.Add([ordered]@{ id = $Id; status = $Status; detail = $Detail })
  if (-not $Json) { Write-Host ('  [{0}] {1}: {2}' -f $Status, $Id, $Detail) }
}
function Test-Tcp([string]$HostName, [int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync($HostName, $Port)
    return ($task.Wait(5000) -and $client.Connected)
  } catch { return $false } finally { $client.Close() }
}
function Test-Target([string]$Id, [string]$Target) {
  $t = $Target -replace '^[a-z]+://', '' -replace '/.*$', ''
  $parts = $t.Split(':')
  $hostName = $parts[0]; $port = 443
  if ($parts.Length -gt 1 -and $parts[1] -match '^\\d+$') { $port = [int]$parts[1] }
  if ($hostName -notmatch '^[A-Za-z0-9._-]+$') { Add-Check $Id 'fail' ("'{0}' is not a valid host name" -f $Target); return }
  try { [void][System.Net.Dns]::GetHostAddresses($hostName) } catch { Add-Check $Id 'fail' ("cannot resolve {0} (check DNS or VPN)" -f $hostName); return }
  if (Test-Tcp $hostName $port) { Add-Check $Id 'pass' ('{0}:{1} reachable' -f $hostName, $port) }
  else { Add-Check $Id 'fail' ('{0}:{1} is not reachable (outbound {1} must be allowed by the firewall or proxy)' -f $hostName, $port) }
}
function Get-WslText([string[]]$WslArgs) { # wsl.exe prints UTF-16 for its own messages; drop the NUL bytes
  $out = & wsl.exe @WslArgs 2>&1
  return (($out | Out-String) -replace "\\0", '')
}

Add-Check 'platform' 'pass' ('{0} {1}' -f [Environment]::OSVersion.VersionString, $env:PROCESSOR_ARCHITECTURE)
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { Add-Check 'architecture' 'warn' 'ARM64 Windows: the study image is published for amd64 only unless the study page says otherwise, so it runs under emulation (not verified)' }
elseif ([Environment]::Is64BitOperatingSystem) { Add-Check 'architecture' 'pass' 'amd64' }
else { Add-Check 'architecture' 'fail' '32-bit Windows cannot run Docker Desktop' }

$wslOk = $false
if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
  $list = Get-WslText @('-l', '-v')
  # Docker Desktop's own docker-desktop and docker-desktop-data distributions are WSL 2 too but cannot run the kit: ignore them.
  $userDistros = ($list -split "\`r?\`n") | Where-Object { $_ -notmatch 'docker-desktop' }
  if ($userDistros -match '\\s2\\s*$') { $wslOk = $true; Add-Check 'wsl2' 'pass' 'a WSL 2 distribution is installed' }
  else { Add-Check 'wsl2' 'fail' 'no WSL 2 distribution found. In an administrator PowerShell run: wsl --install -d Ubuntu, then restart (see the Get ready page)' }
} else { Add-Check 'wsl2' 'fail' 'wsl.exe not found. Windows 10 2004+ or Windows 11 is required; see the Get ready page' }

if (Get-Command docker.exe -ErrorAction SilentlyContinue) {
  & docker.exe info *> $null
  if ($LASTEXITCODE -eq 0) { Add-Check 'docker_desktop' 'pass' 'Docker Desktop engine reachable from Windows' }
  else { Add-Check 'docker_desktop' 'fail' 'Docker is installed but the engine is not running; start Docker Desktop and wait until it says running' }
} else { Add-Check 'docker_desktop' 'fail' 'Docker Desktop not found; see the Get ready page' }

if ($wslOk) {
  $dv = (Get-WslText @('-e', 'docker', 'version', '--format', '{{.Server.Version}}')).Trim()
  if ($LASTEXITCODE -eq 0 -and $dv -match '^\\d') { Add-Check 'docker_in_wsl' 'pass' ('Docker {0} reachable inside WSL' -f $dv) }
  else { Add-Check 'docker_in_wsl' 'fail' 'Docker is not reachable inside WSL. In Docker Desktop: Settings > Resources > WSL integration, enable your distribution' }
  $cv = (Get-WslText @('-e', 'docker', 'compose', 'version', '--short')).Trim()
  if ($LASTEXITCODE -eq 0 -and $cv -match '^v?2\\.') { Add-Check 'compose' 'pass' ('Compose {0} inside WSL' -f $cv) }
  else { Add-Check 'compose' 'fail' 'Docker Compose v2 not found inside WSL' }
} else { Add-Check 'docker_in_wsl' 'warn' 'not checked: needs WSL 2' }

$drive = (Get-Location).Drive
if ($drive) {
  $freeGb = [math]::Floor($drive.Free / 1GB)
  if ($freeGb -lt 5) { Add-Check 'disk' 'fail' ('{0} GB free on {1}: ; at least 5 GB are needed' -f $freeGb, $drive.Name) }
  elseif ($freeGb -lt 20) { Add-Check 'disk' 'warn' ('{0} GB free on {1}: ; 20 GB or more recommended' -f $freeGb, $drive.Name) }
  else { Add-Check 'disk' 'pass' ('{0} GB free on {1}:' -f $freeGb, $drive.Name) }
}
try {
  $ramGb = [math]::Floor((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
  if ($ramGb -lt 4) { Add-Check 'ram' 'warn' ('{0} GB RAM installed; 8 GB or more recommended' -f $ramGb) } else { Add-Check 'ram' 'pass' ('{0} GB RAM installed' -f $ramGb) }
} catch { Add-Check 'ram' 'warn' 'could not read installed memory' }

if ($Aggregator) { Test-Target 'aggregator' $Aggregator } else { Add-Check 'aggregator' 'warn' 'not checked: pass -Aggregator HOST (the study server shown on your site page in Fedlify)' }
if ($Registry) { Test-Target 'registry' $Registry } else { Add-Check 'registry' 'warn' 'not checked: pass -Registry HOST (the image registry in your kit .env)' }
if ($Data) {
  if (Test-Path -LiteralPath $Data -PathType Container) {
    $n = @(Get-ChildItem -LiteralPath $Data -Filter *.csv -File -ErrorAction SilentlyContinue).Count
    if ($n -eq 0) { Add-Check 'data' 'warn' 'folder exists but holds no .csv files yet' } else { Add-Check 'data' 'pass' ('{0} csv file(s) found (names only; contents are never read here)' -f $n) }
  } else { Add-Check 'data' 'fail' ('data folder not found: {0}' -f $Data) }
}

$gpu = $null
if (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue) { $gpu = (& nvidia-smi.exe -L 2>$null | Out-String).Trim() }
if ($gpu) { Add-Check 'gpu' 'pass' 'an NVIDIA GPU was found (optional: CPU is the default; Docker GPU support inside WSL is not checked here)' }
else { Add-Check 'gpu' 'pass' 'no NVIDIA GPU detected; runs on CPU (the default)' }

$failed = @($script:checks | Where-Object { $_.status -eq 'fail' }).Count
$warned = @($script:checks | Where-Object { $_.status -eq 'warn' }).Count
if ($Json) {
  [ordered]@{ ok = ($failed -eq 0); version = $version; failed = $failed; warnings = $warned; checks = @($script:checks) } | ConvertTo-Json -Depth 4
} else { Write-Host ('Result: {0} failed, {1} warning(s). Nothing was sent or saved.' -f $failed, $warned) }
if ($failed -gt 0) { exit 1 } else { exit 0 }
`;

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export const PREFLIGHT_SH_SHA256 = sha256(PREFLIGHT_SH);
export const PREFLIGHT_PS1_SHA256 = sha256(PREFLIGHT_PS1);
