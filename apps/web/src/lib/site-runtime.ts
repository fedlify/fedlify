import { checkSiteImages, isImageMismatch, siteImageFixSteps, type SiteImageState } from "@/lib/site-image";
import { formatHeartbeat, kitState, type KitState } from "@/lib/site-overview";
import { isHeartbeatStale, isSitePresent } from "@/lib/site-presence";

export type SiteStageKey = "kit" | "runner" | "image" | "connection";
export type SiteStage = { key: SiteStageKey; title: string; status: string; tone: "idle" | "ok" | "warn" | "error"; tab: string };

export type SiteRuntime = {
  live: { hostname: string | null; version: string | null; gitCommit: string | null; versionId: string | null } | null;
  clientName: string;
  kitState: KitState;
  imageState: SiteImageState;
  imageFix: string[];
  /** null: the study server could not be asked, or nothing is published. */
  connected: boolean | null;
  lastHeartbeatAt: string | null;
  lastHeartbeatLabel: string;
  runnerSilent: boolean;
  evidence: { runner: string | null; container: string | null; health: string | null; restarts: number | null; dataFiles: number | null; diskFreeGb: number | null; gpus: number | null; reportedImage: string | null };
  stages: SiteStage[];
  nextStep: string | null;
};

type RuntimeInput = {
  code: string;
  clientName: string;
  deployment: { status: string; hostname: string | null; imageDigest: string | null } | null;
  liveVersion: { id: string; version: string; gitCommit: string | null } | null;
  activeKit: { imageDigest: string | null; expiresAt: Date | string | null } | null;
  heartbeat: { createdAt: Date | string; metadata: unknown } | null;
  listedByAggregator: boolean | null;
  now?: number;
};

const day = (value: Date | string | null) =>
  value ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(value)) : "";
const str = (value: unknown) => (typeof value === "string" && value ? value : null);
const num = (value: unknown) => (typeof value === "number" ? value : null);

/** One view of a site, using the same checks as the Sites table in Code & run. */
export function summarizeSiteRuntime(input: RuntimeInput): SiteRuntime {
  const now = input.now ?? Date.now();
  const active = input.deployment?.status === "ACTIVE" ? input.deployment : null;
  const metadata = (input.heartbeat?.metadata ?? {}) as Record<string, unknown>;
  const lastBeat = input.heartbeat ? new Date(input.heartbeat.createdAt).toISOString() : null;
  const silent = lastBeat ? isHeartbeatStale(lastBeat, now) : false;
  const ago = formatHeartbeat(lastBeat, now).toLowerCase();
  const kit = kitState(input.activeKit, active?.imageDigest);
  const [check] = checkSiteImages([{ code: input.code, clientName: input.clientName, heartbeatMetadata: input.heartbeat?.metadata ?? null, kitImageRef: input.activeKit?.imageDigest ?? null }], active?.imageDigest);
  const imageFix = isImageMismatch(check.state) ? siteImageFixSteps(check) : [];
  const connected = active && input.listedByAggregator !== null ? isSitePresent(input.listedByAggregator, lastBeat, now) : null;
  const dataFiles = num(metadata.csvCount);
  const noData = Boolean(lastBeat) && !silent && dataFiles === 0;
  const versionLabel = input.liveVersion?.version ?? "";

  let nextStep: string | null = null;
  if (active) {
    if (kit === "NOT_RELEASED") nextStep = "Create a site kit for this site.";
    else if (kit === "OUTDATED") nextStep = "The code version changed, so this site needs a new site kit.";
    else if (!lastBeat) nextStep = "Unlock the site kit on the site's computer, then start the runner with ./fedlify-runner.sh start.";
    else if (silent) nextStep = `The runner last reported ${ago}. It has stopped or the computer is offline. In the site kit folder, run ./fedlify-runner.sh start.`;
    else if (noData) nextStep = "The runner found no data files. Put the site's CSV file in the site kit's data folder.";
    else if (isImageMismatch(check.state)) nextStep = check.state === "OUTDATED" ? `This site is not on ${versionLabel || "the published pipeline version"}. In the site kit folder, run ./fedlify-runner.sh update.` : "This site has not reported its code version yet.";
    else if (connected === false) nextStep = "The runner is reporting, but the study server does not list this site. Check that the computer can reach the study server on port 443.";
  }

  const stages: SiteStage[] = [
    {
      key: "kit",
      title: "Site kit",
      tab: "runner",
      status: kit === "NOT_RELEASED" ? "Not created yet" : kit === "OUTDATED" ? "New site kit needed" : `Ready · expires ${day(input.activeKit?.expiresAt ?? null)}`,
      tone: kit === "RELEASED" ? "ok" : active ? "warn" : "idle"
    },
    {
      key: "runner",
      title: "Runner",
      tab: "readiness",
      status: !lastBeat ? "Not connected" : silent ? `Not reporting · last report ${ago}` : noData ? "Connected · no data files" : `Connected · ${ago}`,
      tone: !lastBeat ? "idle" : silent ? "error" : noData ? "warn" : "ok"
    },
    {
      key: "image",
      title: "Code version",
      tab: "runner",
      status: check.state === "CURRENT" ? `Up to date${versionLabel ? ` · ${versionLabel}` : ""}` : check.state === "OUTDATED" ? "Needs update" : check.state === "NOT_REPORTED" ? "Not reported" : "Nothing published",
      tone: check.state === "CURRENT" ? "ok" : isImageMismatch(check.state) ? "warn" : "idle"
    },
    {
      key: "connection",
      title: "Connection",
      tab: "runner",
      status: !active ? "Nothing published" : connected === null ? "Unknown" : connected ? "Connected" : "Not connected",
      tone: !active ? "idle" : connected ? "ok" : "warn"
    }
  ];

  return {
    live: active ? { hostname: active.hostname, version: input.liveVersion?.version ?? null, gitCommit: input.liveVersion?.gitCommit ?? null, versionId: input.liveVersion?.id ?? null } : null,
    clientName: input.clientName,
    kitState: kit,
    imageState: check.state,
    imageFix,
    connected,
    lastHeartbeatAt: lastBeat,
    lastHeartbeatLabel: formatHeartbeat(lastBeat, now),
    runnerSilent: silent,
    evidence: { runner: str(metadata.runner), container: str(metadata.container), health: str(metadata.health), restarts: num(metadata.restarts), dataFiles, diskFreeGb: num(metadata.diskFreeGb), gpus: num(metadata.gpuCount), reportedImage: str(metadata.imageDigest) },
    stages,
    nextStep
  };
}

/** Plain-words state of the study software on a site, from the runner's raw container/health values. */
export function studySoftwareLabel(container: string | null | undefined, health: string | null | undefined): "Running" | "Running, with a problem" | "Stopped" | "Not reported" {
  const c = (container ?? "").trim().toLowerCase();
  const h = (health ?? "").trim().toLowerCase();
  if (!c) return "Not reported";
  if (c === "running" || c === "up" || c.startsWith("up ")) return h === "unhealthy" ? "Running, with a problem" : "Running";
  return "Stopped";
}
