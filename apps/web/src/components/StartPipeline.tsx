"use client";

import { ArrowLeftOutlined, CheckCircleFilled, CloseCircleFilled, ExclamationCircleFilled, QuestionCircleOutlined } from "@ant-design/icons";
import { Alert, Button, Checkbox, Empty, Input, InputNumber, Radio, Select, Space, Spin, Table, Tag, Tooltip, Typography, Upload } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DATA_TYPE_LABELS,
  TASK_LABELS,
  computeTemplateFit,
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
  WIZARD_STEPS,
  alignmentReport,
  applyContractToPipelineJson,
  contractError,
  contractFromPipelineJson,
  featureAvailability,
  intersectionFeatures,
  nameError,
  parseRepoUrl,
  safeImportPath,
  isZipJunk,
  importableFiles,
  importProposalPrompt,
  sortByFit,
  stripCommonRoot,
  type AlignmentReport,
  type ContractDraft,
  type ListJob,
  type ListProject,
  type RepoFile,
  type StartPath
} from "@/lib/pipeline-start";
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
const FIT_COLOR = { fits: "green", partial: "gold", different: "default" } as const;
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
    pipelineJson: null,
    scope: "PUBLIC_TEMPLATE",
    blockedReason: null
  };
}

/** Messages worth showing next to the badge: contradictions first, then unknowns, then the matches. */
function fitReasons(report: FitReport): string[] {
  const order = { mismatch: 0, unknown: 1, match: 2 } as const;
  return [...report.reasons].sort((a, b) => order[a.status] - order[b.status]).map((reason) => reason.message);
}

