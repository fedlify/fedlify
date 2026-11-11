"use client";

import type { Key } from "react";
import { CloudUploadOutlined, FolderOutlined, LinkOutlined, MenuFoldOutlined, MenuUnfoldOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, StopOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Empty, Input, InputNumber, Modal, Select, Space, Spin, Table, Tag, Tooltip, Typography, message } from "antd";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppPage, AppPageHeader, SectionHeader } from "@/components/AppPage";
import { ACCEPT_EXPLAIN, ProceedReasonModal } from "@/components/AssistantControlParts";
import { AssistantPanel, type AskRequest, type ProposalActionResult, type ProposalSync } from "@/components/AssistantPanel";
import { ChecksPanel } from "@/components/ChecksPanel";
import { CodeReviewPanel, type ProposalReviewState, type SourceFile } from "@/components/CodeReviewPanel";
import { Details } from "@/components/Details";
import { FileTree } from "@/components/FileTree";
import { PipelineRail } from "@/components/PipelineRail";
import { PipelinesList } from "@/components/PipelinesList";
import { SitesTable } from "@/components/SitesTable";
import { StatusTag } from "@/components/StatusTag";
import { StartPipeline, type CreatedPipeline } from "@/components/StartPipeline";
import { acceptProposal, appliedPaths, getProposal, rejectProposal } from "@/lib/agent-proposal-client";
import { withThreadParam } from "@/lib/agent-thread-client";
import { publishRefusalText } from "@/lib/assistant-control-client";
import type { StartPath } from "@/lib/pipeline-start";
import { PreflightChecklist, PreflightApiError, failingCount, postWithChecklist, thingsToFix, usePreflight } from "@/components/PreflightChecklist";
import { computeStages, parseStageParam, type StageKey, type StageSummary } from "@/lib/pipeline-stage";
import { statusLabel, TERMS } from "@/lib/terms";
import { useStudyPermissions } from "@/lib/use-permissions";
import { ApiError, apiCall } from "@/lib/web-api";

type Version = {
  id: string;
  version: string;
  gitCommit: string | null;
  /** Set when the version's commit was accepted from an assistant proposal. */
  agentProposal?: { id: string; title: string | null } | null;
  imageDigest: string | null;
  validationStatus: string;
  publishedAt: string | null;
  publish: { status: string; summary: string | null; workflowId: string | null; step?: string | null; stepState?: string | null; waiting?: string | null } | null;
};
type Project = {
  id: string;
  name: string;
  giteaRepoUrl: string | null;
  defaultBranch: string;
  versions: Version[];
  /** Present once the server returns lineage columns; older responses omit them (shown as "Template"). */
  sourceKind?: "template" | "assistant" | "import" | "copy" | null;
  sourceRef?: string | null;
  parentProjectId?: string | null;
  parentVersion?: string | null;
};
type Site = {
  studySiteId: string;
  code: string;
  name: string;
  nvflareClientName: string;
  provisioned: boolean;
  kitReleased: boolean;
  kitImageDigest: string | null;
  /** Runner-reported image against the published one. */
  imageState?: "CURRENT" | "OUTDATED" | "NOT_REPORTED" | "UNKNOWN";
  needsNewKit?: boolean;
  imageFix?: string[];
  connected: boolean | null;
};
type Aggregator = {
  id: string;
  hostname: string | null;
  status: string;
  imageDigest: string | null;
  pipelineVersionId: string | null;
  lastError: string | null;
  reachable: boolean | null;
  error: string | null;
};
type Job = {
  id: string;
  status: string;
  nvflareJobId: string | null;
  createdAt: string;
  commandSummary: string | null;
  pipelineVersion: { id: string; version: string } | null;
  result: { id: string } | null;
};
type Overview = { aggregator: Aggregator | null; sites: Site[]; projects: Project[]; jobs: Job[]; can?: { approvePipeline: boolean; submitJob: boolean } };
type RoundRow = { round: number; sites: Array<{ site: string; numSamples: number; metrics: Record<string, number> }>; weighted: Record<string, number> };

const ASSISTANT_OPEN_KEY = "fedlify.workspace.assistantOpen";
const FILES_OPEN_KEY = "fedlify.workspace.filesOpen";
/** Status wording for the pipeline version table: says what the status is about (publishing). */
const PUBLISH_LABELS: Record<string, string> = { PASSED: "Published", FAILED: "Publishing failed", QUEUED: "Waiting to start", RUNNING: "In progress" };
const ACTIVE_JOB = new Set(["SUBMITTED", "SCHEDULED", "RUNNING"]);
const statusColor: Record<string, string> = {
  PASSED: "green",
  ACTIVE: "green",
  COMPLETED: "green",
  RUNNING: "blue",
  QUEUED: "blue",
  SUBMITTED: "blue",
  FAILED: "red",
  ABORTED: "orange",
  DRAFT: "default"
};

function short(value?: string | null, length = 12) {
  return value ? value.slice(0, length) : "—";
}

function digestLabel(digest?: string | null) {
  return digest ? `…${digest.split("@sha256:")[1]?.slice(0, 12) ?? short(digest)}` : "—";
}

