/**
 * Preflight: the checklist of what must be true before Publish or Start run, shown as ticks and crosses.
 *
 * `evaluatePreflight` is pure. The publish route and the run-start route decide with it too, so the checklist a
 * person sees and the server's refusal can never disagree. Client-safe: no prisma or other server-only imports
 * (the loader that fills the snapshot lives in preflight-data.ts).
 */
import { ethicsCleared, ethicsExpired, ethicsExpiredMessage, publishRequirementMessage } from "@/lib/governance";
import type { SiteImageState } from "@/lib/site-image";

const QUESTIONS_DETAIL_TAIL = "Suggested answers count only after you accept them. Open Study setup, then Questions.";

export type PreflightKind = "publish" | "run";
export type PreflightOwner = "study" | "site" | "system";

export type PreflightItem = {
  /** Stable machine key, e.g. "ethics", "study_questions", "site_signed_off:<studySiteId>". Never shown to people. */
  code: string;
  ok: boolean;
  /** One plain sentence: "The ethics decision is recorded" when ok, "Record the ethics decision" when not. */
  text: string;
  /** Extra plain sentence, e.g. "3 study questions are not answered yet". */
  detail?: string;
  /** Who can fix it: the study team, a site's staff, or the system (wait or ask for help). */
  owner: PreflightOwner;
  /** In-app link to the place where it is fixed. */
  fixHref?: string;
};

export type PreflightResult = { ok: boolean; items: PreflightItem[] };

export type PreflightSite = {
  studySiteId: string;
  /** Id used in /sites/{id}. */
  siteId: string;
  code: string;
  name: string;
  /** The human sign-off (siteSignedOff). */
  signedOff: boolean;
  /** Runner connected (isSitePresent). null = not checked, so the item is left out. */
  connected: boolean | null;
  /** Code version state from site-image. null = not checked, so the item is left out. */
  imageState: SiteImageState | null;
};

