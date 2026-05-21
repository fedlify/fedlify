#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log() {
  printf '[fedlify-start] %s\n' "$*"
}

services="$(docker compose config --services)"
requested_services=()
for service in postgres minio mailpit gitea; do
  if printf '%s\n' "$services" | grep -qx "$service"; then
    requested_services+=("$service")
  elif [ "$service" = "gitea" ]; then
    log "Compose service 'gitea' is not defined here; assuming Gitea is external or already running."
  else
    log "Compose service '${service}' is not defined here; skipping."
  fi
done

if [ "${#requested_services[@]}" -gt 0 ]; then
  log "Starting Docker services: ${requested_services[*]}"
  docker compose up -d "${requested_services[@]}"
else
  log "No local Docker services were found in docker-compose.yml."
fi

log "Applying Prisma migrations"
pnpm --filter @fedlify/web exec prisma migrate deploy

log "Starting Fedlify web app at http://localhost:3000"
pnpm --filter @fedlify/web dev
