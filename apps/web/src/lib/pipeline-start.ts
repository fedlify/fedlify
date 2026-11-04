/**
 * Pure logic behind the "Start a pipeline" screen, the pipelines list and the stale-failure notice. No I/O.
 *
 * Imported repositories are untrusted text: everything here only reads file contents as strings (regular
 * expressions and JSON.parse); nothing is executed or imported.
 */

import { isProhibitedDataPath } from "@/lib/data-paths";
import { checkRepoFiles, fileHasSecret, isDataLikePath } from "@/lib/repo-checks";
import { DATA_TYPE_LABELS, TASK_LABELS, profileColumns, type DataType, type FitResult, type FitSite, type TaskKind } from "@/lib/template-fit";

// ---- wizard -------------------------------------------------------------------------------------------------------

export type StartPath = "template" | "assistant" | "import" | "copy";
export const WIZARD_STEPS = ["Source", "Data contract and run defaults", "Name and create"] as const;

export const PATH_LABELS: Record<StartPath, string> = {
  template: "Choose a template",
  assistant: "Describe it to the assistant",
  import: "Bring your own code",
  copy: "Copy a pipeline in this study"
};

export type ContractDraft = {
  label: string;
  positiveValue: string;
  /** JSON type of positiveValue as read from the source, so an unchanged value is written back unchanged. */
  positiveValueType?: "string" | "number";
  features: string[];
  numRounds: number;
  minClients: number;
};

export const DEFAULT_CONTRACT: ContractDraft = { label: "", positiveValue: "", features: [], numRounds: 5, minClients: 2 };

export const NAME_MIN = 3;
export const NAME_MAX = 120;

/** Same bounds the clone route enforces (trimmed, 3 to 120 characters). Null when the name is acceptable. */
export function nameError(name: string): string | null {
  const value = name.trim();
  if (value.length < NAME_MIN) return `Use at least ${NAME_MIN} characters.`;
  if (value.length > NAME_MAX) return `Use at most ${NAME_MAX} characters.`;
  return null;
}

