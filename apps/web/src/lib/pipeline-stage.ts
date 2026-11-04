/**
 * Derives the four-stage pipeline rail (Code, Publish, Sites, Run) from the project overview.
 * Each stage has live status text and at most one human action; only the "current" stage's action is primary.
 */

export type StageKey = "code" | "publish" | "sites" | "run";
export type StageTone = "idle" | "active" | "ok" | "warn" | "error";
export type StageActionKey = "new_project" | "save" | "publish" | "release_kit" | "setup_run" | "start_run" | "save_model";

export type StageAction = { key: StageActionKey; label: string; disabledReason?: string; loading?: boolean };
export type StageSummary = { key: StageKey; title: string; status: string; detail?: string; tone: StageTone; action?: StageAction };

export type StageInput = {
  hasProject: boolean;
  unsavedFiles: number;
  sourceCommit: string | null;
  versions: Array<{ id: string; version: string; gitCommit: string | null; publish: { status: string; step?: string | null } | null }>;
  aggregator: { status: string; pipelineVersionId: string | null; imageDigest: string | null; lastError?: string | null; error?: string | null } | null;
  sites: Array<{ kitReleased: boolean; kitImageDigest: string | null; connected: boolean | null }>;
  jobs: Array<{ id: string; status: string; result: { id: string } | null }>;
  busy: { saving: boolean; publishing: boolean; starting: boolean };
  activeStage: StageKey;
};

const ACTIVE_JOB = new Set(["SUBMITTED", "SCHEDULED", "RUNNING"]);
const IN_FLIGHT = new Set(["QUEUED", "RUNNING"]);

function short(value: string | null, length = 8) {
  return value ? value.slice(0, length) : "none";
}

