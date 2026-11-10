// Content of the public "Get ready" page, kept as data so tests can check what it promises. Everything marked unverified has
// not been run on a real machine of that kind.

export type OsGuide = { id: "windows" | "macos" | "linux"; title: string; verified: string; steps: string[]; commands: string[] };

export const DOCKER_LINKS = {
  windows: "https://docs.docker.com/desktop/setup/install/windows-install/",
  macos: "https://docs.docker.com/desktop/setup/install/mac-install/",
  linux: "https://docs.docker.com/engine/install/",
  wsl: "https://learn.microsoft.com/windows/wsl/install",
  wslDocker: "https://docs.docker.com/desktop/features/wsl/",
  nvidia: "https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
} as const;

export const OS_GUIDES: OsGuide[] = [
  {
    id: "windows",
    title: "Windows 10 (2004 or later) and Windows 11",
    verified: "Not verified on a real Windows machine. Nothing on this tab has been run.",
    steps: [
      "Windows support means WSL 2 plus Docker Desktop. The Fedlify runner is a bash program and there is no native PowerShell version: on Windows it runs inside WSL 2, and the PowerShell files in your site kit are launchers that call it.",
      "Install WSL 2 with an Ubuntu distribution (administrator PowerShell), then restart Windows.",
      "Install Docker Desktop for Windows and keep the WSL 2 backend selected.",
      "In Docker Desktop open Settings, Resources, WSL integration, and switch on your Ubuntu distribution. Without this, Docker is not visible inside WSL and the runner cannot start.",
      "Start Docker Desktop and wait until it says it is running.",
      "Run the check below (preflight.ps1). It tests WSL 2, Docker Desktop, Docker inside WSL, Compose v2, disk, memory and the network."
    ],
    commands: ["wsl --install -d Ubuntu", "powershell -ExecutionPolicy Bypass -File .\\preflight.ps1 -Aggregator <study-server-host>"]
  },
  {
    id: "macos",
    title: "macOS (Apple silicon and Intel)",
    verified: "Not verified end to end. The bash preflight was exercised against stand-in tools on a Mac, not on a clean machine with Docker Desktop.",
    steps: [
      "Install Docker Desktop for Mac (the Apple silicon build on M-series Macs).",
      "Start Docker Desktop and wait until it says it is running. Raise its memory limit to 4 GB or more under Settings, Resources if the check warns.",
      "Open Terminal, go to the folder with preflight.sh and run it.",
      "Apple silicon: the study software is published for amd64 only today, so Docker runs it under emulation. It is slower and has not been verified on Apple silicon."
    ],
    commands: ["chmod +x preflight.sh", "./preflight.sh --aggregator <study-server-host>"]
  },
  {
    id: "linux",
    title: "Linux (Ubuntu, Debian, Fedora and similar)",
    verified: "Not verified on a clean Linux install. The bash preflight was exercised against stand-in tools only.",
    steps: [
      "Install Docker Engine and the Compose plugin from Docker's own instructions for your distribution. Do not pipe a download into a shell.",
      "Let your account use Docker (add it to the docker group, then log out and back in) or run the commands with sudo.",
      "Make sure the service runs: systemctl is-active docker.",
      "Run the check. It needs no Docker to run, but it reports whether Docker and Compose v2 are present."
    ],
    commands: ["chmod +x preflight.sh", "./preflight.sh --aggregator <study-server-host>"]
  }
];

export const ARCHITECTURE_STATEMENT =
  "The published study software is amd64 only. Intel and AMD computers run it natively. Apple silicon and other ARM machines run it under emulation, which is slower and has not been verified. A build for other computer types is prepared in the repository but has not been built, published or tested, so do not rely on arm64 yet.";

export const GPU_STATEMENT =
  "CPU is the default and is all the starter study needs. A GPU is used only if you ask for it (FEDLIFY_GPU=auto in the site kit's .env) and the runner detects both an NVIDIA GPU and the NVIDIA container toolkit; it also needs a GPU-enabled version of the study software. This has not been run on a GPU host.";

export const HEADLESS_UNIT = [
  "# /etc/systemd/system/fedlify-agent.service   (generate the exact text for your folder with: ./fedlify-runner.sh agent-unit)",
  "[Unit]",
  "Description=Fedlify site runner (status reporting)",
  "After=docker.service network-online.target",
  "Wants=network-online.target",
  "",
  "[Service]",
  "User=fedlify",
  "WorkingDirectory=/opt/fedlify-site-kit",
  "Environment=\"FEDLIFY_SITE_TOKEN_FILE=/opt/fedlify-site-kit/.fedlify/site-token\"",
  "ExecStart=\"/opt/fedlify-site-kit/fedlify-runner.sh\" agent",
  "Restart=always",
  "RestartSec=15",
  "",
  "[Install]",
  "WantedBy=multi-user.target"
].join("\n");