export function contractError(contract: ContractDraft): string | null {
  if (!Number.isInteger(contract.numRounds) || contract.numRounds < 1 || contract.numRounds > 1000) return "Rounds must be a whole number from 1 to 1000.";
  if (!Number.isInteger(contract.minClients) || contract.minClients < 1) return "Min sites must be at least 1.";
  if (contract.label.trim() && contract.features.some((feature) => feature.trim().toLowerCase() === contract.label.trim().toLowerCase())) {
    return "The label cannot also be a feature.";
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The contract and run defaults written in a fedlify-pipeline.json text; null when it is missing or not valid JSON. */
export function contractFromPipelineJson(text: string | null | undefined): ContractDraft | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const config = record(parsed);
  if (!config) return null;
  const contract = record(config.dataContract);
  const defaults = record(config.runtimeDefaults);
  const features = Array.isArray(contract?.features) ? contract.features.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
  const positive = contract?.positiveValue;
  return {
    label: typeof contract?.label === "string" ? contract.label : "",
    positiveValue: typeof positive === "string" || typeof positive === "number" ? String(positive) : "",
    positiveValueType: typeof positive === "number" ? "number" : "string",
    features,
    numRounds: typeof defaults?.numRounds === "number" ? defaults.numRounds : DEFAULT_CONTRACT.numRounds,
    minClients: typeof defaults?.minClients === "number" ? defaults.minClients : DEFAULT_CONTRACT.minClients
  };
}

export function contractsEqual(a: ContractDraft, b: ContractDraft): boolean {
  return (
    a.label.trim() === b.label.trim() &&
    a.positiveValue.trim() === b.positiveValue.trim() &&
    a.numRounds === b.numRounds &&
    a.minClients === b.minClients &&
    a.features.length === b.features.length &&
    a.features.every((feature, index) => feature === b.features[index])
  );
}

/**
 * Merge the wizard's contract into an existing fedlify-pipeline.json text, keeping every other key (name, entrypoint,
 * hyperparameters, ...). A missing or unreadable file yields a minimal valid one. Returns the new file text.
 */
export function applyContractToPipelineJson(existing: string | null | undefined, contract: ContractDraft, name: string, options: { keepBlank?: boolean } = {}): string {
  let config: Record<string, unknown> = {};
  if (existing) {
    try {
      config = record(JSON.parse(existing)) ?? {};
    } catch {
      config = {};
    }
  }
  const base: Record<string, unknown> = { packageType: "fedlify-study-pipeline", schemaVersion: 1, dataBoundary: "site-only", ...config };
  const previous = record(base.dataContract) ?? {};
  // With keepBlank (the source's contract was unreadable in the wizard), an empty label or feature list keeps what the file has.
  const dataContract: Record<string, unknown> = { ...previous };
  if (!options.keepBlank || contract.label.trim()) dataContract.label = contract.label.trim();
  if (!options.keepBlank || contract.features.length > 0) dataContract.features = contract.features;
  const positive = contract.positiveValue.trim();
  if (positive) {
    const asNumber = Number(positive);
    // Keep a numeric positiveValue numeric when the text still reads as the same number.
    (dataContract as Record<string, unknown>).positiveValue = contract.positiveValueType === "number" && Number.isFinite(asNumber) ? asNumber : positive;
  }
  else if (!options.keepBlank) delete (dataContract as Record<string, unknown>).positiveValue;
  const next = {
    ...base,
    name: typeof base.name === "string" && base.name ? base.name : name.trim(),
    dataContract,
    runtimeDefaults: { ...(record(base.runtimeDefaults) ?? {}), numRounds: contract.numRounds, minClients: contract.minClients }
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

export type FeatureCell = "listed" | "missing" | "unknown";
export type FeatureRow = { name: string; bySite: Record<string, FeatureCell> };

/**
 * Candidate features with per-site availability. Candidates are the template's contract features plus every column
 * a site profile lists. A site whose profile lists no columns is "unknown" for every feature: nothing is guessed.
 */
export function featureAvailability(contractFeatures: string[], sites: FitSite[], limit = 120): FeatureRow[] {
  const columns = new Map(sites.map((site) => [site.code, profileColumns(site.dataProfile)?.map((name) => name.toLowerCase())]));
  const seen = new Set<string>();
  const names: string[] = [];
  const add = (name: string) => {
    const key = name.toLowerCase();
    if (!name.trim() || seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };
  contractFeatures.forEach(add);
  for (const site of sites) (profileColumns(site.dataProfile) ?? []).forEach(add);
  return names.slice(0, limit).map((name) => ({
    name,
    bySite: Object.fromEntries(
      sites.map((site) => {
        const list = columns.get(site.code);
        return [site.code, list ? (list.includes(name.toLowerCase()) ? "listed" : "missing") : "unknown"] as const;
      })
    )
  }));
}

/** Features every site that lists columns has (empty when no site lists any). Used when a source has no contract. */
export function intersectionFeatures(sites: FitSite[]): string[] {
  const lists = sites.map((site) => profileColumns(site.dataProfile)).filter((list): list is string[] => Boolean(list));
  if (lists.length === 0) return [];
  const [first, ...rest] = lists;
  return first.filter((name) => rest.every((list) => list.some((other) => other.toLowerCase() === name.toLowerCase())));
}

/** A commit id (abbreviated or full). Gitea's branch endpoint takes branch names only, so commits are read directly. */
export function isCommitRef(ref: string | undefined): ref is string {
  return Boolean(ref && /^[0-9a-f]{7,64}$/i.test(ref));
}

// ---- templates ----------------------------------------------------------------------------------------------------

const FIT_ORDER: Record<FitResult, number> = { fits: 0, partial: 1, different: 2 };
export const FIT_LABELS: Record<FitResult, string> = { fits: "fits", partial: "partial fit", different: "different" };

/** Best fit first; ties keep their incoming order (the catalog's own ordering). */
export function sortByFit<T extends { fit: FitResult }>(items: T[]): T[] {
  return items.map((item, index) => ({ item, index })).sort((a, b) => FIT_ORDER[a.item.fit] - FIT_ORDER[b.item.fit] || a.index - b.index).map(({ item }) => item);
}

// ---- template browser: search, filter, sort, paginate (pure) ---------------------------------------------------------

export const TEMPLATE_PAGE_SIZE = 10;

/** What the template browser needs to know about one template. */
export type BrowseFields = {
  name: string;
  algorithm: string | null;
  task: TaskKind | null;
  dataType: DataType | null;
  /** False when the template cannot be cloned (no approved version or no reviewable source). */
  available: boolean;
  fit: FitResult;
};

export type BrowseOptions = { query?: string; task?: TaskKind | "all"; dataType?: DataType | "all"; showUnavailable?: boolean };

/** Every word of the query must appear in the name, algorithm, task or data type (keys and labels), ignoring case. */
export function matchesQuery(item: BrowseFields, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [
    item.name,
    item.algorithm ?? "",
    item.task ? `${item.task} ${item.task.replace(/_/g, " ")} ${TASK_LABELS[item.task]}` : "",
    item.dataType ? `${item.dataType} ${item.dataType.replace(/_/g, " ")} ${DATA_TYPE_LABELS[item.dataType]}` : ""
  ]
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Search and the task / data type filters. Availability is not applied here. */
export function filterTemplates<T extends BrowseFields>(items: T[], options: BrowseOptions): T[] {
  const { query = "", task = "all", dataType = "all" } = options;
  return items.filter((item) => (task === "all" || item.task === task) && (dataType === "all" || item.dataType === dataType) && matchesQuery(item, query));
}

/** Available templates first, then best fit first; ties keep their incoming order. */
export function sortTemplates<T extends BrowseFields>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => Number(!a.item.available) - Number(!b.item.available) || FIT_ORDER[a.item.fit] - FIT_ORDER[b.item.fit] || a.index - b.index)
    .map(({ item }) => item);
}

/** Search, filter and sort. Unavailable templates are dropped unless asked for; `unavailableCount` is how many matched but were hidden or shown as unavailable. */
export function browseTemplates<T extends BrowseFields>(items: T[], options: BrowseOptions): { rows: T[]; unavailableCount: number } {
  const matched = filterTemplates(items, options);
  const unavailableCount = matched.filter((item) => !item.available).length;
  return { rows: sortTemplates(options.showUnavailable ? matched : matched.filter((item) => item.available)), unavailableCount };
}

export type Page<T> = { items: T[]; page: number; pageCount: number; total: number; from: number; to: number };

/** One page of a list. `page` is 1-based and clamped, so a stale page number after a filter change is safe. */
export function paginate<T>(items: T[], page: number, pageSize = TEMPLATE_PAGE_SIZE): Page<T> {
  const size = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (current - 1) * size;
  const slice = items.slice(start, start + size);
  return { items: slice, page: current, pageCount, total: items.length, from: slice.length ? start + 1 : 0, to: start + slice.length };
}

/** The recommendation: the first available template whose fit is genuinely "fits", otherwise none. Expects fit-sorted input. */
export function recommendedMatch<T extends BrowseFields>(items: T[]): T | null {
  return items.find((item) => item.available && item.fit === "fits") ?? null;
}

/** Owner and repository of a Gitea repository URL, or null if it does not look like one (also rejects odd characters). */
export function parseRepoUrl(url: string | null | undefined): { owner: string; repo: string } | null {
  if (!url) return null;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const [owner, repo, ...rest] = pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  const part = /^[A-Za-z0-9_.-]{1,100}$/;
  if (!owner || !repo || rest.length > 0 || !part.test(owner) || !part.test(repo)) return null;
  return { owner, repo };
}

// ---- pipelines list -----------------------------------------------------------------------------------------------

export type ListVersion = { id: string; version: string; gitCommit: string | null; publishedAt?: string | null; validationStatus: string; publish: { status: string } | null };
export type ListProject = {
  id: string;
  name: string;
  versions: ListVersion[];
  sourceKind?: "template" | "assistant" | "import" | "copy" | null;
  sourceRef?: string | null;
  parentProjectId?: string | null;
  parentVersion?: string | null;
};
export type ListJob = { id: string; status: string; createdAt: string; pipelineVersion: { id: string; version: string } | null };

export type PipelineRow = {
  id: string;
  name: string;
  source: string;
  latestVersion: string | null;
  state: string;
  live: boolean;
  liveVersion: string | null;
  lastRun: { status: string; at: string; version: string | null } | null;
  lineage: string | null;
};

const SOURCE_LABELS = { template: "Template", assistant: "Assistant", import: "Imported", copy: "Copy" } as const;

/** Versions arrive newest first from the overview; the first one is the latest. */
export function pipelineRows(projects: ListProject[], liveVersionId: string | null | undefined, jobs: ListJob[]): PipelineRow[] {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  return projects.map((project) => {
    const latest = project.versions[0] ?? null;
    const live = project.versions.find((version) => version.id === liveVersionId) ?? null;
    const versionIds = new Set(project.versions.map((version) => version.id));
    const job = jobs.find((item) => item.pipelineVersion && versionIds.has(item.pipelineVersion.id)) ?? null;
    const kind = project.sourceKind ?? "template";
    const parentName = project.parentProjectId ? names.get(project.parentProjectId) : null;
    const lineage =
      kind === "copy" || project.parentProjectId
        ? `forked from ${parentName ?? "a deleted pipeline"}${project.parentVersion ? ` ${project.parentVersion}` : ""}`
        : project.sourceRef && kind === "template"
          ? `from ${project.sourceRef}`
          : null;
    return {
      id: project.id,
      name: project.name,
      source: SOURCE_LABELS[kind],
      latestVersion: latest?.version ?? null,
      state: latest ? (latest.publish?.status ?? latest.validationStatus) : "Not published",
      live: Boolean(live),
      liveVersion: live?.version ?? null,
      lastRun: job ? { status: job.status, at: job.createdAt, version: job.pipelineVersion?.version ?? null } : null,
      lineage
    };
  });
}

// ---- stale failure notice -----------------------------------------------------------------------------------------

const sameCommit = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a)));

