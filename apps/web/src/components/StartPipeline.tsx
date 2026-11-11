"use client";

import { AppstoreOutlined, ArrowLeftOutlined, CheckCircleFilled, CloseCircleFilled, CopyOutlined, ExclamationCircleFilled, MessageOutlined, QuestionCircleOutlined, SearchOutlined, UploadOutlined } from "@ant-design/icons";
import { Alert, Button, Checkbox, Collapse, Empty, Input, InputNumber, Pagination, Radio, Select, Space, Spin, Table, Tag, Typography, Upload } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DATA_TYPE_LABELS,
  TASK_LABELS,
  computeTemplateFit,
  orderedFitReasons,
  shortFitReason,
  templateTraits,
  type DataType,
  type FitReport,
  type FitSite,
  type FitStudy,
  type TaskKind,
  type TemplateTraits
} from "@/lib/template-fit";
import {
  DEFAULT_CONTRACT,
  FIT_LABELS,
  IMPORT_LIMITS,
  NAME_MAX,
  PATH_LABELS,
  TEMPLATE_PAGE_SIZE,
  WIZARD_STEPS,
  alignmentReport,
  applyContractToPipelineJson,
  browseTemplates,
  contractError,
  contractFromPipelineJson,
  featureAvailability,
  intersectionFeatures,
  nameError,
  paginate,
  parseRepoUrl,
    safeImportPath,
  isZipJunk,
  importableFiles,
  importProposalPrompt,
  stripCommonRoot,
  type AlignmentReport,
  type ContractDraft,
  type ListJob,
  type ListProject,
  type RepoFile,
  type StartPath
} from "@/lib/pipeline-start";
import { StatusTag } from "@/components/StatusTag";
import { formatDate as formatDateValue } from "@/lib/format";
import { isProhibitedDataPath } from "@/lib/data-paths";
import { ApiError, apiCall } from "@/lib/web-api";

export type StartProject = ListProject & { giteaRepoUrl: string | null };
export type CreatedPipeline = { projectId: string; warning?: string; startPrompt?: { text: string; mode: "ask" | "propose" } };

type Props = {
  studyId: string;
  projects: StartProject[];
  liveVersionId: string | null;
  jobs: ListJob[];
  /** Path to open first, e.g. "copy" from a row's Copy button. */
  initialPath?: StartPath | null;
  initialCopyProjectId?: string | null;
  /** Set when the study already has pipelines; the screen then shows a way back. */
  onCancel?: () => void;
  onCreated: (created: CreatedPipeline) => void;
};

type StudyContext = { fitStudy: FitStudy; sites: FitSite[] };

type TemplateCard = {
  key: string;
  name: string;
  description: string | null;
  /** Clone source; undefined means the Fedlify starter, which the clone route uses by default. */
  source?: { owner: string; repo: string; ref?: string };
  version: string | null;
  validation: string | null;
  validatedAt: string | null;
  traits: TemplateTraits;
  /** Name-based traits, never replaced by the lazy source read: the list's fit, sort and filters use these so rows do not move under the user. */
  listTraits: TemplateTraits;
  /** Text of fedlify-pipeline.json when it could be read; used to prefill step 2. */
  pipelineJson: string | null;
  scope: string;
  blockedReason: string | null;
};

type CatalogTemplate = {
  id: string;
  name: string;
  description: string | null;
  scope: string;
  version: string;
  spec: unknown;
  giteaOwner: string | null;
  giteaRepo: string | null;
  currentApprovedVersion: { version: string; gitCommit: string; validationStatus: string; approvalStatus: string; updatedAt: string } | null;
};

const STARTER_DESCRIPTION = "Fedlify starter: FedAvg logistic regression on tabular EHR data, binary classification (NVFLARE Client API).";
const FIT_TONE = { fits: "success", partial: "warning", different: "neutral" } as const;
const GIT_URL = /^https:\/\/[^\s/]+\/[^\s]+$/;

function cardFromCatalog(template: CatalogTemplate): TemplateCard {
  const approved = template.currentApprovedVersion;
  const cloneable = Boolean(template.giteaOwner && template.giteaRepo && approved && !approved.gitCommit.startsWith("legacy-seed-"));
  return {
    key: template.id,
    name: template.name,
    description: template.description,
    source: cloneable ? { owner: template.giteaOwner!, repo: template.giteaRepo!, ref: approved!.gitCommit } : undefined,
    version: approved?.version ?? template.version,
    validation: approved?.validationStatus ?? null,
    validatedAt: approved?.updatedAt ?? null,
    traits: templateTraits({ name: template.name, description: template.description, pipelineJson: null }),
    listTraits: templateTraits({ name: template.name, description: template.description, pipelineJson: null }),
    pipelineJson: null,
    scope: template.scope,
    blockedReason: cloneable ? null : approved ? "No reviewable source repository." : "No approved version yet."
  };
}

function starterCard(): TemplateCard {
  return {
    key: "starter",
    name: "Fedlify starter",
    description: STARTER_DESCRIPTION,
    version: null,
    validation: null,
    validatedAt: null,
    traits: templateTraits({ name: "Fedlify starter", description: STARTER_DESCRIPTION, pipelineJson: null }),
    listTraits: templateTraits({ name: "Fedlify starter", description: STARTER_DESCRIPTION, pipelineJson: null }),
    pipelineJson: null,
    scope: "PUBLIC_TEMPLATE",
    blockedReason: null
  };
}

function FitBadge({ report, provisional }: { report: FitReport; provisional?: boolean }) {
  return (
    <StatusTag tone={FIT_TONE[report.fit]} data-fit={report.fit} data-testid="fit-badge" title={provisional ? "First guess from the template's name. Select the template to read its source." : undefined} label={FIT_LABELS[report.fit]} />
  );
}

const PATH_CARDS: Array<{ path: StartPath; icon: React.ReactNode; sentence: string }> = [
  { path: "template", icon: <AppstoreOutlined />, sentence: "Start from an approved template." },
  { path: "assistant", icon: <MessageOutlined />, sentence: "Describe what you want in your own words." },
  { path: "import", icon: <UploadOutlined />, sentence: "Upload a zip or point to a Git repository." },
  { path: "copy", icon: <CopyOutlined />, sentence: "Reuse a pipeline from this study." }
];

