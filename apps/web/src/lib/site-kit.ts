import { createHash } from "node:crypto";
import type { ArchiveFileMap } from "@/lib/archive";
import type { buildStartupPackageManifest } from "@/lib/site-onboarding";
import { FEDLIFY_RUNNER_PS1, GPU_COMPOSE_YML, HELPER_BRIDGE_SH, START_HELPER_PS1, helperComposeYml, isPinnedImage, startHelperSh, unlockHeadlessSh } from "@/lib/site-helper-scripts";
import { PUBLISHED_RUNNER_SCRIPT } from "@/lib/site-runner-script";
import { UNLOCK_PS1, UNLOCK_SH } from "@/lib/site-unlock-script";

// Join kit for a published study (runtime mode k8s): the hospital runs the exact study image the aggregator
// runs, pinned by digest, with its own data mounted read-only. The real NVFLARE client kit is added under nvflare/.

export type PublishedKitInput = {
  manifest: ReturnType<typeof buildStartupPackageManifest>;
  hostname: string;
  imageDigest: string;
  registry: { server: string; username: string; password: string };
  /** CPU architectures the published study image really lists (verified with `docker buildx imagetools inspect`). Default amd64 only. */
  imageArches?: string[];
};

/**
 * The base manifest is shared with the legacy kit, whose PowerShell runner is a different file. The published kit ships its
 * own Windows wrapper (it runs the bash runner inside WSL 2), so its manifest lists exactly the files that are in the zip
 * (plus the NVFLARE client kit under nvflare/).
 */
