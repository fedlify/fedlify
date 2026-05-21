#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-reset}"

cd "$ROOT_DIR"

log() {
  printf '[fedlify-reset] %s\n' "$*"
}

stop_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    log "Stopping process(es) on port ${port}: ${pids}"
    kill $pids 2>/dev/null || true
  fi
}

compose_projects_from_runtime_containers() {
  docker ps -a --format '{{.Names}}' 2>/dev/null \
    | rg '^(fedlify-[a-z0-9]{8}-[a-z0-9]{8}|manual-|e2e-live-|.+-site-[0-9]+-)' \
    | while read -r container; do
        docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$container" 2>/dev/null || true
      done \
    | awk 'NF' \
    | sort -u
}

stop_runtime_compose_projects() {
  if ! command -v docker >/dev/null 2>&1; then
    log "Docker is not installed; skipping container cleanup."
    return
  fi

  local projects
  projects="$(compose_projects_from_runtime_containers || true)"
  if [ -z "$projects" ]; then
    log "No Fedlify runtime/site Docker Compose projects found."
    return
  fi

  while read -r project; do
    [ -z "$project" ] && continue
    log "Stopping Docker Compose project: ${project}"
    docker compose -p "$project" down --remove-orphans || true
  done <<< "$projects"
}

cleanup_gitea_study_orgs() {
  if ! command -v node >/dev/null 2>&1; then
    log "Node is not installed; skipping Gitea study-org cleanup."
    return
  fi

  node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...parts] = trimmed.split("=");
    if (process.env[key]) continue;
    process.env[key] = parts.join("=").replace(/^"|"$/g, "");
  }
}

loadEnv(path.resolve(process.cwd(), ".env"));
loadEnv(path.resolve(process.cwd(), "apps/web/.env"));

const baseUrl = process.env.GITEA_BASE_URL?.replace(/\/$/, "");
const token = process.env.GITEA_TOKEN;
const studyPrefix = process.env.GITEA_STUDY_ORG_PREFIX || "fedlify-study";

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      authorization: `token ${token}`,
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers
    }
  });
  return response;
}

(async () => {
  if (!baseUrl || !token) {
    console.log("[fedlify-reset] Gitea is not configured; skipping generated study org cleanup.");
    return;
  }

  const orgResponse = await request(`${baseUrl}/api/v1/user/orgs`).catch(() => null);
  if (!orgResponse?.ok) {
    console.log("[fedlify-reset] Could not list Gitea orgs; skipping generated study org cleanup.");
    return;
  }

  const orgs = await orgResponse.json();
  for (const org of orgs) {
    const name = org.username || org.name;
    if (!name || !name.startsWith(`${studyPrefix}-`)) continue;
    const response = await request(`${baseUrl}/api/v1/orgs/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => null);
    console.log(`[fedlify-reset] Delete Gitea study org ${name}: ${response?.status ?? "failed"}`);
  }
})();
NODE
}

reset_database() {
  if ! command -v pnpm >/dev/null 2>&1; then
    log "pnpm is not installed; cannot reset database."
    return 1
  fi

  if command -v docker >/dev/null 2>&1; then
    log "Ensuring Postgres is running for Prisma reset."
    docker compose up -d postgres >/dev/null
  fi

  log "Resetting Prisma database."
  pnpm --filter @fedlify/web exec prisma migrate reset --force --skip-seed
}

cleanup_files() {
  log "Removing local runtime/output artifacts."
  rm -rf apps/web/.fedlify-runtime/* output/* apps/web/output/* 2>/dev/null || true
}

stop_base_stack() {
  log "Stopping base Docker Compose stack."
  docker compose down --remove-orphans || true
}

if [ "$MODE" != "reset" ] && [ "$MODE" != "down" ]; then
  printf 'Usage: bash scripts/fresh-test-reset.sh [reset|down]\n' >&2
  exit 2
fi

log "Starting fresh-test cleanup mode: ${MODE}"
stop_port 3000
stop_port 3010
stop_runtime_compose_projects
cleanup_gitea_study_orgs
cleanup_files
reset_database

if [ "$MODE" = "down" ]; then
  stop_base_stack
  log "Fresh reset complete. Base Docker services are stopped."
else
  log "Fresh reset complete. Base Docker services are still available for a new test."
fi