type RankedTemplate = {
  card: TemplateCard;
  report: FitReport;
  fit: FitReport["fit"];
  name: string;
  algorithm: string | null;
  task: TemplateTraits["task"];
  dataType: TemplateTraits["dataType"];
  available: boolean;
};

function rowSummary(card: TemplateCard) {
  const parts = [card.traits.algorithm, card.traits.task ? TASK_LABELS[card.traits.task] : null].filter(Boolean);
  return parts.length ? parts.join(" \u00b7 ") : "Details unknown";
}

function formatDate(value: string | null) {
  return value ? formatDateValue(value) : null;
}

function AlignmentView({ report }: { report: AlignmentReport }) {
  return (
    <div className="fedlify-start-report" data-testid="alignment-report" role="region" aria-label="Alignment report">
      <strong>
        Alignment report: {report.fileCount} file{report.fileCount === 1 ? "" : "s"}, {report.blocking.length} blocking, {report.advisory.length} advisory
      </strong>
      {report.blocking.length === 0 && report.advisory.length === 0 ? (
        <div className="fedlify-start-finding is-ok"><CheckCircleFilled /> Nothing found. Checked: {report.checked.join(", ")}.</div>
      ) : null}
      {report.blocking.map((item) => (
        <div key={item.id} className="fedlify-start-finding is-blocking" data-testid="finding-blocking">
          <CloseCircleFilled /> <span><b>Blocking.</b> {item.message}{item.paths.length > 0 ? <> <code>{item.paths.join(", ")}</code></> : null}</span>
        </div>
      ))}
      {report.advisory.map((item) => (
        <div key={item.id} className="fedlify-start-finding is-advisory" data-testid="finding-advisory">
          <ExclamationCircleFilled /> <span><b>Advisory.</b> {item.message}{item.paths.length > 0 ? <> <code>{item.paths.join(", ")}</code></> : null}</span>
        </div>
      ))}
      <Typography.Text type="secondary" className="fedlify-start-note">
        The files were only read as text. Nothing from this repository is run by Fedlify.
      </Typography.Text>
    </div>
  );
}