export function computeStages(input: StageInput): { current: StageKey; stages: StageSummary[] } {
  const { sourceCommit, aggregator, sites, jobs, versions, busy } = input;
  const live = versions.find((version) => version.id === aggregator?.pipelineVersionId) ?? null;
  const inFlight = versions.find((version) => version.publish && IN_FLIGHT.has(version.publish.status)) ?? null;
  const newest = versions[0] ?? null;
  const activeJob = jobs.find((job) => ACTIVE_JOB.has(job.status)) ?? null;
  const lastJob = jobs[0] ?? null;
  const connected = sites.filter((site) => site.connected).length;
  const dirty = input.unsavedFiles > 0;

  // Code
  const code: StageSummary = !input.hasProject
    ? { key: "code", title: "Code", status: "No project yet", tone: "idle", action: { key: "new_project", label: "New project" } }
    : dirty
      ? {
          key: "code",
          title: "Code",
          status: `${input.unsavedFiles} unsaved`,
          detail: "Save commits to the project branch.",
          tone: "warn",
          action: { key: "save", label: "Save to main", loading: busy.saving }
        }
      : { key: "code", title: "Code", status: `Saved ${short(sourceCommit)}`, detail: "No unsaved edits.", tone: "ok" };

  // Publish
  const liveCurrent = Boolean(live && sourceCommit && live.gitCommit === sourceCommit);
  const lastFailed = !inFlight && newest?.publish?.status === "FAILED" && newest.gitCommit === sourceCommit;
  const publishAction = (label: string): StageAction => ({
    key: "publish",
    label,
    loading: busy.publishing || Boolean(inFlight),
    disabledReason: activeJob ? "A run is in progress; publishing restarts the aggregator." : !sourceCommit ? "No saved commit to publish." : undefined
  });
  let publish: StageSummary;
  if (!input.hasProject) publish = { key: "publish", title: "Publish", status: "Needs a project", tone: "idle" };
  else if (inFlight)
    publish = {
      key: "publish",
      title: "Publish",
      status: `Publishing ${inFlight.version}`,
      detail: inFlight.publish?.step ? `Step: ${inFlight.publish.step}` : "Building the study image.",
      tone: "active",
      action: publishAction("Publishing")
    };
  else if (lastFailed) publish = { key: "publish", title: "Publish", status: "Last publish failed", tone: "error", action: publishAction(`Retry ${short(sourceCommit)}`) };
  else if (live && liveCurrent) publish = { key: "publish", title: "Publish", status: `${live.version} live`, detail: "Matches the saved commit.", tone: "ok" };
  else if (live)
    publish = {
      key: "publish",
      title: "Publish",
      status: `${live.version} live`,
      detail: `Newer commit ${short(sourceCommit)} is not published.`,
      tone: "warn",
      action: publishAction(`Publish ${short(sourceCommit)}`)
    };
  else publish = { key: "publish", title: "Publish", status: "Not published", tone: "idle", action: publishAction(`Publish ${short(sourceCommit)}`) };

  // Sites
  const aggregatorActive = aggregator?.status === "ACTIVE";
  const firstNoKit = sites.find((site) => !site.kitReleased);
  const outdatedKit = sites.some((site) => site.kitReleased && site.kitImageDigest && aggregator?.imageDigest && site.kitImageDigest !== aggregator.imageDigest);
  let siteStage: StageSummary;
  const aggregatorProblem = aggregator && !aggregatorActive ? (aggregator.error ?? aggregator.lastError ?? (aggregator.status === "FAILED" ? "The aggregator failed to start." : null)) : null;
  if (aggregator && !aggregatorActive && (aggregator.status === "FAILED" || aggregator.error))
    siteStage = { key: "sites", title: "Sites", status: "Aggregator failed", detail: aggregatorProblem ?? undefined, tone: "error" };
  else if (!aggregatorActive) siteStage = { key: "sites", title: "Sites", status: "Waiting for publish", detail: aggregatorProblem ?? `${connected}/${sites.length} connected`, tone: aggregatorProblem ? "warn" : "idle" };
  else if (sites.length === 0) siteStage = { key: "sites", title: "Sites", status: "No sites in this study", tone: "warn" };
  else if (firstNoKit)
    siteStage = { key: "sites", title: "Sites", status: `${connected}/${sites.length} connected`, detail: "A site still needs its kit.", tone: "warn", action: { key: "release_kit", label: "Release kit" } };
  else if (outdatedKit)
    siteStage = { key: "sites", title: "Sites", status: `${connected}/${sites.length} connected`, detail: "A kit is older than the live image.", tone: "warn", action: { key: "release_kit", label: "Update kit" } };
  else if (connected === 0) siteStage = { key: "sites", title: "Sites", status: `0/${sites.length} connected`, detail: "Waiting for sites to run their kit.", tone: "active" };
  else siteStage = { key: "sites", title: "Sites", status: `${connected}/${sites.length} connected`, tone: connected === sites.length ? "ok" : "warn" };

  // Run
  const canRun = aggregatorActive && connected > 0 && !activeJob;
  let run: StageSummary;
  if (activeJob) run = { key: "run", title: "Run", status: `Run ${activeJob.status.toLowerCase()}`, tone: "active" };
  else if (lastJob?.status === "COMPLETED" && !lastJob.result)
    run = { key: "run", title: "Run", status: "Completed, model not saved", tone: "warn", action: { key: "save_model", label: "Save model" } };
  else if (canRun)
    run = {
      key: "run",
      title: "Run",
      status: lastJob ? `Last run ${lastJob.status.toLowerCase()}` : "Ready to start",
      tone: "idle",
      action: input.activeStage === "run" ? { key: "start_run", label: "Start run", loading: busy.starting } : { key: "setup_run", label: "Set up run" }
    };
  else run = { key: "run", title: "Run", status: lastJob ? `Last run ${lastJob.status.toLowerCase()}` : "Not started", detail: "Needs a live aggregator and a connected site.", tone: lastJob?.status === "FAILED" ? "error" : "idle" };

  const stages = [code, publish, siteStage, run];
  let current: StageKey = "run";
  if (!input.hasProject || dirty) current = "code";
  else if (inFlight || lastFailed || !liveCurrent) current = "publish";
  else if (!aggregatorActive || sites.length === 0 || firstNoKit || outdatedKit || connected === 0) current = "sites";
  else if (activeJob) current = "run";
  return { current, stages };
}
