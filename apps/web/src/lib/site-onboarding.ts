import { sha256 } from "@/lib/crypto";

export type ReadinessInput = {
  connectivityVerified?: boolean;
  kitInstalled?: boolean;
  dependenciesVerified?: boolean;
  policyAccepted?: boolean;
};

export type StartupPackageManifestInput = {
  apiBaseUrl: string;
  studyId: string;
  studyTitle: string;
  studySiteId: string;
  siteId: string;
  siteCode: string;
  siteName: string;
  nvflareClientName: string;
  deployment?: {
    id: string;
    status?: string | null;
    serverAddress?: string | null;
    adminAddress?: string | null;
  } | null;
  expiresAt: Date;
};

export const SITE_ONBOARDING_STEPS = [
  "Accept participation",
  "Review governance",
  "Download startup kit",
  "Install local runner",
  "Configure data",
  "Pass readiness",
  "Join federation"
] as const;

export function readinessStatus(input: ReadinessInput) {
  return input.connectivityVerified && input.kitInstalled && input.dependenciesVerified && input.policyAccepted
    ? "PASSED"
    : "PENDING";
}

export function buildStartupPackageManifest(input: StartupPackageManifestInput) {
  return {
    packageType: "fedlify-site-startup-kit",
    version: "1.0.0",
    study: {
      id: input.studyId,
      title: input.studyTitle
    },
    site: {
      studySiteId: input.studySiteId,
      siteId: input.siteId,
      code: input.siteCode,
      name: input.siteName,
      nvflareClientName: input.nvflareClientName
    },
    fedlify: {
      apiBaseUrl: input.apiBaseUrl,
      heartbeatEndpoint: `${input.apiBaseUrl}/api/v1/sites/${input.siteId}/heartbeat`,
      enrollmentTokenEnv: "FEDLIFY_SITE_TOKEN"
    },
    nvflare: {
      deploymentId: input.deployment?.id ?? null,
      deploymentStatus: input.deployment?.status ?? null,
      serverAddress: input.deployment?.serverAddress ?? null,
      adminAddress: input.deployment?.adminAddress ?? null
    },
    files: {
      readme: "README.md",
      runner: "fedlify-runner.sh",
      runnerPowerShell: "fedlify-runner.ps1",
      compose: "docker-compose.yml",
      env: ".env",
      envExample: ".env.example",
      nvflareClientConfig: "nvflare/client.json",
      manifest: "manifest.json"
    },
    installCommands: [
      "chmod +x fedlify-runner.sh",
      "FEDLIFY_SITE_TOKEN=<token-shown-once-in-fedlify> ./fedlify-runner.sh start --safe"
    ],
    dataBoundary: "Raw clinical data remains at the participant site. Configure only local dataset paths or site-local connectors.",
    expiresAt: input.expiresAt.toISOString()
  };
}

export function startupPackageChecksum(manifest: unknown) {
  return sha256(JSON.stringify(manifest));
}

function dockerReachableUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      url.hostname = "host.docker.internal";
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