export type PreflightSnapshot = {
  studyId: string;
  now?: Date;
  /** Latest ethics decision, or null when none is recorded. */
  ethics: { status: string; validUntil?: Date | string | null } | null;
  questions: {
    answered: number;
    total: number;
    /** Strict study questions (STUDY_QUESTIONS_STRICT): Publish also needs the study specification confirmed. */
    strict?: boolean;
    /** Strict only: the study specification is confirmed. */
    confirmed?: boolean;
  };
  /** Active (non-disabled) sites that take part. */
  sites: PreflightSite[];

  // Publish. null/undefined = not checked yet, so the item is left out.
  savedCode?: boolean | null;
  /** The code host could not be asked whether code is saved. Shown as "Check the saved code", not as "no saved code". */
  savedCodeUnchecked?: boolean;
  publishInProgress?: boolean | null;
  runInProgress?: boolean | null;
  /**
   * Enforced studies only. Whether the person publishing made changes in this version while another approver exists, and
   * who else can publish. null/undefined = not checked (or not enforced), so the item is left out.
   */
  secondApprover?: { required: boolean; names: string[] } | null;

  // Run
  pipeline?: { exists: boolean; approved: boolean; checksPassed: boolean };
  studyServer?: { running: boolean; /** Serving the pipeline version being run. */ servesPipeline: boolean };
  /** The study server could not be asked which sites are connected. */
  serverUnreachable?: boolean;
  /** Smallest number of connected sites a run may start with. Defaults to all active sites. */
  minSites?: number | null;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Dr. Lee", "Dr. Lee or Sam Park", "Dr. Lee, Sam Park or Ana Diaz". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "another approver";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** Informational item (always ok) for a site that is not connected and so will not take part in a run. */
export const PREFLIGHT_NOT_TAKING_PART_PREFIX = "site_not_taking_part:";

export const PREFLIGHT_SITE_PREFIXES = {
  signedOff: "site_signed_off:",
  connected: "site_connected:",
  codeVersion: "site_code_version:"
} as const;

export function evaluatePreflight(kind: PreflightKind, snapshot: PreflightSnapshot): PreflightResult {
  const { studyId } = snapshot;
  const now = snapshot.now ?? new Date();
  const items: PreflightItem[] = [];
  const ethicsHref = `/studies/${studyId}?section=protocol&tab=ethics`;
  const questionsHref = `/studies/${studyId}?section=protocol&tab=requirements`;
  // Each item opens the Code & run stage where it is fixed (?stage=), not just the page.
  const codeHref = `/studies/${studyId}/projects`;
  const publishHref = `/studies/${studyId}/projects?stage=publish`;
  const runHref = `/studies/${studyId}/projects?stage=run`;
  const siteStageHref = `/studies/${studyId}/projects?stage=sites`;
  const sitesHref = `/studies/${studyId}?section=sites`;

  // Ethics
  const decision = snapshot.ethics;
  const ethicsOk = ethicsCleared(decision?.status as never, decision?.validUntil, now);
  const expired = Boolean(decision) && ethicsExpired(decision?.validUntil, now);
  items.push({
    code: "ethics",
    ok: ethicsOk,
    text: ethicsOk ? "The ethics decision is recorded" : publishRequirementMessage("ethicsApproval"),
    ...(ethicsOk ? {} : { detail: expired && decision?.validUntil ? ethicsExpiredMessage(decision.validUntil) : decision ? "The latest ethics decision is not an approval." : "No ethics decision has been recorded yet." }),
    owner: "study",
    fixHref: ethicsHref
  });

  if (kind === "publish") {
    const left = Math.max(0, snapshot.questions.total - snapshot.questions.answered);
    if (snapshot.questions.strict) {
      const needsConfirm = left === 0 && !snapshot.questions.confirmed;
      const ok = left === 0 && !needsConfirm;
      items.push({
        code: "study_questions",
        ok,
        text: ok ? "The study specification is confirmed" : left > 0 ? `${plural(left, "study question still needs", "study questions still need")} an answer` : "Confirm the study specification",
        ...(ok
          ? {}
          : { detail: left > 0 ? `${left === 1 ? "1 study question needs" : `${left} study questions need`} an answer or a decision. ${QUESTIONS_DETAIL_TAIL}` : "Everything is answered. Check the answers and confirm the study specification." }),
        owner: "study",
        fixHref: questionsHref
      });
    } else {
      items.push({
        code: "study_questions",
        ok: left === 0,
        text: left === 0 ? "All study questions are answered" : publishRequirementMessage("studyQuestions", { remaining: left }),
        ...(left === 0 ? {} : { detail: `${left === 1 ? "1 study question needs" : `${left} study questions need`} an answer or a decision. ${QUESTIONS_DETAIL_TAIL}` }),
        owner: "study",
        fixHref: questionsHref
      });
    }
  }

  // Sites (both kinds)
  const hasSites = snapshot.sites.length > 0;
  items.push({
    code: "sites",
    ok: hasSites,
    text: hasSites ? `${plural(snapshot.sites.length, "site takes", "sites take")} part` : publishRequirementMessage("studySites"),
    ...(hasSites ? {} : { detail: "A study needs at least one site that takes part." }),
    owner: "study",
    fixHref: sitesHref
  });

  if (kind === "publish") {
    if (snapshot.savedCodeUnchecked) {
      items.push({
        code: "saved_code_check",
        ok: false,
        text: "Check the saved code",
        detail: "The code could not be looked up just now. Try again in a minute.",
        owner: "system",
        fixHref: codeHref
      });
    } else if (snapshot.savedCode != null) {
      items.push({
        code: "saved_code",
        ok: snapshot.savedCode,
        text: snapshot.savedCode ? "The pipeline code is saved" : "Save the pipeline code",
        ...(snapshot.savedCode ? {} : { detail: "There is no saved code to publish yet." }),
        owner: "study",
        fixHref: codeHref
      });
    }
    if (snapshot.publishInProgress != null) {
      items.push({
        code: "publish_idle",
        ok: !snapshot.publishInProgress,
        text: snapshot.publishInProgress ? "Wait for the current publish to finish" : "No other publish is in progress",
        ...(snapshot.publishInProgress ? { detail: "A publish is already in progress for this pipeline." } : {}),
        owner: "system",
        fixHref: publishHref
      });
    }
    if (snapshot.runInProgress != null) {
      items.push({
        code: "run_idle",
        ok: !snapshot.runInProgress,
        text: snapshot.runInProgress ? "Wait for the current run to finish, or stop it" : "No run is in progress",
        ...(snapshot.runInProgress ? { detail: "Publishing restarts the study server, so it cannot happen during a run." } : {}),
        owner: "study",
        fixHref: runHref
      });
    }
    // Shown only when it applies; there is no tick for a rule that does not touch this version.
    if (snapshot.secondApprover?.required) {
      items.push({
        code: "second_approver",
        ok: false,
        text: "A second approver publishes this version",
        detail: `You made changes in this version, so another approver has to publish it. ${joinNames(snapshot.secondApprover.names)} can publish it.`,
        owner: "study"
      });
    }
    return { ok: items.every((item) => item.ok), items };
  }

  // Run: pipeline version and study server
  const pipeline = snapshot.pipeline ?? { exists: false, approved: false, checksPassed: false };
  const pipelineOk = pipeline.exists && pipeline.approved && pipeline.checksPassed;
  items.push({
    code: "pipeline_published",
    ok: pipelineOk,
    text: pipelineOk ? "A pipeline version is published" : "Publish the pipeline",
    ...(pipelineOk
      ? {}
      : {
          detail: !pipeline.exists
            ? "No pipeline version has been published yet."
            : !pipeline.approved
              ? "The pipeline version has not been approved yet."
              : "The pipeline version has not passed its checks yet."
        }),
    owner: "study",
    fixHref: publishHref
  });

  const server = snapshot.studyServer ?? { running: false, servesPipeline: false };
  const serverOk = server.running && server.servesPipeline;
  items.push({
    code: "study_server",
    ok: serverOk,
    text: serverOk ? "The study server is running" : "Start the study server",
    ...(serverOk
      ? {}
      : { detail: server.running ? "The study server is running a different pipeline version. Publish this one first." : "The study server is not running. Publishing the pipeline starts it." }),
    owner: server.running ? "study" : "system",
    fixHref: publishHref
  });

  if (snapshot.publishInProgress != null) {
    items.push({
      code: "publish_idle",
      ok: !snapshot.publishInProgress,
      text: snapshot.publishInProgress ? "Wait for the current publish to finish" : "No publish is in progress",
      ...(snapshot.publishInProgress ? { detail: "Publishing restarts the study server, so a run cannot start until it finishes." } : {}),
      owner: "system",
      fixHref: publishHref
    });
  }
  if (snapshot.runInProgress != null) {
    items.push({
      code: "run_idle",
      ok: !snapshot.runInProgress,
      text: snapshot.runInProgress ? "Wait for the current run to finish, or stop it" : "No run is in progress",
      ...(snapshot.runInProgress ? { detail: "A run is already in progress on the study server." } : {}),
      owner: "study",
      fixHref: runHref
    });
  }

  // Run: each active site
  for (const site of snapshot.sites) {
    const label = site.name || site.code;
    const siteHref = `/sites/${site.siteId}`;
    items.push({
      code: `${PREFLIGHT_SITE_PREFIXES.signedOff}${site.studySiteId}`,
      ok: site.signedOff,
      text: site.signedOff ? `${label} has signed off` : `${label} needs to sign off`,
      ...(site.signedOff ? {} : { detail: `${label} has not finished its site sign-off.` }),
      owner: "site",
      fixHref: siteHref
    });
    if (site.connected != null) {
      items.push({
        code: `${PREFLIGHT_SITE_PREFIXES.connected}${site.studySiteId}`,
        ok: site.connected,
        text: site.connected ? `${label} runner is connected` : `Connect the runner at ${label}`,
        ...(site.connected ? {} : { detail: `${label} is not connected to the study server.` }),
        owner: "site",
        fixHref: siteHref
      });
    }
    if (site.imageState != null && site.imageState !== "UNKNOWN") {
      const current = site.imageState === "CURRENT";
      items.push({
        code: `${PREFLIGHT_SITE_PREFIXES.codeVersion}${site.studySiteId}`,
        ok: current,
        text: current ? `${label} code version is up to date` : `Update the code version at ${label}`,
        ...(current ? {} : { detail: site.imageState === "NOT_REPORTED" ? `${label} has not reported a code version yet.` : `${label} runs an older code version than the study server.` }),
        owner: "site",
        fixHref: siteHref
      });
    }
  }

  // A site that is not connected will not take part. Say so for each one, so nobody is surprised; it never blocks.
  if (!snapshot.serverUnreachable) {
    for (const site of snapshot.sites) {
      if (site.connected !== false) continue;
      items.push({
        code: `${PREFLIGHT_NOT_TAKING_PART_PREFIX}${site.studySiteId}`,
        ok: true,
        text: `${site.name || site.code} is not connected and will not take part in this run`,
        owner: "site",
        fixHref: `/sites/${site.siteId}`
      });
    }
  }

  if (snapshot.serverUnreachable) {
    items.push({
      code: "site_connection_check",
      ok: false,
      text: "Check which sites are connected",
      detail: "The study server could not be reached just now. Try again in a minute.",
      owner: "system",
      fixHref: siteStageHref
    });
  } else if (snapshot.sites.length > 0 && snapshot.sites.every((site) => site.connected != null)) {
    const connected = snapshot.sites.filter((site) => site.connected).length;
    const needed = Math.max(1, snapshot.minSites ?? snapshot.sites.length);
    const enough = connected >= needed;
    items.push({
      code: "min_sites",
      ok: enough,
      text: enough ? "Enough sites are connected" : "Connect more sites",
      detail: `${connected} of ${snapshot.sites.length} ${snapshot.sites.length === 1 ? "site" : "sites"} ${connected === 1 ? "is" : "are"} connected${enough ? "" : `; at least ${needed} ${needed === 1 ? "is" : "are"} needed`}.`,
      owner: "site",
      fixHref: siteStageHref
    });
  }

  return { ok: items.every((item) => item.ok), items };
}

/** One sentence listing what is still missing, built from the failing items. */
export function preflightSummary(items: PreflightItem[]): string {
  const failing = items.filter((item) => !item.ok);
  return failing.map((item) => item.text).join(". ");
}
