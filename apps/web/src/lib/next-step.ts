/**
 * The six phases of a study, from the ethics decision to a released model, and which one needs attention now.
 *
 * `resolveStudySteps` is pure: it reads a snapshot and a map of what the person may do. Rules that already exist are
 * reused, not copied: the stage rail (pipeline-stage.ts computeStages) decides whether the pipeline is published and
 * whether the sites are ready, and the checklist (preflight.ts evaluatePreflight) supplies the blockers.
 * Client-safe: no prisma or other server-only imports (the loader is in next-step-data.ts).
 */
import { ethicsExpired } from "@/lib/governance";
import { codeRunHref, computeStages, type StageInput } from "@/lib/pipeline-stage";
import { evaluatePreflight, PREFLIGHT_SITE_PREFIXES, type PreflightItem, type PreflightSite, type PreflightSnapshot } from "@/lib/preflight";
import type { SiteImageState } from "@/lib/site-image";
import type { StudyAction } from "@/lib/rbac";

export type StepKey = "authorize" | "prepare" | "approve" | "deploy" | "execute" | "validate";
export type StepTone = "ok" | "active" | "warn" | "idle" | "error";
export type StepAction = { label: string; href: string; permission?: StudyAction };

export type Step = {
  key: StepKey;
  /** "Ethics decision", "Study questions", "Pipeline", "Sites", "Run", "Results". */
  title: string;
  /** Short plain phrase: "Done", "3 of 29 answered", "1 of 2 sites connected", "Not started". */
  status: string;
  tone: StepTone;
  /** One plain sentence. For a person who cannot act it reads "Ask a study lead to ...". */
  detail?: string;
  /** Failing checklist items that belong to this step. */
  blockers: PreflightItem[];
  /** What to do next. Absent when the step is done or the person may not do it. */
  action?: StepAction;
  /** Where this step's "Open" link goes: the exact tab or stage the step describes. */
  href: string;
};

export type StepsResult = { current: StepKey | null; steps: Step[] };

/** Study permissions of the person asking (a missing entry means no). */
export type StepPermissions = Partial<Record<StudyAction, boolean>>;

export type StepSite = StageInput["sites"][number] & {
  studySiteId: string;
  code: string;
  name: string;
  signedOff: boolean;
};

export type StepsSnapshot = {
  studyId: string;
  now?: Date;
  ethics: PreflightSnapshot["ethics"];
  questions: { answered: number; total: number };
  /** True when the study has at least one pipeline. */
  hasProject: boolean;
  /** Published versions, newest first. */
  versions: StageInput["versions"];
  aggregator: StageInput["aggregator"];
  /** Active sites with their runner and code version state (the Code & run overview). */
  sites: StepSite[];
  /** Recent runs, newest first. */
  jobs: StageInput["jobs"];
  /** How many model releases exist. */
  modelReleases: number;
  /** Study sites where the person is site staff (their own site pages). */
  mySiteIds?: string[];
};

export const STEP_ORDER: StepKey[] = ["authorize", "prepare", "approve", "deploy", "execute", "validate"];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function failing(items: PreflightItem[], test: (code: string) => boolean): PreflightItem[] {
  return items.filter((item) => !item.ok && test(item.code));
}

function item(items: PreflightItem[], code: string): PreflightItem | undefined {
  return items.find((entry) => entry.code === code);
}

/** Failing checklist items worth showing under a step: not the one the step's own button already fixes. */
export function visibleBlockers(step: Step): PreflightItem[] {
  const own = step.key === "authorize" ? "ethics" : step.key === "prepare" ? "study_questions" : null;
  return step.blockers.filter((entry) => !entry.ok && entry.code !== own);
}