export default function StudyProjectsPage() {
  const { studyId } = useParams<{ studyId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(searchParams.get("project"));
  const [sourceCommit, setSourceCommit] = useState<string | null>(null);
  /** The commit the editor's files were actually read at; the base for a save's stale-write check. */
  const [loadedCommit, setLoadedCommit] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [view, setView] = useState<"workspace" | "pipelines" | "start">(searchParams.get("start") ? "start" : "workspace");
  const [startPath, setStartPath] = useState<StartPath | null>(null);
  const [copyFromId, setCopyFromId] = useState<string | null>(null);
  const [startKey, setStartKey] = useState(0);
  const [startPrompt, setStartPrompt] = useState<{ id: number; text: string; mode: "ask" | "propose" } | null>(null);
  const [rounds, setRounds] = useState(5);
  const [minClients, setMinClients] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [progress, setProgress] = useState<{ jobId: string; nvflareStatus: string | null; rounds: RoundRow[] } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollGeneration = useRef(0);
  // A link can open a stage directly (?stage=publish|sites|run), for example from the Summary page.
  const [activeStage, setActiveStage] = useState<StageKey>(() => parseStageParam(searchParams.get("stage")));
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [repoPaths, setRepoPaths] = useState<string[]>([]);
  const [sourceStatus, setSourceStatus] = useState<"loading" | "ready" | "error">("loading");
  const [filesStatus, setFilesStatus] = useState<"loading" | "ready" | "error">("loading");
  const sourceSeq = useRef(0);
  const [expandedRounds, setExpandedRounds] = useState<readonly Key[]>([]);
  const [dirtyPath, setDirtyPath] = useState<string | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [assistantExpanded, setAssistantExpanded] = useState(false);
  const [filesOpen, setFilesOpen] = useState(true);
  const [workspaceFullScreen, setWorkspaceFullScreen] = useState(false);
  const [askRequest, setAskRequest] = useState<AskRequest | null>(null);
  const [conflict, setConflict] = useState<{ file: SourceFile; content: string } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [review, setReview] = useState<ProposalReviewState | null>(null);
  /** Set when the server wants a reason before saving a change the second check did not pass (enforced studies). */
  const [reviewReason, setReviewReason] = useState<{ id: string; paths: string[]; note: string } | null>(null);
  const [proposalSync, setProposalSync] = useState<ProposalSync | null>(null);
  /** Open assistant chat, kept in the URL (?thread=) so a reload or a shared link returns to it. Read once; the panel restores the last chat otherwise. */
  const initialThreadId = useRef(searchParams.get("thread")).current;
  const syncThreadParam = useCallback((id: string | null) => {
    if (typeof window === "undefined") return;
    const search = withThreadParam(window.location.search, id);
    if (search !== window.location.search) window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
  }, []);
  const syncCounter = useRef(0);
  const editorControl = useRef<{ save: () => void; hasEdits: () => boolean } | null>(null);
  const askCounter = useRef(0);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(ASSISTANT_OPEN_KEY);
      if (saved !== null) setAssistantOpen(saved === "true");
      else if (window.innerWidth < 1280) setAssistantOpen(false);
    } catch {
      // Storage is optional.
    }
  }, []);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(FILES_OPEN_KEY) === "false") setFilesOpen(false);
    } catch {
      // Ignore unavailable storage.
    }
  }, []);

  function toggleFiles() {
    setFilesOpen((current) => {
      try {
        window.localStorage.setItem(FILES_OPEN_KEY, String(!current));
      } catch {
        // Ignore unavailable storage.
      }
      return !current;
    });
  }

  function toggleAssistant() {
    setAssistantOpen((current) => {
      try {
        window.localStorage.setItem(ASSISTANT_OPEN_KEY, String(!current));
      } catch {
        // Ignore unavailable storage.
      }
      return !current;
    });
  }

  const load = useCallback(async () => {
    try {
      const body = await apiCall<Overview>(`/api/v1/studies/${studyId}/aggregator`);
      setOverview(body);
      setLoadError(null);
      setProjectId((current) => (current && body.projects.some((item) => item.id === current) ? current : (body.projects[0]?.id ?? null)));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load the study pipeline.");
    }
  }, [studyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const project = overview?.projects.find((item) => item.id === projectId) ?? null;
  const publishInFlight = project?.versions.some((version) => version.publish && ["QUEUED", "RUNNING"].includes(version.publish.status)) ?? false;
  const activeJob = overview?.jobs.find((job) => ACTIVE_JOB.has(job.status)) ?? null;
  const liveVersion = project?.versions.find((version) => version.id === overview?.aggregator?.pipelineVersionId) ?? null;
  const connectedCount = overview?.sites.filter((site) => site.connected).length ?? 0;

  const aggregatorActive = overview?.aggregator?.status === "ACTIVE";
  const runBlockers = [
    !aggregatorActive ? "The study server is not running yet. Publish a pipeline version first." : null,
    aggregatorActive && connectedCount === 0 ? "No site is connected. A site connects when its runner is started." : null,
    activeJob ? "A run is already in progress." : null
  ].filter((item): item is string => Boolean(item));

  // Checklists for Publish and Start run. They reload with the overview (after a save, a publish, a run, and on polling).
  const publishCheck = usePreflight(studyId, "publish", { projectId: projectId ?? undefined, commit: sourceCommit ?? undefined }, Boolean(projectId), `${overview ? 1 : 0}:${overview?.jobs[0]?.status}:${sourceCommit}:${project?.versions[0]?.publish?.status}`);
  const runCheck = usePreflight(
    studyId,
    "run",
    {
      pipelineVersionId: overview?.aggregator?.pipelineVersionId ?? undefined,
      studySiteIds: connectedCount > 0 ? overview?.sites.filter((site) => site.connected).map((site) => site.studySiteId).join(",") : undefined,
      minClients: String(minClients ?? connectedCount)
    },
    Boolean(overview),
    `${overview?.jobs[0]?.status}:${overview?.aggregator?.status}:${connectedCount}`
  );
  const publishFailing = failingCount(publishCheck.result);
  const runFailing = failingCount(runCheck.result);
  // Until the overview says otherwise a person may act; the server still decides.
  const { can: studyCan, loading: permissionsLoading } = useStudyPermissions(studyId);
  const mayPublish = permissionsLoading ? (overview?.can?.approvePipeline ?? true) : Boolean(studyCan.approvePipeline);
  const mayRun = permissionsLoading ? (overview?.can?.submitJob ?? true) : Boolean(studyCan.submitJob);
  const mayStop = permissionsLoading ? true : Boolean(studyCan.abortJob);
  const maySaveModel = permissionsLoading ? true : Boolean(studyCan.manage || studyCan.approveRelease);
  const publishBlocked = publishCheck.result ? !publishCheck.result.ok : false;
  const runBlocked = Boolean(activeJob) || (runCheck.result ? !runCheck.result.ok : runCheck.error ? runBlockers.length > 0 : true);

  // What the assistant panel turns into a failure notice and quick prompts. Keys change when a new attempt fails.
  const latestPublish = project?.versions[0];
  const assistantFailures = {
    publish: latestPublish?.publish?.status === "FAILED" ? `publish:${latestPublish.id}:${latestPublish.publish.workflowId ?? ""}` : null,
    publishCommit: latestPublish?.publish?.status === "FAILED" ? latestPublish.gitCommit : null,
    run: overview?.jobs[0] && ["FAILED", "REJECTED"].includes(overview.jobs[0].status) ? `run:${overview.jobs[0].id}` : null
  };
  const unconnectedSites = aggregatorActive ? (overview?.sites.filter((site) => site.connected === false).map((site) => site.code) ?? []) : [];

  // Keep the page live while something is moving (publish, run).
  useEffect(() => {
    if (!publishInFlight && !activeJob) return;
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [publishInFlight, activeJob, load]);

  const followJob = useCallback(
    (jobId: string) => {
      if (pollRef.current) clearInterval(pollRef.current);
      // A tick already in flight for a previous job must not touch state or the new job's timer.
      const generation = ++pollGeneration.current;
      const tick = async () => {
        try {
          const body = await apiCall<{ job: Job; nvflareStatus: string | null; rounds: RoundRow[] }>(`/api/v1/nvflare/jobs/${jobId}/progress`);
          if (generation !== pollGeneration.current) return;
          setProgress({ jobId, nvflareStatus: body.nvflareStatus, rounds: body.rounds });
          if (!ACTIVE_JOB.has(body.job.status) && pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
            void load();
          }
        } catch (error) {
          if (generation !== pollGeneration.current) return;
          message.error(error instanceof Error ? error.message : "Could not read run progress.");
        }
      };
      void tick();
      pollRef.current = setInterval(tick, 5_000);
    },
    [load]
  );

  useEffect(() => {
    const latest = overview?.jobs[0];
    if (latest && (!progress || progress.jobId !== latest.id) && latest.nvflareJobId) followJob(latest.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview?.jobs[0]?.id]);

  useEffect(
    () => () => {
      pollGeneration.current += 1;
      if (pollRef.current) clearInterval(pollRef.current);
    },
    []
  );

  const loadSourceCommit = useCallback(async () => {
    if (!projectId) return;
    // Only the newest request may write state: a slow answer for a previous project or reload is dropped.
    const seq = ++sourceSeq.current;
    setSourceStatus("loading");
    try {
      const body = await apiCall<{ commit: string | null }>(`/api/v1/studies/${studyId}/pipeline-projects/${projectId}/source`);
      if (seq !== sourceSeq.current) return;
      setSourceCommit(body.commit);
      setSourceStatus("ready");
    } catch {
      if (seq !== sourceSeq.current) return;
      setSourceCommit(null);
      setSourceStatus("error");
    }
  }, [projectId, studyId]);

  useEffect(() => {
    setFilesStatus("loading");
    void loadSourceCommit();
    return () => {
      sourceSeq.current += 1;
    };
  }, [loadSourceCommit, reloadKey]);

  async function save(file: SourceFile, content: string, baseCommit: string | null = loadedCommit ?? sourceCommit) {
    if (!projectId) return;
    setSaving(true);
    try {
      const body = await apiCall<{ commitSha: string; changed: number }>(`/api/v1/studies/${studyId}/pipeline-projects/${projectId}/save`, {
        method: "POST",
        body: JSON.stringify({ baseCommit: baseCommit ?? undefined, message: `Edit ${file.path}`, files: [{ path: file.path, content }] })
      });
      message.success(body.changed ? `Saved ${file.path}.` : "No changes to save.");
      setConflict(null);
      setReloadKey((key) => key + 1);
    } catch (error) {
      if (error instanceof ApiError && error.code === "save_conflict") setConflict({ file, content });
      else message.error(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function openProposalReview(id: string) {
    if (!projectId) return;
    const result = await getProposal(studyId, projectId, id);
    if (!result.ok) {
      message.error(result.message);
      return;
    }
    const { proposal } = result;
    const applied = appliedPaths(proposal);
    setReview({
      id: proposal.id,
      title: proposal.title,
      status: proposal.status,
      baseCommit: proposal.baseCommit,
      files: proposal.files,
      acceptedCommit: proposal.acceptedCommit,
      baseUnavailable: proposal.baseUnavailable,
      // Every file starts selected; the person can reject any of them before committing. A decided proposal shows what was applied.
      accepted: Object.fromEntries(proposal.files.map((file) => [file.path, proposal.status === "ACCEPTED" ? applied.has(file.path) : true])),
      busy: false
    });
    setActiveStage("code");
  }

  useEffect(() => {
    setReview(null);
  }, [projectId]);

  function announceProposal(id: string, status: ProposalSync["status"], commit: string | null, paths: string[] | null = null) {
    syncCounter.current += 1;
    setProposalSync({ id, status, commit, paths, nonce: syncCounter.current });
  }

  async function decideProposalAccept(id: string, paths?: string[], proceedReason?: string): Promise<ProposalActionResult> {
    if (!projectId) return { ok: false, status: 0, code: "no_project", message: "No pipeline is open.", details: [], stale: false };
    if (dirtyPath) {
      const result: ProposalActionResult = { ok: false, status: 0, code: "unsaved_edit", message: `Save or discard your edit to ${dirtyPath} first; accepting reloads the files.`, details: [], stale: false };
      message.warning(result.message);
      return result;
    }
    const result = await acceptProposal(studyId, projectId, id, paths, proceedReason);
    if (result.ok) {
      message.success(`Saved ${result.changed} file(s). Nothing was published or run.`);
      if (result.approvalWarning) message.warning(result.approvalWarning);
      announceProposal(id, "ACCEPTED", result.commitSha, paths ?? null);
      setReview(null);
      setReloadKey((key) => key + 1);
      void load();
      return { ok: true, commitSha: result.commitSha };
    }
    if (result.code === "second_check_reason_required") {
      // The caller asks the person why they are going ahead and sends the request again; no error toast.
      return result;
    }
    if (result.stale) {
      message.warning(result.message);
      announceProposal(id, "STALE", null);
      setReview((current) => (current?.id === id ? { ...current, status: "STALE", busy: false } : current));
    } else {
      message.error([result.message, ...result.details].join(" "));
    }
    return result;
  }

  async function decideProposalReject(id: string) {
    if (!projectId) return { ok: false as const, status: 0, code: "no_project", message: "No pipeline is open.", details: [], stale: false };
    const result = await rejectProposal(studyId, projectId, id);
    if (result.ok) {
      announceProposal(id, "REJECTED", null);
      setReview((current) => (current?.id === id ? null : current));
    } else {
      message.error(result.message);
    }
    return result.ok ? { ok: true as const } : result;
  }

  async function saveOnTopOfLatest() {
    if (!conflict || !projectId) return;
    try {
      const latest = await apiCall<{ commit: string | null }>(`/api/v1/studies/${studyId}/pipeline-projects/${projectId}/source`);
      await save(conflict.file, conflict.content, latest.commit);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Could not read the latest saved code.");
    }
  }

  async function publish() {
    if (!projectId) return;
    setPublishing(true);
    try {
      const body = await postWithChecklist<{ pipelineVersion: { version: string }; deployment: { hostname: string; provision: boolean } }>(
        `/api/v1/studies/${studyId}/pipeline-projects/${projectId}/publish`,
        { commit: sourceCommit ?? undefined }
      );
      message.success(
        `Publishing ${body.pipelineVersion.version} to the study server${body.deployment.provision ? " (issuing site certificates)" : ""}.`
      );
      await load();
    } catch (error) {
      if (error instanceof PreflightApiError && error.items.length) {
        publishCheck.showItems(error.items);
        // The two-person rule explains itself in plain words: say who else can publish instead of the generic line.
        message.warning(publishRefusalText(error.code, error.message) ?? "Not published yet. Fix the items in the checklist first.", publishRefusalText(error.code, error.message) ? 8 : undefined);
      } else {
        message.error(error instanceof Error ? error.message : "Publish failed.");
        publishCheck.refresh();
      }
    } finally {
      setPublishing(false);
    }
  }

  /** The workspace unmounts when another view opens, so an unsaved edit needs the same confirmation as switching files. */
  function showView(next: "workspace" | "pipelines" | "start") {
    if (next === "workspace") return setView(next);
    confirmDiscard(() => {
      setDirtyPath(null);
      setView(next);
    });
  }

  function openStart(path: StartPath | null = null, copyId: string | null = null) {
    setStartPath(path);
    setCopyFromId(copyId);
    setStartKey((key) => key + 1);
    showView("start");
  }

  async function pipelineCreated(created: CreatedPipeline) {
    setProjectId(created.projectId);
    // Fresh workspace for the new project: nothing carries over from the previous one.
    setDirtyPath(null);
    setSelectedPath(null);
    setRepoPaths([]);
    setSourceCommit(null);
    setLoadedCommit(null);
    setAskRequest(null);
    setActiveStage("code");
    if (created.startPrompt) setStartPrompt({ id: Date.now(), ...created.startPrompt });
    await load();
    setProjectId(created.projectId);
    setView("workspace");
    if (created.warning) message.warning(created.warning, 8);
    else message.success("Pipeline created. Nothing was published or run.");
  }

  async function startRun() {
    if (!overview?.aggregator?.pipelineVersionId) return;
    setStarting(true);
    setRunError(null);
    try {
      const body = await postWithChecklist<{ job: Job }>(`/api/v1/studies/${studyId}/nvflare/jobs`, {
        pipelineVersionId: overview.aggregator.pipelineVersionId,
        studySiteIds: overview.sites.filter((site) => site.connected).map((site) => site.studySiteId),
        runtimeParameters: { numRounds: rounds, minClients: minClients ?? connectedCount },
        commandSummary: `Started from the project workspace: ${rounds} rounds.`
      });
      message.success("Run started.");
      setActiveStage("run");
      await load();
      followJob(body.job.id);
    } catch (error) {
      setActiveStage("run");
      if (error instanceof PreflightApiError && error.items.length) {
        runCheck.showItems(error.items);
        message.warning("The run was not started. Fix the items in the checklist first.");
      } else {
        setRunError(error instanceof Error ? error.message : "Could not start the run.");
        runCheck.refresh();
      }
    } finally {
      setStarting(false);
    }
  }

  async function abortRun(jobId: string) {
    try {
      await apiCall(`/api/v1/nvflare/jobs/${jobId}/abort`, { method: "POST", body: JSON.stringify({ reason: "Stopped from the project workspace." }) });
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Could not stop the run.");
    }
  }

  async function syncResult(jobId: string) {
    try {
      await apiCall(`/api/v1/nvflare/jobs/${jobId}/results/sync`, { method: "POST", body: "{}" });
      message.success("Model saved.");
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Could not save the model.");
    }
  }

  const metricKeys = useMemo(() => [...new Set((progress?.rounds ?? []).flatMap((row) => Object.keys(row.weighted)))], [progress]);

  const { current: currentStage, stages } = useMemo(
    () =>
      computeStages({
        hasProject: Boolean(project),
        unsavedFiles: dirtyPath ? 1 : 0,
        sourceCommit,
        sourceStatus,
        versions: project?.versions ?? [],
        aggregator: overview?.aggregator ?? null,
        sites: overview?.sites ?? [],
        jobs: overview?.jobs ?? [],
        busy: { saving, publishing, starting },
        activeStage
      }),
    [project, dirtyPath, sourceCommit, sourceStatus, overview, saving, publishing, starting, activeStage]
  );

  // A stage whose checklist has failing items offers no action; it says how many things to fix instead.
  const railStages = useMemo(
    () =>
      stages.map((stage) => {
        const failing = stage.action?.key === "publish" ? publishFailing : stage.action?.key === "start_run" ? runFailing : 0;
        return failing > 0 ? { ...stage, action: undefined, detail: thingsToFix(failing), tone: "warn" as const } : stage;
      }),
    [stages, publishFailing, runFailing]
  );

  /** Run `proceed` now, or after the user agrees to discard the unsaved edit. */
  function confirmDiscard(proceed: () => void) {
    if (!dirtyPath) return proceed();
    Modal.confirm({
      title: "Discard unsaved edits?",
      content: `${dirtyPath} has edits that are not saved. Leaving or switching away discards them.`,
      okText: "Discard and continue",
      okButtonProps: { danger: true },
      cancelText: "Keep editing",
      onOk: proceed
    });
  }

  /** Navigate away, asking first when there is an unsaved edit. */
  function leaveTo(href: string) {
    confirmDiscard(() => router.push(href));
  }

  useEffect(() => {
    if (!dirtyPath) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirtyPath]);

  function selectFile(path: string) {
    if (path === selectedPath) return setActiveStage("code");
    confirmDiscard(() => {
      setDirtyPath(null);
      setSelectedPath(path);
      setActiveStage("code");
    });
  }

  function selectProject(id: string) {
    if (id === projectId) return;
    confirmDiscard(() => {
      setDirtyPath(null);
      setSelectedPath(null);
      setRepoPaths([]);
      sourceSeq.current += 1;
      setFilesStatus("loading");
      setSourceStatus("loading");
      setSourceCommit(null);
      setLoadedCommit(null);
      setAskRequest(null);
      setStartPrompt(null);
      setProjectId(id);
    });
  }

  function requestPublish() {
    if (publishBlocked || !mayPublish) return;
    Modal.confirm({
      title: dirtyPath ? "Publish without your unsaved edits?" : "Publish the latest saved code?",
      content: (
        <>
          <p>This turns the latest saved code into a new pipeline version and starts, or restarts, the study server.</p>
          <p>
            Sites will need to update to the new code version before the next run.
            {dirtyPath ? " Your unsaved edit is not included." : ""}
          </p>
        </>
      ),
      okText: "Publish",
      onOk: () => publish()
    });
  }

  function requestRun() {
    if (runBlocked || !mayRun) return;
    const sitesNow = connectedCount === 1 ? "1 connected site" : `${connectedCount} connected sites`;
    Modal.confirm({
      title: "Start this run?",
      content: (
        <>
          <p>
            This starts a run of {rounds} {rounds === 1 ? "round" : "rounds"} on {sitesNow}, using the published pipeline version.
          </p>
          <p>Only model weights and summary results leave the sites.</p>
        </>
      ),
      okText: "Start run",
      onOk: () => startRun()
    });
  }

  function handleStageAction(stage: StageSummary) {
    const action = stage.action;
    if (!action) return;
    const lastJob = overview?.jobs[0];
    switch (action.key) {
      case "new_project":
        return openStart();
      case "save":
        setActiveStage("code");
        return editorControl.current?.save();
      case "publish":
        setActiveStage("publish");
        return requestPublish();
      case "release_kit": {
        // Same predicate as computeStages: a kit must be replaced only when the image moved to another registry location.
        const target =
          overview?.sites.find((site) => !site.kitReleased) ??
          overview?.sites.find((site) => site.kitReleased && site.needsNewKit);
        if (target) leaveTo(`/sites/${target.studySiteId}`);
        return;
      }
      case "setup_run":
        return setActiveStage("run");
      case "start_run":
        return requestRun();
      case "save_model":
        if (lastJob) void syncResult(lastJob.id);
        return;
    }
  }

  const publishPanel = project ? (
    <Card>
      <SectionHeader
        title="Publish"
        description="Turn the latest saved code into a pipeline version, prepare it for the sites, and start the study server."
        actions={
          <Space wrap>
            {project.giteaRepoUrl ? (
              <Button icon={<LinkOutlined />} href={project.giteaRepoUrl} target="_blank">
                {TERMS.openRepository}
              </Button>
            ) : null}
            {publishInFlight ? null : (
              <Tooltip title={!mayPublish ? "Ask a study lead to publish the pipeline." : activeJob ? "A run is in progress; publishing restarts the study server." : sourceCommit ? `Commit ${short(sourceCommit, 8)}` : undefined}>
                <Button type="primary" icon={<CloudUploadOutlined />} loading={publishing} disabled={!mayPublish || Boolean(activeJob) || !sourceCommit || publishBlocked} onClick={requestPublish}>
                  {sourceStatus === "loading" && !sourceCommit ? "Publish" : TERMS.publishLatest}
                </Button>
              </Tooltip>
            )}
          </Space>
        }
      />
      {!sourceCommit && sourceStatus === "loading" ? <Typography.Paragraph type="secondary">Loading the saved code…</Typography.Paragraph> : null}
      {!sourceCommit && sourceStatus === "error" ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message="Could not read the saved code" description="Publish is unavailable until the code loads. Reload the page to try again." /> : null}
      {publishInFlight ? null : (
        <PreflightChecklist title="Before you publish" result={publishCheck.result} loading={publishCheck.loading} error={publishCheck.error} onRetry={publishCheck.refresh} />
      )}
      <Table<Version>
        size="small"
        rowKey="id"
        pagination={false}
        scroll={{ x: "max-content" }}
        dataSource={project.versions}
        locale={{ emptyText: "Not published yet." }}
        columns={[
          {
            title: TERMS.pipelineVersion,
            dataIndex: "version",
            render: (value: string, row) => (
              <Space size={4} wrap>
                {value}
                {row.id === overview?.aggregator?.pipelineVersionId ? <Tag color="green">Live</Tag> : null}
                {row.agentProposal ? (
                  <Tooltip title={`This code was written by the assistant and accepted by a person${row.agentProposal.title ? `: ${row.agentProposal.title}` : ""}.`}>
                    <Tag color="purple">Assistant</Tag>
                  </Tooltip>
                ) : null}
              </Space>
            )
          },
          {
            title: "Status",
            render: (_, row) => {
              const inProgress = row.publish && ["QUEUED", "RUNNING"].includes(row.publish.status);
              return (
                <div>
                  <StatusTag value={row.publish?.status ?? row.validationStatus} label={row.publish ? PUBLISH_LABELS[row.publish.status] : row.validationStatus === "VALIDATED" ? "Checked, not published yet" : undefined} />
                  {inProgress && row.publish?.waiting ? (
                    <div>
                      <Typography.Text type="warning">{row.publish.waiting}</Typography.Text>
                    </div>
                  ) : null}
                  {row.publish?.status === "FAILED" ? (
                    <div>
                      <Typography.Text type="danger">Publishing did not finish. Open Details for the technical message.</Typography.Text>
                    </div>
                  ) : null}
                </div>
              );
            }
          },
          { title: "Published", dataIndex: "publishedAt", render: (value: string | null) => (value ? new Date(value).toLocaleString() : "—") },
          {
            title: TERMS.details,
            render: (_, row) => (
              <Details
                modalTitle={`Pipeline version ${row.version}`}
                items={[
                  { label: "Commit", value: <code>{short(row.gitCommit, 8)}</code>, copyText: row.gitCommit ?? undefined },
                  { label: "Image digest", value: <code>{digestLabel(row.imageDigest)}</code>, copyText: row.imageDigest ?? undefined },
                  ...(row.publish?.step ? [{ label: "Step", value: `${row.publish.step}${row.publish.stepState === "pending" ? " (starting)" : ""}` }] : []),
                  ...(row.publish?.summary ? [{ label: "Message", value: row.publish.summary }] : [])
                ]}
              />
            )
          }
        ]}
      />
    </Card>
  ) : null;

  const sitesPanel = (
    <Card>
      <SectionHeader
        title="Study server and sites"
        description={
          overview?.aggregator?.hostname
            ? "Each site connects using the site kit from its site page. Nothing needs to connect in to the site."
            : "The study server is created on the first publish."
        }
        actions={
          overview?.aggregator ? (
            <Space>
              <StatusTag value={overview.aggregator.status} />
              {liveVersion ? <Tag>Running {liveVersion.version}</Tag> : null}
            </Space>
          ) : null
        }
      />
      {overview?.aggregator?.hostname ? <Details items={[{ label: "Study server address", value: <code>{overview.aggregator.hostname}:443</code>, copyText: overview.aggregator.hostname }]} /> : null}
      {overview?.aggregator?.lastError ? <Alert type="warning" showIcon message={overview.aggregator.lastError} style={{ marginBottom: 12 }} /> : null}
      {overview?.aggregator?.error ? <Alert type="error" showIcon message={overview.aggregator.error} style={{ marginBottom: 12 }} /> : null}
      <SitesTable
        studyId={studyId}
        onNavigate={leaveTo}
        liveConnection={overview ? Object.fromEntries(overview.sites.map((site) => [site.studySiteId, site.connected])) : undefined}
        refreshKey={`${overview?.aggregator?.status ?? ""}:${overview?.aggregator?.imageDigest ?? ""}:${(overview?.sites ?? []).map((site) => `${site.studySiteId}=${site.connected}/${site.imageState}`).join(",")}`}
      />
    </Card>
  );

  const runPanel = (
    <Card>
      <SectionHeader
        title="Run"
        description="Runs the published version on the connected sites. Only model weights and aggregate metrics leave the sites."
        actions={
          <Space wrap>
            <span>Rounds</span>
            <InputNumber min={1} max={1000} value={rounds} onChange={(value) => setRounds(Number(value) || 1)} />
            <span>Min sites</span>
            <InputNumber min={1} max={Math.max(1, connectedCount)} value={minClients ?? connectedCount} onChange={(value) => setMinClients(Number(value) || 1)} />
            <Tooltip title={mayRun ? undefined : "Ask a study lead to start the run."}>
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                loading={starting}
                disabled={runBlocked || !mayRun}
                onClick={requestRun}
              >
                Start run
              </Button>
            </Tooltip>
          </Space>
        }
      />
      {activeJob ? <Alert type="info" showIcon style={{ marginBottom: 12 }} message="A run is already in progress." /> : null}
      <PreflightChecklist title="Before you start" result={runCheck.result} loading={runCheck.loading} error={runCheck.error} onRetry={runCheck.refresh} />
      {runError ? <Alert type="error" showIcon closable onClose={() => setRunError(null)} message="The run was not started" description={runError} style={{ marginBottom: 12 }} /> : null}
      {progress ? (
        <>
          <Typography.Paragraph type="secondary">
            Run status: <Tag>{statusLabel(progress.nvflareStatus ?? "pending")}</Tag> {progress.rounds.length} round(s) reported.
          </Typography.Paragraph>
          <Table<RoundRow>
            size="small"
            rowKey="round"
            pagination={false}
            tableLayout="auto"
            className="fedlify-run-table"
            dataSource={progress.rounds}
            locale={{ emptyText: "Waiting for the first round." }}
            expandable={{
              expandedRowKeys: expandedRounds,
              onExpandedRowsChange: (keys) => setExpandedRounds(keys),
              rowExpandable: (row) => row.sites.length > 0,
              expandedRowRender: (row) => (
                <Space direction="vertical" size={2}>
                  {row.sites.map((site) => (
                    <div key={site.site}>
                      <strong>{site.site}</strong> <span className="fedlify-muted">n={site.numSamples}</span>:{" "}
                      {Object.entries(site.metrics).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(" · ") || "no metrics"}
                    </div>
                  ))}
                </Space>
              )
            }}
            columns={[
              { title: "Round", dataIndex: "round", width: 64 },
              ...metricKeys.map((key) => ({
                title: key,
                ellipsis: true,
                render: (_: unknown, row: RoundRow) => (row.weighted[key] != null ? row.weighted[key].toFixed(4) : "—")
              }))
            ]}
          />
        </>
      ) : null}
      <Table<Job>
        size="small"
        rowKey="id"
        pagination={false}
        tableLayout="auto"
        className="fedlify-run-table"
        style={{ marginTop: 16 }}
        dataSource={overview?.jobs ?? []}
        locale={{ emptyText: "No runs yet." }}
        columns={[
          {
            title: "Run",
            render: (_, row) => (
              <div>
                <div>{new Date(row.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
                <span className="fedlify-muted">
                  <span title={row.nvflareJobId ? `Run ID ${row.nvflareJobId}` : undefined}>{row.pipelineVersion ? `Pipeline version ${row.pipelineVersion.version}` : "—"}</span>
                </span>
              </div>
            )
          },
          { title: "Status", dataIndex: "status", width: 110, render: (value: string) => <StatusTag value={value} /> },
          {
            title: "",
            width: 120,
            render: (_, row) => (
              <Space direction="vertical" size={4} align="end">
                <Button size="small" onClick={() => followJob(row.id)} disabled={!row.nvflareJobId}>
                  Metrics
                </Button>
                {ACTIVE_JOB.has(row.status) && mayStop ? (
                  <Button size="small" danger icon={<StopOutlined />} onClick={() => void abortRun(row.id)}>
                    Stop
                  </Button>
                ) : null}
                {row.status === "COMPLETED" && !row.result && maySaveModel ? (
                  <Button size="small" onClick={() => void syncResult(row.id)}>
                    Save model
                  </Button>
                ) : null}
                {row.result ? <Tag color="green">Model saved</Tag> : null}
                <Link href={`/studies/${studyId}/runs/${row.id}`}>Open run detail</Link>
              </Space>
            )
          }
        ]}
      />
    </Card>
  );

  return (
    <AppPage className="fedlify-ws-page">
      <AppPageHeader
        title="Code & run"
        subtitle={view === "workspace" ? undefined : "Edit the study code, publish it to the study server, connect the sites, and run the study."}
        onBack={() => leaveTo(`/studies/${studyId}`)}
        backLabel="Study"
        actions={
          <Space wrap>
            {overview && overview.projects.length > 0 ? (
              <>
                <Select
                  style={{ minWidth: 220 }}
                  placeholder="Switch pipeline"
                  aria-label="Switch pipeline"
                  value={projectId ?? undefined}
                  options={(overview?.projects ?? []).map((item) => ({ value: item.id, label: item.name }))}
                  onChange={(id) => {
                    selectProject(id);
                    setView("workspace");
                  }}
                />
                <Button type={view === "pipelines" ? "primary" : "default"} icon={<UnorderedListOutlined />} onClick={() => showView(view === "pipelines" ? "workspace" : "pipelines")}>
                  Pipelines ({overview.projects.length})
                </Button>
              </>
            ) : null}
            {overview ? (
              <Button icon={<PlusOutlined />} onClick={() => openStart()}>
                New pipeline
              </Button>
            ) : null}
            <Button icon={<ReloadOutlined />} onClick={() => void load()} aria-label="Refresh" />
          </Space>
        }
      />

      {loadError ? (
        <Alert
          type="error"
          showIcon
          message={loadError}
          style={{ marginBottom: 16 }}
          action={
            <Button size="small" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      ) : null}

      {!overview ? (
        loadError ? null : (
          <Card>
            <div style={{ textAlign: "center", padding: 32 }}>
              <Spin tip="Loading the study pipeline" />
            </div>
          </Card>
        )
      ) : overview.projects.length === 0 || view === "start" ? (
        <StartPipeline
          key={startKey}
          studyId={studyId}
          projects={overview.projects}
          liveVersionId={overview.aggregator?.pipelineVersionId ?? null}
          jobs={overview.jobs}
          initialPath={startPath}
          initialCopyProjectId={copyFromId}
          onCancel={overview.projects.length > 0 ? () => setView("workspace") : undefined}
          onCreated={(created) => void pipelineCreated(created)}
        />
      ) : null}

      {overview && view === "pipelines" && overview.projects.length > 0 ? (
        <Card data-testid="pipelines-list">
          <SectionHeader
            title="Pipelines"
            description="Every pipeline in this study. Open one to edit, publish and run it; Copy starts a new pipeline from it."
            actions={
              <Button icon={<PlusOutlined />} onClick={() => openStart()}>
                New pipeline
              </Button>
            }
          />
          <PipelinesList
            projects={overview.projects}
            liveVersionId={overview.aggregator?.pipelineVersionId}
            jobs={overview.jobs}
            openId={projectId}
            statusColor={statusColor}
            onOpen={(id) => {
              selectProject(id);
              setView("workspace");
            }}
            onCopy={(id) => openStart("copy", id)}
          />
        </Card>
      ) : null}

      {overview && project && view === "workspace" ? (
        <>
          <PipelineRail stages={railStages} activeStage={activeStage} currentStage={currentStage} onSelect={setActiveStage} onAction={handleStageAction} />

          <div className={["fedlify-ws-grid", assistantOpen ? "has-assistant" : "assistant-collapsed", filesOpen ? "" : "files-collapsed", workspaceFullScreen ? "is-fullscreen" : ""].join(" ")}>
            {filesOpen ? (
              <aside className="fedlify-ws-side" aria-label="Files and checks">
                <div className="fedlify-ws-section-title">
                  <strong>Files</strong>
                  <span className="fedlify-ws-section-tools">
                    <span className="fedlify-muted">{filesStatus === "ready" ? repoPaths.length : filesStatus === "error" ? "error" : "…"}</span>
                    <Tooltip title="Collapse files">
                      <Button size="small" type="text" icon={<MenuFoldOutlined />} onClick={toggleFiles} aria-label="Collapse files" />
                    </Tooltip>
                  </span>
                </div>
                <FileTree paths={repoPaths} selectedPath={selectedPath} modifiedPaths={dirtyPath ? [dirtyPath] : []} onSelect={selectFile} />
                <ChecksPanel key={project.id} studyId={studyId} projectId={project.id} commit={sourceCommit} />
              </aside>
            ) : (
              <aside className="fedlify-ws-side is-collapsed" aria-label="Files (collapsed)">
                <Tooltip title="Open files" placement="right">
                  <Button type="text" icon={<MenuUnfoldOutlined />} onClick={toggleFiles} aria-label="Open files" />
                </Tooltip>
                <FolderOutlined className="fedlify-ws-assistant-glyph" />
                <span className="fedlify-ws-assistant-vertical">Files</span>
              </aside>
            )}

            <main className="fedlify-ws-centre">
              <div hidden={activeStage !== "code"} className="fedlify-ws-code">
                <CodeReviewPanel
                  fullScreen={workspaceFullScreen}
                  onFullScreenChange={setWorkspaceFullScreen}
                  contextNote="Each save is recorded. Publishing uses the last saved code."
                  hideHeader
                  hideExplorer
                  sourceUrl={`/api/v1/studies/${studyId}/pipeline-projects/${project.id}/source`}
                  title={project.name}
                  reloadKey={`${project.id}-${reloadKey}`}
                  savingDraft={saving}
                  editLabel="Edit"
                  saveLabel={TERMS.save}
                  selectedPath={selectedPath}
                  onSelectedPathChange={setSelectedPath}
                  onFilesLoaded={(files, commit) => {
                    setRepoPaths(files.map((file) => file.path));
                    setFilesStatus("ready");
                    setLoadedCommit(commit);
                  }}
                  onLoadError={() => {
                    setFilesStatus("error");
                    setLoadedCommit(null);
                  }}
                  onDirtyChange={setDirtyPath}
                  controlRef={editorControl}
                  proposalReview={review}
                  proposalForceFullWidth={assistantExpanded}
                  onProposalExitFullWidth={() => setAssistantExpanded(false)}
                  onProposalToggle={(path, accepted) => setReview((current) => (current ? { ...current, accepted: { ...current.accepted, [path]: accepted } } : current))}
                  onProposalAccept={() => {
                    if (!review) return;
                    const id = review.id;
                    const paths = review.files.filter((file) => review.accepted[file.path]).map((file) => file.path);
                    setReview((current) => (current ? { ...current, busy: true } : current));
                    void decideProposalAccept(id, paths).then((result) => {
                      if (!result.ok) setReview((current) => (current?.id === id ? { ...current, busy: false } : current));
                      if (!result.ok && result.code === "second_check_reason_required") setReviewReason({ id, paths, note: result.message });
                    });
                  }}
                  onProposalReject={() => {
                    if (!review) return;
                    const id = review.id;
                    setReview((current) => (current ? { ...current, busy: true } : current));
                    void decideProposalReject(id).then((result) => {
                      if (!result.ok) setReview((current) => (current?.id === id ? { ...current, busy: false } : current));
                    });
                  }}
                  onProposalClose={() => setReview(null)}
                  onSaveDraft={(file, content) => void save(file, content)}
                  onAskAssistant={({ path, selection }) => {
                    askCounter.current += 1;
                    setAskRequest({ id: askCounter.current, path, selection });
                    setAssistantOpen(true);
                  }}
                />
              </div>
              {activeStage === "publish" ? publishPanel : null}
              {activeStage === "sites" ? sitesPanel : null}
              {activeStage === "run" ? runPanel : null}
            </main>

            <AssistantPanel
              key={project.id}
              studyId={studyId}
              projectId={project.id}
              commit={sourceCommit}
              focusFile={selectedPath}
              unsavedPaths={dirtyPath ? [dirtyPath] : []}
              open={assistantOpen}
              onToggle={toggleAssistant}
              askRequest={askRequest}
              onReviewProposal={(id) => void openProposalReview(id)}
              expanded={assistantExpanded}
              onExpandedChange={setAssistantExpanded}
              onAcceptProposal={decideProposalAccept}
              onRejectProposal={decideProposalReject}
              proposalSync={proposalSync}
              failures={assistantFailures}
              onOpenPublish={() => {
                setWorkspaceFullScreen(false);
                setActiveStage("publish");
              }}
              startPrompt={startPrompt}
              onStartPromptConsumed={(id) => setStartPrompt((current) => (current?.id === id ? null : current))}
              unconnectedSites={unconnectedSites}
              threadId={initialThreadId}
              onThreadChange={syncThreadParam}
            />
          </div>
        </>
      ) : null}

      <Modal
        title="This file changed since you opened it"
        open={Boolean(conflict)}
        onCancel={() => setConflict(null)}
        footer={[
          <Button key="keep" onClick={() => setConflict(null)}>
            Keep editing
          </Button>,
          <Button
            key="reload"
            onClick={() => {
              setConflict(null);
              setReloadKey((key) => key + 1);
            }}
          >
            Reload latest (discard my edit)
          </Button>,
          <Button key="overwrite" type="primary" danger loading={saving} onClick={() => void saveOnTopOfLatest()}>
            Save over latest
          </Button>
        ]}
      >
        <Typography.Paragraph>
          Someone else saved this pipeline after you opened it, so your save was not applied.
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary">
          &quot;Save over latest&quot; replaces <code>{conflict?.file.path}</code> with your version on top of the newest saved code. Other files are untouched. Reloading
          discards your edit.
        </Typography.Paragraph>
      </Modal>
      <ProceedReasonModal
        open={reviewReason !== null}
        title="Save this change?"
        explain={ACCEPT_EXPLAIN}
        note={reviewReason?.note}
        okText="Accept"
        onCancel={() => setReviewReason(null)}
        onConfirm={(reason) => {
          const ask = reviewReason;
          setReviewReason(null);
          if (!ask) return;
          setReview((current) => (current?.id === ask.id ? { ...current, busy: true } : current));
          void decideProposalAccept(ask.id, ask.paths, reason).then((result) => {
            if (!result.ok) setReview((current) => (current?.id === ask.id ? { ...current, busy: false } : current));
            if (!result.ok && result.code === "second_check_reason_required") setReviewReason({ id: ask.id, paths: ask.paths, note: result.message });
          });
        }}
      />
    </AppPage>
  );
}
