import Link from "next/link";
import { ARCHITECTURE_STATEMENT, DOCKER_LINKS, GPU_STATEMENT, HEADLESS_UNIT, OS_GUIDES } from "@/lib/get-ready";
import { PREFLIGHT_PS1_SHA256, PREFLIGHT_SH_SHA256 } from "@/lib/site-preflight-script";

// Public page (no sign-in): a hospital IT person reads this before any kit exists. Plain server component, no client code.
export const metadata = { title: "Get ready for a Fedlify site", description: "Docker setup and a no-Docker readiness check for hospital sites." };

const wrap = { maxWidth: 820, margin: "0 auto", padding: "32px 20px", lineHeight: 1.55, color: "#2F3040" } as const;
const pre = { background: "#F1EEF9", padding: 12, borderRadius: 8, overflowX: "auto", fontSize: 13 } as const;
const note = { background: "#FFF8E6", border: "1px solid #F0D58C", borderRadius: 8, padding: "8px 12px" } as const;

export default function GetReadyPage() {
  return (
    <main style={wrap}>
      <h1>Get ready for a Fedlify site</h1>
      <p>
        Before you receive a kit, check that this machine can run it. The check below needs no Docker, no account and no kit. It reads local facts,
        probes DNS and port 443 to the hosts you give it, and sends and saves nothing. Patient data is never read by it.
      </p>

      <h2 id="check">1. Run the check</h2>
      <p>
        <a href="/get-ready/preflight.sh" download>preflight.sh</a> (macOS, Linux, WSL) and <a href="/get-ready/preflight.ps1" download>preflight.ps1</a> (Windows).
        Read them before you run them; they are short. Compare the SHA-256 of what you downloaded with these values:
      </p>
      <pre style={pre}>{`preflight.sh   ${PREFLIGHT_SH_SHA256}\npreflight.ps1  ${PREFLIGHT_PS1_SHA256}`}</pre>
      <p>
        Pass <code>--aggregator</code> with the study server host from your site page in Fedlify, and <code>--registry</code> with the registry host from your kit. The kit&apos;s own
        <code> ./fedlify-runner.sh preflight</code> repeats the checks with those values filled in.
      </p>

      <h2 id="docker">2. Install Docker for your system</h2>
      {OS_GUIDES.map((os) => (
        <section key={os.id} id={os.id}>
          <h3>{os.title}</h3>
          <p style={note}>{os.verified}</p>
          <ol>{os.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          <pre style={pre}>{os.commands.join("\n")}</pre>
          <p>
            Official instructions: <a href={os.id === "linux" ? DOCKER_LINKS.linux : os.id === "macos" ? DOCKER_LINKS.macos : DOCKER_LINKS.windows}>Docker</a>
            {os.id === "windows" ? (<> and <a href={DOCKER_LINKS.wsl}>WSL</a>, <a href={DOCKER_LINKS.wslDocker}>Docker with WSL</a></>) : null}.
          </p>
        </section>
      ))}
      <p>Fedlify cannot install Docker for you, and a web page inside Docker cannot either, so this page only guides and checks.</p>

      <h2 id="architecture">Machine type</h2>
      <p>{ARCHITECTURE_STATEMENT}</p>

      <h2 id="gpu">GPU</h2>
      <p>{GPU_STATEMENT}</p>
      <p>Linux GPU hosts need the <a href={DOCKER_LINKS.nvidia}>NVIDIA container toolkit</a>.</p>

      <h2 id="helper">3. Terminal or browser helper</h2>
      <p>
        You can run everything from a terminal. If you prefer a browser, the kit download can include an optional helper that runs only on this computer
        (address 127.0.0.1), holds no secret in the browser, never sends patient data anywhere and offers five screens: Unlock, Checks, Your data, Run status, Help bundle.
        On Windows it also runs inside WSL 2. The helper is available only when your Fedlify administrator has published its image.
      </p>

      <h2 id="headless">Servers without a screen</h2>
      <p>
        Every action is a command: <code>preflight</code>, <code>status --json</code>, <code>start</code>, <code>stop</code>, <code>update</code>, <code>logs</code>, <code>logout</code>, <code>support-bundle</code>.
        To keep the heartbeat running across reboots, install a systemd unit (the runner prints one for your folder). Keep the site token in a file readable only by the service account, never on a command line.
        For unattended unlock the download can include <code>unlock-headless.sh --passphrase-file FILE</code>; the passphrase is read from the file by a container on standard input, so it is never an argument or an environment variable.
      </p>
      <pre style={pre}>{HEADLESS_UNIT}</pre>
      <p>This unit has not been installed on a real server by the people who wrote it.</p>

      <p><Link href="/signin">Sign in to Fedlify</Link></p>
    </main>
  );
}
