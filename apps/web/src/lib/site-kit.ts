import type { ArchiveFileMap } from "@/lib/archive";
import type { buildStartupPackageManifest } from "@/lib/site-onboarding";

// Join kit for a published study (runtime mode k8s): the hospital runs the exact study image the aggregator
// runs, pinned by digest, with its own data mounted read-only. The real NVFLARE client kit is added under nvflare/.

export type PublishedKitInput = {
  manifest: ReturnType<typeof buildStartupPackageManifest>;
  hostname: string;
  imageDigest: string;
  registry: { server: string; username: string; password: string };
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildPublishedSiteKitFiles(input: PublishedKitInput): ArchiveFileMap {
  const { manifest } = input;
  const env = (token: string) =>
    [
      "# Fedlify site configuration. Keep this file private: it contains the site token and a registry login.",
      `FEDLIFY_HEARTBEAT_ENDPOINT=${manifest.fedlify.heartbeatEndpoint}`,
      `FEDLIFY_SITE_TOKEN=${token}`,
      `FEDLIFY_STUDY_IMAGE=${input.imageDigest}`,
      "# Folder with this site's extract (CSV). Mounted read-only; it never leaves this machine.",
      "FEDLIFY_DATA_DIR=./data",
      `FEDLIFY_REGISTRY=${input.registry.server}`,
      `FEDLIFY_REGISTRY_USERNAME=${shellQuote(input.registry.username)}`,
      `FEDLIFY_REGISTRY_PASSWORD=${shellQuote(input.registry.password)}`,
      `NVFLARE_CLIENT_NAME=${manifest.site.nvflareClientName}`,
      `NVFLARE_SERVER=${input.hostname}:443`,
      ""
    ].join("\n");

  const compose = [
    "# Fedlify hospital site. Only outbound HTTPS (443) is needed; nothing listens on this machine.",
    "name: fedlify-site",
    "services:",
    "  nvflare-client:",
    "    image: ${FEDLIFY_STUDY_IMAGE:?set by fedlify-runner.sh}",
    "    command: [\"client\"]",
    "    restart: unless-stopped",
    "    environment:",
    "      FEDLIFY_KIT_DIR: /kit",
    "      FEDLIFY_DATA_PATH: /data",
    "    volumes:",
    "      - ./nvflare:/kit:ro",
    "      - ${FEDLIFY_DATA_DIR:-./data}:/data:ro",
    "  fedlify-site-agent:",
    "    image: curlimages/curl:8.10.1",
    "    restart: unless-stopped",
    "    environment:",
    "      FEDLIFY_HEARTBEAT_ENDPOINT: ${FEDLIFY_HEARTBEAT_ENDPOINT}",
    "      FEDLIFY_SITE_TOKEN: ${FEDLIFY_SITE_TOKEN}",
    "      FEDLIFY_STUDY_IMAGE: ${FEDLIFY_STUDY_IMAGE}",
    "    command:",
    "      - /bin/sh",
    "      - -c",
    "      - |",
    "        while true; do",
    "          curl -fsS -X POST \"$$FEDLIFY_HEARTBEAT_ENDPOINT\" -H 'content-type: application/json' \\",
    "            -H \"x-site-token: $$FEDLIFY_SITE_TOKEN\" \\",
    "            -d \"{\\\"status\\\":\\\"CONNECTED\\\",\\\"version\\\":\\\"fedlify-site-kit-2\\\",\\\"metadata\\\":{\\\"imageDigest\\\":\\\"$$FEDLIFY_STUDY_IMAGE\\\"}}\" >/dev/null || true",
    "          sleep 30",
    "        done",
    ""
  ].join("\n");

  const runner = `#!/usr/bin/env bash
# Fedlify site runner.  usage: ./fedlify-runner.sh start|update|status|logs|stop
set -euo pipefail
cd "$(dirname "$0")"

die() { echo "fedlify-runner: $*" >&2; exit 1; }
set_env() { # set_env KEY VALUE  (rewrites .env in place)
  local tmp; tmp="$(mktemp)"
  grep -v "^$1=" .env > "$tmp" || true
  printf '%s=%s\\n' "$1" "$2" >> "$tmp"
  mv "$tmp" .env
}

[ -f .env ] || die "run this from the extracted kit folder (.env not found)."
[ -d nvflare/startup ] || die "nvflare/startup is missing; download a new kit from Fedlify."
command -v docker >/dev/null || die "Docker is required: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required."

if [ -n "\${FEDLIFY_SITE_TOKEN:-}" ]; then set_env FEDLIFY_SITE_TOKEN "$FEDLIFY_SITE_TOKEN"; fi
set -a; . ./.env; set +a

login() {
  printf '%s' "$FEDLIFY_REGISTRY_PASSWORD" | docker login "$FEDLIFY_REGISTRY" -u "$FEDLIFY_REGISTRY_USERNAME" --password-stdin >/dev/null
}

check() {
  [ -n "\${FEDLIFY_SITE_TOKEN:-}" ] || die "set the site token: FEDLIFY_SITE_TOKEN=<token shown once in Fedlify> ./fedlify-runner.sh start"
  [ -d "$FEDLIFY_DATA_DIR" ] || die "FEDLIFY_DATA_DIR ($FEDLIFY_DATA_DIR) does not exist; edit .env to point at this site's extract."
  ls "$FEDLIFY_DATA_DIR" | grep -qi '\\.csv$' || echo "warning: no .csv files in $FEDLIFY_DATA_DIR yet." >&2
  getent hosts "\${NVFLARE_SERVER%%:*}" >/dev/null 2>&1 || nslookup "\${NVFLARE_SERVER%%:*}" >/dev/null 2>&1 \\
    || echo "warning: cannot resolve \${NVFLARE_SERVER%%:*} yet (publishing may still be in progress)." >&2
}

case "\${1:-start}" in
  start)
    check
    login
    docker compose pull --quiet
    docker compose up -d
    echo "Started. The site connects to $NVFLARE_SERVER; follow it with: ./fedlify-runner.sh logs"
    ;;
  update)
    # Ask Fedlify which image this site should run (a new study version may have been published).
    desired="$(curl -fsS -X POST "$FEDLIFY_HEARTBEAT_ENDPOINT" -H 'content-type: application/json' \\
      -H "x-site-token: $FEDLIFY_SITE_TOKEN" -d '{"status":"CONNECTED","version":"fedlify-site-kit-2"}' \\
      | sed -n 's/.*"desiredImageDigest":"\\([^"]*\\)".*/\\1/p')"
    if [ -z "$desired" ] || [ "$desired" = "$FEDLIFY_STUDY_IMAGE" ]; then echo "Already on the published version."; exit 0; fi
    set_env FEDLIFY_STUDY_IMAGE "$desired"
    export FEDLIFY_STUDY_IMAGE="$desired"
    login
    docker compose pull --quiet
    docker compose up -d
    echo "Updated to $desired"
    ;;
  status) docker compose ps ;;
  logs) docker compose logs -f --tail 100 nvflare-client ;;
  stop) docker compose down ;;
  *) die "usage: $0 start|update|status|logs|stop" ;;
esac
`;

  const readme = [
    `# Fedlify site kit: ${manifest.site.name}`,
    "",
    `- Study: **${manifest.study.title}**`,
    `- Aggregator: \`${input.hostname}:443\` (outbound HTTPS only; no inbound ports)`,
    `- NVFLARE client: \`${manifest.site.nvflareClientName}\``,
    `- Study image: \`${input.imageDigest}\``,
    "",
    "## Start",
    "1. Put this site's extract (CSV) in `./data`, or set `FEDLIFY_DATA_DIR` in `.env` to its folder.",
    "   It is mounted read-only and never leaves this machine; only model weights and aggregate metrics are sent.",
    "2. Run, with the token Fedlify showed once when this kit was created:",
    "   ```sh",
    "   chmod +x fedlify-runner.sh",
    "   FEDLIFY_SITE_TOKEN=<token> ./fedlify-runner.sh start",
    "   ```",
    "3. The site appears as connected on the study dashboard within a minute.",
    "",
    "## When a new version is published",
    "`./fedlify-runner.sh update` pulls the newly published image (your kit and token stay valid).",
    "",
    "## Other commands",
    "`status`, `logs`, `stop`.",
    ""
  ].join("\n");

  return {
    "README.md": readme,
    "docker-compose.yml": compose,
    "fedlify-runner.sh": runner,
    ".env": env(""),
    ".env.example": env("<paste-token-shown-once-in-fedlify>"),
    "manifest.json": JSON.stringify({ ...manifest, runtime: { mode: "k8s", hostname: input.hostname, imageDigest: input.imageDigest } }, null, 2),
    "data/README.md": "Place this site's CSV extract here (or point FEDLIFY_DATA_DIR elsewhere). Never commit or upload it.\n"
  };
}
