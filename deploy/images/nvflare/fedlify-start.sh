#!/usr/bin/env bash
# Runs an NVFLARE participant in the foreground (containers must not daemonize like start.sh does).
#
#   fedlify-start server   # aggregator; startup kit mounted at $FEDLIFY_KIT_DIR
#   fedlify-start client   # hospital site; startup kit mounted at $FEDLIFY_KIT_DIR
#   fedlify-start <cmd...> # anything else is executed as-is (e.g. the FLARE API adapter)
#
# The kit is copied into a writable workspace because NVFLARE writes run state next to startup/.
set -euo pipefail

role="${1:-}"
kit_dir="${FEDLIFY_KIT_DIR:-/kit}"
workspace="${FEDLIFY_WORKSPACE_DIR:-/workspace/participant}"

prepare_workspace() {
  if [ ! -f "${kit_dir}/startup/$1" ]; then
    echo "fedlify-start: ${kit_dir}/startup/$1 not found; mount the NVFLARE startup kit at ${kit_dir}." >&2
    exit 1
  fi
  mkdir -p "${workspace}"
  cp -R "${kit_dir}/." "${workspace}/"
  mkdir -p "${workspace}/transfer"
  rm -f "${workspace}"/*.fl
}

case "${role}" in
  server)
    prepare_workspace fed_server.json
    org="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["servers"][0].get("org","fedlify"))' "${workspace}/startup/fed_server.json" 2>/dev/null || echo fedlify)"
    exec python3 -u -m nvflare.private.fed.app.server.server_train \
      -m "${workspace}" -s fed_server.json \
      --set secure_train=true "org=${FEDLIFY_ORG:-${org}}" config_folder=config
    ;;
  client)
    prepare_workspace fed_client.json
    name="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["client"]["fqsn"])' "${workspace}/startup/fed_client.json")"
    # NVFLARE orgs allow only [A-Za-z0-9_]; must match the org provision.py put in the certificate.
    default_org="$(printf '%s' "${name}" | sed 's/[^A-Za-z0-9_]/_/g')"
    exec python3 -u -m nvflare.private.fed.app.client.client_train \
      -m "${workspace}" -s fed_client.json \
      --set secure_train=true "uid=${name}" "org=${FEDLIFY_ORG:-${default_org}}" config_folder=config
    ;;
  "")
    echo "usage: fedlify-start server|client|<command>" >&2
    exit 2
    ;;
  *)
    exec "$@"
    ;;
esac
