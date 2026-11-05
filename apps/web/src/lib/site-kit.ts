import type { ArchiveFileMap } from "@/lib/archive";
import type { buildStartupPackageManifest } from "@/lib/site-onboarding";
import { PUBLISHED_RUNNER_SCRIPT } from "@/lib/site-runner-script";
import { UNLOCK_PS1, UNLOCK_SH } from "@/lib/site-unlock-script";

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

export function buildPublishedSiteKitFiles(input: PublishedKitInput): ArchiveFileMap {
  const manifest = publishedKitManifest(input.manifest);
  const env = () =>
    [
      "# Fedlify site configuration. This file holds no secret.",
      "# The site token is not stored here: pass FEDLIFY_SITE_TOKEN once to `start` (kept in .fedlify/site-token, mode 0600).",
      "# The registry login is in .fedlify/registry-credential (mode 0600), read only by fedlify-runner.sh.",
      `FEDLIFY_HEARTBEAT_ENDPOINT=${manifest.fedlify.heartbeatEndpoint}`,
      `FEDLIFY_STUDY_IMAGE=${input.imageDigest}`,
      "# Folder with this site's extract (CSV). Mounted read-only; it never leaves this machine.",
      "FEDLIFY_DATA_DIR=./data",
      `FEDLIFY_REGISTRY=${input.registry.server}`,
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
    "## Secrets in this folder",
    "This folder came out of an encrypted kit and is private to the account that unlocked it (directories 0700, files 0600).",
    "`.env` holds no secret. The registry login is `.fedlify/registry-credential` and the site token (after `start`) is `.fedlify/site-token`.",
    "The NVFLARE client private key is in `nvflare/startup`: anyone who can read this folder can act as this site. Delete the folder when the site leaves the study.",
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
    // Two lines: username, then password. Not shell-sourced; the unlock script makes the folder and file private (0700/0600).
    ".fedlify/registry-credential": `${input.registry.username}\n${input.registry.password}\n`,
    "manifest.json": JSON.stringify({ ...manifest, runtime: { mode: "k8s", hostname: input.hostname, imageDigest: input.imageDigest } }, null, 2),
    "data/README.md": "Place this site's CSV extract here (or point FEDLIFY_DATA_DIR elsewhere). Never commit or upload it.\n"
  };
}

/**
 * The download is a plaintext outer zip: the encrypted kit plus the scripts that decrypt it. The runner is inside the
 * encrypted part and age is not installed on site machines, so the unlock scripts have to travel outside it.
 * Nothing here is secret: the README must not carry the passphrase, the site token or a credential.
 */
export function buildOuterKitFiles(input: { siteName: string; studyTitle: string; encryptedKit: Buffer }): ArchiveFileMap {
  const readme = [
    `Fedlify site kit: ${input.siteName}`,
    `Study: ${input.studyTitle}`,
    "",
    "This kit is encrypted. kit.zip.age holds the runner, the NVFLARE client identity and the registry login.",
    "It opens only with the passphrase Fedlify showed to the person who created the kit. That person must send you the passphrase",
    "by a different channel than this file (phone, a messaging app, in person). Never email both together.",
    "",
    "Unlock (needs `age` or Docker, and `unzip` on macOS and Linux):",
    "  macOS / Linux:   chmod +x unlock.sh && ./unlock.sh",
    "  Windows:         powershell -ExecutionPolicy Bypass -File .\\unlock.ps1",
    "The passphrase is typed at a prompt in your terminal. It is never a command-line argument or an environment variable.",
    "Without age, Docker runs a public image pinned by digest and installs age inside the container, so that needs internet access.",
    "The result is a private folder (fedlify-site-kit) that only your account can read. Then follow the README inside it.",
    "",
    "A wrong passphrase, or a file that was changed or damaged, fails and leaves nothing behind. Ask for a new kit in that case.",
    "The scripts in this zip are not encrypted. Read them before running them, and only use a copy you received from the person you trust.",
    "The Windows runner is a bash script: run it in WSL or Git Bash.",
    ""
  ].join("\n");
  return { "kit.zip.age": input.encryptedKit, "unlock.sh": UNLOCK_SH, "unlock.ps1": UNLOCK_PS1, "README.txt": readme };
}