function buildUnixRunnerScript() {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "COMMAND=\"start\"",
    "if [ \"$#\" -gt 0 ]; then",
    "  case \"$1\" in",
    "    start|doctor|stop|logs) COMMAND=\"$1\"; shift ;;",
    "  esac",
    "fi",
    "",
    "TOKEN=\"${FEDLIFY_SITE_TOKEN:-}\"",
    "INSTALL_DEPS=0",
    "YES=0",
    "SAFE_MODE=1",
    "",
    "while [ \"$#\" -gt 0 ]; do",
    "  case \"$1\" in",
    "    --token) TOKEN=\"${2:-}\"; shift 2 ;;",
    "    --install-deps) INSTALL_DEPS=1; shift ;;",
    "    --yes|-y) YES=1; shift ;;",
    "    --safe) SAFE_MODE=1; shift ;;",
    "    --help|-h)",
    "      cat <<'HELP'",
    "Fedlify site runner",
    "",
    "Usage:",
    "  FEDLIFY_SITE_TOKEN=<token> ./fedlify-runner.sh start --safe",
    "  ./fedlify-runner.sh doctor --token <token>",
    "  ./fedlify-runner.sh logs",
    "  ./fedlify-runner.sh stop",
    "",
    "Safe mode checks Docker and configuration before starting. Dependency installation",
    "requires the explicit --install-deps --yes flags because it may use sudo or install",
    "Docker Desktop/package-manager dependencies on this client machine.",
    "HELP",
    "      exit 0",
    "      ;;",
    "    *) echo \"Unknown option: $1\" >&2; exit 2 ;;",
    "  esac",
    "done",
    "",
    "log() { printf '\\033[1;34m[fedlify]\\033[0m %s\\n' \"$*\"; }",
    "warn() { printf '\\033[1;33m[fedlify]\\033[0m %s\\n' \"$*\" >&2; }",
    "die() { printf '\\033[1;31m[fedlify]\\033[0m %s\\n' \"$*\" >&2; exit 1; }",
    "have() { command -v \"$1\" >/dev/null 2>&1; }",
    "",
    "confirm() {",
    "  [ \"$YES\" = \"1\" ] && return 0",
    "  printf \"%s [y/N] \" \"$1\"",
    "  read -r answer || true",
    "  [ \"$answer\" = \"y\" ] || [ \"$answer\" = \"Y\" ]",
    "}",
    "",
    "install_docker() {",
    "  if [ \"$INSTALL_DEPS\" != \"1\" ]; then",
    "    warn \"Docker is not installed or not on PATH.\"",
    "    warn \"Install Docker Desktop/Engine, then rerun: ./fedlify-runner.sh start\"",
    "    warn \"To let this runner attempt installation, rerun with: --install-deps --yes\"",
    "    exit 11",
    "  fi",
    "  confirm \"Install Docker dependencies on this machine now?\" || die \"Docker installation cancelled.\"",
    "  os=\"$(uname -s)\"",
    "  if [ \"$os\" = \"Darwin\" ]; then",
    "    have brew || die \"Homebrew is required for automatic Docker Desktop installation on macOS: https://brew.sh\"",
    "    brew install --cask docker",
    "    open -a Docker || true",
    "    return 0",
    "  fi",
    "  if have apt-get; then",
    "    sudo apt-get update",
    "    sudo apt-get install -y docker.io docker-compose-plugin",
    "    sudo usermod -aG docker \"${USER:-$(id -un)}\" || true",
    "    warn \"You may need to log out and back in before Docker works without sudo.\"",
    "    return 0",
    "  fi",
    "  if have dnf; then",
    "    sudo dnf install -y docker docker-compose-plugin",
    "    sudo systemctl enable --now docker || true",
    "    return 0",
    "  fi",
    "  die \"Automatic Docker installation is not supported on this OS. Install Docker and rerun the runner.\"",
    "}",
    "",
    "ensure_docker() {",
    "  have docker || install_docker",
    "  if ! docker info >/dev/null 2>&1; then",
    "    if [ \"$(uname -s)\" = \"Darwin\" ]; then",
    "      log \"Starting Docker Desktop...\"",
    "      open -a Docker || true",
    "      for _ in $(seq 1 60); do",
    "        docker info >/dev/null 2>&1 && break",
    "        sleep 2",
    "      done",
    "    fi",
    "  fi",
    "  docker info >/dev/null 2>&1 || die \"Docker is installed but the daemon is not running.\"",
    "  docker compose version >/dev/null 2>&1 || die \"Docker Compose v2 is required. Install the Docker Compose plugin and rerun.\"",
    "}",
    "",
    "write_env() {",
    "  [ -f manifest.json ] || die \"Run this command from the extracted Fedlify startup kit directory.\"",
    "  [ -f .env ] || cp .env.example .env",
    "  if [ -n \"$TOKEN\" ]; then",
    "    tmp=\"$(mktemp)\"",
    "    awk -v token=\"$TOKEN\" 'BEGIN{done=0} /^FEDLIFY_SITE_TOKEN=/{print \"FEDLIFY_SITE_TOKEN=\" token; done=1; next} {print} END{if(!done) print \"FEDLIFY_SITE_TOKEN=\" token}' .env > \"$tmp\"",
    "    mv \"$tmp\" .env",
    "  fi",
    "  if grep -q '<paste-token' .env || ! awk -F= 'BEGIN{missing=1} /^FEDLIFY_SITE_TOKEN=/{if(length($2) >= 20) missing=0} END{exit missing}' .env >/dev/null 2>&1; then",
    "    die \"Missing FEDLIFY_SITE_TOKEN. Run: FEDLIFY_SITE_TOKEN=<token-from-fedlify> ./fedlify-runner.sh start --safe\"",
    "  fi",
    "}",
    "",
    "doctor() {",
    "  write_env",
    "  ensure_docker",
    "  log \"Configuration file: .env\"",
    "  log \"Docker: $(docker --version)\"",
    "  log \"Compose: $(docker compose version)\"",
    "  log \"Heartbeat endpoint: $(awk -F= '/^FEDLIFY_HEARTBEAT_ENDPOINT=/{print $2}' .env)\"",
    "  log \"NVFLARE server: $(awk -F= '/^NVFLARE_SERVER_ADDRESS=/{print $2}' .env)\"",
    "}",
    "",
    "case \"$COMMAND\" in",
    "  doctor)",
    "    doctor",
    "    ;;",
    "  start)",
    "    doctor",
    "    log \"Starting Fedlify site runner and NVFLARE client...\"",
    "    docker compose pull || true",
    "    docker compose up -d",
    "    docker compose ps",
    "    log \"Runner started. Fedlify should show heartbeat within about 30 seconds.\"",
    "    ;;",
    "  stop)",
    "    ensure_docker",
    "    docker compose down",
    "    ;;",
    "  logs)",
    "    ensure_docker",
    "    docker compose logs -f --tail=100",
    "    ;;",
    "  *)",
    "    die \"Unknown command: $COMMAND\"",
    "    ;;",
    "esac",
    ""
  ].join("\n");
}

