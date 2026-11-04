/**
 * Publish and run diagnostics for the project assistant. Pure (no I/O) so redaction, bounding and step selection
 * can be unit tested; diagnostics-loader.ts reads the database and the cluster and feeds these functions.
 *
 * Everything here treats its input as untrusted: workflow logs and NVFLARE messages can contain secrets, addresses
 * of a site's network, and (if a user's code printed it) data. Text is redacted first, then bounded.
 */

import { redactSecrets } from "@/lib/repo-checks";
import { podStep, type PodLike } from "@/lib/workflow-health";

export const DIAGNOSTICS_LIMITS = {
  /** Asked of the Kubernetes API, so an oversized log is never read into memory. */
  fetchTailLines: 200,
  fetchBytes: 32 * 1024,
  /** Kept after redaction. */
  logLines: 60,
  logChars: 4000,
  lineChars: 300,
  firstErrorLines: 8,
  steps: 12,
  stepMessage: 300,
  summaryChars: 600,
  events: 10,
  eventMessage: 300,
  sites: 20
} as const;

export const SITE_SIDE_NOTE =
  "Site-side tracebacks are not visible to the Fedlify server. For a problem on a site (client crash, training error, connection refused), the operator at that site should run ./fedlify-runner.sh logs and share the relevant lines. Do not guess at the cause.";