function FitBadge({ report, inferred }: { report: FitReport; inferred: boolean }) {
  const reasons = fitReasons(report);
  return (
    <div className="fedlify-start-fit" data-testid="fit-badge">
      <Tooltip title={<div>{reasons.map((reason) => <div key={reason}>{reason}</div>)}</div>}>
        <Tag color={FIT_COLOR[report.fit]} data-fit={report.fit}>
          {FIT_LABELS[report.fit]}
        </Tag>
      </Tooltip>
      <span className="fedlify-start-fit-reason" data-testid="fit-reason">
        {reasons[0] ?? "No evidence to compare."}
        {reasons.length > 1 ? ` (+${reasons.length - 1} more)` : ""}
        {inferred ? " Traits inferred from the name." : ""}
      </span>
    </div>
  );
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null;
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
  const [templateKey, setTemplateKey] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<TaskKind | "all">("all");
  const [typeFilter, setTypeFilter] = useState<DataType | "all">("all");
  const [showAll, setShowAll] = useState(false);
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
  const prefillSeq = useRef(0);

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

  // Approved templates (public catalog and this study's), then each one's fedlify-pipeline.json for declared traits.
  useEffect(() => {
    let cancelled = false;
    void apiCall<{ templates: CatalogTemplate[] }>(`/api/v1/pipeline-templates?scope=all&studyId=${encodeURIComponent(studyId)}`)
      .then(async (body) => {
        if (cancelled) return;
        const fromCatalog = body.templates.map(cardFromCatalog);
        const hasStarter = fromCatalog.some((card) => card.source?.repo === "fedlify-starter");
        const initial = hasStarter ? fromCatalog : [starterCard(), ...fromCatalog];
        setCards(initial);
        const readable = initial.filter((card) => card.source).slice(0, 12);
        let next = 0;
        const worker = async () => {
          while (!cancelled && next < readable.length) {
            const card = readable[next++];
            const id = card.key;
            try {
              const source = await apiCall<{ files: Array<{ path: string; content: string }> }>(`/api/v1/pipeline-templates/${id}/source`);
              const file = source.files.find((item) => item.path === "fedlify-pipeline.json");
              if (!file || cancelled) continue;
              let parsed: unknown = null;
              try {
                parsed = JSON.parse(file.content);
              } catch {
                continue;
              }
              setCards((current) =>
                current?.map((item) => (item.key === id ? { ...item, pipelineJson: file.content, traits: templateTraits({ name: item.name, description: item.description, pipelineJson: parsed }) } : item)) ?? current
              );
            } catch {
              // A template whose source cannot be read keeps its inferred traits.
            }
          }
        };
        await Promise.all([worker(), worker(), worker()]);
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

  const ranked = useMemo(() => {
    if (!cards || !context) return [];
    return sortByFit(
      cards.map((card) => {
        const report = computeTemplateFit(context.fitStudy, context.sites, card.traits);
        return { card, report, fit: report.fit };
      })
    );
  }, [cards, context]);

  const filtered = ranked.filter(({ card }) => (taskFilter === "all" || card.traits.task === taskFilter) && (typeFilter === "all" || card.traits.dataType === typeFilter));
  const visible = showAll ? filtered : filtered.slice(0, 3);

  // Default selections once the ranking is known: the best-fitting template that can actually be cloned.
  useEffect(() => {
    const best = ranked.find(({ card }) => !card.blockedReason);
    if (best) {
      setTemplateKey((current) => current ?? best.card.key);
      setBaseKey((current) => current ?? best.card.key);
    }
  }, [ranked]);

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
        ? description.trim().length >= 20 && Boolean(selectedCard(baseKey))
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
    const seq = ++prefillSeq.current;
    setTouched(false);
    setPrefillNote(null);
    let json: string | null = null;
    let note: string | null = null;
    if (path === "template" || path === "assistant") {
      const card = selectedCard(path === "template" ? templateKey : baseKey);
      json = card?.pipelineJson ?? null;
      if (!json && card && card.key !== "starter" && card.source) {
        try {
          const source = await apiCall<{ files: Array<{ path: string; content: string }> }>(`/api/v1/pipeline-templates/${card.key}/source`);
          json = source.files.find((file) => file.path === "fedlify-pipeline.json")?.content ?? null;
        } catch {
          json = null;
        }
      }
      note = json ? `Prefilled from ${card?.name}.` : `${card?.name ?? "The template"} keeps its own contract unless you change it here.`;
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
        note = json ? `Prefilled from ${copyProject.name} at its saved head.` : null;
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
        else if (path === "assistant") source = selectedCard(baseKey)?.source;
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
        ? `Assistant, starting from ${selectedCard(baseKey)?.name ?? "the starter"}`
        : path === "import"
          ? importMode === "zip"
            ? `Uploaded zip (${importFiles?.length ?? 0} files)`
            : gitUrl
          : `Copy of ${copyProject?.name ?? "a pipeline"}`;

  return (
    <section className="fedlify-start" aria-label="Start a pipeline" data-testid="start-pipeline">
      <header className="fedlify-start-head">
        <div>
          <h2>Start a pipeline</h2>
          <Typography.Text type="secondary">Four ways in, one wizard. Every path ends in the workspace; nothing is published or run.</Typography.Text>
        </div>
        {onCancel ? (
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

      {step === 0 ? (
        <>
          {loading ? (
            <div style={{ textAlign: "center", padding: 32 }}>
              <Spin tip="Loading templates and study context" />
            </div>
          ) : (
            <div className="fedlify-start-paths">
              {/* Path 1: template */}
              <div className={["fedlify-start-path", path === "template" ? "is-selected" : ""].join(" ")} data-testid="path-template">
                <div className="fedlify-start-path-head">
                  <Radio checked={path === "template"} onChange={() => setPath("template")} aria-label={PATH_LABELS.template}>
                    <b>{PATH_LABELS.template}</b>
                  </Radio>
                  <Tag color="purple">recommended</Tag>
                </div>
                <p>Approved templates, best fit with this study&apos;s protocol, outcome and the sites&apos; data profiles first.</p>
                {catalogError ? <Alert type="warning" showIcon message="The template catalog could not be loaded; only the starter is offered." description={catalogError} /> : null}
                <div className="fedlify-start-filters">
                  <Select<TaskKind | "all">
                    size="small"
                    aria-label="Filter by task"
                    value={taskFilter}
                    onChange={setTaskFilter}
                    options={[{ value: "all", label: "Any task" }, ...Object.entries(TASK_LABELS).map(([value, label]) => ({ value: value as TaskKind, label }))]}
                  />
                  <Select<DataType | "all">
                    size="small"
                    aria-label="Filter by data type"
                    value={typeFilter}
                    onChange={setTypeFilter}
                    options={[{ value: "all", label: "Any data type" }, ...Object.entries(DATA_TYPE_LABELS).map(([value, label]) => ({ value: value as DataType, label }))]}
                  />
                </div>
                <div className="fedlify-start-cards" role="radiogroup" aria-label="Templates">
                  {visible.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No template matches these filters." /> : null}
                  {visible.map(({ card, report }) => {
                    const contractSummary = card.traits.contract;
                    const validated = formatDate(card.validatedAt);
                    return (
                      <button
                        type="button"
                        key={card.key}
                        role="radio"
                        aria-checked={templateKey === card.key && path === "template"}
                        disabled={Boolean(card.blockedReason)}
                        className={["fedlify-start-card", templateKey === card.key && path === "template" ? "is-on" : ""].join(" ")}
                        data-testid="template-card"
                        onClick={() => {
                          setPath("template");
                          setTemplateKey(card.key);
                        }}
                      >
                        <span className="fedlify-start-card-title">
                          <span>{card.name}</span>
                          {card.scope === "STUDY_TEMPLATE" ? <Tag>this study</Tag> : null}
                        </span>
                        <span className="fedlify-start-card-meta">
                          {[
                            card.traits.task ? TASK_LABELS[card.traits.task] : "task unknown",
                            card.traits.algorithm ?? "algorithm unknown",
                            card.traits.dataType ? DATA_TYPE_LABELS[card.traits.dataType] : "data type unknown",
                            contractSummary ? `${contractSummary.label ?? "no label"} + ${contractSummary.featureCount} features` : "contract not read",
                            card.version ? `v${card.version.replace(/^v/, "")}` : null,
                            card.validation ? `validation ${card.validation.toLowerCase()}${validated ? ` ${validated}` : ""}` : null
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        <FitBadge report={report} inferred={card.traits.traitSource !== "declared"} />
                        {card.blockedReason ? <span className="fedlify-start-card-meta">Unavailable: {card.blockedReason}</span> : null}
                      </button>
                    );
                  })}
                </div>
                {filtered.length > 3 ? (
                  <Button size="small" type="link" onClick={() => setShowAll((value) => !value)}>
                    {showAll ? "Show the best three" : `Browse all ${filtered.length}`}
                  </Button>
                ) : null}
              </div>

              {/* Path 2: assistant */}
              <div className={["fedlify-start-path", path === "assistant" ? "is-selected" : ""].join(" ")} data-testid="path-assistant">
                <div className="fedlify-start-path-head">
                  <Radio checked={path === "assistant"} onChange={() => setPath("assistant")} aria-label={PATH_LABELS.assistant}>
                    <b>{PATH_LABELS.assistant}</b>
                  </Radio>
                </div>
                <p>Say what you want. The pipeline starts from the closest template; the workspace assistant then proposes the first changes for your request as a diff you review.</p>
                <Input.TextArea
                  aria-label="What should the pipeline do"
                  rows={3}
                  maxLength={2000}
                  showCount
                  placeholder="e.g. Predict in-hospital mortality from admission labs and vitals, using only features both hospitals record."
                  value={description}
                  onFocus={() => setPath("assistant")}
                  onChange={(event) => setDescription(event.target.value)}
                />
                <Select
                  size="small"
                  aria-label="Closest template"
                  value={baseKey ?? undefined}
                  onChange={(value) => {
                    setPath("assistant");
                    setBaseKey(value);
                  }}
                  options={ranked.filter(({ card }) => !card.blockedReason).map(({ card, fit }) => ({ value: card.key, label: `${card.name} (${FIT_LABELS[fit]})` }))}
                />
                <Typography.Text type="secondary" className="fedlify-start-note">
                  At least 20 characters. The pipeline is created from the closest template and your request is sent to the assistant as a proposal. You review the diff and accept or reject it; nothing is saved by the assistant on its own.
                </Typography.Text>
              </div>

              {/* Path 3: import */}
              <div className={["fedlify-start-path", path === "import" ? "is-selected" : ""].join(" ")} data-testid="path-import">
                <div className="fedlify-start-path-head">
                  <Radio checked={path === "import"} onChange={() => setPath("import")} aria-label={PATH_LABELS.import}>
                    <b>{PATH_LABELS.import}</b>
                  </Radio>
                </div>
                <p>Upload a zip or give a Git URL. It is checked against the Fedlify contract before anything is created.</p>
                <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <Radio.Group
                  size="small"
                  value={importMode}
                  onChange={(event) => {
                    setPath("import");
                    setImportMode(event.target.value);
                    setImportReport(null);
                    setImportError(null);
                  }}
                  options={[
                    { value: "zip", label: "Upload zip" },
                    { value: "git", label: "Git URL" }
                  ]}
                  optionType="button"
                />
                {importMode === "zip" ? (
                  <Upload.Dragger accept=".zip" maxCount={1} multiple={false} showUploadList={{ showRemoveIcon: false }} beforeUpload={(file) => { setPath("import"); return readZip(file); }} disabled={importBusy}>
                    <span>Drop a .zip here or click to choose (max {IMPORT_LIMITS.maxZipBytes / 1024 / 1024} MB, text files only)</span>
                  </Upload.Dragger>
                ) : (
                  <Space.Compact style={{ width: "100%" }}>
                    <Input aria-label="Git URL" placeholder="https://git.example.com/org/repo" value={gitUrl} onFocus={() => setPath("import")} onChange={(event) => { setGitUrl(event.target.value); setImportReport(null); }} />
                    <Input aria-label="Git ref" style={{ maxWidth: 110 }} placeholder="ref (main)" value={gitRef} onChange={(event) => setGitRef(event.target.value)} />
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
                </fieldset>
              </div>

              {/* Path 4: copy */}
              <div className={["fedlify-start-path", path === "copy" ? "is-selected" : ""].join(" ")} data-testid="path-copy">
                <div className="fedlify-start-path-head">
                  <Radio checked={path === "copy"} onChange={() => setPath("copy")} aria-label={PATH_LABELS.copy} disabled={projects.length === 0}>
                    <b>{PATH_LABELS.copy}</b>
                  </Radio>
                </div>
                <p>For a v2 or an ablation. The copy starts from this pipeline&apos;s code at the version you choose.</p>
                {projects.length === 0 ? (
                  <Typography.Text type="secondary">This study has no pipeline to copy yet.</Typography.Text>
                ) : (
                  <>
                    <Select
                      size="small"
                      aria-label="Pipeline to copy"
                      value={copyId ?? undefined}
                      onChange={(value) => {
                        setPath("copy");
                        setCopyId(value);
                        setCopyVersionId("head");
                      }}
                      options={projects.map((project) => ({ value: project.id, label: project.name }))}
                    />
                    <Select
                      size="small"
                      aria-label="Version to copy"
                      value={copyVersionId}
                      onChange={(value) => {
                        setPath("copy");
                        setCopyVersionId(value);
                      }}
                      options={[
                        { value: "head", label: "Saved head (latest commit)" },
                        ...(copyProject?.versions.filter((version) => version.gitCommit).map((version) => ({ value: version.id, label: `${version.version}${version.id === liveVersionId ? " (live)" : ""}` })) ?? [])
                      ]}
                    />
                    {copyProject && !copyRepo ? <Alert type="warning" showIcon message="This pipeline has no readable repository address, so it cannot be copied." /> : null}
                    {copyProject ? (
                      <Typography.Text type="secondary" className="fedlify-start-note">
                        {jobs.some((job) => job.pipelineVersion && copyProject.versions.some((version) => version.id === job.pipelineVersion?.id))
                          ? "It has runs; the copy starts with none."
                          : "It has no runs yet."}
                      </Typography.Text>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          )}
          <footer className="fedlify-start-foot">
            <Typography.Text type="secondary">
              {sourceReady ? `Source: ${sourceSummary}.` : "Choose a source to continue."}
            </Typography.Text>
            <Button type="primary" disabled={!canContinue || loading} onClick={() => void goToContract()}>
              Continue
            </Button>
          </footer>
        </>
      ) : null}

      {step === 1 ? (
        <div className="fedlify-start-panel" data-testid="wizard-step-contract">
          <h3>Data contract and run defaults</h3>
          <Typography.Paragraph type="secondary">
            {prefillNote ?? "Optional."} Leave everything as it is to keep the source&apos;s own contract. Changing anything writes <code>fedlify-pipeline.json</code> as the first commit after the copy.
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
                      return cell === "listed" ? <Tag color="green">listed</Tag> : cell === "missing" ? <Tag color="red">missing</Tag> : <Tag icon={<QuestionCircleOutlined />}>unknown</Tag>;
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
            <dd>{touched ? `${contract.label} + ${contract.features.length} features, ${contract.numRounds} rounds, min ${contract.minClients} sites (written as the first commit)` : "kept from the source"}</dd>
          </dl>
          <Typography.Paragraph type="secondary">
            This creates a repository in this study&apos;s Gitea organization and opens the workspace. It does not publish, run, or release anything.
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