function buildPowerShellRunnerScript() {
  return [
    "param(",
    "  [ValidateSet('start','doctor','stop','logs')] [string]$Command = 'start',",
    "  [string]$Token = $env:FEDLIFY_SITE_TOKEN,",
    "  [switch]$InstallDeps",
    ")",
    "$ErrorActionPreference = 'Stop'",
    "function Log($message) { Write-Host \"[fedlify] $message\" -ForegroundColor Cyan }",
    "function Fail($message) { Write-Host \"[fedlify] $message\" -ForegroundColor Red; exit 1 }",
    "",
    "function Write-FedlifyEnv {",
    "  if (!(Test-Path 'manifest.json')) { Fail 'Run this command from the extracted Fedlify startup kit directory.' }",
    "  if (!(Test-Path '.env')) { Copy-Item '.env.example' '.env' }",
    "  if ($Token) {",
    "    $lines = Get-Content '.env'",
    "    $found = $false",
    "    $lines = $lines | ForEach-Object { if ($_ -like 'FEDLIFY_SITE_TOKEN=*') { $found = $true; \"FEDLIFY_SITE_TOKEN=$Token\" } else { $_ } }",
    "    if (!$found) { $lines += \"FEDLIFY_SITE_TOKEN=$Token\" }",
    "    Set-Content -Path '.env' -Value $lines",
    "  }",
    "  $envLine = Get-Content '.env' | Where-Object { $_ -like 'FEDLIFY_SITE_TOKEN=*' } | Select-Object -First 1",
    "  if (!$envLine -or $envLine -like '*<paste-token*' -or $envLine.Length -lt 40) {",
    "    Fail 'Missing FEDLIFY_SITE_TOKEN. Run: .\\fedlify-runner.ps1 start -Token <token-from-fedlify>'",
    "  }",
    "}",
    "",
    "function Ensure-Docker {",
    "  if (!(Get-Command docker -ErrorAction SilentlyContinue)) {",
    "    if ($InstallDeps) {",
    "      if (Get-Command winget -ErrorAction SilentlyContinue) {",
    "        winget install -e --id Docker.DockerDesktop",
    "        Fail 'Docker Desktop was installed or queued. Start Docker Desktop, then rerun this command.'",
    "      }",
    "    }",
    "    Fail 'Docker Desktop is required. Install Docker Desktop, start it, then rerun this command.'",
    "  }",
    "  docker info *> $null",
    "  if ($LASTEXITCODE -ne 0) { Fail 'Docker is installed but the daemon is not running. Start Docker Desktop and rerun.' }",
    "  docker compose version *> $null",
    "  if ($LASTEXITCODE -ne 0) { Fail 'Docker Compose v2 is required.' }",
    "}",
    "",
    "function Doctor {",
    "  Write-FedlifyEnv",
    "  Ensure-Docker",
    "  Log 'Configuration file: .env'",
    "  Log ((docker --version) -join ' ')",
    "  Log ((docker compose version) -join ' ')",
    "}",
    "",
    "switch ($Command) {",
    "  'doctor' { Doctor }",
    "  'start' { Doctor; docker compose pull; docker compose up -d; docker compose ps; Log 'Runner started. Fedlify should show heartbeat within about 30 seconds.' }",
    "  'stop' { Ensure-Docker; docker compose down }",
    "  'logs' { Ensure-Docker; docker compose logs -f --tail=100 }",
    "}",
    ""
  ].join("\n");
}