export function StartPipeline({ studyId, projects, liveVersionId, jobs, initialPath, initialCopyProjectId, onCancel, onCreated }: Props) {
  const [context, setContext] = useState<StudyContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [cards, setCards] = useState<TemplateCard[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [path, setPath] = useState<StartPath>(initialPath ?? "template");
  // Step 1 shows only the four choices until one is picked (or a row's Copy button asked for a path).
  const [picked, setPicked] = useState(Boolean(initialPath));
  const [templateKey, setTemplateKey] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<TaskKind | "all">("all");
  const [typeFilter, setTypeFilter] = useState<DataType | "all">("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [sourceStatus, setSourceStatus] = useState<Record<string, "loading" | "done" | "failed">>({});
  const [description, setDescription] = useState("");
  const [baseKey, setBaseKey] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<"git" | "zip">("zip");
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [importFiles, setImportFiles] = useState<RepoFile[] | null>(null);
  const [importReport, setImportReport] = useState<AlignmentReport | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [ackBlocking, setAckBlocking] = useState(false);
  const [copyId, setCopyId] = useState<string | null>(initialCopyProjectId ?? projects[0]?.id ?? null);
  const [copyVersionId, setCopyVersionId] = useState<string>("head");
  const [contract, setContract] = useState<ContractDraft>(DEFAULT_CONTRACT);
  const [touched, setTouched] = useState(false);
  // False when the source's own contract could not be read; the draft is then empty and blank fields keep the source's values.
  const [contractKnown, setContractKnown] = useState(true);
  const [prefillNote, setPrefillNote] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const prefillSeq = useRef(0);
  const requestedSource = useRef(new Set<string>());

  // Study protocol and sites' data profiles: the evidence the fit badge and the feature table use.
  useEffect(() => {
    let cancelled = false;
    void apiCall<{
      study: {
        dataModalities?: string | null;
        primaryOutcome?: string | null;
        primaryEndpointDetails?: string | null;
        studySites?: Array<{ code: string; name: string; dataProfile?: { modality?: string | null; datasetDescription?: string | null } | null }>;
      };
    }>(`/api/v1/studies/${studyId}`)
      .then((body) => {
        if (cancelled) return;
        setContext({
          fitStudy: { dataModalities: body.study.dataModalities, primaryOutcome: body.study.primaryOutcome, primaryEndpointDetails: body.study.primaryEndpointDetails },
          sites: (body.study.studySites ?? []).map((site) => ({ code: site.code, name: site.name, dataProfile: site.dataProfile ?? null }))
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setContextError(error instanceof Error ? error.message : "Could not read the study.");
        setContext({ fitStudy: {}, sites: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [studyId]);

  // Approved templates (public catalog and this study's): one request. A template's own source is read only when it is selected.
  useEffect(() => {
    let cancelled = false;
    void apiCall<{ templates: CatalogTemplate[] }>(`/api/v1/pipeline-templates?scope=all&studyId=${encodeURIComponent(studyId)}`)
      .then((body) => {
        if (cancelled) return;
        const fromCatalog = body.templates.map(cardFromCatalog);
        const hasStarter = fromCatalog.some((card) => card.source?.repo === "fedlify-starter");
        setCards(hasStarter ? fromCatalog : [starterCard(), ...fromCatalog]);
      })
      .catch((error) => {
        if (cancelled) return;
        setCatalogError(error instanceof Error ? error.message : "Could not load the template catalog.");
        setCards([starterCard()]);
      });
    return () => {
      cancelled = true;
    };
  }, [studyId]);

  // Read the selected template's fedlify-pipeline.json once, for its declared traits and to prefill step 2.
  useEffect(() => {
    if (!picked || path !== "template" || !templateKey || requestedSource.current.has(templateKey)) return;
    const card = cards?.find((item) => item.key === templateKey);
    if (!card?.source || card.key === "starter") return;
    const id = card.key;
    requestedSource.current.add(id);
    setSourceStatus((current) => ({ ...current, [id]: "loading" }));
    void apiCall<{ files: Array<{ path: string; content: string }> }>(`/api/v1/pipeline-templates/${id}/source`)
      .then((source) => {
        const file = source.files.find((item) => item.path === "fedlify-pipeline.json");
        let parsed: unknown = null;
        try {
          parsed = file ? JSON.parse(file.content) : null;
        } catch {
          parsed = null;
        }
        if (file && parsed) {
          setCards((current) => current?.map((item) => (item.key === id ? { ...item, pipelineJson: file.content, traits: templateTraits({ name: item.name, description: item.description, pipelineJson: parsed }) } : item)) ?? current);
        }
        if (!(file && parsed)) requestedSource.current.delete(id);
        setSourceStatus((current) => ({ ...current, [id]: file && parsed ? "done" : "failed" }));
      })
      .catch(() => {
        // Forget the request so Retry (or selecting the template again) can read it once more.
        requestedSource.current.delete(id);
        setSourceStatus((current) => ({ ...current, [id]: "failed" }));
      });
  }, [picked, path, templateKey, cards, retryTick]);

  const ranked = useMemo<RankedTemplate[]>(() => {
    if (!cards || !context) return [];
    return cards.map((card) => {
      const report = computeTemplateFit(context.fitStudy, context.sites, card.listTraits);
      return { card, report, fit: report.fit, name: card.name, algorithm: card.listTraits.algorithm, task: card.listTraits.task, dataType: card.listTraits.dataType, available: !card.blockedReason };
    });
  }, [cards, context]);

  const browse = useMemo(() => browseTemplates(ranked, { query, task: taskFilter, dataType: typeFilter, showUnavailable }), [ranked, query, taskFilter, typeFilter, showUnavailable]);
  const pageInfo = paginate(browse.rows, page, TEMPLATE_PAGE_SIZE);
  const filtersActive = query.trim() !== "" || taskFilter !== "all" || typeFilter !== "all";
  // The assistant starts from the best available template unless "Advanced" picks another.
  const bestAvailableKey = useMemo(() => browseTemplates(ranked, {}).rows[0]?.card.key ?? null, [ranked]);
  const effectiveBaseKey = baseKey ?? bestAvailableKey;

  const selectedCard = (key: string | null) => ranked.find(({ card }) => card.key === key)?.card ?? null;
  const copyProject = projects.find((project) => project.id === copyId) ?? null;
  const copyRepo = parseRepoUrl(copyProject?.giteaRepoUrl);

  // ---- import ----------------------------------------------------------------------------------------------------

  async function readZip(file: File): Promise<false> {
    setImportError(null);
    setImportReport(null);
    setImportFiles(null);
    setAckBlocking(false);
    if (file.size > IMPORT_LIMITS.maxZipBytes) {
      setImportError(`The zip is larger than ${IMPORT_LIMITS.maxZipBytes / 1024 / 1024} MB.`);
      return false;
    }
    setImportBusy(true);
    try {
      const { default: JSZip } = await import("jszip");
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      // macOS resource forks and Finder files are dropped before the wrapper folder is worked out.
      const entries = Object.values(zip.files).filter((entry) => !entry.dir && !isZipJunk(entry.name));
      if (entries.length > IMPORT_LIMITS.maxFiles * 5) throw new Error("The zip has too many entries.");
      let inflated = 0;
      const roots = stripCommonRoot(entries.map((entry) => entry.name));
      const files: RepoFile[] = [];
      const skipped: string[] = [];
      for (let index = 0; index < entries.length; index += 1) {
        const entryPath = roots[index];
        if (!safeImportPath(entryPath)) {
          skipped.push(entries[index].name);
          continue;
        }
        // Data-like files are listed in the report by path but their content is never read or kept.
        if (isProhibitedDataPath(entryPath)) {
          files.push({ path: entryPath, content: "" });
          continue;
        }
        // Never inflate more than the per-file limit: the declared size is checked first, and the stream is
        // aborted at the limit in case the header lies. The total of inflated bytes has its own budget.
        const bytes = await inflateWithin(entries[index], IMPORT_LIMITS.maxFileBytes);
        if (!bytes) {
          skipped.push(entryPath);
          continue;
        }
        inflated += bytes.byteLength;
        if (inflated > IMPORT_LIMITS.maxTotalBytes) throw new Error(`The zip expands to more than ${IMPORT_LIMITS.maxTotalBytes / 1024 / 1024} MB of text.`);
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          skipped.push(entryPath);
          continue;
        }
        files.push({ path: entryPath, content: text });
      }
      if (files.length === 0) throw new Error("The zip has no readable text files.");
      if (files.length > IMPORT_LIMITS.maxFiles) throw new Error(`The zip has more than ${IMPORT_LIMITS.maxFiles} files.`);
      setImportFiles(files);
      setImportReport(alignmentReport(files));
      if (skipped.length > 0) setImportError(`${skipped.length} entr${skipped.length === 1 ? "y was" : "ies were"} skipped (unsafe path, binary, or over 512 KB): ${skipped.slice(0, 4).join(", ")}${skipped.length > 4 ? ", ..." : ""}.`);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not read the zip.");
    } finally {
      setImportBusy(false);
    }
    return false;
  }

  async function checkGit() {
    setImportBusy(true);
    setImportError(null);
    setImportReport(null);
    setAckBlocking(false);
    try {
      const body = await apiCall<{ report: AlignmentReport }>(`/api/v1/studies/${studyId}/pipeline-projects/import`, {
        method: "POST",
        body: JSON.stringify({ kind: "git", url: gitUrl.trim(), ref: gitRef.trim() || undefined, dryRun: true })
      });
      setImportReport(body.report);
    } catch (error) {
      setImportError(importUnavailable(error) ?? (error instanceof Error ? error.message : "Could not check the repository."));
    } finally {
      setImportBusy(false);
    }
  }

  // ---- step 1 -> 2: prefill the contract from the chosen source --------------------------------------------------

  const sourceReady =
    path === "template"
      ? Boolean(selectedCard(templateKey) && !selectedCard(templateKey)?.blockedReason)
      : path === "assistant"
        ? description.trim().length >= 20 && Boolean(selectedCard(effectiveBaseKey))
        : path === "import"
          ? importMode === "zip"
            ? Boolean(importFiles && importReport)
            : GIT_URL.test(gitUrl.trim()) && Boolean(importReport)
          : Boolean(copyProject && copyRepo);
  const blockingFound = path === "import" && (importReport?.blocking.length ?? 0) > 0;
  // The server refuses any import with a credential in it, so acknowledging cannot get past that finding.
  const secretsFound = path === "import" && (importReport?.blocking.some((item) => item.id === "secrets") ?? false);
  const canContinue = sourceReady && !secretsFound && (!blockingFound || ackBlocking);

  async function goToContract() {
    if (advancing) return;
    setAdvancing(true);
    try {
      await prefillContract();
    } finally {
      setAdvancing(false);
    }
  }

  async function prefillContract() {
    const seq = ++prefillSeq.current;
    setTouched(false);
    setPrefillNote(null);
    let json: string | null = null;
    let note: string | null = null;
    if (path === "template" || path === "assistant") {
      const card = selectedCard(path === "template" ? templateKey : effectiveBaseKey);
      json = card?.pipelineJson ?? null;
      if (!json && card && card.key !== "starter" && card.source) {
        try {
          const source = await apiCall<{ files: Array<{ path: string; content: string }> }>(`/api/v1/pipeline-templates/${card.key}/source`);
          json = source.files.find((file) => file.path === "fedlify-pipeline.json")?.content ?? null;
        } catch {
          json = null;
        }
      }
      note = json ? `Prefilled from ${card?.name}.` : `${card?.name ?? "The template"} keeps the original pipeline's settings unless you change it here.`;
    } else if (path === "import") {
      json = importFiles?.find((file) => file.path === "fedlify-pipeline.json")?.content ?? null;
      note = json ? "Prefilled from the fedlify-pipeline.json in the import." : "The import has no readable data contract yet; fill it in to write one.";
    } else if (copyProject) {
      if (copyVersionId === "head") {
        try {
          const source = await apiCall<{ files: Array<{ path: string; content: string }> }>(`/api/v1/studies/${studyId}/pipeline-projects/${copyProject.id}/source`);
          json = source.files.find((file) => file.path === "fedlify-pipeline.json")?.content ?? null;
        } catch {
          json = null;
        }
        note = json ? `Prefilled from the latest saved code of ${copyProject.name}.` : null;
      } else {
        note = "Copying a published version keeps that version's contract unless you change it here.";
      }
    }
    if (seq !== prefillSeq.current) return;
    const fromJson = contractFromPipelineJson(json);
    const sites = context?.sites ?? [];
    setContractKnown(Boolean(fromJson));
    setContract(fromJson ?? { ...DEFAULT_CONTRACT, features: intersectionFeatures(sites), minClients: Math.max(1, Math.min(2, sites.length || 1)) });
    setPrefillNote(note);
    setName((current) => current || defaultName());
    setStep(1);
  }

  function defaultName() {
    if (path === "copy" && copyProject) return `${copyProject.name} v2`;
    if (path === "import" && gitUrl) return parseRepoUrl(gitUrl)?.repo ?? "";
    return "";
  }

  const featureRows = useMemo(() => featureAvailability(contract.features, context?.sites ?? []), [contract.features, context]);
  const sites = context?.sites ?? [];
  const contractProblem = touched && contractKnown
    ? !contract.label.trim()
      ? "Set the label column, or go back and leave the contract untouched to keep the source's own."
      : contract.features.length === 0
        ? "Select at least one feature."
        : contractError(contract)
    : contractError(contract);

  function edit(patch: Partial<ContractDraft>) {
    setTouched(true);
    setContract((current) => ({ ...current, ...patch }));
  }

  // ---- create ----------------------------------------------------------------------------------------------------

  async function create(options: { propose?: boolean } = {}) {
    const problem = nameError(name);
    if (problem) return setCreateError(problem);
    setCreating(true);
    setCreateError(null);
    try {
      let projectId: string;
      let importedReport: AlignmentReport | null = null;
      let importWarning: string | undefined;
      const trimmed = name.trim();
      if (path === "import") {
        const body =
          importMode === "zip"
            ? { kind: "files", name: trimmed, files: importableFiles(importFiles ?? []), acknowledgeBlocking: ackBlocking }
            : { kind: "git", name: trimmed, url: gitUrl.trim(), ref: gitRef.trim() || undefined, acknowledgeBlocking: ackBlocking };
        const created = await apiCall<{ project: { id: string }; report?: AlignmentReport; blocking?: string[] }>(`/api/v1/studies/${studyId}/pipeline-projects/import`, { method: "POST", body: JSON.stringify(body) }).catch((error) => {
          throw new Error(importUnavailable(error) ?? (error instanceof Error ? error.message : "Import failed."));
        });
        projectId = created.project.id;
        // The server's report is the one that counts; the browser's preview is the fallback.
        importedReport = created.report ?? importReport;
        if (created.blocking?.length) importWarning = `Not publishable yet: ${created.blocking.length} blocking finding${created.blocking.length === 1 ? "" : "s"} (${created.blocking.join(", ")}). Fix them in the workspace before publishing.`;
      } else {
        let source: { owner: string; repo: string; ref?: string } | undefined;
        let lineage: { sourceKind: "template" | "assistant" | "copy"; parentProjectId?: string; parentVersion?: string } = { sourceKind: path === "copy" ? "copy" : path === "assistant" ? "assistant" : "template" };
        if (path === "template") source = selectedCard(templateKey)?.source;
        else if (path === "assistant") source = selectedCard(effectiveBaseKey)?.source;
        else if (copyRepo) {
          const version = copyVersionId === "head" ? null : copyProject?.versions.find((item) => item.id === copyVersionId);
          source = { ...copyRepo, ref: version?.gitCommit ?? undefined };
          lineage = { sourceKind: "copy", parentProjectId: copyProject?.id, parentVersion: version?.version };
        }
        const created = await apiCall<{ project: { id: string } }>(`/api/v1/studies/${studyId}/pipeline-projects/clone`, {
          method: "POST",
          body: JSON.stringify({ name: trimmed, source, ...lineage })
        });
        projectId = created.project.id;
      }

      // The project exists from here on; a failure below is reported as a warning in the workspace, not as a failed create.
      let warning: string | undefined = importWarning;
      if (touched && !contractProblem) {
        try {
          await writeContract(projectId, trimmed);
        } catch (error) {
          warning = `${warning ? `${warning} ` : ""}The pipeline was created, but the data contract and run defaults were not written: ${error instanceof Error ? error.message : "save failed"}. Edit fedlify-pipeline.json in the workspace.`;
        }
      }
      const startPrompt =
        path === "assistant"
          ? {
              mode: "propose" as const,
              text: `Propose the first version of this repository for the study. What the researcher wants: ${description.trim()}\n\nUse the protocol, the requirement answers and the sites' data profiles. Keep the Client API loop and the data contract in fedlify-pipeline.json.`
            }
          : path === "import" && options.propose
            ? { mode: "propose" as const, text: importProposalPrompt(importedReport) }
            : undefined;
      onCreated({ projectId, warning, startPrompt });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Could not create the pipeline.");
    } finally {
      setCreating(false);
    }
  }

  async function writeContract(projectId: string, projectName: string) {
    const source = await apiCall<{ commit: string | null; files: Array<{ path: string; content: string }> }>(`/api/v1/studies/${studyId}/pipeline-projects/${projectId}/source`);
    const existing = source.files.find((file) => file.path === "fedlify-pipeline.json")?.content ?? null;
    const content = applyContractToPipelineJson(existing, contract, projectName, { keepBlank: !contractKnown });
    if (content === existing) return;
    await apiCall(`/api/v1/studies/${studyId}/pipeline-projects/${projectId}/save`, {
      method: "POST",
      body: JSON.stringify({ baseCommit: source.commit ?? undefined, message: "Set data contract and run defaults", files: [{ path: "fedlify-pipeline.json", content }] })
    });
  }

  // ---- render ----------------------------------------------------------------------------------------------------

  const loading = !cards || !context;
  const sourceSummary =
    path === "template"
      ? (selectedCard(templateKey)?.name ?? "No template")
      : path === "assistant"
        ? `Assistant, starting from ${selectedCard(effectiveBaseKey)?.name ?? "the starter"}`
        : path === "import"
          ? importMode === "zip"
            ? `Uploaded zip (${importFiles?.length ?? 0} files)`
            : gitUrl
          : `Copy of ${copyProject?.name ?? "a pipeline"}`;

  // Why Continue is disabled, so the screen never reads as a dead end.
  const continueHint = canContinue || loading
    ? null
    : path === "template"
      ? "Select a template to continue."
      : path === "assistant"
        ? description.trim().length < 20
          ? "Describe your pipeline in at least 20 characters to continue."
          : "No template is available to start from."
        : path === "import"
          ? secretsFound
            ? "Remove the credentials the check found, then check again."
            : blockingFound && !ackBlocking
              ? "Tick the box above to continue anyway."
              : importMode === "zip"
                ? "Upload a zip to continue."
                : !GIT_URL.test(gitUrl.trim())
                  ? "Enter an https Git URL, then check it."
                  : "Check the repository first."
          : !copyProject
            ? "Choose a pipeline to copy."
            : "This pipeline has no readable repository address.";

  const continueButton = (
    <footer className="fedlify-start-foot is-end">
      {continueHint ? (
        <Typography.Text type="secondary" className="fedlify-start-hint" data-testid="continue-hint">
          {continueHint}
        </Typography.Text>
      ) : null}
      <Button type="primary" loading={advancing} disabled={!canContinue || loading || advancing} onClick={() => void goToContract()}>
        Continue
      </Button>
    </footer>
  );
  const chosenCard = selectedCard(templateKey);
  const chosenStatus = chosenCard ? sourceStatus[chosenCard.key] : undefined;
  const chosenReport = chosenCard && context ? computeTemplateFit(context.fitStudy, context.sites, chosenCard.traits) : null;
  const descriptionLength = description.length;

  function pickTemplate(key: string) {
    setPath("template");
    setTemplateKey(key);
  }

  function resetBrowse() {
    setPage(1);
  }

  return (
    <section className="fedlify-start" aria-label="Start a pipeline" data-testid="start-pipeline">
      <header className="fedlify-start-head">
        <h2>Start a pipeline</h2>
        {step === 0 && picked ? (
          <Button icon={<ArrowLeftOutlined />} onClick={() => setPicked(false)}>
            Back
          </Button>
        ) : step === 0 && onCancel ? (
          <Button icon={<ArrowLeftOutlined />} onClick={onCancel}>
            Back to pipelines
          </Button>
        ) : null}
      </header>

      <ol className="fedlify-start-steps" aria-label="Wizard steps">
        {WIZARD_STEPS.map((label, index) => (
          <li key={label} className={index === step ? "is-current" : index < step ? "is-done" : ""} aria-current={index === step ? "step" : undefined}>
            <span>{index + 1}</span> {label}
          </li>
        ))}
      </ol>

      {contextError ? <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Study details unavailable" description={`${contextError} Fit badges and feature availability will say unknown.`} /> : null}

      {step === 0 && !picked ? (
        <div className="fedlify-start-choose" data-testid="start-choose">
          <h3>How do you want to start?</h3>
          <div className="fedlify-start-choices">
            {PATH_CARDS.map((choice) => {
              const disabled = choice.path === "copy" && projects.length === 0;
              return (
                <button
                  type="button"
                  key={choice.path}
                  className="fedlify-start-choice"
                  data-testid={`path-card-${choice.path}`}
                  disabled={disabled}
                  onClick={() => {
                    setPath(choice.path);
                    setPicked(true);
                  }}
                >
                  <span className="fedlify-start-choice-icon" aria-hidden="true">{choice.icon}</span>
                  <span className="fedlify-start-choice-title">{PATH_LABELS[choice.path]}</span>
                  <span className="fedlify-start-choice-text">{disabled ? "This study has no pipeline yet." : choice.sentence}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {step === 0 && picked && path === "template" ? (
        <div className="fedlify-start-panel" data-testid="path-template">
          <h3>Choose a template</h3>
          {catalogError ? <Alert type="warning" showIcon message="The template catalog could not be loaded; only the starter is offered." description={catalogError} /> : null}
          {loading ? (
            <div style={{ textAlign: "center", padding: 24 }}>
              <Spin tip="Loading templates" />
            </div>
          ) : (
            <>
              <div className="fedlify-start-toolbar">
                <Input
                  className="fedlify-start-search"
                  allowClear
                  prefix={<SearchOutlined />}
                  aria-label="Search templates"
                  placeholder="Search name, algorithm, task or data type"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    resetBrowse();
                  }}
                />
                <Select<TaskKind | "all">
                  aria-label="Filter by task"
                  value={taskFilter}
                  onChange={(value) => {
                    setTaskFilter(value);
                    resetBrowse();
                  }}
                  options={[{ value: "all", label: "Any task" }, ...Object.entries(TASK_LABELS).map(([value, label]) => ({ value: value as TaskKind, label }))]}
                />
                <Select<DataType | "all">
                  aria-label="Filter by data type"
                  value={typeFilter}
                  onChange={(value) => {
                    setTypeFilter(value);
                    resetBrowse();
                  }}
                  options={[{ value: "all", label: "Any data type" }, ...Object.entries(DATA_TYPE_LABELS).map(([value, label]) => ({ value: value as DataType, label }))]}
                />
              </div>
              <div className="fedlify-start-count-row">
                <span aria-live="polite" data-testid="template-count">
                  {pageInfo.total === 0 ? "No templates" : `Showing ${pageInfo.from}–${pageInfo.to} of ${pageInfo.total} template${pageInfo.total === 1 ? "" : "s"}`}
                </span>
                {chosenCard && path === "template" ? (
                  <Tag color="blue" data-testid="selected-chip" style={{ marginInlineEnd: 0 }}>
                    Selected: {chosenCard.name}
                    {pageInfo.items.some(({ card }) => card.key === chosenCard.key) ? "" : " (not in this view)"}
                  </Tag>
                ) : null}
                {browse.unavailableCount > 0 ? (
                  <Button size="small" type="link" onClick={() => { setShowUnavailable((value) => !value); resetBrowse(); }}>
                    {showUnavailable ? `Hide unavailable (${browse.unavailableCount})` : `Show unavailable (${browse.unavailableCount})`}
                  </Button>
                ) : null}
              </div>
              <Typography.Text type="secondary" className="fedlify-start-note" data-testid="provisional-note">
                Fit, search and filters use what each template&apos;s name suggests. Select one to read its source and see its declared details.
              </Typography.Text>
              {pageInfo.total === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={filtersActive ? "No template matches your search or filters." : "No templates are available."}
                >
                  {filtersActive ? (
                    <Button size="small" onClick={() => { setQuery(""); setTaskFilter("all"); setTypeFilter("all"); resetBrowse(); }}>
                      Clear search and filters
                    </Button>
                  ) : null}
                </Empty>
              ) : (
                <div className="fedlify-start-rows" role="group" aria-label="Templates">
                  {pageInfo.items.map(({ card, report }) => (
                    <button
                      type="button"
                      key={card.key}
                      aria-pressed={templateKey === card.key}
                      disabled={Boolean(card.blockedReason)}
                      title={[card.name, rowSummary(card), card.blockedReason].filter(Boolean).join(" \u2014 ")}
                      className={["fedlify-start-row", templateKey === card.key ? "is-on" : ""].join(" ")}
                      data-testid="template-row"
                      onClick={() => pickTemplate(card.key)}
                    >
                      <span className="fedlify-start-row-name">{card.name}</span>
                      <span className="fedlify-start-row-summary">{rowSummary(card)}</span>
                      {card.blockedReason ? <Tag style={{ marginInlineEnd: 0 }}>unavailable</Tag> : <FitBadge report={report} provisional />}
                    </button>
                  ))}
                </div>
              )}
              {pageInfo.pageCount > 1 ? (
                <Pagination size="small" current={pageInfo.page} pageSize={TEMPLATE_PAGE_SIZE} total={pageInfo.total} showSizeChanger={false} onChange={setPage} />
              ) : null}
              {chosenCard && chosenReport ? (
                <div className="fedlify-start-details" data-testid="template-details" role="region" aria-label={`Details of ${chosenCard.name}`}>
                  <div className="fedlify-start-details-head">
                    <b>{chosenCard.name}</b>
                    {chosenCard.scope === "STUDY_TEMPLATE" ? <Tag style={{ marginInlineEnd: 0 }}>this study</Tag> : null}
                    <FitBadge report={chosenReport} />
                    <span className="fedlify-start-best-reason">{shortFitReason(chosenReport)}</span>
                  </div>
                  {chosenCard.description ? <p className="fedlify-start-details-text">{chosenCard.description}</p> : null}
                  <dl className="fedlify-start-summary">
                    <dt>Version</dt>
                    <dd>{chosenCard.version ? `v${chosenCard.version.replace(/^v/, "")}` : "Not versioned"}</dd>
                    <dt>Validation</dt>
                    <dd>{chosenCard.validation ? `${chosenCard.validation.toLowerCase()}${formatDate(chosenCard.validatedAt) ? `, ${formatDate(chosenCard.validatedAt)}` : ""}` : "Not recorded"}</dd>
                    <dt>Traits</dt>
                    <dd>
                      {chosenStatus === "failed" ? (
                        <Button size="small" type="link" style={{ padding: 0, marginInlineEnd: 8 }} onClick={() => setRetryTick((tick) => tick + 1)}>
                          Retry
                        </Button>
                      ) : null}
                      {chosenStatus === "loading"
                        ? "Reading the template…"
                        : chosenCard.traits.traitSource === "declared"
                          ? "Declared by the template"
                          : chosenStatus === "failed"
                            ? "Source could not be read; traits are inferred from the name"
                            : "Inferred from the name"}
                    </dd>
                    {chosenCard.traits.contract ? (
                      <>
                        <dt>Contract</dt>
                        <dd>{`${chosenCard.traits.contract.label ?? "no label"} + ${chosenCard.traits.contract.featureCount} features`}</dd>
                      </>
                    ) : null}
                  </dl>
                  <div>
                    <strong>Why this fit</strong>
                    <ul className="fedlify-start-reasons" data-testid="fit-reasons">
                      {orderedFitReasons(chosenReport).map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                      {chosenReport.reasons.length === 0 ? <li>No evidence to compare.</li> : null}
                    </ul>
                  </div>
                </div>
              ) : null}
            </>
          )}
          {continueButton}
        </div>
      ) : null}

      {step === 0 && picked && path === "assistant" ? (
        <div className="fedlify-start-panel" data-testid="path-assistant">
          <h3>Describe your pipeline</h3>
          <Input.TextArea
            className="fedlify-start-describe"
            aria-label="What should the pipeline do"
            rows={7}
            maxLength={2000}
            autoSize={{ minRows: 7, maxRows: 14 }}
            placeholder="e.g. Predict in-hospital mortality from admission labs and vitals, using only features both hospitals record."
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <div className="fedlify-start-counter" data-testid="char-count">
            {descriptionLength < 20 ? `${descriptionLength} / 2000 · at least 20 characters` : `${descriptionLength} / 2000`}
          </div>
          <Collapse
            ghost
            items={[
              {
                key: "advanced",
                label: "Advanced",
                children: (
                  <label className="fedlify-start-name">
                    Start from template
                    <Select
                      showSearch
                      optionFilterProp="label"
                      aria-label="Closest template"
                      value={effectiveBaseKey ?? undefined}
                      onChange={setBaseKey}
                      options={browseTemplates(ranked, {}).rows.map(({ card, fit }) => ({ value: card.key, label: `${card.name} (${FIT_LABELS[fit]})` }))}
                    />
                  </label>
                )
              }
            ]}
          />
          {continueButton}
        </div>
      ) : null}

      {step === 0 && picked && path === "import" ? (
        <div className="fedlify-start-panel" data-testid="path-import">
          <h3>Bring your own code</h3>
          <Radio.Group
            value={importMode}
            onChange={(event) => {
              setImportMode(event.target.value);
              setImportReport(null);
              setImportFiles(null);
              setImportError(null);
              setAckBlocking(false);
            }}
            options={[
              { value: "zip", label: "Upload zip" },
              { value: "git", label: "Git URL" }
            ]}
            optionType="button"
          />
          {importMode === "zip" ? (
            <Upload.Dragger accept=".zip" maxCount={1} multiple={false} showUploadList={{ showRemoveIcon: false }} beforeUpload={(file) => readZip(file)} disabled={importBusy}>
              <span>Drop a .zip here or click to choose (max {IMPORT_LIMITS.maxZipBytes / 1024 / 1024} MB, text files only)</span>
            </Upload.Dragger>
          ) : (
            <Space.Compact style={{ width: "100%" }}>
              <Input aria-label="Git URL" placeholder="https://git.example.com/org/repo" value={gitUrl} onChange={(event) => { setGitUrl(event.target.value); setImportReport(null); setAckBlocking(false); }} />
              <Input aria-label="Git ref" style={{ maxWidth: 110 }} placeholder="ref (main)" value={gitRef} onChange={(event) => { setGitRef(event.target.value); setImportReport(null); setAckBlocking(false); }} />
              <Button loading={importBusy} disabled={!GIT_URL.test(gitUrl.trim())} onClick={() => void checkGit()}>
                Check
              </Button>
            </Space.Compact>
          )}
          {importBusy && importMode === "zip" ? <Spin size="small" /> : null}
          {importError ? <Alert type={importReport ? "info" : "warning"} showIcon message={importError} /> : null}
          {importReport ? <AlignmentView report={importReport} /> : null}
          {blockingFound ? (
            <Checkbox checked={ackBlocking} onChange={(event) => setAckBlocking(event.target.checked)}>
              Create it anyway and fix the blocking items in the workspace (publish will refuse them until fixed).
            </Checkbox>
          ) : null}
          {continueButton}
        </div>
      ) : null}

      {step === 0 && picked && path === "copy" ? (
        <div className="fedlify-start-panel" data-testid="path-copy">
          <h3>Copy a pipeline</h3>
          {projects.length === 0 ? (
            <Typography.Text type="secondary">This study has no pipeline to copy yet.</Typography.Text>
          ) : (
            <>
              <label className="fedlify-start-name">
                Pipeline
                <Select
                  aria-label="Pipeline to copy"
                  value={copyId ?? undefined}
                  onChange={(value) => {
                    setCopyId(value);
                    setCopyVersionId("head");
                  }}
                  options={projects.map((project) => ({ value: project.id, label: project.name }))}
                />
              </label>
              <label className="fedlify-start-name">
                Version
                <Select
                  aria-label="Version to copy"
                  value={copyVersionId}
                  onChange={setCopyVersionId}
                  options={[
                    { value: "head", label: "Latest saved code" },
                    ...(copyProject?.versions.filter((version) => version.gitCommit).map((version) => ({ value: version.id, label: `${version.version}${version.id === liveVersionId ? " (live)" : ""}` })) ?? [])
                  ]}
                />
              </label>
              {copyProject && !copyRepo ? <Alert type="warning" showIcon message="This pipeline has no readable repository address, so it cannot be copied." /> : null}
            </>
          )}
          {continueButton}
        </div>
      ) : null}

      {step === 1 ? (
        <div className="fedlify-start-panel" data-testid="wizard-step-contract">
          <h3>Data contract and run defaults</h3>
          <Typography.Paragraph type="secondary">
            {prefillNote ?? "Optional."} Leave everything as it is to keep the original pipeline&apos;s settings. Changing anything writes <code>fedlify-pipeline.json</code> as the first save after the copy.
          </Typography.Paragraph>
          <div className="fedlify-start-fields">
            <label>
              Label column
              <Input value={contract.label} onChange={(event) => edit({ label: event.target.value })} placeholder="e.g. hospitaldischargestatus" />
            </label>
            <label>
              Positive value
              <Input value={contract.positiveValue} onChange={(event) => edit({ positiveValue: event.target.value })} placeholder="e.g. Expired" />
            </label>
            <label>
              Rounds
              <InputNumber min={1} max={1000} value={contract.numRounds} onChange={(value) => edit({ numRounds: Number(value) || 1 })} />
            </label>
            <label>
              Min sites
              <InputNumber min={1} max={Math.max(1, sites.length, contract.minClients)} value={contract.minClients} onChange={(value) => edit({ minClients: Number(value) || 1 })} />
            </label>
          </div>
          <div className="fedlify-start-features">
            <strong>Features ({contract.features.length} selected)</strong>
            <Typography.Text type="secondary" className="fedlify-start-note">
              Candidates are the source&apos;s features plus every column a site profile lists. Unknown means that site&apos;s profile lists no columns.
            </Typography.Text>
            {featureRows.length === 0 ? (
              <Typography.Text type="secondary">No features are known yet. Sites have no column lists; add feature names below.</Typography.Text>
            ) : (
              <Table
                size="small"
                rowKey="name"
                pagination={false}
                scroll={{ y: 260, x: "max-content" }}
                dataSource={featureRows}
                rowSelection={{
                  selectedRowKeys: contract.features,
                  onChange: (keys) => edit({ features: keys.map(String) }),
                  getCheckboxProps: (row) => ({ disabled: row.name.toLowerCase() === contract.label.trim().toLowerCase() })
                }}
                columns={[
                  { title: "Feature", dataIndex: "name", render: (value: string) => <code>{value}</code> },
                  ...sites.map((site) => ({
                    title: site.name,
                    key: site.code,
                    width: 120,
                    render: (_: unknown, row: (typeof featureRows)[number]) => {
                      const cell = row.bySite[site.code];
                      return cell === "listed" ? <StatusTag tone="success" label="listed" /> : cell === "missing" ? <StatusTag tone="danger" label="missing" /> : <StatusTag icon={<QuestionCircleOutlined />} label="unknown" />;
                    }
                  }))
                ]}
              />
            )}
            <Input.Search
              size="small"
              enterButton="Add feature"
              aria-label="Add a feature"
              placeholder="Feature column name"
              onSearch={(value) => {
                const next = value.trim();
                if (next && !contract.features.some((feature) => feature.toLowerCase() === next.toLowerCase())) edit({ features: [...contract.features, next] });
              }}
            />
          </div>
          {contractProblem ? <Alert type="warning" showIcon message={contractProblem} style={{ marginTop: 12 }} /> : null}
          <footer className="fedlify-start-foot">
            <Button onClick={() => setStep(0)}>Back</Button>
            <Button type="primary" disabled={Boolean(contractProblem)} onClick={() => setStep(2)}>
              Continue
            </Button>
          </footer>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="fedlify-start-panel" data-testid="wizard-step-create">
          <h3>Name and create</h3>
          <label className="fedlify-start-name">
            Pipeline name
            <Input value={name} maxLength={NAME_MAX} onChange={(event) => setName(event.target.value)} placeholder="e.g. HF mortality FedAvg" status={name && nameError(name) ? "error" : undefined} aria-label="Pipeline name" />
          </label>
          <dl className="fedlify-start-summary">
            <dt>Path</dt>
            <dd>{PATH_LABELS[path]}</dd>
            <dt>Source</dt>
            <dd>{sourceSummary}</dd>
            <dt>Contract</dt>
            <dd>{touched ? `${contract.label} + ${contract.features.length} features, ${contract.numRounds} rounds, min ${contract.minClients} sites (saved as the first save)` : "kept from the source"}</dd>
          </dl>
          <Typography.Paragraph type="secondary">
            This creates a repository for this pipeline in this study and opens the workspace. It does not publish, run, or release anything.
          </Typography.Paragraph>
          {createError ? <Alert type="error" showIcon message={createError} style={{ marginBottom: 12 }} /> : null}
          <footer className="fedlify-start-foot">
            <Button onClick={() => setStep(1)} disabled={creating}>
              Back
            </Button>
            {path === "import" ? (
              <Button loading={creating} disabled={Boolean(nameError(name))} onClick={() => void create({ propose: true })}>
                Create with proposed edits
              </Button>
            ) : null}
            <Button type="primary" loading={creating} disabled={Boolean(nameError(name))} onClick={() => void create()}>
              Create pipeline
            </Button>
          </footer>
        </div>
      ) : null}
    </section>
  );
}

type ZipEntry = { name: string; _data?: { uncompressedSize?: number }; internalStream: (type: "uint8array") => ZipStream };
type ZipStream = { on: (event: string, handler: (arg?: never) => void) => ZipStream; pause: () => void; resume: () => void };

/** Inflate one zip entry, or return null without finishing when it is (or turns out to be) larger than `limit` bytes. */
function inflateWithin(entry: unknown, limit: number): Promise<Uint8Array | null> {
  const item = entry as ZipEntry;
  const declared = item._data?.uncompressedSize;
  if (typeof declared === "number" && declared > limit) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;
    const stream = item.internalStream("uint8array");
    stream
      .on("data", ((chunk: Uint8Array) => {
        if (done) return;
        total += chunk.byteLength;
        if (total > limit) {
          done = true;
          stream.pause();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      }) as never)
      .on("error", ((error: Error) => {
        if (!done) {
          done = true;
          reject(error);
        }
      }) as never)
      .on("end", (() => {
        if (done) return;
        done = true;
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          out.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(out);
      }) as never);
    stream.resume();
  });
}

/** A friendly message when the import route is not deployed on this server (a bare 404 or 405), else null. */
function importUnavailable(error: unknown): string | null {
  if (error instanceof ApiError && (error.status === 404 || error.status === 405) && !error.code) {
    return "Import is not enabled on this server yet, so nothing was created. Use a template, or upload the code through Git and copy it.";
  }
  return null;
}