export function resolveStudySteps(snapshot: StepsSnapshot, can: StepPermissions): StepsResult {
  const { studyId, aggregator, sites, jobs, versions } = snapshot;
  const projectsHref = codeRunHref(studyId);
  const publishHref = codeRunHref(studyId, "publish");
  const siteStageHref = codeRunHref(studyId, "sites");
  const runHref = codeRunHref(studyId, "run");
  const resultsHref = `/studies/${studyId}/runs`;

  const live = versions.find((version) => version.id === aggregator?.pipelineVersionId) ?? null;
  const inFlight = versions.some((version) => version.publish && (version.publish.status === "QUEUED" || version.publish.status === "RUNNING"));
  const activeJob = jobs.some((job) => job.status === "SUBMITTED" || job.status === "SCHEDULED" || job.status === "RUNNING");
  const completedJobs = jobs.filter((job) => job.status === "COMPLETED");
  const serverActive = aggregator?.status === "ACTIVE";

  // Rules that exist elsewhere.
  const stages = computeStages({
    hasProject: snapshot.hasProject,
    unsavedFiles: 0,
    sourceCommit: versions[0]?.gitCommit ?? null,
    versions,
    aggregator,
    sites,
    jobs,
    busy: { saving: false, publishing: false, starting: false },
    activeStage: "code"
  }).stages;
  const publishStage = stages.find((stage) => stage.key === "publish")!;
  const siteStage = stages.find((stage) => stage.key === "sites")!;

  const preflightSites: PreflightSite[] = sites.map((site) => ({
    studySiteId: site.studySiteId,
    siteId: site.studySiteId,
    code: site.code,
    name: site.name,
    signedOff: site.signedOff,
    connected: serverActive ? site.connected : null,
    imageState: serverActive && site.imageState ? (site.imageState as SiteImageState) : null
  }));
  const base = { studyId, now: snapshot.now, ethics: snapshot.ethics, questions: snapshot.questions, sites: preflightSites };
  // Code & run starts a run with the sites that are connected right now (it can start with fewer than all of them),
  // so the Run step checks the same sites with the same minimum of one.
  const connectedSites = preflightSites.filter((site) => site.connected === true);
  const runSites = serverActive && connectedSites.length > 0 ? connectedSites : preflightSites;
  const publishItems = evaluatePreflight("publish", { ...base, publishInProgress: inFlight, runInProgress: activeJob }).items;
  const runItems = evaluatePreflight("run", {
    ...base,
    pipeline: { exists: Boolean(live), approved: Boolean(live), checksPassed: Boolean(live) },
    studyServer: { running: serverActive, servesPipeline: Boolean(live) },
    serverUnreachable: serverActive && Boolean(aggregator?.error)
  }).items;
  const startItems = evaluatePreflight("run", {
    ...base,
    sites: runSites,
    minSites: 1,
    pipeline: { exists: Boolean(live), approved: Boolean(live), checksPassed: Boolean(live) },
    studyServer: { running: serverActive, servesPipeline: Boolean(live) },
    serverUnreachable: serverActive && Boolean(aggregator?.error)
  }).items;
  const runReady = serverActive && Boolean(live) && !activeJob && startItems.every((entry) => entry.ok);

  const steps: Step[] = [];
  // A person who can change nothing for the study team is not sent to the places where the team fixes things.
  const studyTeam = Boolean(can.manage || can.manageEthics || can.approvePipeline || can.manageSites || can.submitJob);
  const forPerson = (entry: PreflightItem): PreflightItem => (entry.owner === "study" && !studyTeam ? { ...entry, fixHref: undefined } : entry);
  // Where each step's "Open" goes: the tab or stage the step talks about.
  const stepHref = (key: StepKey, done: boolean): string => {
    switch (key) {
      case "authorize":
        return `/studies/${studyId}?section=protocol&tab=ethics`;
      case "prepare":
        return `/studies/${studyId}?section=protocol&tab=requirements`;
      case "approve":
        return done || !snapshot.hasProject ? projectsHref : publishHref;
      case "deploy":
        return sites.length === 0 ? `/studies/${studyId}?section=sites` : siteStageHref;
      case "execute":
        return runHref;
      case "validate":
        return resultsHref;
    }
  };
  const push = (
    step: Omit<Step, "blockers" | "href"> & {
      blockers?: PreflightItem[];
      ask?: string;
      act?: Omit<StepAction, "permission"> & { permission: StudyAction };
      /** What a person without the permission can do instead (site staff open their own site page). */
      instead?: { detail: string; action: StepAction } | null;
    }
  ) => {
    const { ask, act, blockers, instead, ...rest } = step;
    const done = rest.tone === "ok";
    let detail = rest.detail;
    let action: StepAction | undefined;
    if (act && !done) {
      if (can[act.permission]) action = act;
      else if (instead) {
        detail = instead.detail;
        action = instead.action;
      } else if (ask) detail = ask;
    }
    steps.push({ ...rest, detail, href: stepHref(rest.key, done), blockers: done ? [] : (blockers ?? []).map(forPerson), ...(action ? { action } : {}) });
  };

  // 1. Authorize
  const ethicsItem = item(publishItems, "ethics")!;
  const expired = Boolean(snapshot.ethics) && ethicsExpired(snapshot.ethics?.validUntil, snapshot.now);
  push({
    key: "authorize",
    title: "Ethics decision",
    status: ethicsItem.ok ? "Done" : expired ? "Expired" : snapshot.ethics ? "Not approved" : "Not started",
    tone: ethicsItem.ok ? "ok" : expired ? "warn" : "idle",
    detail: ethicsItem.ok ? "The ethics decision is on record." : ethicsItem.detail,
    blockers: [ethicsItem],
    act: { label: expired ? "Record the renewed decision" : "Record the ethics decision", href: ethicsItem.fixHref ?? `/studies/${studyId}?section=protocol`, permission: "manageEthics" },
    ask: expired ? "Ask a study lead to record the renewed ethics decision." : "Ask a study lead to record the ethics decision."
  });

  // 2. Prepare
  const { answered, total } = snapshot.questions;
  const questionItem = item(publishItems, "study_questions")!;
  push({
    key: "prepare",
    title: "Study questions",
    status: questionItem.ok ? "Done" : answered === 0 ? "Not started" : `${answered} of ${total} answered`,
    tone: questionItem.ok ? "ok" : "idle",
    detail: questionItem.ok ? "All study questions are answered." : "The answers tell the assistant what the pipeline must do.",
    blockers: [questionItem],
    act: { label: answered === 0 ? "Answer the study questions" : "Continue the study questions", href: questionItem.fixHref ?? `/studies/${studyId}?section=protocol`, permission: "manage" },
    ask: "Ask a study lead to answer the study questions."
  });

  // 3. Approve: write, review and publish the code
  const approveBlockers = failing(publishItems, (code) => code !== "ethics" && code !== "study_questions");
  if (publishStage.tone === "ok") {
    push({ key: "approve", title: "Pipeline", status: "Done", tone: "ok", detail: live ? `Pipeline version ${live.version} is published.` : "The pipeline is published." });
  } else if (!snapshot.hasProject) {
    push({
      key: "approve",
      title: "Pipeline",
      status: "Not started",
      tone: "idle",
      detail: "Write the code with the assistant, accept its changes, then publish.",
      // The pipeline can be started before anything else is ready; what publishing needs is shown once it exists.
      blockers: [],
      act: { label: "Start the pipeline", href: projectsHref, permission: "runAgent" },
      ask: "Ask a study lead to start the pipeline."
    });
  } else if (publishStage.tone === "active") {
    push({ key: "approve", title: "Pipeline", status: "Publishing", tone: "active", detail: "Preparing the code version for the sites. This takes a few minutes.", blockers: approveBlockers });
  } else if (publishStage.tone === "error") {
    push({
      key: "approve",
      title: "Pipeline",
      status: "Publish failed",
      tone: "error",
      detail: "The last publish did not finish. Publish again from the pipeline page.",
      blockers: approveBlockers,
      act: { label: "Publish again", href: publishHref, permission: "approvePipeline" },
      ask: "Ask a study lead to publish the pipeline again."
    });
  } else {
    push({
      key: "approve",
      title: "Pipeline",
      status: live ? "Newer code not published" : "Not published",
      tone: live ? "warn" : "idle",
      detail: "Review the code, then publish it so the sites can use it.",
      blockers: approveBlockers,
      act: { label: "Review and publish", href: publishHref, permission: "approvePipeline" },
      ask: "Ask a study lead to review and publish the pipeline."
    });
  }

  // 4. Deploy: study server running, sites connected and signed off
  const deployBlockers = failing(runItems, (code) => code === "study_server" || code === "sites" || (code.startsWith("site_") && code !== "site_connection_check"));
  const connectedCount = sites.filter((site) => site.connected).length;
  const signedCount = sites.filter((site) => site.signedOff).length;
  const sitesReady = serverActive && Boolean(live) && sites.length > 0 && deployBlockers.length === 0 && connectedCount === sites.length && siteStage.tone === "ok";
  if (sitesReady) {
    push({ key: "deploy", title: "Sites", status: "Done", tone: "ok", detail: "The study server is running and every site is connected and signed off." });
  } else if (!serverActive) {
    const failed = siteStage.tone === "error";
    const stopped = Boolean(aggregator) && Boolean(live) && !failed && !inFlight;
    const siteBlockers = failing(runItems, (code) => code === "sites" || code.startsWith(PREFLIGHT_SITE_PREFIXES.signedOff));
    if (failed || stopped) {
      push({
        key: "deploy",
        title: "Sites",
        status: failed ? "Study server failed" : "Study server stopped",
        tone: failed ? "error" : "warn",
        detail: failed ? "The study server did not start. Publish the pipeline again, or ask for help." : "The study server is not running. Publish the pipeline again to start it.",
        blockers: siteBlockers,
        act: { label: "Publish again", href: publishHref, permission: "approvePipeline" },
        ask: failed ? "Ask a study lead to publish the pipeline again, or to ask for help." : "Ask a study lead to publish the pipeline again."
      });
    } else {
      push({
        key: "deploy",
        title: "Sites",
        status: inFlight ? "Waiting for publish" : "Not started",
        tone: "idle",
        detail: inFlight ? "The study server starts when publishing finishes. Then each site installs its runner and signs off." : "The study server starts when the pipeline is published. Then each site installs its runner and signs off.",
        blockers: siteBlockers
      });
    }
  } else if (sites.length === 0) {
    push({
      key: "deploy",
      title: "Sites",
      status: "No sites",
      tone: "warn",
      detail: "Add at least one site to the study.",
      blockers: deployBlockers,
      act: { label: "Add a site", href: `/studies/${studyId}?section=sites`, permission: "manageSites" },
      ask: "Ask a study lead to add a site."
    });
  } else {
    const allConnected = connectedCount === sites.length;
    const firstOpen = deployBlockers.find((entry) => entry.fixHref?.startsWith("/sites/"));
    // "Open the sites" opens the Sites stage of Code & run, which lists every site's runner and code version.
    // A single site's page is linked from its own line in the checklist.
    const needing = new Set(deployBlockers.map((entry) => entry.code.split(":")[1]).filter(Boolean));
    const mine = snapshot.mySiteIds ?? [];
    const myHome = mine.find((id) => needing.has(id)) ?? mine[0];
    push({
      key: "deploy",
      title: "Sites",
      status: allConnected
        ? needing.size > 0
          ? `${plural(needing.size, "site needs", "sites need")} attention`
          : `${signedCount} of ${sites.length} ${sites.length === 1 ? "site" : "sites"} signed off`
        : `${connectedCount} of ${sites.length} ${sites.length === 1 ? "site" : "sites"} connected`,
      tone: "warn",
      detail: firstOpen?.detail ?? siteStage.detail ?? (allConnected ? "Each site must sign off before a run." : "Each site installs the runner from its site kit."),
      blockers: deployBlockers,
      act: { label: "Open the sites", href: siteStageHref, permission: "manageSites" },
      ask: "Ask a study lead to follow up with the sites that are not ready.",
      instead: myHome ? { detail: "Open your site page to install the runner and sign off.", action: { label: "Open your site page", href: `/sites/${myHome}` } } : null
    });
  }

  // 5. Execute
  const lastJob = jobs[0] ?? null;
  const runBlockers = failing(startItems, (code) => code === "min_sites" || code === "site_connection_check" || code.startsWith(PREFLIGHT_SITE_PREFIXES.connected) || code.startsWith(PREFLIGHT_SITE_PREFIXES.codeVersion));
  if (activeJob) {
    push({ key: "execute", title: "Run", status: "In progress", tone: "active", detail: "The sites are training the model. This page updates as the run goes on." });
  } else if (completedJobs.length > 0 && lastJob?.status !== "FAILED") {
    push({ key: "execute", title: "Run", status: "Done", tone: "ok", detail: plural(completedJobs.length, "run has finished.", "runs have finished.") });
  } else if (lastJob?.status === "FAILED") {
    const earlier = completedJobs.length;
    push({
      key: "execute",
      title: "Run",
      status: "Last run failed",
      tone: earlier > 0 ? "warn" : "error",
      detail: `${earlier > 0 ? `${plural(earlier, "earlier run", "earlier runs")} finished, but the latest one failed. ` : ""}${runReady ? "Open the run to see what happened, then start it again." : "Get the sites ready, then start the run again."}`,
      blockers: runBlockers,
      ...(runReady ? { act: { label: "Start the run again", href: runHref, permission: "submitJob" as const } } : {}),
      ask: "Ask a study lead to start the run again."
    });
  } else {
    push({
      key: "execute",
      title: "Run",
      status: "Not started",
      tone: "idle",
      detail: runReady ? "Everything is in place. Start the run when you are ready." : "A run can start once the study server is running and the sites are ready.",
      blockers: runBlockers,
      ...(runReady ? { act: { label: "Start run", href: runHref, permission: "submitJob" as const } } : {}),
      ask: "Ask a study lead to start the run."
    });
  }

  // 6. Validate
  const unsaved = completedJobs.find((job) => !job.result) ?? null;
  const saved = completedJobs.some((job) => job.result);
  if (snapshot.modelReleases > 0) {
    push({ key: "validate", title: "Results", status: "Done", tone: "ok", detail: plural(snapshot.modelReleases, "model release exists.", "model releases exist.") });
  } else if (completedJobs.length === 0) {
    push({ key: "validate", title: "Results", status: "Not started", tone: "idle", detail: "After a run finishes, review the results, save the model and release it." });
  } else if (unsaved && !saved) {
    push({
      key: "validate",
      title: "Results",
      status: "Model not saved",
      tone: "warn",
      detail: "The run finished. Save the model so it can be reviewed and released.",
      act: { label: "Save the model", href: resultsHref, permission: "submitJob" },
      ask: "Ask a study lead to save the model."
    });
  } else {
    push({
      key: "validate",
      title: "Results",
      status: "Model saved, not released",
      tone: "warn",
      detail: "Review the results, then release the model.",
      act: { label: "Review and release", href: resultsHref, permission: "approveRelease" },
      ask: "Ask a study lead to release the model."
    });
  }

  // Once a run has finished, publishing and getting the sites ready are history: results come next. A step that was
  // only waiting (idle) reads "Done". A warning or an error stays visible; a warning no longer decides the next step.
  const ran = completedJobs.length > 0;
  const settled = ran
    ? steps.map((step) =>
        (step.key === "approve" || step.key === "deploy") && step.tone === "idle"
          ? { ...step, status: "Done", tone: "ok" as const, detail: "A run has already finished.", blockers: [], action: undefined, href: step.key === "approve" ? projectsHref : step.href }
          : step
      )
    : steps;
  const waiting = (step: Step) => ran && step.tone === "warn" && (step.key === "approve" || step.key === "deploy" || step.key === "execute");
  const currentStep = settled.find((step) => step.tone !== "ok" && !waiting(step)) ?? null;
  const resolved = settled.map((step) => (step === currentStep && step.tone === "idle" ? { ...step, tone: "active" as const } : step));
  return { current: currentStep?.key ?? null, steps: resolved };
}