export function buildStartupKitFiles(manifest: ReturnType<typeof buildStartupPackageManifest>) {
  const dockerApiBaseUrl = dockerReachableUrl(manifest.fedlify.apiBaseUrl);
  const dockerHeartbeatEndpoint = `${dockerApiBaseUrl}/api/v1/sites/${manifest.site.siteId}/heartbeat`;
  const environmentFile = (siteToken: string) => [
    `FEDLIFY_API_BASE_URL=${dockerApiBaseUrl}`,
    `FEDLIFY_HEARTBEAT_ENDPOINT=${dockerHeartbeatEndpoint}`,
    `FEDLIFY_SITE_TOKEN=${siteToken}`,
    `FEDLIFY_STUDY_SITE_ID=${manifest.site.studySiteId}`,
    `FEDLIFY_RUNTIME_SITE_ID=${manifest.site.siteId}`,
    `NVFLARE_CLIENT_NAME=${manifest.site.nvflareClientName}`,
    `NVFLARE_SERVER_ADDRESS=${manifest.nvflare.serverAddress ?? ""}`,
    ""
  ].join("\n");
  const envFile = environmentFile("");
  const envExample = environmentFile("<paste-token-shown-once-in-fedlify>");
  const compose = [
    "services:",
    "  fedlify-site-agent:",
    "    image: curlimages/curl:latest",
    "    extra_hosts:",
    "      - \"host.docker.internal:host-gateway\"",
    "    env_file:",
    "      - .env",
    "    environment:",
    "      FEDLIFY_SITE_TOKEN: ${FEDLIFY_SITE_TOKEN:-}",
    "    command:",
    "      - /bin/sh",
    "      - -lc",
    "      - |",
    "        while true; do",
    "          curl -fsS -X POST \"$$FEDLIFY_HEARTBEAT_ENDPOINT\" \\",
    "            -H \"content-type: application/json\" \\",
    "            -H \"x-site-token: $$FEDLIFY_SITE_TOKEN\" \\",
    "            -d '{\"status\":\"CONNECTED\",\"version\":\"fedlify-compose-site-agent\",\"metadata\":{\"runner\":\"docker-compose\"}}' || true",
    "          sleep 30",
    "        done",
    "  nvflare-client:",
    "    image: ${NVFLARE_DOCKER_IMAGE:-fedlify-nvflare:2.6.2}",
    "    extra_hosts:",
    "      - \"host.docker.internal:host-gateway\"",
    "    env_file:",
    "      - .env",
    "    working_dir: /workspace/nvflare/startup",
    "    command: [\"/bin/bash\", \"-lc\", \"chmod +x start.sh sub_start.sh stop_fl.sh && ./start.sh && tail -f /dev/null\"]",
    "    volumes:",
    "      - ./nvflare:/workspace/nvflare",
    ""
  ].join("\n");
  const readme = [
    `# Fedlify startup kit: ${manifest.site.name}`,
    "",
    `Study: ${manifest.study.title}`,
    `NVFLARE client: ${manifest.site.nvflareClientName}`,
    `Aggregator: ${manifest.nvflare.serverAddress ?? "not provisioned yet"}`,
    "",
    "## Start in safe mode",
    "Run the Fedlify runner from this extracted directory. It writes the token into `.env`, checks Docker, starts Docker Desktop when possible, and launches the site runner with Docker Compose.",
    "",
    "```bash",
    "chmod +x fedlify-runner.sh",
    "FEDLIFY_SITE_TOKEN=<token-from-fedlify> ./fedlify-runner.sh start --safe",
    "```",
    "",
    "Windows PowerShell:",
    "",
    "```powershell",
    ".\\fedlify-runner.ps1 start -Token <token-from-fedlify>",
    "```",
    "",
    "Useful commands:",
    "",
    "```bash",
    "./fedlify-runner.sh doctor",
    "./fedlify-runner.sh logs",
    "./fedlify-runner.sh stop",
    "```",
    "",
    "Safe mode does not perform privileged dependency installation automatically. If Docker is missing and the site allows the runner to install dependencies, rerun with `--install-deps --yes`.",
    "",
    "The `nvflare/` directory contains the real client startup kit produced by `nvflare provision` for this site.",
    "",
    "Raw clinical data must remain on this site network. Configure only local paths/connectors inside the site environment.",
    ""
  ].join("\n");
  const files: Record<string, string> = {
    "README.md": readme,
    "fedlify-runner.sh": buildUnixRunnerScript(),
    "fedlify-runner.ps1": buildPowerShellRunnerScript(),
    "docker-compose.yml": compose,
    ".env": envFile,
    ".env.example": envExample,
    "manifest.json": JSON.stringify(manifest, null, 2),
    "fedlify-site-agent/config.json": JSON.stringify(
      {
        heartbeatEndpoint: manifest.fedlify.heartbeatEndpoint,
        dockerHeartbeatEndpoint,
        enrollmentTokenEnv: manifest.fedlify.enrollmentTokenEnv,
        studySiteId: manifest.site.studySiteId,
        runtimeSiteId: manifest.site.siteId
      },
      null,
      2
    ),
    "nvflare/client.json": JSON.stringify(
      {
        clientName: manifest.site.nvflareClientName,
        serverAddress: manifest.nvflare.serverAddress,
        deploymentId: manifest.nvflare.deploymentId
      },
      null,
      2
    )
  };
  files["checksums.json"] = JSON.stringify(
    Object.fromEntries(Object.entries(files).map(([path, body]) => [path, sha256(body)])),
    null,
    2
  );
  return files;
}
