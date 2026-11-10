import { updateNeedsNewKit } from "@/lib/site-image";
import { statusLabel, TERMS } from "@/lib/terms";
/**
 * Derives the four-stage pipeline rail (Code, Publish, Sites, Run) from the project overview.
 * Each stage has live status text and at most one human action; only the "current" stage's action is primary.
 */

export type StageKey = "code" | "publish" | "sites" | "run";
export type StageTone = "idle" | "active" | "ok" | "warn" | "error";
export type StageActionKey = "new_project" | "save" | "publish" | "release_kit" | "setup_run" | "start_run" | "save_model";

export type StageAction = { key: StageActionKey; label: string; disabledReason?: string; loading?: boolean };
export type StageSummary = { key: StageKey; title: string; status: string; detail?: string; tone: StageTone; action?: StageAction; /** Raw technical text (step ids, commits) for a tooltip only. */ technical?: string };

export type StageInput = {
  hasProject: boolean;
  unsavedFiles: number;
  sourceCommit: string | null;
  /** "loading" until the saved commit is known; "error" if it could not be read. Defaults to "ready". */
  sourceStatus?: "loading" | "ready" | "error";
  versions: Array<{ id: string; version: string; gitCommit: string | null; publish: { status: string; step?: string | null } | null }>;
  aggregator: { status: string; pipelineVersionId: string | null; imageDigest: string | null; lastError?: string | null; error?: string | null } | null;
  sites: Array<{ kitReleased: boolean; kitImageDigest: string | null; connected: boolean | null; imageState?: string; needsNewKit?: boolean }>;
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
    ? { key: "code", title: "Code", status: "No pipeline yet", tone: "idle", action: { key: "new_project", label: TERMS.newPipeline } }
    : dirty
      ? {
          key: "code",
          title: "Code",
          status: `${input.unsavedFiles} unsaved`,
          detail: "Saving records your edits in the pipeline.",
          tone: "warn",
          action: { key: "save", label: TERMS.save, loading: busy.saving }
        }
      : { key: "code", title: "Code", status: "Saved", detail: "No unsaved edits.", technical: `Saved commit ${short(sourceCommit)}`, tone: "ok" };

  // Publish
  const sourceStatus = input.sourceStatus ?? "ready";
  const liveCurrent = Boolean(live && sourceCommit && live.gitCommit === sourceCommit);
  const lastFailed = !inFlight && newest?.publish?.status === "FAILED" && newest.gitCommit === sourceCommit;
  const publishAction = (label: string): StageAction => ({
    key: "publish",
    label,
    loading: busy.publishing || Boolean(inFlight),
    disabledReason: activeJob ? "A run is in progress; publishing restarts the study server." : !sourceCommit ? "There is no saved code to publish yet." : undefined
  });
  let publish: StageSummary;
  if (!input.hasProject) publish = { key: "publish", title: "Publish", status: "Needs a pipeline", tone: "idle" };
  else if (sourceStatus === "loading" && !sourceCommit) publish = { key: "publish", title: "Publish", status: "Loading…", detail: "Reading the saved code.", tone: "idle" };
  else if (sourceStatus === "error" && !sourceCommit)
    publish = { key: "publish", title: "Publish", status: "Could not read the saved code", detail: "Reload to try again.", tone: "error" };
  else if (inFlight)
    publish = {
      key: "publish",
      title: "Publish",
      status: `Publishing ${inFlight.version}`,
      detail: "Preparing the code version for the sites.",
      technical: inFlight.publish?.step ? `Step: ${inFlight.publish.step}` : undefined,
      tone: "active"
    };
  else if (lastFailed) publish = { key: "publish", title: "Publish", status: "Last publish failed", tone: "error", technical: `Commit ${short(sourceCommit)}`, action: publishAction("Retry publishing") };
  else if (live && liveCurrent) publish = { key: "publish", title: "Publish", status: `${live.version} live`, detail: "Matches the latest saved code.", tone: "ok" };
  else if (live)
    publish = {
      key: "publish",
      title: "Publish",
      status: `${live.version} live`,
      detail: "The latest saved code is not published yet.",
      technical: `Commit ${short(sourceCommit)}`,
      tone: "warn",
      action: publishAction(TERMS.publishLatest)
    };
  else publish = { key: "publish", title: "Publish", status: "Not published", tone: "idle", technical: `Commit ${short(sourceCommit)}`, action: publishAction(TERMS.publishLatest) };

  // Sites
  const aggregatorActive = aggregator?.status === "ACTIVE";
  const firstNoKit = sites.find((site) => !site.kitReleased);
  // A site kit needs replacing only when the code version moved to another registry location. A code-only publish keeps the path: the site runs `update`.
  const outdatedKit = sites.some((site) => site.kitReleased && (site.needsNewKit || updateNeedsNewKit(site.kitImageDigest, aggregator?.imageDigest)));
  // A site whose runner reports another code version than the study server's cannot take part in a run (the server refuses it).
  const outdatedImage = sites.some((site) => site.imageState === "OUTDATED" || (site.imageState === "NOT_REPORTED" && site.connected === true));
  let siteStage: StageSummary;
  const aggregatorProblem = aggregator && !aggregatorActive ? (aggregator.error ?? aggregator.lastError ?? (aggregator.status === "FAILED" ? "The study server failed to start." : null)) : null;
  if (aggregator && !aggregatorActive && (aggregator.status === "FAILED" || aggregator.error))
    siteStage = { key: "sites", title: "Sites", status: "Study server failed", detail: aggregatorProblem ?? undefined, tone: "error" };
  else if (!aggregatorActive) siteStage = { key: "sites", title: "Sites", status: "Waiting for publish", detail: aggregatorProblem ?? `${connected}/${sites.length} connected`, tone: aggregatorProblem ? "warn" : "idle" };
  else if (sites.length === 0) siteStage = { key: "sites", title: "Sites", status: "No sites in this study", tone: "warn" };
  else if (firstNoKit)
    siteStage = { key: "sites", title: "Sites", status: `${connected}/${sites.length} connected`, detail: "A site still needs its site kit.", tone: "warn", action: { key: "release_kit", label: "Release site kit" } };
  else if (outdatedKit)
    siteStage = { key: "sites", title: "Sites", status: `${connected}/${sites.length} connected`, detail: "The live code version moved; a site needs a new site kit.", tone: "warn", action: { key: "release_kit", label: "Release new site kit" } };
  else if (outdatedImage)
    siteStage = { key: "sites", title: "Sites", status: `${connected}/${sites.length} connected`, detail: "A site runs an older code version than the live one. Its runner must be updated before a run can start. The site page shows how.", tone: "warn" };
  else if (connected === 0) siteStage = { key: "sites", title: "Sites", status: `0/${sites.length} connected`, detail: "Waiting for sites to start their runner.", tone: "active" };
  else siteStage = { key: "sites", title: "Sites", status: `${connected}/${sites.length} connected`, tone: connected === sites.length ? "ok" : "warn" };

  // Run
  const canRun = aggregatorActive && connected > 0 && !activeJob;
  let run: StageSummary;
  if (activeJob) run = { key: "run", title: "Run", status: `Run ${statusLabel(activeJob.status).toLowerCase()}`, tone: "active" };
  else if (lastJob?.status === "COMPLETED" && !lastJob.result)
    run = { key: "run", title: "Run", status: "Completed, model not saved", tone: "warn", action: { key: "save_model", label: "Save model" } };
  else if (canRun)
    run = {
      key: "run",
      title: "Run",
      status: lastJob ? `Last run: ${statusLabel(lastJob.status).toLowerCase()}` : "Ready to start",
      tone: "idle",
      action: input.activeStage === "run" ? { key: "start_run", label: "Start run", loading: busy.starting } : { key: "setup_run", label: "Set up run" }
    };
  else run = { key: "run", title: "Run", status: lastJob ? `Last run: ${statusLabel(lastJob.status).toLowerCase()}` : "Not started", detail: "Needs a live study server and a connected site.", tone: lastJob?.status === "FAILED" ? "error" : "idle" };

  const stages = [code, publish, siteStage, run];
  let current: StageKey = "run";
  if (!input.hasProject || dirty) current = "code";
  else if (sourceStatus !== "ready" && !sourceCommit) current = "publish";
  else if (inFlight || lastFailed || !liveCurrent) current = "publish";
  else if (!aggregatorActive || sites.length === 0 || firstNoKit || outdatedKit || outdatedImage || connected === 0) current = "sites";
  else if (activeJob) current = "run";
  return { current, stages };
}