export function publishedKitManifest(manifest: PublishedKitInput["manifest"]) {
  const { runnerPowerShell: _omitted, ...shipped } = manifest.files;
  void _omitted;
  return {
    ...manifest,
    files: { ...shipped, runnerWindowsWsl: "fedlify-runner.ps1", gpuCompose: "docker-compose.gpu.yml", nvflareClientConfig: "nvflare/startup/fed_client.json" },
    installCommands: [
      "chmod +x fedlify-runner.sh",
      "./fedlify-runner.sh preflight",
      "FEDLIFY_SITE_TOKEN=<token-shown-once-in-fedlify> ./fedlify-runner.sh start"
    ]
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
      "# CPU is the default. auto = use the GPU only if an NVIDIA GPU and the container toolkit are detected; on = same, but start fails if not.",
      "# Needs a CUDA flavour of the study image. See README.md.",
      "FEDLIFY_GPU=off",
      "# CPU architectures the study image is published for. The runner warns on other machines (they run it under emulation).",
      `FEDLIFY_IMAGE_ARCHES=${(input.imageArches?.length ? input.imageArches : ["amd64"]).filter((a) => /^[a-z0-9]+$/.test(a)).join(",") || "amd64"}`,
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
    "## Windows",
    "There is no native Windows runner. On Windows the bash runner runs inside WSL 2 with Docker Desktop (WSL integration on).",
    "`fedlify-runner.ps1` is a thin wrapper: `.\\fedlify-runner.ps1 preflight`, `save-token` (asks for the token, stores it in `.fedlify/site-token`), `start`, `status`, `stop`, `logout`.",
    "`start` keeps the heartbeat running in that window, because background jobs can end when WSL idles. Closing the window stops heartbeats (the client container keeps running).",
    "On a Windows drive, WSL does not enforce the 0600/0700 modes; the Windows folder permissions set by `unlock.ps1` are what protect this folder.",
    "The wrapper has not been run on a real Windows machine.",
    "",
    "## GPU (optional)",
    "CPU is the default and needs nothing. To request a GPU set `FEDLIFY_GPU=auto` in `.env`. `docker-compose.gpu.yml` is then added only if an NVIDIA GPU (`nvidia-smi`)",
    "and the NVIDIA container toolkit are both detected; `FEDLIFY_GPU=on` makes `start` fail instead of falling back. This needs a CUDA flavour of the study image, which the study owner selects.",
    "`preflight` reports whether the GPU reservation is active.",
    "",
    "## Start",
    "1. Put this site's extract (CSV) in `./data`, or set `FEDLIFY_DATA_DIR` in `.env` to its folder.",
    "   It is mounted read-only and never leaves this machine; only model weights and aggregate metrics are sent.",
    "2. Run, with the token Fedlify showed once when this kit was created:",
    "   ```sh",
    "   chmod +x fedlify-runner.sh",
    "   FEDLIFY_SITE_TOKEN=<token> ./fedlify-runner.sh start",
    "   (For servers prefer a file: write the token to `.fedlify/site-token` with mode 0600, or point `FEDLIFY_SITE_TOKEN_FILE` at it, so it is never in a shell history or the environment.)",
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
    "- `status [--json]`: container health, data folder, GPU state, last heartbeat.",
    "- `agent-unit`: prints a systemd unit for the heartbeat agent on a server (review it, install it yourself). The client container restarts by itself (`restart: unless-stopped`).",
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
    "docker-compose.gpu.yml": GPU_COMPOSE_YML,
    "fedlify-runner.ps1": FEDLIFY_RUNNER_PS1,
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
export function buildOuterKitFiles(input: {
  siteName: string;
  studyTitle: string;
  encryptedKit: Buffer;
  /** Public helper image, pinned by digest. Without it the optional UI and headless-unlock files are not shipped. */
  helperImage?: string;
  /**
   * The plaintext kit files. The helper container unlocks the kit into a folder the host then runs code from, so the host
   * bridge refuses any runner, compose file or .env whose sha256 differs from the pins computed here (none of these files
   * hold a secret). Without the runner in this map the helper is not shipped.
   */
  kitFiles?: ArchiveFileMap;
}): ArchiveFileMap {
  const pins = input.kitFiles ? kitPins(input.kitFiles) : null;
  const helper = pins && isPinnedImage(input.helperImage) ? input.helperImage : null;
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
    "Windows: the runner is a bash script. It runs inside WSL 2 with Docker Desktop (WSL integration on); the kit contains fedlify-runner.ps1, a wrapper that calls it.",
    "Before anything else, run the checks from the Fedlify Get ready page (preflight.sh or preflight.ps1); they need no Docker and no kit.",
    ...(helper
      ? [
          "",
          "Optional local helper (a browser page on this computer only, for people who prefer not to use a terminal):",
          "  macOS / Linux:   ./start-helper.sh      Windows:  powershell -ExecutionPolicy Bypass -File .\\start-helper.ps1",
          "It listens on 127.0.0.1 only, holds no secret in the browser, and contains no code that sends data anywhere (the container network is not firewalled, so that rests on the code, which you can read). Put your CSV extract in the data folder it creates.",
          "Servers without a person at the keyboard: ./unlock-headless.sh --passphrase-file FILE (file mode 0400 or 0600; the passphrase goes to a container on stdin, never an argument or variable)."
        ]
      : []),
    ""
  ].join("\n");
  const files: ArchiveFileMap = { "kit.zip.age": input.encryptedKit, "unlock.sh": UNLOCK_SH, "unlock.ps1": UNLOCK_PS1, "README.txt": readme };
  if (helper) {
    files["docker-compose.helper.yml"] = helperComposeYml();
    files["start-helper.sh"] = startHelperSh(helper);
    files["start-helper.ps1"] = START_HELPER_PS1;
    files["fedlify-helper-bridge.sh"] = HELPER_BRIDGE_SH;
    files["unlock-headless.sh"] = unlockHeadlessSh(helper);
    files[KIT_PINS_FILE] = pins!;
  }
  return files;
}

export const KIT_PINS_FILE = "fedlify-kit-pins.txt";
/** Kit files the host executes or sources. None is secret, so their hashes may sit in the plaintext zip. */
export const PINNED_KIT_PATHS = ["fedlify-runner.sh", "docker-compose.yml", "docker-compose.gpu.yml", ".env", "fedlify-runner.ps1"];
function kitPins(kitFiles: ArchiveFileMap): string | null {
  if (!("fedlify-runner.sh" in kitFiles)) return null;
  return PINNED_KIT_PATHS.filter((p) => p in kitFiles).map((p) => `${createHash("sha256").update(kitFiles[p]).digest("hex")}  ${p}`).join("\n") + "\n";
}

/** Paths that must be executable after unzip. Pass to zipFiles as its `modes` argument. */
export const OUTER_KIT_MODES: Record<string, number> = {
  "unlock.sh": 0o755,
  "start-helper.sh": 0o755,
  "fedlify-helper-bridge.sh": 0o755,
  "unlock-headless.sh": 0o755
};
export function outerKitModes(files: ArchiveFileMap): Record<string, number> {
  return Object.fromEntries(Object.entries(OUTER_KIT_MODES).filter(([p]) => p in files));
}