/** True when a publish failed for `failedCommit` and the saved head has since moved on to a different commit. */
export function failureIsStale(failedCommit: string | null | undefined, head: string | null | undefined): boolean {
  if (!failedCommit || !head) return false;
  return !sameCommit(failedCommit, head);
}

// ---- alignment report ---------------------------------------------------------------------------------------------

export type AlignmentFinding = { id: string; message: string; paths: string[] };
export type AlignmentReport = { fileCount: number; blocking: AlignmentFinding[]; advisory: AlignmentFinding[]; checked: string[] };

export type RepoFile = { path: string; content: string };

/**
 * Compare a repository's files with the publish rules (repo-checks.ts, a port of validate_repo.py) and the Fedlify
 * contract in AGENTS.md. Every rule that makes CI fail is blocking. Findings name files, never the matched text, so a
 * secret found in an upload is not echoed back to the screen. This is a preview only: the server must re-check.
 */
export function alignmentReport(files: RepoFile[]): AlignmentReport {
  const blocking: AlignmentFinding[] = [];
  const advisory: AlignmentFinding[] = [];
  const py = files.filter((file) => file.path.endsWith(".py"));
  const finding = (list: AlignmentFinding[], id: string, message: string, paths: string[] = []) => list.push({ id, message, paths: paths.slice(0, 8) });

  const dataFiles = files.filter((file) => isDataLikePath(file.path) || isProhibitedDataPath(file.path)).map((file) => file.path);
  if (dataFiles.length > 0) finding(blocking, "data-files", "Data-like files are not allowed in a pipeline repository; publish rejects them.", dataFiles);

  const secrets = files.filter((file) => fileHasSecret(file.path, file.content)).map((file) => file.path);
  if (secrets.length > 0) finding(blocking, "secrets", "Looks like a credential is committed in these files. Remove it and rotate it.", secrets);

  // Required files, size, packageType, entrypoint, label and features, launcher path and pinned requirements.
  const labels: Record<string, string> = { layout: "Required files", contract: "Pipeline file", launcher: "Launcher", requirements: "Requirements" };
  for (const check of checkRepoFiles(files).checks) {
    if (check.status !== "fail" || !(check.id in labels)) continue;
    const shown = check.errors.slice(0, 6).join("; ");
    finding(blocking, check.id, `${labels[check.id]} (publish rejects this): ${shown}${check.errors.length > 6 ? `; and ${check.errors.length - 6} more` : ""}.`);
  }

  const loop = py.find((file) => /\bflare\.init\s*\(/.test(file.content) && /\bis_running\s*\(/.test(file.content) && /\bflare\.send\s*\(/.test(file.content) && /\bflare\.receive\s*\(/.test(file.content));
  if (!loop) finding(blocking, "client-loop", "No training loop follows the Client API: flare.init(), then while flare.is_running(): receive, train, send.");

  const network = py.filter((file) => /\b(requests\.(get|post|put|delete)|urllib\.request|socket\.socket|httpx\.|aiohttp\.)/.test(file.content)).map((file) => file.path);
  if (network.length > 0) finding(blocking, "network", "Outbound network calls are not allowed; sites only talk to the aggregator through NVFLARE.", network);

  const fixedData = py
    .filter((file) => /(read_csv|read_parquet|open)\(\s*["'][^"']+\.(csv|parquet)["']/.test(file.content) && !/FEDLIFY_DATA_PATH/.test(file.content))
    .map((file) => file.path);
  if (fixedData.length > 0) finding(blocking, "data-path", "Reads data from a fixed path instead of FEDLIFY_DATA_PATH.", fixedData);

  if (!files.some((file) => /^tests\/.+\.py$/.test(file.path))) finding(advisory, "tests", "No unit tests under tests/; they run on synthetic rows at publish time.");
  if (!files.some((file) => file.path === "AGENTS.md")) finding(advisory, "agents-md", "No AGENTS.md; the assistant works better with the Fedlify contract written down.");

  return {
    fileCount: files.length,
    blocking,
    advisory,
    checked: ["required files", "data files", "secrets", "fedlify-pipeline.json contract", "launcher path", "pinned requirements", "Client API loop", "network calls", "data path", "tests"]
  };
}

/**
 * Files sent to the server: data-like files are dropped here (the server drops them too). Credential-bearing files are
 * sent on purpose, so the server's refusal applies exactly as it does for a Git import instead of silently omitting them.
 */
export function importableFiles(files: RepoFile[]): RepoFile[] {
  return files.filter((file) => !isProhibitedDataPath(file.path) && !isDataLikePath(file.path));
}

/** The request sent as a proposal for an import: bring it in line with the Fedlify contract, using the server's report. */
export function importProposalPrompt(report: AlignmentReport | null): string {
  const lines = [...(report?.blocking ?? []), ...(report?.advisory ?? [])].slice(0, 12).map((finding) => `- ${finding.message}${finding.paths.length ? ` (${finding.paths.slice(0, 4).join(", ")})` : ""}`);
  return [
    "This repository was imported from existing code. Propose the edits that make it follow the Fedlify contract in AGENTS.md: the NVFLARE Client API loop, the launcher path, no data files or fixed data paths, pinned requirements, and the data contract in fedlify-pipeline.json.",
    lines.length ? `The alignment report found:\n${lines.join("\n")}` : "The alignment report found nothing blocking; propose only what is still needed.",
    "Keep the existing model and training logic. Change only repository files."
  ].join("\n\n");
}

// ---- zip import limits (the server applies the same limits again) ----------------------------------------------

export const IMPORT_LIMITS = { maxFiles: 200, maxFileBytes: 512 * 1024, maxZipBytes: 10 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 } as const;

/** Whether a zip entry path is safe to keep: relative, inside the repo, not .git, no empty or ".." parts. */
export function safeImportPath(path: string): boolean {
  if (!path || path.length > 300 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return !path.split("/").some((part) => part === ".." || part === "" || part === "." || part === ".git");
}

/** Zip metadata that is not part of the project: macOS resource forks and Finder files. */
export function isZipJunk(path: string): boolean {
  return path.split("/").some((part) => part === "__MACOSX" || part === ".DS_Store");
}

const WRAPPER_NOT_ALLOWED = new Set(["job", "tests", "test", "src", "app", "config", "custom", "docs"]);

/**
 * Strip the single top-level folder most zips carry (`repo-main/...`) when every entry shares it. Junk entries must be
 * removed first (see isZipJunk). A lone folder named like a repo part (job/, tests/, ...) is kept: it is not a wrapper.
 */
export function stripCommonRoot(paths: string[]): string[] {
  if (paths.length === 0) return paths;
  const roots = new Set(paths.map((path) => path.split("/")[0]));
  if (roots.size !== 1 || paths.some((path) => !path.includes("/"))) return paths;
  if (WRAPPER_NOT_ALLOWED.has([...roots][0].toLowerCase())) return paths;
  return paths.map((path) => path.split("/").slice(1).join("/"));
}
