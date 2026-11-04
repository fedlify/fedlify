import type { ArchiveFileMap } from "@/lib/archive";
import type { buildStartupPackageManifest } from "@/lib/site-onboarding";
import { PUBLISHED_RUNNER_SCRIPT } from "@/lib/site-runner-script";

// Join kit for a published study (runtime mode k8s): the hospital runs the exact study image the aggregator
// runs, pinned by digest, with its own data mounted read-only. The real NVFLARE client kit is added under nvflare/.

export type PublishedKitInput = {
  manifest: ReturnType<typeof buildStartupPackageManifest>;
  hostname: string;
  imageDigest: string;
  registry: { server: string; username: string; password: string };
};

/**
 * The base manifest is shared with the legacy kit, which ships a PowerShell runner. The published kit does not,
 * so its manifest lists only files that are really in the zip (plus the NVFLARE client kit under nvflare/).
 */
export function publishedKitManifest(manifest: PublishedKitInput["manifest"]) {
  const { runnerPowerShell: _omitted, ...shipped } = manifest.files;
  void _omitted;
  return {
    ...manifest,
    files: { ...shipped, nvflareClientConfig: "nvflare/startup/fed_client.json" },
    installCommands: ["chmod +x fedlify-runner.sh", "FEDLIFY_SITE_TOKEN=<token-shown-once-in-fedlify> ./fedlify-runner.sh start"]
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildPublishedSiteKitFiles(input: PublishedKitInput): ArchiveFileMap {
  const manifest = publishedKitManifest(input.manifest);
  const env = () =>
    [
      "# Fedlify site configuration. Keep this file private: it contains a registry login.",
      "# The site token is not stored here: pass FEDLIFY_SITE_TOKEN once to `start` (kept in .fedlify/site-token, mode 0600).",
      `FEDLIFY_HEARTBEAT_ENDPOINT=${manifest.fedlify.heartbeatEndpoint}`,
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

  // The heartbeat comes from the host runner (`fedlify-runner.sh agent`), which reads `docker inspect` health.
  // A container sidecar cannot see container health and used to report CONNECTED unconditionally.
  const compose = [
    "# Fedlify hospital site. Only outbound HTTPS (443) is needed; nothing listens on this machine.",
    "name: fedlify-site",
    "x-logging: &default-logging",
    "  driver: json-file",
    "  options:",
    "    max-size: \"10m\"",
    "    max-file: \"3\"",
    "services:",
    "  nvflare-client:",
    "    image: ${FEDLIFY_STUDY_IMAGE:?set by fedlify-runner.sh}",
    "    command: [\"client\"]",
    "    restart: unless-stopped",
    "    logging: *default-logging",
    "    healthcheck:",
    "      test: [\"CMD-SHELL\", \"grep -ql '[c]lient_train' /proc/[0-9]*/cmdline 2>/dev/null\"]",
    "      interval: 30s",
    "      timeout: 10s",
    "      retries: 3",
    "      start_period: 60s",
    "    environment:",
    "      FEDLIFY_KIT_DIR: /kit",
    "      FEDLIFY_DATA_PATH: /data",
    "    volumes:",
    "      - ./nvflare:/kit:ro",
    "      - ${FEDLIFY_DATA_DIR:-./data}:/data:ro",
    ""
  ].join("\n");

  const runner = PUBLISHED_RUNNER_SCRIPT;

  const readme = [
    `# Fedlify site kit: ${manifest.site.name}`,
    "",
    `- Study: **${manifest.study.title}**`,
    `- Aggregator: \`${input.hostname}:443\` (outbound HTTPS only; no inbound ports)`,
    `- NVFLARE client: \`${manifest.site.nvflareClientName}\``,
    `- Study image: \`${input.imageDigest}\``,
    "",
    "## Check this machine first",
    "`./fedlify-runner.sh preflight` checks Docker, Compose v2, disk, memory, DNS, outbound 443 to the aggregator and registry, the data folder and GPU. Add `--json` for scripts. It needs no token and sends nothing.",
    "",
    "## Start",
    "1. Put this site's extract (CSV) in `./data`, or set `FEDLIFY_DATA_DIR` in `.env` to its folder.",
    "   It is mounted read-only and never leaves this machine; only model weights and aggregate metrics are sent.",
    "2. Run, with the token Fedlify showed once when this kit was created:",
    "   ```sh",
    "   chmod +x fedlify-runner.sh",
    "   FEDLIFY_SITE_TOKEN=<token> ./fedlify-runner.sh start",
    "   ```",
    "   The token is saved to `.fedlify/site-token` (mode 0600), not to `.env`, so later commands need no token.",
    "3. `start` also launches a background heartbeat agent. The site shows as connected on the study dashboard within a minute,",
    "   and as offline after three missed beats (about 90 seconds), for example if the client container stops.",
    "   The agent does not survive a host reboot (the client container does). Run `./fedlify-runner.sh agent-unit` to print a systemd unit,",
    "   or re-run `start` after a reboot; otherwise the site shows offline until you do.",
    "   CONNECTED means the NVFLARE client process is running and the data folder holds CSVs. It does not prove the client has reached the aggregator.",
    "",
    "## When a new version is published",
    "`./fedlify-runner.sh update` pulls the newly published image (your kit and token stay valid).",
    "",
    "## Other commands",
    "- `status [--json]`: container health, data folder, last heartbeat.",
    "- `logs`, `stop`.",
    "- `logout`: stop the agent, delete the saved site token, clear the registry login.",
    "- `support-bundle [--include-logs]`: write a small archive built from an allowlist (versions, preflight and status, container state).",
    "  It never includes data, keys, tokens or passwords and is never uploaded: review it, then send it yourself.",
    ""
  ].join("\n");

  return {
    "README.md": readme,
    "docker-compose.yml": compose,
    "fedlify-runner.sh": runner,
    ".env": env(),
    ".env.example": env(),
    "manifest.json": JSON.stringify({ ...manifest, runtime: { mode: "k8s", hostname: input.hostname, imageDigest: input.imageDigest } }, null, 2),
    "data/README.md": "Place this site's CSV extract here (or point FEDLIFY_DATA_DIR elsewhere). Never commit or upload it.\n"
  };
}