// ---- redaction and bounding ---------------------------------------------------------------------------------

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
// Not a version pin such as "pkg==1.2.3.4" or "v1.2.3.4".
const IPV4 = new RegExp(`(?<![\\w.]|==|>=|<=|~=|[vV]|version )\\b(?!127\\.0\\.0\\.1\\b)(?:${OCTET}\\.){3}${OCTET}(?::\\d{2,5})?\\b`, "g");
// Full and compressed IPv6 (::1 is loopback and left alone; plain clock times like 12:34:56 do not match).
const IPV6 = /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?![\w:])/gi;
// Host names: URL hosts, cluster-internal names, and dotted names under common public or internal suffixes.
const URL_HOST = /(\b[a-z][a-z0-9+.-]*:\/\/)(?:[^/@\s]*@)?(?!127\.0\.0\.1\b|localhost\b)[^/\s:?#'"]+(?::\d{2,5})?/gi;
const INTERNAL_HOST = /\b[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)*\.(?:svc|cluster\.local|local|internal|lan|corp|intranet)\b(?::\d{2,5})?/gi;
const FQDN = /\b(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\.){1,}(?:com|org|net|edu|gov|ca|uk|de|fr|nl|health|hospital|ac\.[a-z]{2})\b(?::\d{2,5})?/gi;
const NAMED_HOST_PORT = /\b(?:host|hostname|server|address|connect(?:ing|ed)?(?: to)?|to)\s*[=:]?\s*(?!127\.0\.0\.1\b|localhost\b)[a-z][a-z0-9_-]*:\d{2,5}\b/gi;
// Exception message payloads often echo the offending value. Quoted values and long digit runs there are dropped.
const ERROR_PAYLOAD = /\b((?:[A-Za-z_][\w.]*)?(?:Error|Exception)):\s*(.+)$/;
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const HOME_PATH = /\/(?:Users|home)\/[^/\s'"]+/g;

/** A line that looks like a row of tabular data (several delimited fields, mostly numeric). */
export function looksLikeDataRow(line: string): boolean {
  const fields = line.trim().split(/\s*[,;\t|]\s*/);
  if (fields.length < 5) return false;
  const numeric = fields.filter((field) => /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(field) || /^\d{4}-\d{2}-\d{2}/.test(field)).length;
  return numeric / fields.length >= 0.6;
}

/** Redact one piece of free text (no bounding). Secrets first, then addresses and personal paths. */
export function redactText(text: string): string {
  // Whole PEM blocks first: redactSecrets alone would replace only the BEGIN line and leave the key body behind.
  return redactSecrets(text.replace(ANSI, "").replace(CONTROL, "").replace(PEM_BLOCK, "[REDACTED]"))
    .replace(EMAIL, "[email]")
    .replace(URL_HOST, "$1[host]")
    .replace(IPV4, "[address]")
    .replace(IPV6, "[address]")
    .replace(INTERNAL_HOST, "[host]")
    .replace(FQDN, "[host]")
    .replace(NAMED_HOST_PORT, (match) => match.replace(/[a-z][a-z0-9_-]*:\d{2,5}$/i, "[host]"))
    .replace(HOME_PATH, (match) => `/${match.split("/")[1]}/[user]`)
    .split("\n")
    .map(redactErrorPayload)
    .join("\n");
}

/** Keep the exception type, drop quoted values and long numbers from its message (they may be record values). */
function redactErrorPayload(line: string): string {
  return line.replace(ERROR_PAYLOAD, (_all, type: string, payload: string) => {
    const cleaned = payload.replace(/(['"`])(?:(?!\1).){2,}\1/g, "[value]").replace(/\b\d{5,}\b/g, "[number]");
    return `${type}: ${cleaned}`;
  });
}

/** Redact a short single message (an event, a step message) and cap it. */
export function sanitizeMessage(text: string | null | undefined, max: number): string {
  const clean = redactText(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)} [truncated]` : clean;
}

/**
 * Redact a log, drop data-like rows, and keep only the tail within the line and character limits. Redaction runs on
 * the whole text first so a secret split by the cap cannot slip through.
 */
export function sanitizeLog(raw: string, limits: { lines: number; chars: number; lineChars: number } = { lines: DIAGNOSTICS_LIMITS.logLines, chars: DIAGNOSTICS_LIMITS.logChars, lineChars: DIAGNOSTICS_LIMITS.lineChars }): { text: string; notes: string[] } {
  const notes: string[] = [];
  let droppedRows = 0;
  const lines = redactText(raw)
    .split(/\r\n|\n|\r/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0)
    .map((line) => {
      if (looksLikeDataRow(line)) {
        droppedRows += 1;
        return "[data-like row removed]";
      }
      return line.length > limits.lineChars ? `${line.slice(0, limits.lineChars)} [line truncated]` : line;
    });
  if (droppedRows > 0) notes.push(`${droppedRows} data-like log row(s) were removed`);
  let kept = lines;
  if (kept.length > limits.lines) {
    notes.push(`log shortened to its last ${limits.lines} lines`);
    kept = kept.slice(-limits.lines);
  }
  let text = kept.join("\n");
  if (text.length > limits.chars) {
    notes.push(`log shortened to its last ${limits.chars} characters`);
    text = text.slice(-limits.chars);
  }
  return { text, notes };
}

const ERROR_LINE = /\b(traceback|error|exception|failed|failure|fatal|denied|refused|not found|no such file|cannot|could not|unable to|timed? ?out|exit code)\b/i;

/** The lines that show what went wrong: from the first error-looking line onward, else the last lines. */
export function firstErrorLines(log: string, max: number = DIAGNOSTICS_LIMITS.firstErrorLines): string[] {
  // Argo's executor wraps every step's log with its own housekeeping lines; they never explain a failure.
  log = log.split("\n").filter((line) => !/^time=\S+ level=\w+ .*argo=true/.test(line) && !/^Error: exit status \d+$/.test(line.trim())).join("\n");
  const lines = log.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const first = lines.findIndex((line) => ERROR_LINE.test(line));
  if (first === -1) return lines.slice(-max);
  // A Python traceback ends with the exception line; show its tail rather than only the "Traceback" header.
  const window = lines.slice(first, first + 40);
  if (window.length <= max) return window;
  return /^traceback/i.test(window[0]) ? [window[0], ...window.slice(-(max - 1))] : window.slice(0, max);
}

// ---- Argo step selection ------------------------------------------------------------------------------------

export type WorkflowNodeLike = {
  name?: string;
  displayName?: string;
  type?: string;
  phase?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type StepState = { step: string; phase: string; message: string; seconds: number | null };

const FAILED_PHASES = new Set(["Failed", "Error"]);

function isExitHandlerNode(node: WorkflowNodeLike): boolean {
  return (node.name ?? "").includes(".onExit") || (node.displayName ?? "").includes(".onExit");
}

/**
 * Step states in start order. Only pod nodes count (a step that actually ran), and the exit handler is left out: it
 * only reports the outcome and would otherwise show as the "failing" step of a healthy-looking workflow.
 */
export function selectSteps(nodes: WorkflowNodeLike[], workflowName?: string, max: number = DIAGNOSTICS_LIMITS.steps): StepState[] {
  return nodes
    .filter((node) => node.type === "Pod" && !isExitHandlerNode(node))
    .map((node) => {
      const display = node.displayName || (node.name ?? "").split(".").pop() || "unknown";
      const started = Date.parse(node.startedAt ?? "");
      const finished = Date.parse(node.finishedAt ?? "");
      return {
        sortKey: Number.isFinite(started) ? started : Number.MAX_SAFE_INTEGER,
        state: {
          step: workflowName && display === workflowName ? "workflow" : display,
          phase: node.phase ?? "Unknown",
          message: sanitizeMessage(node.message, DIAGNOSTICS_LIMITS.stepMessage),
          seconds: Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, Math.round((finished - started) / 1000)) : null
        } satisfies StepState
      };
    })
    .sort((a, b) => a.sortKey - b.sortKey)
    .slice(0, max)
    .map((entry) => entry.state);
}

/** The step to explain: the earliest failed one (later failures are usually fallout). Null if none failed. */
export function selectFailedStep(steps: StepState[]): StepState | null {
  return steps.find((step) => FAILED_PHASES.has(step.phase)) ?? null;
}

/** The failed pod of a step. Prefers a Failed pod; among several (retries) the newest. */
export function selectFailedPod(pods: PodLike[], step: string, workflowName?: string): string | null {
  const matching = pods
    .filter((pod) => podStep(pod, workflowName) === step && pod.metadata?.name)
    .sort((a, b) => Date.parse(b.metadata?.creationTimestamp ?? "") - Date.parse(a.metadata?.creationTimestamp ?? ""));
  const failed = matching.find((pod) => pod.status?.phase === "Failed") ?? matching[0];
  return failed?.metadata?.name ?? null;
}

// ---- context shape -------------------------------------------------------------------------------------------

export type DiagnosticsContext = {
  publish: null | {
    id: string;
    version: string | null;
    commit: string | null;
    status: string;
    summary: string | null;
    workflowPhase: string | null;
    steps: StepState[];
    failedStep: string | null;
    firstErrorLines: string[];
    logTail: string | null;
    logNote: string | null;
  };
  aggregator: null | { status: string; reachable: boolean | null; lastError: string | null; kitGeneration: number };
  run: null | {
    id: string;
    status: string;
    nvflareJobId: string | null;
    submittedAt: string | null;
    completedAt: string | null;
    events: Array<{ type: string; site: string | null; message: string; at: string }>;
  };
  sites: Array<{
    code: string;
    name: string;
    participation: string;
    observedStatus: string | null;
    observedAt: string | null;
    connected: boolean | null;
    provisioned: boolean;
    kitReleased: boolean;
    /** True when the issued kit was built for a different image than the one live now. Null if unknown. */
    kitMatchesLiveImage: boolean | null;
  }>;
  notes: string[];
  siteSideNote: string;
};

/** Whether a user message is about publishing, runs or sites, so the diagnostics are worth loading. */
export function diagnosticsRelevant(message: string, flagged = false): boolean {
  if (flagged) return true;
  // Phrasing about publish, run or site status only. Ordinary code questions ("add error handling", "log the loss")
  // do not load logs; the failure and site buttons send the explicit flag.
  return (
    /\b(why|what)\b.*\b(publish\w*|runs?|workflow|aggregator|sites?|kits?)\b.*\b(fail\w*|error\w*|stuck|crash\w*|not\s+connect\w*|disconnect\w*|rejected)\b/i.test(message) ||
    /\b(publish|run|workflow|aggregator)\s+(fail\w*|error\w*|log\w*|status|diagnos\w*)\b/i.test(message) ||
    /\b(fail\w*|failed)\s+(publish|run|workflow)\b/i.test(message) ||
    /\bsite\b.*\b(connect\w*|status|kit)\b/i.test(message) ||
    /\b(diagnos\w*|traceback)\b/i.test(message)
  );
}

/** Bound and redact a diagnostics object that may have come from a looser source. Idempotent. */
export function boundDiagnostics(input: DiagnosticsContext): DiagnosticsContext {
  const L = DIAGNOSTICS_LIMITS;
  const log = input.publish?.logTail ? sanitizeLog(input.publish.logTail) : null;
  return {
    publish: input.publish && {
      ...input.publish,
      summary: input.publish.summary === null ? null : sanitizeMessage(input.publish.summary, L.summaryChars),
      steps: input.publish.steps.slice(0, L.steps).map((step) => ({ ...step, message: sanitizeMessage(step.message, L.stepMessage) })),
      firstErrorLines: input.publish.firstErrorLines.slice(0, L.firstErrorLines).map((line) => sanitizeMessage(line, L.lineChars)),
      logTail: log ? log.text : null,
      logNote: input.publish.logNote === null ? null : sanitizeMessage(input.publish.logNote, L.stepMessage)
    },
    aggregator: input.aggregator && { ...input.aggregator, lastError: input.aggregator.lastError === null ? null : sanitizeMessage(input.aggregator.lastError, L.summaryChars) },
    run: input.run && {
      ...input.run,
      events: input.run.events.slice(0, L.events).map((event) => ({ ...event, message: sanitizeMessage(event.message, L.eventMessage) }))
    },
    sites: input.sites.slice(0, L.sites),
    notes: input.notes.slice(0, 10).map((note) => sanitizeMessage(note, L.stepMessage)),
    siteSideNote: SITE_SIDE_NOTE
  };
}

// ---- failure summary for the workspace ------------------------------------------------------------------------

export type FailureSummary = { kind: "publish" | "run"; key: string; title: string; lines: string[] };

/** The system-message content for a failed publish or run: a title and the first error lines. Null if nothing failed. */
export function summarizeFailures(diagnostics: DiagnosticsContext): FailureSummary[] {
  const out: FailureSummary[] = [];
  const publish = diagnostics.publish;
  if (publish && publish.status === "FAILED") {
    const lines = publish.firstErrorLines.length > 0 ? publish.firstErrorLines : publish.summary ? [publish.summary] : [];
    out.push({
      kind: "publish",
      key: `publish:${publish.id}`,
      title: [`Publish`, publish.version, publish.failedStep ? `failed in step "${publish.failedStep}"` : "failed"].filter(Boolean).join(" "),
      lines: lines.slice(0, DIAGNOSTICS_LIMITS.firstErrorLines)
    });
  }
  const run = diagnostics.run;
  if (run && (run.status === "FAILED" || run.status === "REJECTED")) {
    const lines = run.events.filter((event) => event.type === "FAILED" || event.type === "REJECTED" || event.type === "SITE_UPDATE").map((event) => (event.site ? `${event.site}: ${event.message}` : event.message)).filter(Boolean);
    out.push({ kind: "run", key: `run:${run.id}`, title: `Run ${run.status === "REJECTED" ? "was rejected" : "failed"}`, lines: lines.slice(0, DIAGNOSTICS_LIMITS.firstErrorLines) });
  }
  return out;
}
