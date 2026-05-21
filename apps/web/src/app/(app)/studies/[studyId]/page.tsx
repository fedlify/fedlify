"use client";

import {
  AuditOutlined,
  CheckCircleOutlined,
  CloudDownloadOutlined,
  ClusterOutlined,
  CodeOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  EyeOutlined,
  FileTextOutlined,
  MailOutlined,
  MonitorOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  UploadOutlined
} from "@ant-design/icons";
import { Alert, Button, Form, Input, InputNumber, Select, Space, Tabs, Typography, Upload, message } from "antd";
import type { UploadFile } from "antd";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppPage, AppPageHeader, SectionHeader } from "@/components/AppPage";
import { CodeReviewPanel } from "@/components/CodeReviewPanel";
import { CardGrid, EntityCard, NavigationCard, NextActionCard, StatCard } from "@/components/DataCards";
import { ArtifactList, EntityActionMenu, EntityDetailView, FieldGrid, FieldRow, TimelineList } from "@/components/EntityDetail";
import { FormError } from "@/components/FormFeedback";
import { CardGridSkeleton, EmptyState, InlineLoadError } from "@/components/LoadStates";
import { StatusTag } from "@/components/StatusTag";
import { GateChecklist, WorkflowRail, type GateItem, type WorkflowStep } from "@/components/WorkflowRail";
import {
  CLINICAL_USE_CASE_OPTIONS,
  DATA_MODALITY_OPTIONS,
  INTENDED_USE_OPTIONS,
  governanceOptionLabel,
  normalizeMultiSelectValue,
  splitMultiSelectValue
} from "@/lib/governance-options";
import {
  getStudyWorkspaceSection,
  normalizeStudyWorkspaceSection,
  type StudyWorkspaceSection
} from "@/lib/study-workspace";
import { parseStudyDetailParam, serializeStudyDetailParam, type StudyDetailKind, type StudyDetailState } from "@/lib/study-detail";
import {
  activeDeployment,
  approvedPipelineVersions,
  connectedStudySites,
  protocolReadinessDetail,
  readyStudySites,
  resolveStudyNextAction,
  studyEthicsReady,
  studyProtocolReady,
  summaryReadinessItems,
  type SummaryReadinessState
} from "@/lib/study-summary";
import { chooseSelectedStudy, SELECTED_STUDY_EVENT, SELECTED_STUDY_STORAGE_KEY, type StudySummary } from "@/lib/studies";
import {
  WORKFLOW_TERMS,
  approvedTemplateCatalog,
  pipelineVersionState,
  templateScopeLabel,
  templateSourceLabel,
  templateVersionLabel
} from "@/lib/workflow-copy";

type EntityRecord = Record<string, any>;

type JobLogsPayload = {
  job?: EntityRecord;
  state?: EntityRecord;
  flareMeta?: EntityRecord | null;
  result?: EntityRecord | null;
  modelResult?: EntityRecord | null;
  logs?: EntityRecord[];
  runtimeLogs?: Array<{ container?: string; image?: string; status?: string; output?: string }>;
  events?: EntityRecord[];
  message?: string;
};

type StudyDetail = {
  id: string;
  title: string;
  description?: string;
  goal?: string;
  researchQuestion?: string;
  clinicalUseCase?: string;
  population?: string;
  dataModalities?: string;
  primaryOutcome?: string;
  riskLevel?: string;
  intendedUse?: string;
  governanceStatus?: string;
  status: string;
  organization: { id: string; name: string };
  members: Array<EntityRecord & { id: string; role: string; user: { id?: string; name?: string; email?: string } }>;
  invitations: EntityRecord[];
  ethics: EntityRecord[];
  documents: EntityRecord[];
  sites: Array<EntityRecord & { heartbeats?: EntityRecord[]; studySite?: EntityRecord }>;
  studySites: EntityRecord[];
  agentRuns: EntityRecord[];
  pipelineProjects: EntityRecord[];
  nvflareDeployments: EntityRecord[];
  nvflareJobs: EntityRecord[];
  releases: KitRelease[];
  modelReleases: EntityRecord[];
  auditEvents: EntityRecord[];
};

type KitArtifact = {
  id: string;
  filename: string;
  kind: string;
  checksum: string;
};

type KitRelease = {
  id: string;
  version: string;
  status: string;
  checksum: string;
  approvedAt?: string;
  artifacts?: KitArtifact[];
};

function uniqueValues(values: Array<string | undefined | null>) {
  return Array.from(new Set(values.filter(Boolean).map(String)));
}

function memberIdentityKey(member: EntityRecord) {
  return member.user?.id ?? member.user?.email ?? member.userId ?? member.id;
}

function groupedStudyMembers(members: StudyDetail["members"]) {
  const grouped = new Map<string, EntityRecord & { memberships: EntityRecord[]; roles: string[] }>();
  for (const member of members) {
    const key = String(memberIdentityKey(member));
    const existing =
      grouped.get(key) ??
      ({
        ...member,
        id: member.id,
        user: member.user,
        memberships: [],
        roles: []
      } as EntityRecord & { memberships: EntityRecord[]; roles: string[] });
    existing.memberships.push(member);
    existing.roles = uniqueValues([...existing.roles, member.role]);
    grouped.set(key, existing);
  }

  return Array.from(grouped.values()).sort((first, second) =>
    text(first.user?.name, first.user?.email).localeCompare(text(second.user?.name, second.user?.email))
  );
}

const CREATE_FORM_META = {
  invite: {
    title: "Add study member",
    subtitle: "Invite one person and assign one or more study roles.",
    backLabel: "Team and access"
  },
  ethics: {
    title: "Record ethics decision",
    subtitle: "Document the review status, approval identifier, responsible body, and notes.",
    backLabel: "Protocol"
  },
  document: {
    title: "Register study document",
    subtitle: "Add a protocol, ethics, policy, or agreement document for study governance.",
    backLabel: "Protocol"
  },
  site: {
    title: "Register participant site",
    subtitle: "Add the institution identity first. Data and resource profiles are completed from the site view.",
    backLabel: "Sites and data"
  },
  agent: {
    title: WORKFLOW_TERMS.createPipelineVersion,
    subtitle: "Select an approved template commit and create a study-specific pipeline version for review.",
    backLabel: "Pipeline"
  },
  job: {
    title: WORKFLOW_TERMS.submitFederatedRun,
    subtitle: "Run an approved pipeline version against ready participant sites through the Fedlify FLARE API wrapper.",
    backLabel: "Federated run"
  }
} as const;

async function sha256File(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function text(value: unknown, fallback = "Not set") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function status(value: unknown, fallback = "PENDING") {
  return typeof value === "string" && value ? value : fallback;
}

function formatDate(value: unknown) {
  if (!value || typeof value !== "string") return "Not recorded";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function displayEnum(value: unknown, fallback = "Not set") {
  if (!value || typeof value !== "string") return fallback;
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace("Pdf", "PDF")
    .replace("Nvflare", "NVFLARE");
}

const STUDY_ROLE_OPTIONS = [
  { value: "PRINCIPAL_INVESTIGATOR", label: "Principal Investigator" },
  { value: "STUDY_COORDINATOR", label: "Study Coordinator" },
  { value: "CLINICAL_LEAD", label: "Clinical Lead" },
  { value: "ETHICS_REVIEWER", label: "Ethics Reviewer" },
  { value: "DATA_SCIENTIST", label: "Data Scientist" },
  { value: "PIPELINE_DEVELOPER", label: "Pipeline Developer" },
  { value: "PRIVACY_SECURITY_OFFICER", label: "Privacy/Security Officer" },
  { value: "RELEASE_APPROVER", label: "Release Approver" },
  { value: "AUDITOR", label: "Auditor" }
];

function externalUrl(value: unknown) {
  return typeof value === "string" && /^https?:\/\//.test(value) ? value : undefined;
}

function giteaBranchUrl(repoUrl: unknown, branchName: unknown) {
  const repo = externalUrl(repoUrl);
  if (!repo || typeof branchName !== "string" || !branchName) return undefined;
  const encodedBranch = branchName.split("/").map(encodeURIComponent).join("/");
  return `${repo.replace(/\/$/, "")}/src/branch/${encodedBranch}`;
}

function shortCommit(value: unknown) {
  return typeof value === "string" && value ? value.slice(0, 12) : "None";
}

function repoLabel(project: EntityRecord) {
  if (project.giteaOwner && project.giteaRepo) return `${project.giteaOwner}/${project.giteaRepo}`;
  return text(project.giteaRepoUrl, "Repo not linked");
}

function renderGovernanceField(label: string, value: unknown, className?: string) {
  return (
    <div className={["fedlify-governance-field", className].filter(Boolean).join(" ")}>
      <span className="fedlify-governance-label">{label}</span>
      <span className="fedlify-governance-value">{text(value)}</span>
    </div>
  );
}

function renderGovernanceTags(label: string, values: string[]) {
  return (
    <div className="fedlify-governance-field">
      <span className="fedlify-governance-label">{label}</span>
      {values.length > 0 ? (
        <span className="fedlify-governance-tags">
          {values.map((value) => (
            <span key={value} className="fedlify-governance-tag">
              {value}
            </span>
          ))}
        </span>
      ) : (
        <span className="fedlify-governance-value">Not set</span>
      )}
    </div>
  );
}

function currentApprovedPipelineVersions(study?: StudyDetail | null) {
  return (study?.pipelineProjects ?? [])
    .flatMap((project) =>
      (project.versions ?? []).map((version: EntityRecord) => ({
        ...version,
        project
      }))
    )
    .filter((version) => version.approvalStatus === "APPROVED");
}

function currentValidatedPipelineVersions(study?: StudyDetail | null) {
  return (study?.pipelineProjects ?? [])
    .flatMap((project) =>
      (project.versions ?? []).map((version: EntityRecord) => ({
        ...version,
        project
      }))
    )
    .filter((version) => version.validationStatus === "PASSED");
}

function latestEthicsStatus(study?: StudyDetail | null) {
  return study?.ethics?.[0]?.status;
}

function ethicsGatePassed(study?: StudyDetail | null) {
  const latest = latestEthicsStatus(study);
  return latest === "APPROVED" || latest === "NOT_REQUIRED";
}

function activeDeploymentForStudy(study?: StudyDetail | null) {
  return study?.nvflareDeployments?.find((deployment) => deployment.active) ?? study?.nvflareDeployments?.[0];
}

function readySites(study?: StudyDetail | null) {
  return (study?.studySites ?? []).filter((site) => site.readinessChecks?.[0]?.status === "PASSED");
}

function connectedSites(study?: StudyDetail | null) {
  return (study?.studySites ?? []).filter((site) => site.nvflareStatuses?.[0]?.status === "CONNECTED");
}

function workflowState(passed: boolean, blocked = false): WorkflowStep["state"] {
  if (passed) return "done";
  return blocked ? "blocked" : "current";
}

function pipelineWorkflowSteps(study: StudyDetail): WorkflowStep[] {
  const validated = currentValidatedPipelineVersions(study);
  const approved = currentApprovedPipelineVersions(study);
  const latestProject = study.pipelineProjects?.[0];
  const latestProposal = latestProject?.proposals?.[0];
  return [
    {
      label: "Template commit selected",
      detail: latestProject ? templateSourceLabel(latestProject.template, latestProject.templateVersion) : "Choose an approved public or study template",
      state: workflowState(Boolean(latestProject))
    },
    {
      label: "Study source PR",
      detail: latestProposal?.giteaPullRequestUrl ? "Branch and pull request created" : "Fedlify creates a study-scoped branch and PR",
      state: workflowState(Boolean(latestProposal?.giteaPullRequestUrl), !latestProject),
      meta: latestProposal?.giteaHeadCommit ? `Commit ${String(latestProposal.giteaHeadCommit).slice(0, 12)}` : undefined
    },
    {
      label: "CI validation",
      detail: validated.length > 0 ? `${validated.length} version(s) passed validation` : "Validation must pass before approval",
      state: workflowState(validated.length > 0, !latestProposal)
    },
    {
      label: "Human approval",
      detail: approved.length > 0 ? `${approved.length} runnable pipeline version(s)` : "Reviewer approves exact commit",
      state: workflowState(approved.length > 0, validated.length === 0)
    }
  ];
}

function operationsWorkflowSteps(study: StudyDetail): WorkflowStep[] {
  const approvedVersions = currentApprovedPipelineVersions(study);
  const activeDeployment = activeDeploymentForStudy(study);
  const ready = readySites(study);
  const connected = connectedSites(study);
  const hasSubmittedJob = (study.nvflareJobs ?? []).some((job) => ["SUBMITTED", "SCHEDULED", "RUNNING", "COMPLETED"].includes(status(job.status)));
  return [
    {
      label: "Governance active",
      detail: ethicsGatePassed(study) ? "Study is eligible for runtime provisioning" : "Ethics approval or exemption required",
      state: workflowState(study.status === "ACTIVE" && ethicsGatePassed(study))
    },
    {
      label: "Approved pipeline",
      detail: approvedVersions.length > 0 ? `${approvedVersions.length} runnable version(s)` : "Approve a validated immutable commit",
      state: workflowState(approvedVersions.length > 0, study.status !== "ACTIVE")
    },
    {
      label: "Aggregator online",
      detail: activeDeployment?.serverAddress ? text(activeDeployment.serverAddress) : "Provision and start local Docker runtime",
      state: workflowState(activeDeployment?.status === "ACTIVE", approvedVersions.length === 0)
    },
    {
      label: "Sites joined",
      detail: `${connected.length} connected, ${ready.length} ready`,
      state: workflowState(connected.length > 0 && ready.length > 0, activeDeployment?.status !== "ACTIVE")
    },
    {
      label: "Federated run submitted",
      detail: hasSubmittedJob ? "Federated run recorded by Fedlify" : "Submit federated run after gates pass",
      state: workflowState(hasSubmittedJob, connected.length === 0 || ready.length === 0)
    }
  ];
}

function operationsGateItems(study: StudyDetail): GateItem[] {
  const approvedVersions = currentApprovedPipelineVersions(study);
  const activeDeployment = activeDeploymentForStudy(study);
  const ready = readySites(study);
  const connected = connectedSites(study);
  return [
    {
      label: "Protocol status",
      detail: protocolReadinessDetail(study),
      passed: study.status === "ACTIVE" && ethicsGatePassed(study)
    },
    {
      label: "Approved pipeline version",
      detail: approvedVersions.length > 0 ? `${approvedVersions.length} approved version(s)` : "No approved immutable commit",
      passed: approvedVersions.length > 0
    },
    {
      label: "Aggregator deployment",
      detail: activeDeployment?.serverAddress ? text(activeDeployment.serverAddress) : "No active deployment address",
      passed: activeDeployment?.status === "ACTIVE"
    },
    {
      label: "Site readiness",
      detail: `${ready.length}/${study.studySites?.length ?? 0} ready · ${connected.length} connected`,
      passed: ready.length > 0 && connected.length > 0
    }
  ];
}

function summaryReadinessLabel(state: SummaryReadinessState) {
  if (state === "done") return "Done";
  if (state === "ready") return "Ready";
  return "Needs attention";
}

function summaryReadinessIcon(state: SummaryReadinessState) {
  return state === "needs_attention" ? <ExclamationCircleOutlined /> : <CheckCircleOutlined />;
}

export default function StudyDetailPage() {
  const params = useParams<{ studyId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const studyId = params.studyId;
  const activeSection = normalizeStudyWorkspaceSection(searchParams.get("section"));
  const activeSectionMeta = getStudyWorkspaceSection(activeSection);
  const activeDetail = useMemo(() => parseStudyDetailParam(searchParams.get("detail")), [searchParams]);
  const [study, setStudy] = useState<StudyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [siteToken, setSiteToken] = useState<string | null>(null);
  const [templates, setTemplates] = useState<EntityRecord[]>([]);
  const [activeCreate, setActiveCreate] = useState<"invite" | "ethics" | "document" | "site" | "agent" | "job" | null>(null);
  const [governanceEditing, setGovernanceEditing] = useState(false);
  const [protocolTab, setProtocolTab] = useState("metadata");
  const [teamTab, setTeamTab] = useState("members");
  const [sitesTab, setSitesTab] = useState("sites");
  const [pipelineTab, setPipelineTab] = useState("versions");
  const [runTab, setRunTab] = useState("readiness");
  const [resultsTab, setResultsTab] = useState("models");
  const [ethicsEditingRecord, setEthicsEditingRecord] = useState<EntityRecord | null>(null);
  const [memberRoleEditingId, setMemberRoleEditingId] = useState<string | null>(null);
  const [pipelineTemplateVersionPreset, setPipelineTemplateVersionPreset] = useState<string | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [jobLogLoadingId, setJobLogLoadingId] = useState<string | null>(null);
  const [jobLogDetail, setJobLogDetail] = useState<JobLogsPayload | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  function openCreate(mode: NonNullable<typeof activeCreate>) {
    setFormError(null);
    setEthicsEditingRecord(null);
    setActiveCreate(mode);
  }

  function openPipelineCreate(templateVersionId?: string) {
    setPipelineTemplateVersionPreset(templateVersionId ?? null);
    openCreate("agent");
  }

  function openEthicsForm(record?: EntityRecord) {
    setFormError(null);
    setEthicsEditingRecord(record ?? null);
    setProtocolTab("ethics");
    setActiveCreate("ethics");
  }

  function closeCreate() {
    setActiveCreate(null);
    setFormError(null);
    setSelectedFile(null);
    setEthicsEditingRecord(null);
    setPipelineTemplateVersionPreset(null);
  }

  function sectionUrl(section: StudyWorkspaceSection, detail?: StudyDetailState | null) {
    const params = new URLSearchParams();
    if (section !== "overview" || detail) params.set("section", section);
    if (detail) params.set("detail", serializeStudyDetailParam(detail));
    const query = params.toString();
    return `/studies/${studyId}${query ? `?${query}` : ""}`;
  }

  function openDetail(kind: StudyDetailKind, id: string, section: StudyWorkspaceSection = activeSection) {
    setActiveCreate(null);
    setFormError(null);
    setEthicsEditingRecord(null);
    setMemberRoleEditingId(null);
    router.push(sectionUrl(section, { kind, id }));
  }

  function closeDetail() {
    setJobLogDetail(null);
    setMemberRoleEditingId(null);
    router.push(sectionUrl(activeSection));
  }

  const load = useCallback(async (redirectSection: StudyWorkspaceSection = "overview") => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/v1/studies/${studyId}`, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 403 || response.status === 404) {
          const studiesResponse = await fetch("/api/v1/studies?status=active", { cache: "no-store" });
          const studiesBody = await studiesResponse.json().catch(() => null);
          const selected = chooseSelectedStudy((studiesBody?.studies ?? []) as StudySummary[], null);
          if (selected?.id && selected.id !== studyId) {
            window.localStorage.setItem(SELECTED_STUDY_STORAGE_KEY, selected.id);
            window.dispatchEvent(new CustomEvent(SELECTED_STUDY_EVENT, { detail: { studyId: selected.id } }));
            router.replace(`/studies/${selected.id}${redirectSection === "overview" ? "" : `?section=${redirectSection}`}`);
            return;
          }
        }
        throw new Error(body?.error?.message ?? "Study workspace could not be loaded.");
      }
      setStudy(body?.study ?? null);
      const templatesResponse = await fetch(`/api/v1/pipeline-templates?scope=all&studyId=${encodeURIComponent(studyId)}`, { cache: "no-store" });
      if (templatesResponse.ok) {
        const templatesBody = await templatesResponse.json().catch(() => null);
        setTemplates(templatesBody?.templates ?? []);
      }
    } catch (error) {
      setStudy(null);
      setLoadError(error instanceof Error ? error.message : "Study workspace could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [router, studyId]);

  useEffect(() => {
    void load(activeSection);
  }, [activeSection, load]);

  useEffect(() => {
    setActiveCreate(null);
    setFormError(null);
    setSelectedFile(null);
    setGovernanceEditing(false);
    setEthicsEditingRecord(null);
    setMemberRoleEditingId(null);
    setPipelineTemplateVersionPreset(null);
    if (activeSection !== "protocol") setProtocolTab("metadata");
    if (activeSection !== "team") setTeamTab("members");
    if (activeSection !== "sites") setSitesTab("sites");
    if (activeSection !== "pipeline") setPipelineTab("versions");
    if (activeSection !== "run") setRunTab("readiness");
    if (activeSection !== "results") setResultsTab("models");
  }, [activeSection]);

  async function post(path: string, values: unknown, success: string) {
    setFormSubmitting(true);
    setFormError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values)
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "The request could not be completed.");
      messageApi.success(success);
      await load(activeSection);
      return body ?? {};
    } catch (error) {
      const nextError = error instanceof Error ? error.message : "The request could not be completed.";
      setFormError(nextError);
      messageApi.error(nextError);
      return null;
    } finally {
      setFormSubmitting(false);
    }
  }

  async function patch(path: string, values: unknown, success: string) {
    setFormSubmitting(true);
    setFormError(null);
    try {
      const response = await fetch(path, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values)
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "The request could not be completed.");
      messageApi.success(success);
      await load(activeSection);
      return body ?? {};
    } catch (error) {
      const nextError = error instanceof Error ? error.message : "The request could not be completed.";
      setFormError(nextError);
      messageApi.error(nextError);
      return null;
    } finally {
      setFormSubmitting(false);
    }
  }

  async function openJobLogs(job: EntityRecord) {
    setJobLogLoadingId(job.id);
    try {
      const response = await fetch(`/api/v1/nvflare/jobs/${job.id}/logs`, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error?.message ?? "Run logs could not be loaded.");
      }
      setJobLogDetail(body ?? null);
      openDetail("experimentRun", String(job.id), "run");
      void load(activeSection);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "Run logs could not be loaded.");
    } finally {
      setJobLogLoadingId(null);
    }
  }

  useEffect(() => {
    if (activeDetail?.kind !== "experimentRun") {
      setJobLogDetail(null);
      return;
    }
    const job = study?.nvflareJobs?.find((item) => item.id === activeDetail.id);
    if (job) void openJobLogs(job);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDetail?.kind, activeDetail?.id, study?.id]);

  async function provisionDeployment() {
    await post(`/api/v1/studies/${studyId}/nvflare/deployments`, {}, "NVFLARE deployment provisioned.");
  }

  async function startDeployment(deploymentId: string) {
    await post(`/api/v1/studies/${studyId}/nvflare/deployments/${deploymentId}/start`, {}, "NVFLARE aggregator started.");
  }

  async function stopDeployment(deploymentId: string) {
    await post(`/api/v1/studies/${studyId}/nvflare/deployments/${deploymentId}/stop`, {}, "NVFLARE aggregator stopped.");
  }

  async function updateStudyMemberRoles(userId: string, roles: string[]) {
    const body = await patch(`/api/v1/studies/${studyId}/members/${userId}/roles`, { roles }, "Study member roles updated.");
    if (body) setMemberRoleEditingId(null);
  }

  async function syncJobResult(jobId: string, nvflareJobId?: unknown) {
    const body = await post(`/api/v1/nvflare/jobs/${jobId}/results/sync`, {}, "Model result synced.");
    if (body) await openJobLogs({ id: jobId, nvflareJobId });
  }

  async function promoteModelRelease(jobId: string, nvflareJobId?: unknown) {
    const body = await post(
      `/api/v1/nvflare/jobs/${jobId}/model-release`,
      { status: "APPROVED" },
      "Model release promoted."
    );
    if (body) await openJobLogs({ id: jobId, nvflareJobId });
  }

  async function downloadModelReleaseArtifact(releaseId: string, artifactId: string) {
    const response = await fetch(`/api/v1/model-releases/${releaseId}/download?artifactId=${artifactId}`);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      messageApi.error(body?.error?.message ?? "Model artifact download could not be prepared.");
      return;
    }
    if (body?.downloadUrl) window.location.assign(body.downloadUrl);
    else messageApi.info(body?.message ?? "This model artifact is recorded, but no download URL is available.");
  }

  async function downloadCodeReleaseArtifact(releaseId: string, artifactId: string) {
    const response = await fetch(`/api/v1/releases/${releaseId}/download?artifactId=${artifactId}`);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      messageApi.error(body?.error?.message ?? "Release artifact download could not be prepared.");
      return;
    }
    if (body?.downloadUrl) window.location.assign(body.downloadUrl);
    else messageApi.info(body?.message ?? "This artifact is recorded, but no download URL is available.");
  }

  async function uploadDocument(values: { kind: string; extractedText?: string }) {
    if (!selectedFile) {
      setFormError("Select a document before registering the record.");
      messageApi.error("Select a document before registering the record.");
      return false;
    }

    setFormSubmitting(true);
    setFormError(null);
    try {
      const uploadUrlResponse = await fetch(`/api/v1/studies/${studyId}/documents/upload-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: values.kind,
          filename: selectedFile.name,
          contentType: selectedFile.type || "application/octet-stream"
        })
      });
      const uploadUrlBody = await uploadUrlResponse.json();
      if (!uploadUrlResponse.ok) throw new Error(uploadUrlBody?.error?.message ?? "The document upload was rejected.");

      await fetch(uploadUrlBody.uploadUrl, {
        method: "PUT",
        headers: { "content-type": selectedFile.type || "application/octet-stream" },
        body: selectedFile
      });

      const checksum = await sha256File(selectedFile);
      const result = await post(
        `/api/v1/studies/${studyId}/documents`,
        {
          kind: values.kind,
          filename: selectedFile.name,
          contentType: selectedFile.type || "application/octet-stream",
          sizeBytes: selectedFile.size,
          storageKey: uploadUrlBody.storageKey,
          sha256: checksum,
          extractedText: values.extractedText
        },
        "Study document registered."
      );
      if (!result) return false;
      setSelectedFile(null);
      return true;
    } catch (error) {
      const nextError = error instanceof Error ? error.message : "The study document could not be registered.";
      setFormError(nextError);
      messageApi.error(nextError);
      return false;
    } finally {
      setFormSubmitting(false);
    }
  }

  if (!study && loading) {
    return (
      <AppPage>
        <CardGridSkeleton count={6} />
      </AppPage>
    );
  }
  if (!study && loadError) {
    return (
      <AppPage>
        <InlineLoadError message={loadError} onRetry={() => void load()} />
      </AppPage>
    );
  }
  if (!study) return <Alert type="error" message="Study not found or access was denied." />;
  const activeCreateMeta = activeCreate ? CREATE_FORM_META[activeCreate] : null;

  function renderHeaderAction(section: StudyWorkspaceSection) {
    if (section === "protocol") {
      return null;
    }

    if (section === "team") {
      return (
        <Button type="primary" className="fedlify-dark-action" icon={<PlusOutlined />} onClick={() => openCreate("invite")}>
          Add study member
        </Button>
      );
    }

    if (section === "sites") {
      return (
        <Button type="primary" className="fedlify-dark-action" icon={<PlusOutlined />} onClick={() => openCreate("site")}>
          Register site
        </Button>
      );
    }

    if (section === "pipeline") {
      return (
        <Button type="primary" className="fedlify-dark-action" icon={<PlayCircleOutlined />} onClick={() => openPipelineCreate()}>
          {WORKFLOW_TERMS.createPipelineVersion}
        </Button>
      );
    }

    if (section === "run") {
      return (
        <Button type="primary" className="fedlify-dark-action" icon={<MonitorOutlined />} onClick={() => openCreate("job")}>
          {WORKFLOW_TERMS.submitFederatedRun}
        </Button>
      );
    }

    return null;
  }

  function renderInlineCreateForm(mode: NonNullable<typeof activeCreate>) {
    if (activeCreate !== mode) return null;

    if (mode === "invite") {
      return (
        <div className="fedlify-inline-create-card">
          <Form
            layout="vertical"
            className="fedlify-inline-create-form"
            onFinish={async (values) => {
              const result = await post(`/api/v1/studies/${studyId}/invitations`, values, "Invitation sent.");
              if (result) closeCreate();
            }}
          >
            <FormError title="Invitation was not sent" message={formError} />
            <div className="fedlify-intake-field-grid">
              <Form.Item name="email" label="Recipient email" rules={[{ required: true, type: "email" }]}>
                <Input placeholder="member@institution.ca" />
              </Form.Item>
              <Form.Item
                name="roles"
                label="Study roles"
                initialValue={["DATA_SCIENTIST"]}
                rules={[{ required: true, message: "Select at least one study role." }]}
                extra="Assign multiple roles when one person is responsible for more than one study function."
              >
                <Select
                  mode="multiple"
                  placeholder="Select one or more roles"
                  options={STUDY_ROLE_OPTIONS}
                />
              </Form.Item>
            </div>
            <Space className="fedlify-form-actions">
              <Button onClick={closeCreate}>Cancel</Button>
              <Button type="primary" htmlType="submit" icon={<MailOutlined />} className="fedlify-dark-action" loading={formSubmitting}>
                Send role invitation
              </Button>
            </Space>
          </Form>
        </div>
      );
    }

    if (mode === "ethics") {
      const isEditingEthics = Boolean(ethicsEditingRecord?.id);
      return (
        <div className="fedlify-inline-create-card">
          <Form
            key={ethicsEditingRecord?.id ?? "new-ethics-record"}
            layout="vertical"
            className="fedlify-inline-create-form"
            initialValues={{
              status: ethicsEditingRecord?.status ?? "PENDING",
              approvalNumber: ethicsEditingRecord?.approvalNumber ?? undefined,
              approvingBody: ethicsEditingRecord?.approvingBody ?? undefined,
              notes: ethicsEditingRecord?.notes ?? undefined
            }}
            onFinish={async (values) => {
              const result = isEditingEthics
                ? await patch(
                    `/api/v1/studies/${studyId}/ethics/${String(ethicsEditingRecord?.id)}`,
                    values,
                    "Ethics decision updated."
                  )
                : await post(`/api/v1/studies/${studyId}/ethics`, values, "Ethics decision saved.");
              if (result) closeCreate();
            }}
          >
            <FormError title={isEditingEthics ? "Ethics decision was not updated" : "Ethics decision was not saved"} message={formError} />
            <div className="fedlify-intake-field-grid">
              <Form.Item name="status" label="Review status">
                <Select
                  options={["NOT_REQUIRED", "PENDING", "APPROVED", "REJECTED", "EXPIRED"].map((value) => ({
                    value,
                    label: displayEnum(value)
                  }))}
                />
              </Form.Item>
              <Form.Item name="approvalNumber" label="Approval identifier">
                <Input />
              </Form.Item>
              <Form.Item name="approvingBody" label="Review body" className="fedlify-intake-full">
                <Input />
              </Form.Item>
              <Form.Item name="notes" label="Decision notes" className="fedlify-intake-full">
                <Input.TextArea rows={3} />
              </Form.Item>
            </div>
            <Space className="fedlify-form-actions">
              <Button onClick={closeCreate}>Cancel</Button>
              <Button type="primary" htmlType="submit" icon={<SafetyCertificateOutlined />} className="fedlify-dark-action" loading={formSubmitting}>
                {isEditingEthics ? "Update decision" : "Save decision"}
              </Button>
            </Space>
          </Form>
        </div>
      );
    }

    if (mode === "document") {
      return (
        <div className="fedlify-inline-create-card">
          <Form
            layout="vertical"
            className="fedlify-inline-create-form"
            onFinish={async (values) => {
              const result = await uploadDocument(values);
              if (result) closeCreate();
            }}
          >
            <FormError title="Study document was not registered" message={formError} />
            <Form.Item name="kind" label="Document type" initialValue="REQUIREMENTS_PDF">
              <Select
                options={["REQUIREMENTS_PDF", "ETHICS_APPROVAL", "DATA_PROCESSING_AGREEMENT", "SITE_POLICY", "OTHER"].map(
                  (value) => ({ value, label: displayEnum(value) })
                )}
              />
            </Form.Item>
            <Upload.Dragger
              beforeUpload={(file) => {
                setSelectedFile(file);
                return false;
              }}
              maxCount={1}
              fileList={selectedFile ? ([{ uid: selectedFile.name, name: selectedFile.name } as UploadFile] as UploadFile[]) : []}
              onRemove={() => setSelectedFile(null)}
            >
              <p>
                <UploadOutlined /> Select governed document
              </p>
            </Upload.Dragger>
            <Form.Item name="extractedText" label="Document summary or extracted text" style={{ marginTop: 16 }}>
              <Input.TextArea rows={4} />
            </Form.Item>
            <Space className="fedlify-form-actions">
              <Button onClick={closeCreate}>Cancel</Button>
              <Button type="primary" htmlType="submit" icon={<UploadOutlined />} className="fedlify-dark-action" loading={formSubmitting}>
                Register document
              </Button>
            </Space>
          </Form>
        </div>
      );
    }

    if (mode === "site") {
      return (
        <div className="fedlify-inline-create-card">
          <Form
            layout="vertical"
            className="fedlify-inline-create-form"
            onFinish={async (values) => {
              const dataProfile = values.dataProfile
                ? {
                    ...values.dataProfile,
                    modality: normalizeMultiSelectValue(values.dataProfile.modality)
                  }
                : undefined;
              const body = await post(`/api/v1/studies/${studyId}/sites`, { ...values, dataProfile }, "Site registered.");
              if (body) {
                setSiteToken(body?.apiToken ?? null);
                closeCreate();
              }
            }}
          >
            <FormError title="Participant site was not registered" message={formError} />
            <div className="fedlify-intake-field-grid">
              <Form.Item name="name" label="Site name" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="institutionName" label="Institution name" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="principalInvestigator" label="Site PI">
                <Input />
              </Form.Item>
              <Form.Item name="notes" label="Site onboarding note" className="fedlify-intake-full">
                <Input.TextArea rows={2} placeholder="Optional note for the site operator. Data/resource details are completed after registration." />
              </Form.Item>
            </div>
            <Space className="fedlify-form-actions">
              <Button onClick={closeCreate}>Cancel</Button>
              <Button type="primary" htmlType="submit" className="fedlify-dark-action" loading={formSubmitting}>
                Register site
              </Button>
            </Space>
          </Form>
        </div>
      );
    }

    if (mode === "job") {
      const approvedVersions = currentApprovedPipelineVersions(study);
      const defaultReadySites = readySites(study).map((site) => site.id);
      return (
        <div className="fedlify-inline-create-card">
          <Form
            layout="vertical"
            className="fedlify-inline-create-form"
            initialValues={{
              pipelineVersionId: approvedVersions[0]?.id,
              studySiteIds: defaultReadySites,
              runtimeParameters: {
                minClients: Math.max(1, defaultReadySites.length),
                numRounds: 1
              },
              commandSummary: "Submit approved pipeline version as a Fedlify federated run."
            }}
            onFinish={async (values) => {
              const result = await post(`/api/v1/studies/${studyId}/nvflare/jobs`, values, "Federated run submitted.");
              if (result) closeCreate();
            }}
          >
            <FormError title="Federated run was not submitted" message={formError} />
            <GateChecklist items={operationsGateItems(study!)} />
            <Form.Item name="pipelineVersionId" label="Approved pipeline version" rules={[{ required: true }]}>
              <Select
                options={approvedVersions.map((version) => ({
                  value: version.id,
                  label: `${text(version.project?.name, "Pipeline")} ${text(version.version, "")}`
                }))}
                placeholder="Select approved version"
              />
            </Form.Item>
            <Form.Item name="studySiteIds" label="Participant sites">
              <Select
                mode="multiple"
                options={(study?.studySites ?? []).map((site) => ({
                  value: site.id,
                  label: text(site.name, site.code)
                }))}
                placeholder="All ready sites"
              />
            </Form.Item>
            <div className="fedlify-intake-field-grid">
              <Form.Item
                name={["runtimeParameters", "minClients"]}
                label="Minimum participating sites"
                rules={[{ required: true, message: "Set the minimum number of sites required to start." }]}
                extra="Default is the number of selected sites. Lower this only for a partial-site smoke test."
              >
                <InputNumber min={1} precision={0} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item
                name={["runtimeParameters", "numRounds"]}
                label="Federated rounds"
                rules={[{ required: true, message: "Set at least one training round." }]}
              >
                <InputNumber min={1} max={1000} precision={0} style={{ width: "100%" }} />
              </Form.Item>
            </div>
            <Form.Item name="commandSummary" label="Run notes">
              <Input.TextArea rows={3} />
            </Form.Item>
            <Space className="fedlify-form-actions">
              <Button onClick={closeCreate}>Cancel</Button>
              <Button type="primary" htmlType="submit" icon={<MonitorOutlined />} className="fedlify-dark-action" loading={formSubmitting}>
                {WORKFLOW_TERMS.submitFederatedRun}
              </Button>
            </Space>
          </Form>
        </div>
      );
    }

    const approvedTemplatesForPipeline = approvedTemplateCatalog(templates);
    const hasApprovedTemplatesForPipeline = approvedTemplatesForPipeline.length > 0;

    return (
      <div className="fedlify-inline-create-card">
        <Form
          layout="vertical"
          className="fedlify-inline-create-form"
          initialValues={{
            templateVersionId: pipelineTemplateVersionPreset ?? approvedTemplatesForPipeline[0]?.currentApprovedVersion?.id,
            name: `${study?.title ?? "Study"} NVFLARE pipeline`,
            prompt:
              "Create a study-specific pipeline version from this approved template commit. Keep raw clinical data local, preserve configurable runtime parameters, and include README, manifest, tests, and validation-safe configuration."
          }}
          onFinish={async (values) => {
            const result = await post(
              `/api/v1/studies/${studyId}/pipeline-projects`,
              {
                ...values,
                name: typeof values.name === "string" && values.name.trim() === "" ? undefined : values.name,
                branchName:
                  typeof values.branchName === "string" && values.branchName.trim() === "" ? undefined : values.branchName
              },
              "Pipeline version proposal created."
            );
            if (result) closeCreate();
          }}
        >
          <FormError title="Pipeline version was not created" message={formError} />
          <Alert
            type={hasApprovedTemplatesForPipeline ? "info" : "warning"}
            showIcon
            message={
              hasApprovedTemplatesForPipeline
                ? "Template code is copied into a study source workspace"
                : "No approved template version is available"
            }
            description={
              hasApprovedTemplatesForPipeline
                ? "Select a published public template or an approved study template. Fedlify creates a new study branch and immutable pipeline version; the template itself is not modified."
                : "Publish a public template version or approve a study template before creating a runnable study pipeline version."
            }
          />
          <div className="fedlify-intake-field-grid">
            <Form.Item name="templateVersionId" label="Approved template commit" rules={[{ required: true }]}>
              <Select
                options={approvedTemplatesForPipeline
                  .map((template) => ({
                    value: template.currentApprovedVersion.id,
                    label: templateSourceLabel(template, template.currentApprovedVersion)
                  }))}
                placeholder="Select an approved public or study template"
                notFoundContent="No approved template versions are available for this study."
              />
            </Form.Item>
            <Form.Item
              name="name"
              label="Pipeline version name"
              rules={[{ min: 3, message: "Use at least 3 characters, or leave blank for the default name." }]}
            >
              <Input placeholder={`${study?.title ?? "Study"} pipeline`} />
            </Form.Item>
          </div>
          <details className="fedlify-form-advanced">
            <summary>Advanced Git settings</summary>
            <Form.Item
              name="branchName"
              label="Gitea branch"
              rules={[{ min: 3, message: "Use at least 3 characters, or leave blank to auto-generate a branch." }]}
            >
              <Input placeholder="fedlify/study-pipeline" />
            </Form.Item>
          </details>
          <Form.Item
            name="prompt"
            label="Version request"
            rules={[{ required: true, min: 20 }]}
            extra="Describe the study-specific configuration or changes. Fedlify records this as a draft proposal and validates the exact commit before approval."
          >
            <Input.TextArea rows={5} />
          </Form.Item>
          <Space className="fedlify-form-actions">
            <Button onClick={closeCreate}>Cancel</Button>
            <Button type="primary" htmlType="submit" icon={<PlayCircleOutlined />} className="fedlify-dark-action" loading={formSubmitting} disabled={!hasApprovedTemplatesForPipeline}>
              Create pipeline version
            </Button>
          </Space>
        </Form>
      </div>
    );
  }

  function detailVersions(study: StudyDetail) {
    return (study.pipelineProjects ?? []).flatMap((project) =>
      (project.versions ?? []).map((version: EntityRecord) => ({ ...version, project }))
    );
  }

  function detailRecordFor(study: StudyDetail, detail: StudyDetailState): EntityRecord | undefined {
    if (detail.kind === "member") {
      return groupedStudyMembers(study.members).find(
        (member) => member.id === detail.id || member.memberships.some((membership: EntityRecord) => membership.id === detail.id)
      );
    }
    if (detail.kind === "invitation") return study.invitations.find((invitation) => invitation.id === detail.id);
    if (detail.kind === "ethics") return study.ethics.find((record) => record.id === detail.id);
    if (detail.kind === "document") return study.documents.find((document) => document.id === detail.id);
    if (detail.kind === "site") return study.studySites.find((site) => site.id === detail.id);
    if (detail.kind === "pipelineProject") return study.pipelineProjects.find((project) => project.id === detail.id);
    if (detail.kind === "pipelineVersion") return detailVersions(study).find((version) => version.id === detail.id);
    if (detail.kind === "deployment") return study.nvflareDeployments.find((deployment) => deployment.id === detail.id);
    if (detail.kind === "experimentRun") return study.nvflareJobs.find((job) => job.id === detail.id);
    if (detail.kind === "modelRelease") return study.modelReleases.find((release) => release.id === detail.id);
    if (detail.kind === "codeRelease") return study.releases.find((release) => release.id === detail.id);
    if (detail.kind === "auditEvent") return study.auditEvents.find((event) => event.id === detail.id);
    return undefined;
  }

  function renderEntityDetail(study: StudyDetail, detail: StudyDetailState) {
    const record = detailRecordFor(study, detail);
    if (!record) {
      return (
        <EntityDetailView title="Record not found" subtitle="This item is no longer available in the current study payload." onBack={closeDetail}>
          <EmptyState icon={<FileTextOutlined />} title="No matching record" description="Return to the list and refresh the workspace." />
        </EntityDetailView>
      );
    }

    if (detail.kind === "member") {
      const memberships = Array.isArray(record.memberships) ? record.memberships : [record];
      const roles = record.roles ?? uniqueValues(memberships.map((membership: EntityRecord) => membership.role));
      const targetUserId = record.user?.id ?? record.userId ?? memberships[0]?.userId;
      const isEditingRoles = memberRoleEditingId === String(record.id);
      const roleChips = (
        <span className="fedlify-role-chip-list is-left">
          {roles.map((role: string) => (
            <StatusTag key={role} value={role} />
          ))}
        </span>
      );
      return (
        <EntityDetailView
          title={text(record.user?.name, record.user?.email)}
          subtitle={text(record.user?.email)}
          status={<StatusTag value={`${roles.length} study role${roles.length === 1 ? "" : "s"}`} />}
          actions={
            targetUserId ? (
              <Button icon={<EditOutlined />} onClick={() => setMemberRoleEditingId(isEditingRoles ? null : String(record.id))}>
                {isEditingRoles ? "Close role editor" : "Edit study roles"}
              </Button>
            ) : null
          }
          onBack={closeDetail}
        >
          {isEditingRoles && targetUserId ? (
            <div className="fedlify-member-role-editor">
              <Typography.Title level={4}>Study role assignments</Typography.Title>
              <Typography.Text className="fedlify-muted">
                Select every study-level responsibility this person should hold.
              </Typography.Text>
              <Form
                layout="vertical"
                initialValues={{ roles }}
                onFinish={(values) => void updateStudyMemberRoles(String(targetUserId), values.roles ?? [])}
              >
                <Form.Item
                  name="roles"
                  label="Assigned study roles"
                  rules={[{ required: true, message: "Select at least one study role." }]}
                >
                  <Select mode="multiple" options={STUDY_ROLE_OPTIONS} placeholder="Select one or more roles" />
                </Form.Item>
                <Space>
                  <Button onClick={() => setMemberRoleEditingId(null)}>Cancel</Button>
                  <Button type="primary" htmlType="submit" className="fedlify-dark-action" loading={formSubmitting}>
                    Save roles
                  </Button>
                </Space>
              </Form>
            </div>
          ) : null}
          <FieldGrid>
            <FieldRow label="Name" value={text(record.user?.name)} />
            <FieldRow label="Email" value={text(record.user?.email)} />
            <FieldRow label="Study roles" value={roleChips} />
            <FieldRow label="Study role assignments" value={`${memberships.length}`} />
            <FieldRow label="Created" value={formatDate(memberships[0]?.createdAt)} />
            <FieldRow label="Updated" value={formatDate(memberships[0]?.updatedAt)} />
            <FieldRow label="Added by" value={text(memberships[0]?.invitedById)} />
          </FieldGrid>
        </EntityDetailView>
      );
    }

    if (detail.kind === "invitation") {
      const roles = Array.isArray(record.roles) && record.roles.length > 0 ? record.roles : [record.role];
      const roleChips = (
        <span className="fedlify-role-chip-list is-left">
          {roles.map((role: string) => (
            <StatusTag key={role} value={role} />
          ))}
        </span>
      );
      return (
        <EntityDetailView title={text(record.email, "Invitation")} subtitle="Study role invitation" status={<StatusTag value={status(record.status, "PENDING")} />} onBack={closeDetail}>
          <FieldGrid>
            <FieldRow label="Email" value={text(record.email)} />
            <FieldRow label="Study roles" value={roleChips} />
            <FieldRow label="Status" value={displayEnum(record.status)} />
            <FieldRow label="Expires" value={formatDate(record.expiresAt)} />
            <FieldRow label="Created" value={formatDate(record.createdAt)} />
            <FieldRow label="Invited by" value={text(record.invitedById)} />
          </FieldGrid>
        </EntityDetailView>
      );
    }

    if (detail.kind === "ethics") {
      const title = text(record.approvalNumber, record.status === "PENDING" ? "Pending ethics review" : "Ethics decision");
      return (
        <EntityDetailView
          title={title}
          subtitle={text(record.approvingBody, "Review body not recorded")}
          status={<StatusTag value={status(record.status)} />}
          onBack={closeDetail}
          actions={
            <Button
              icon={<EditOutlined />}
              onClick={() => {
                router.push(sectionUrl("protocol"));
                openEthicsForm(record);
              }}
            >
              Edit decision
            </Button>
          }
        >
          <FieldGrid>
            <FieldRow label="Review status" value={displayEnum(record.status)} />
            <FieldRow label="Approval identifier" value={text(record.approvalNumber)} />
            <FieldRow label="Review body" value={text(record.approvingBody)} />
            <FieldRow label="Recorded" value={formatDate(record.createdAt)} />
            <FieldRow label="Decision notes" value={text(record.notes)} full />
          </FieldGrid>
        </EntityDetailView>
      );
    }

    if (detail.kind === "document") {
      return (
        <EntityDetailView title={text(record.filename, "Study document")} subtitle={displayEnum(record.kind, "Document")} status={<StatusTag value={status(record.scanStatus, "PENDING")} />} onBack={closeDetail}>
          <FieldGrid>
            <FieldRow label="Filename" value={text(record.filename)} full />
            <FieldRow label="Document type" value={displayEnum(record.kind)} />
            <FieldRow label="Version" value={text(record.version, "1")} />
            <FieldRow label="Content type" value={text(record.contentType)} />
            <FieldRow label="Size" value={record.sizeBytes ? `${record.sizeBytes} bytes` : "Not recorded"} />
            <FieldRow label="Checksum" value={text(record.sha256)} full />
            <FieldRow label="Summary" value={text(record.extractedText)} full />
          </FieldGrid>
        </EntityDetailView>
      );
    }

    if (detail.kind === "site") {
      return (
        <EntityDetailView
          title={text(record.name, "Participant site")}
          subtitle={text(record.institutionName, "Institution not recorded")}
          status={<StatusTag value={status(record.participationStatus, "INVITED")} />}
          onBack={closeDetail}
          actions={<Button icon={<ClusterOutlined />} onClick={() => router.push(`/sites/${record.id}`)}>Open onboarding dashboard</Button>}
        >
          <FieldGrid>
            <FieldRow label="Institution" value={text(record.institutionName)} />
            <FieldRow label="Site PI" value={text(record.principalInvestigator)} />
            <FieldRow label="NVFLARE client" value={text(record.site?.nvflareClientName)} />
            <FieldRow label="Participation" value={displayEnum(record.participationStatus)} />
            <FieldRow label="Readiness" value={displayEnum(record.readinessChecks?.[0]?.status, "Pending")} />
            <FieldRow label="Connection" value={displayEnum(record.nvflareStatuses?.[0]?.status, "Offline")} />
            <FieldRow label="Data modalities" value={text(record.dataProfile?.modality)} />
            <FieldRow label="Cohort size" value={text(record.dataProfile?.cohortSizeRange)} />
            <FieldRow label="Dataset summary" value={text(record.dataProfile?.datasetDescription)} full />
            <FieldRow label="Resource profile" value={[
              record.resourceProfile?.cpuCores ? `${record.resourceProfile.cpuCores} CPU` : null,
              record.resourceProfile?.gpuCount ? `${record.resourceProfile.gpuCount} GPU` : null,
              record.resourceProfile?.ramGb ? `${record.resourceProfile.ramGb} GB RAM` : null
            ].filter(Boolean).join(" · ") || "Not recorded"} full />
          </FieldGrid>
        </EntityDetailView>
      );
    }

    if (detail.kind === "pipelineProject" || detail.kind === "pipelineVersion") {
      const project = detail.kind === "pipelineProject" ? record : record.project;
      const versions = detail.kind === "pipelineProject" ? (record.versions ?? []) : [record];
      const activeVersion = detail.kind === "pipelineVersion" ? record : versions[0];
      const sourceTemplateVersion = activeVersion?.templateVersion ?? project?.templateVersion ?? project?.template?.currentApprovedVersion;
      const latestProposal = project?.proposals?.[0];
      return (
        <EntityDetailView
          title={
            detail.kind === "pipelineVersion"
              ? `${text(project?.name, "Pipeline source workspace")} ${text(record.version, "")}`.trim()
              : text(project?.name, "Pipeline source workspace")
          }
          subtitle={templateSourceLabel(project?.template, sourceTemplateVersion)}
          status={<StatusTag value={detail.kind === "pipelineVersion" ? (record.approvalStatus ?? record.validationStatus) : status(project?.status, "DRAFT")} />}
          onBack={closeDetail}
        >
          <Tabs
            className="fedlify-card-tabs fedlify-workspace-tabs"
            items={[
              {
                key: "overview",
                label: "Overview",
                children: (
                  <div className="fedlify-tab-panel">
                    <FieldGrid>
                      <FieldRow label="Template source" value={templateScopeLabel(project?.template)} />
                      <FieldRow label="Template version" value={templateVersionLabel(sourceTemplateVersion)} />
                      <FieldRow label="Source workspace" value={text(project?.name)} />
                      <FieldRow label="Source repository" value={repoLabel(project ?? {})} />
                      <FieldRow label="Pipeline version" value={text(activeVersion?.version, detail.kind === "pipelineProject" ? "Latest version not created" : "Not set")} />
                      <FieldRow label="Version state" value={pipelineVersionState(activeVersion)} />
                      <FieldRow label="Validation" value={displayEnum(activeVersion?.validationStatus, "Not run")} />
                      <FieldRow label="Approval" value={displayEnum(activeVersion?.approvalStatus, "Not approved")} />
                      <FieldRow label="Pull request" value={externalUrl(latestProposal?.giteaPullRequestUrl) ? <a href={latestProposal.giteaPullRequestUrl} target="_blank" rel="noreferrer">Review PR</a> : "Not available"} />
                      <FieldRow label="Immutable commit" value={shortCommit(activeVersion?.gitCommit ?? latestProposal?.giteaHeadCommit)} />
                      <FieldRow label="Default branch" value={text(project?.giteaDefaultBranch ?? project?.defaultBranch)} />
                    </FieldGrid>
                    {detail.kind === "pipelineProject" ? (
                      <>
                        <SectionHeader title="Pipeline versions" description="Each card is an immutable Git commit created from the selected template version." />
                        <CardGrid>
                          {versions.map((version: EntityRecord) => (
                            <EntityCard
                              key={version.id}
                              title={text(version.version, "Pipeline version")}
                              subtitle={pipelineVersionState(version)}
                              status={<StatusTag value={version.approvalStatus ?? version.validationStatus} />}
                              meta={[
                                `Template: ${templateVersionLabel(version.templateVersion ?? project?.templateVersion)}`,
                                `Commit: ${shortCommit(version.gitCommit)}`,
                                `Branch: ${text(version.gitBranch)}`
                              ]}
                              onClick={() => openDetail("pipelineVersion", String(version.id), "pipeline")}
                              actions={
                                <Button size="small" icon={<CodeOutlined />} onClick={() => openDetail("pipelineVersion", String(version.id), "pipeline")}>
                                  Review code
                                </Button>
                              }
                            />
                          ))}
                        </CardGrid>
                      </>
                    ) : null}
                  </div>
                )
              },
              ...(detail.kind === "pipelineVersion"
                ? [
                    {
                      key: "code",
                      label: "Code",
                      children: (
                        <CodeReviewPanel
                          sourceUrl={`/api/v1/pipeline-versions/${record.id}/source`}
                          title="Study pipeline source review"
                          description="Review the exact commit-backed source for this study-specific pipeline version."
                        />
                      )
                    }
                  ]
                : [])
            ]}
          />
        </EntityDetailView>
      );
    }

    if (detail.kind === "deployment") {
      return (
        <EntityDetailView title={text(record.name, "NVFLARE deployment")} subtitle={text(record.serverAddress, "No server address")} status={<StatusTag value={status(record.status, "DRAFT")} />} onBack={closeDetail}>
          <FieldGrid>
            <FieldRow label="Runtime" value={text(record.runtimeMode, "local-docker")} />
            <FieldRow label="Server address" value={text(record.serverAddress)} />
            <FieldRow label="Admin" value={text(record.activeAdminEmail)} />
            <FieldRow label="Compose project" value={text(record.composeProject)} />
            <FieldRow label="Started" value={formatDate(record.startedAt)} />
            <FieldRow label="Stopped" value={formatDate(record.stoppedAt)} />
            <FieldRow label="Workspace" value={text(record.workspacePath)} full />
            <FieldRow label="Last error" value={text(record.lastError)} full />
          </FieldGrid>
        </EntityDetailView>
      );
    }

    if (detail.kind === "experimentRun") {
      const payload = jobLogDetail?.job?.id === record.id ? jobLogDetail : null;
      const state = payload?.state ?? record;
      const modelResult = payload?.modelResult ?? record.result;
      const modelRelease = modelResult?.modelRelease;
      const modelArtifact = modelRelease?.artifacts?.find((artifact: EntityRecord) => artifact.kind === "AGGREGATED_MODEL");
      return (
        <EntityDetailView title={text(record.nvflareJobId, WORKFLOW_TERMS.federatedRun)} subtitle={text(record.pipelineVersion?.project?.name, "Pipeline source workspace")} status={<StatusTag value={status(state.fedlifyStatus ?? record.status, "DRAFT")} />} onBack={closeDetail} technicalMetadata={payload?.flareMeta?.meta}>
          {payload?.message ? <Alert type="info" showIcon message={payload.message} /> : null}
          <FieldGrid>
            <FieldRow label="Fedlify state" value={displayEnum(state.fedlifyStatus ?? record.status)} />
            <FieldRow label="NVFLARE state" value={displayEnum(state.nvflareStatus)} />
            <FieldRow label="NVFLARE runtime id" value={text(state.nvflareJobId ?? record.nvflareJobId)} />
            <FieldRow label="Submitted" value={formatDate(state.submittedAt ?? record.submittedAt)} />
            <FieldRow label="Pipeline version" value={text(record.pipelineVersion?.version)} />
            <FieldRow label="Git commit" value={shortCommit(record.pipelineVersion?.gitCommit)} />
            <FieldRow label="Selected sites" value={Array.isArray(record.selectedSites) ? `${record.selectedSites.length} site(s)` : "Not recorded"} />
            <FieldRow label="Command summary" value={text(record.commandSummary)} full />
          </FieldGrid>
          <SectionHeader
            title="Training output"
            actions={
              <Space wrap>
                <Button icon={<ReloadOutlined />} disabled={status(state.fedlifyStatus ?? record.status) !== "COMPLETED" || Boolean(modelResult)} loading={formSubmitting} onClick={() => void syncJobResult(String(record.id), state.nvflareJobId)}>
                  Sync result
                </Button>
                <Button icon={<CloudDownloadOutlined />} disabled={!modelResult || Boolean(modelRelease)} loading={formSubmitting} onClick={() => void promoteModelRelease(String(record.id), state.nvflareJobId)}>
                  Promote to model release
                </Button>
                <Button icon={<CloudDownloadOutlined />} disabled={!modelRelease?.id || !modelArtifact?.id} onClick={() => modelRelease?.id && modelArtifact?.id ? void downloadModelReleaseArtifact(String(modelRelease.id), String(modelArtifact.id)) : undefined}>
                  Download model
                </Button>
              </Space>
            }
          />
          <FieldGrid>
            <FieldRow label="Aggregated model" value={text(modelResult?.modelPath, "workspace/models/server.npy")} />
            <FieldRow label="Model shape" value={Array.isArray(modelResult?.modelShape) ? modelResult.modelShape.join(" x ") : "Not synced"} />
            <FieldRow label="Model dtype" value={text(modelResult?.modelDtype, "Not synced")} />
            <FieldRow label="Model release" value={modelRelease ? `${modelRelease.version} · ${displayEnum(modelRelease.status)}` : "Not released"} />
          </FieldGrid>
          <SectionHeader title="Runtime events" />
          <TimelineList events={payload?.events ?? record.events ?? []} />
          <SectionHeader title="Result bundle" />
          <ArtifactList artifacts={Array.isArray(payload?.result?.files) ? payload?.result?.files : []} />
          <SectionHeader title="Live local Docker logs" />
          {(payload?.runtimeLogs ?? []).length === 0 ? (
            <Typography.Text className="fedlify-muted">No local Docker containers matched this run.</Typography.Text>
          ) : (
            payload?.runtimeLogs?.map((log, index) => (
              <div key={log.container ?? index} className="fedlify-runtime-log">
                <div className="fedlify-runtime-log-header">
                  <strong>{text(log.container, "container")}</strong>
                  <span>{text(log.status)}</span>
                </div>
                <pre className="fedlify-command-panel">{text(log.output, "No recent log output.")}</pre>
              </div>
            ))
          )}
        </EntityDetailView>
      );
    }

    if (detail.kind === "modelRelease") {
      const sourceJob = record.sourceResult?.job;
      return (
        <EntityDetailView title={`Model release ${text(record.version)}`} subtitle={`Source run ${text(sourceJob?.nvflareJobId, sourceJob?.id)}`} status={<StatusTag value={record.status} />} onBack={closeDetail}>
          <FieldGrid>
            <FieldRow label="Version" value={text(record.version)} />
            <FieldRow label="Approval state" value={displayEnum(record.status)} />
            <FieldRow label="Source pipeline" value={text(sourceJob?.pipelineVersion?.version)} />
            <FieldRow label="Git commit" value={shortCommit(sourceJob?.pipelineVersion?.gitCommit)} />
            <FieldRow label="Approved" value={formatDate(record.approvedAt)} />
            <FieldRow label="Checksum" value={text(record.checksum)} full />
            <FieldRow label="Release notes" value={text(record.releaseNotes)} full />
          </FieldGrid>
          <SectionHeader title="Model artifacts" />
          <ArtifactList artifacts={record.artifacts ?? []} onDownload={(artifact) => void downloadModelReleaseArtifact(record.id, artifact.id)} />
        </EntityDetailView>
      );
    }

    if (detail.kind === "codeRelease") {
      return (
        <EntityDetailView title={`Code/kit release ${text(record.version)}`} subtitle="Startup kits, source bundles, and checksum manifests" status={<StatusTag value={record.status} />} onBack={closeDetail}>
          <FieldGrid>
            <FieldRow label="Version" value={text(record.version)} />
            <FieldRow label="Approval state" value={displayEnum(record.status)} />
            <FieldRow label="Approved" value={formatDate(record.approvedAt)} />
            <FieldRow label="Checksum" value={text(record.checksum)} full />
          </FieldGrid>
          <SectionHeader title="Code and kit artifacts" />
          <ArtifactList artifacts={record.artifacts ?? []} onDownload={(artifact) => void downloadCodeReleaseArtifact(record.id, artifact.id)} />
        </EntityDetailView>
      );
    }

    return (
      <EntityDetailView title={text(record.action, "Audit event")} subtitle={formatDate(record.createdAt)} status={<StatusTag value={text(record.targetType, "Audit")} />} onBack={closeDetail} technicalMetadata={record.metadata}>
        <FieldGrid>
          <FieldRow label="Action" value={text(record.action)} />
          <FieldRow label="Target type" value={text(record.targetType)} />
          <FieldRow label="Target id" value={text(record.targetId)} />
          <FieldRow label="Actor" value={text(record.actorUserId)} />
          <FieldRow label="Created" value={formatDate(record.createdAt)} />
          <FieldRow label="Study" value={text(record.studyId)} />
        </FieldGrid>
      </EntityDetailView>
    );
  }

  function renderCurrentSection(section: StudyWorkspaceSection) {
    const currentStudy = study;
    if (!currentStudy) return null;
    if (activeDetail) return renderEntityDetail(currentStudy, activeDetail);

    if (section === "overview") {
      const approvedVersions = approvedPipelineVersions(currentStudy);
      const activeRuntimeDeployment = activeDeployment(currentStudy);
      const ready = readyStudySites(currentStudy);
      const connected = connectedStudySites(currentStudy);
      const nextAction = resolveStudyNextAction(currentStudy);
      const readinessItems = summaryReadinessItems(currentStudy);
      const totalSites = currentStudy.studySites?.length ?? currentStudy.sites.length;
      const memberGroups = groupedStudyMembers(currentStudy.members);
      const roleAssignmentCount = currentStudy.members.length;
      const navigationCards = [
        {
          label: "Protocol",
          metric: displayEnum(currentStudy.governanceStatus, "Incomplete"),
          caption: studyProtocolReady(currentStudy)
            ? "Ready for runtime provisioning"
            : studyEthicsReady(currentStudy)
              ? "Ethics approved; activation needed"
              : "Ethics approval or exemption required",
          section: "protocol" as StudyWorkspaceSection,
          icon: <SafetyCertificateOutlined />
        },
        {
          label: "Sites & Data",
          metric: `${ready.length}/${totalSites} ready`,
          caption: `${connected.length} connected; data stays site-local`,
          section: "sites" as StudyWorkspaceSection,
          icon: <ClusterOutlined />
        },
        {
          label: "Team & Access",
          metric: `${memberGroups.length} member${memberGroups.length === 1 ? "" : "s"}`,
          caption: `${roleAssignmentCount} study role assignment${roleAssignmentCount === 1 ? "" : "s"}`,
          section: "team" as StudyWorkspaceSection,
          icon: <MailOutlined />
        },
        {
          label: "Pipeline",
          metric: `${approvedVersions.length} approved`,
          caption: `${currentStudy.pipelineProjects?.length ?? 0} source workspace(s), commit-backed`,
          section: "pipeline" as StudyWorkspaceSection,
          icon: <CodeOutlined />
        },
        {
          label: "Run",
          metric: `${currentStudy.nvflareJobs?.length ?? 0} run${(currentStudy.nvflareJobs?.length ?? 0) === 1 ? "" : "s"}`,
          caption: activeRuntimeDeployment?.serverAddress ? `Aggregator ${activeRuntimeDeployment.serverAddress}` : "Aggregator not started",
          section: "run" as StudyWorkspaceSection,
          icon: <MonitorOutlined />
        },
        {
          label: "Results & Releases",
          metric: `${currentStudy.modelReleases?.length ?? 0} model${(currentStudy.modelReleases?.length ?? 0) === 1 ? "" : "s"}`,
          caption: "Trained model plus code/kit releases",
          section: "results" as StudyWorkspaceSection,
          icon: <CloudDownloadOutlined />
        }
      ];
      const glanceItems = [
        { label: "Protocol status", value: studyProtocolReady(currentStudy) ? "Ready" : displayEnum(currentStudy.governanceStatus, "Incomplete") },
        { label: "Ethics status", value: studyEthicsReady(currentStudy) ? displayEnum(latestEthicsStatus(currentStudy), "Ready") : displayEnum(latestEthicsStatus(currentStudy), "Not recorded") },
        { label: "Data boundary", value: "Data stays site-local" },
        { label: "Aggregator", value: activeRuntimeDeployment?.serverAddress ?? "Not started" },
        { label: "Connected sites", value: `${connected.length}/${totalSites}` }
      ];

      return (
        <div className="fedlify-section-stack">
          <SectionHeader title="Study at a glance" />
          <div className="fedlify-summary-glance-strip">
            {glanceItems.map((item) => (
              <span key={item.label} className="fedlify-summary-glance-item">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </span>
            ))}
          </div>

          <SectionHeader title="Workspace navigation" />
          <CardGrid className="fedlify-navigation-grid">
            {navigationCards.map((card) => (
              <NavigationCard
                key={card.label}
                label={card.label}
                metric={card.metric}
                caption={card.caption}
                icon={card.icon}
                onClick={() => router.push(sectionUrl(card.section))}
              />
            ))}
          </CardGrid>

          <SectionHeader title="Next action" />
          <NextActionCard
            title={nextAction.title}
            description={nextAction.detail}
            buttonLabel={nextAction.buttonLabel}
            state={nextAction.state}
            icon={<PlayCircleOutlined />}
            onClick={() => router.push(sectionUrl(nextAction.section))}
          />

          <SectionHeader title="Lifecycle checklist" />
          <div className="fedlify-summary-readiness-list">
            {readinessItems.map((item) => (
              <article key={item.key} className={`fedlify-summary-readiness-card is-${item.state}`}>
                <span className="fedlify-summary-readiness-icon">{summaryReadinessIcon(item.state)}</span>
                <div className="fedlify-summary-readiness-copy">
                  <div className="fedlify-summary-readiness-header">
                    <span className="fedlify-summary-readiness-status">{summaryReadinessLabel(item.state)}</span>
                    <Button size="small" onClick={() => router.push(sectionUrl(item.section))}>
                      {item.buttonLabel}
                    </Button>
                  </div>
                  <Typography.Text strong className="fedlify-summary-readiness-title">{item.label}</Typography.Text>
                  <Typography.Text className="fedlify-summary-readiness-detail">{item.detail}</Typography.Text>
                </div>
              </article>
            ))}
          </div>
        </div>
      );
    }

    if (section === "protocol") {
      const dataModalityLabels = splitMultiSelectValue(currentStudy.dataModalities).map(
        (value) => governanceOptionLabel(DATA_MODALITY_OPTIONS, value) ?? value
      );
      const missingProtocolFields = [
        currentStudy.title ? null : "study title",
        currentStudy.goal ? null : "goal",
        currentStudy.researchQuestion ? null : "research question",
        currentStudy.clinicalUseCase ? null : "clinical use case",
        currentStudy.population ? null : "population",
        currentStudy.dataModalities ? null : "data modalities",
        currentStudy.primaryOutcome ? null : "primary outcome",
        currentStudy.intendedUse ? null : "intended use"
      ].filter(Boolean);
      const protocolMetadataReady = missingProtocolFields.length === 0;
      const ethicsReady = ethicsGatePassed(currentStudy);
      const hasParticipantSite = (currentStudy.studySites?.length ?? currentStudy.sites.length) > 0;
      const activationReady = protocolMetadataReady && ethicsReady && hasParticipantSite;
      const protocolModules = [
        {
          key: "metadata",
          title: "Protocol metadata",
          detail: protocolMetadataReady ? "Required protocol fields are complete." : `Missing ${missingProtocolFields.length} required field(s).`,
          status: protocolMetadataReady ? "READY" : "NEEDS_ATTENTION",
          icon: <FileTextOutlined />,
          action: "Edit metadata",
          onClick: () => {
            setProtocolTab("metadata");
            setGovernanceEditing(true);
          }
        },
        {
          key: "ethics",
          title: "Ethics review",
          detail: ethicsReady ? displayEnum(latestEthicsStatus(currentStudy), "Approved") : "Approval or exemption is required.",
          status: ethicsReady ? "READY" : "NEEDS_ATTENTION",
          icon: <SafetyCertificateOutlined />,
          action: "Open ethics",
          onClick: () => setProtocolTab("ethics")
        },
        {
          key: "documents",
          title: "Documents",
          detail: `${currentStudy.documents.length} governed document(s) registered.`,
          status: currentStudy.documents.length > 0 ? "READY" : "OPTIONAL",
          icon: <UploadOutlined />,
          action: "Open documents",
          onClick: () => setProtocolTab("documents")
        },
        {
          key: "activation",
          title: "Activation",
          detail: activationReady ? "Study can be activated for runtime gates." : "Metadata, ethics, and at least one site are required.",
          status: currentStudy.status === "ACTIVE" ? "ACTIVE" : activationReady ? "READY" : "BLOCKED",
          icon: <CheckCircleOutlined />,
          action: currentStudy.status === "ACTIVE" ? "Activated" : "Review gates",
          onClick: () => {
            setProtocolTab("activation");
          }
        }
      ];

      return (
        <div className="fedlify-section-stack">
          <div className="fedlify-protocol-module-grid">
            {protocolModules.map((module) => (
              <article key={module.key} className={`fedlify-protocol-module-card is-${module.status.toLowerCase()}`}>
                <div className="fedlify-protocol-module-card-top">
                  <span className="fedlify-protocol-module-icon">{module.icon}</span>
                  <StatusTag value={module.status} />
                </div>
                <div className="fedlify-protocol-module-copy">
                  <strong>{module.title}</strong>
                  <span>{module.detail}</span>
                </div>
                <Button
                  size="small"
                  onClick={module.onClick}
                >
                  {module.action}
                </Button>
              </article>
            ))}
          </div>
          <Tabs
            className="fedlify-card-tabs fedlify-protocol-tabs"
            activeKey={protocolTab}
            onChange={(key) => {
              setFormError(null);
              setProtocolTab(key);
              if (key !== "metadata") setGovernanceEditing(false);
            }}
            items={[
              {
                key: "metadata",
                label: "Protocol metadata",
                children: governanceEditing ? (
                  <section className="fedlify-protocol-module is-wide">
                    <SectionHeader title="Edit protocol metadata" />
                    <Form
                      layout="vertical"
                      className="fedlify-inline-create-form"
                      initialValues={{
                        title: currentStudy.title,
                        description: currentStudy.description,
                        goal: currentStudy.goal,
                        researchQuestion: currentStudy.researchQuestion,
                        clinicalUseCase: currentStudy.clinicalUseCase,
                        population: currentStudy.population,
                        dataModalities: splitMultiSelectValue(currentStudy.dataModalities),
                        primaryOutcome: currentStudy.primaryOutcome,
                        riskLevel: currentStudy.riskLevel ?? "MODERATE",
                        intendedUse: currentStudy.intendedUse
                      }}
                      onFinish={async (values) => {
                        const result = await patch(
                          `/api/v1/studies/${studyId}`,
                          {
                            action: "updateDetails",
                            ...values,
                            dataModalities: normalizeMultiSelectValue(values.dataModalities)
                          },
                          "Protocol metadata saved."
                        );
                        if (result) setGovernanceEditing(false);
                      }}
                    >
                      <FormError title="Protocol metadata was not saved" message={formError} />
                      <div className="fedlify-intake-field-grid">
                        <Form.Item name="title" label="Study title" rules={[{ required: true, min: 3 }]}>
                          <Input />
                        </Form.Item>
                        <Form.Item name="riskLevel" label="Risk level">
                          <Select
                            options={[
                              { value: "LOW", label: "Low" },
                              { value: "MODERATE", label: "Moderate" },
                              { value: "HIGH", label: "High" }
                            ]}
                          />
                        </Form.Item>
                        <Form.Item name="goal" label="Goal" className="fedlify-intake-full" rules={[{ required: true }]}>
                          <Input.TextArea rows={2} />
                        </Form.Item>
                        <Form.Item name="researchQuestion" label="Research question" className="fedlify-intake-full" rules={[{ required: true }]}>
                          <Input.TextArea rows={2} />
                        </Form.Item>
                        <Form.Item name="clinicalUseCase" label="Clinical use case" rules={[{ required: true }]}>
                          <Select
                            showSearch
                            options={CLINICAL_USE_CASE_OPTIONS}
                            optionFilterProp="label"
                            placeholder="Select clinical use case"
                          />
                        </Form.Item>
                        <Form.Item name="population" label="Population" rules={[{ required: true }]}>
                          <Input />
                        </Form.Item>
                        <Form.Item name="dataModalities" label="Data modalities" rules={[{ required: true }]}>
                          <Select
                            mode="tags"
                            options={DATA_MODALITY_OPTIONS}
                            optionFilterProp="label"
                            placeholder="Select modalities"
                          />
                        </Form.Item>
                        <Form.Item name="primaryOutcome" label="Primary outcome" rules={[{ required: true }]}>
                          <Input />
                        </Form.Item>
                        <Form.Item name="intendedUse" label="Intended use" className="fedlify-intake-full" rules={[{ required: true }]}>
                          <Select
                            showSearch
                            options={INTENDED_USE_OPTIONS}
                            optionFilterProp="label"
                            placeholder="Select intended use"
                          />
                        </Form.Item>
                        <Form.Item name="description" label="Protocol summary" className="fedlify-intake-full">
                          <Input.TextArea rows={3} />
                        </Form.Item>
                      </div>
                      <Space className="fedlify-form-actions">
                        <Button
                          onClick={() => {
                            setFormError(null);
                            setGovernanceEditing(false);
                          }}
                          disabled={formSubmitting}
                        >
                          Cancel
                        </Button>
                        <Button type="primary" htmlType="submit" className="fedlify-dark-action" loading={formSubmitting}>
                          Save protocol metadata
                        </Button>
                      </Space>
                    </Form>
                  </section>
                ) : (
                  <section className="fedlify-protocol-module is-wide">
                    <SectionHeader
                      title="Protocol metadata"
                      actions={
                        <Button icon={<EditOutlined />} onClick={() => setGovernanceEditing(true)}>
                          Edit metadata
                        </Button>
                      }
                    />
                    <div className="fedlify-governance-grid">
                      {renderGovernanceField("Study title", currentStudy.title)}
                      {renderGovernanceField("Risk level", displayEnum(currentStudy.riskLevel))}
                      {renderGovernanceField("Goal", currentStudy.goal, "fedlify-governance-full")}
                      {renderGovernanceField("Research question", currentStudy.researchQuestion, "fedlify-governance-full")}
                      {renderGovernanceField(
                        "Clinical use case",
                        governanceOptionLabel(CLINICAL_USE_CASE_OPTIONS, currentStudy.clinicalUseCase)
                      )}
                      {renderGovernanceField("Population", currentStudy.population)}
                      {renderGovernanceTags("Data modalities", dataModalityLabels)}
                      {renderGovernanceField("Primary outcome", currentStudy.primaryOutcome)}
                      {renderGovernanceField("Intended use", governanceOptionLabel(INTENDED_USE_OPTIONS, currentStudy.intendedUse))}
                      {renderGovernanceField("Protocol summary", currentStudy.description, "fedlify-governance-full")}
                    </div>
                  </section>
                )
              },
              {
                key: "ethics",
                label: "Ethics review",
                children: (
                  <section className="fedlify-protocol-module is-wide">
                    <SectionHeader
                      title="Ethics review"
                      description="Record approval, exemption, expiry, or pending review state."
                      actions={
                        <Button icon={<PlusOutlined />} onClick={() => openEthicsForm()}>
                          Record ethics decision
                        </Button>
                      }
                    />
                    {currentStudy.ethics.length === 0 ? (
                      <EmptyState
                        icon={<SafetyCertificateOutlined />}
                        title="No ethics records"
                        description="Add the review decision when ethics status or exemption status is known."
                        compact
                      />
                    ) : (
                      <div className="fedlify-protocol-record-list">
                        {currentStudy.ethics.map((record) => {
                          const title = text(record.approvalNumber, record.status === "PENDING" ? "Pending ethics review" : "Ethics decision");
                          return (
                            <button
                              key={text(record.id, `${record.status}-${record.createdAt}`)}
                              type="button"
                              className="fedlify-protocol-record-row"
                              onClick={() => openDetail("ethics", String(record.id), "protocol")}
                            >
                              <span>
                                <strong>{title}</strong>
                                <small>{text(record.approvingBody, "Review body not recorded")} · {formatDate(record.createdAt)}</small>
                              </span>
                              <StatusTag value={status(record.status)} />
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </section>
                )
              },
              {
                key: "documents",
                label: "Governed documents",
                children: (
                  <section className="fedlify-protocol-module is-wide">
                    <SectionHeader
                      title="Governed documents"
                      description="Register protocol, agreement, policy, and review documents without storing raw clinical data."
                      actions={
                        <Button icon={<UploadOutlined />} onClick={() => openCreate("document")}>
                          Register document
                        </Button>
                      }
                    />
                    <Alert
                      type="warning"
                      showIcon
                      className="fedlify-protocol-note"
                      message="Do not upload raw or participant-level clinical datasets."
                    />
                    {currentStudy.documents.length === 0 ? (
                      <EmptyState
                        icon={<FileTextOutlined />}
                        title="No study documents"
                        description="Register protocol, ethics, policy, or agreement documents only."
                        compact
                      />
                    ) : (
                      <div className="fedlify-protocol-record-list">
                        {currentStudy.documents.map((document) => (
                          <button
                            key={text(document.id, document.filename)}
                            type="button"
                            className="fedlify-protocol-record-row"
                            onClick={() => openDetail("document", String(document.id), "protocol")}
                          >
                            <span>
                              <strong>{text(document.filename, "Study document")}</strong>
                              <small>{displayEnum(document.kind, "Other")} · Version {text(document.version, "1")}</small>
                            </span>
                            <StatusTag value={status(document.scanStatus, "PENDING")} />
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                )
              },
              {
                key: "activation",
                label: "Activation gates",
                children: (
                  <section className="fedlify-protocol-module is-wide">
                    <SectionHeader
                      title="Activation gates"
                      description="A study must pass these gates before runtime provisioning and experiment submission."
                      actions={
                        <Button
                          icon={<CheckCircleOutlined />}
                          type="primary"
                          className="fedlify-dark-action"
                          disabled={currentStudy.status === "ACTIVE" || !activationReady}
                          loading={formSubmitting}
                          onClick={() => void patch(`/api/v1/studies/${studyId}`, { action: "activate" }, "Study activated.")}
                        >
                          {currentStudy.status === "ACTIVE" ? "Study active" : "Activate study"}
                        </Button>
                      }
                    />
                    <Alert
                      type={activationReady ? "success" : "warning"}
                      showIcon
                      className="fedlify-protocol-note"
                      message={
                        activationReady
                          ? "This study has the protocol, ethics, and site information required for activation."
                          : "Activation is blocked until all required protocol gates pass."
                      }
                    />
                    <div className="fedlify-activation-checklist">
                      {[
                        {
                          label: "Protocol metadata",
                          detail: protocolMetadataReady ? "Required study metadata is complete." : `Missing: ${missingProtocolFields.join(", ")}.`,
                          passed: protocolMetadataReady
                        },
                        {
                          label: "Ethics approval or exemption",
                          detail: ethicsReady ? displayEnum(latestEthicsStatus(currentStudy), "Approved") : "Add an approved or not-required ethics record.",
                          passed: ethicsReady
                        },
                        {
                          label: "Participant sites",
                          detail: hasParticipantSite ? `${currentStudy.studySites?.length ?? currentStudy.sites.length} participant site(s) registered.` : "Register at least one participant site.",
                          passed: hasParticipantSite
                        },
                        {
                          label: "Study activation state",
                          detail: currentStudy.status === "ACTIVE" ? "Study is active." : "Activate the study after the above gates pass.",
                          passed: currentStudy.status === "ACTIVE"
                        }
                      ].map((item) => (
                        <article key={item.label} className={`fedlify-activation-check-row ${item.passed ? "is-ready" : "is-blocked"}`}>
                          <span>{item.passed ? <CheckCircleOutlined /> : <ExclamationCircleOutlined />}</span>
                          <div>
                            <strong>{item.label}</strong>
                            <small>{item.detail}</small>
                          </div>
                          <StatusTag value={item.passed ? "READY" : "NEEDS_ATTENTION"} />
                        </article>
                      ))}
                    </div>
                  </section>
                )
              }
            ]}
          />
        </div>
      );
    }

    if (section === "team") {
      const memberGroups = groupedStudyMembers(currentStudy.members);
      const roleAssignmentCount = currentStudy.members.length;
      return (
        <div className="fedlify-section-stack">
          <Tabs
            className="fedlify-card-tabs fedlify-workspace-tabs"
            activeKey={teamTab}
            onChange={setTeamTab}
            items={[
              {
                key: "members",
                label: "Members",
                children: (
                  <div className="fedlify-tab-panel">
                    <SectionHeader
                      title="Study members and roles"
                      description={`${memberGroups.length} people hold ${roleAssignmentCount} study role assignment${roleAssignmentCount === 1 ? "" : "s"}.`}
                    />
                    {memberGroups.length === 0 ? (
                      <EmptyState icon={<MailOutlined />} title="No study members" description="Invite people and assign one or more study roles." />
                    ) : (
                      <CardGrid>
                        {memberGroups.map((member) => {
                          const roles = member.roles ?? uniqueValues(member.memberships.map((membership: EntityRecord) => membership.role));
                          return (
                            <EntityCard
                              className="fedlify-member-card"
                              key={member.id}
                              onClick={() => openDetail("member", member.id, "team")}
                              title={member.user.name ?? member.user.email}
                              subtitle={member.user.email}
                              meta={[`${roles.length} study role${roles.length === 1 ? "" : "s"} assigned`]}
                              actionsMenu={
                                <EntityActionMenu
                                  items={[
                                    { key: "view", label: "View member", icon: <EyeOutlined />, onClick: () => openDetail("member", member.id, "team") },
                                    { key: "roles", label: "Edit study roles", icon: <EditOutlined />, onClick: () => {
                                      openDetail("member", member.id, "team");
                                      setMemberRoleEditingId(String(member.id));
                                    } }
                                  ]}
                                />
                              }
                            >
                              <div className="fedlify-member-card-body">
                                <span className="fedlify-member-role-label">Assigned study roles</span>
                                <span className="fedlify-role-chip-list is-left">
                                  {roles.map((role: string) => (
                                    <StatusTag key={role} value={role} />
                                  ))}
                                </span>
                              </div>
                            </EntityCard>
                          );
                        })}
                      </CardGrid>
                    )}
                  </div>
                )
              },
              {
                key: "invitations",
                label: "Pending invitations",
                children: (
                  <div className="fedlify-tab-panel">
                    <SectionHeader
                      title="Pending invitations"
                      description="Track people invited to the study before they accept their role assignments."
                    />
                    {currentStudy.invitations.length === 0 ? (
                      <EmptyState
                        icon={<MailOutlined />}
                        title="No invitations issued"
                        description="Add study members or site staff when they need study-scoped access."
                      />
                    ) : (
                      <CardGrid>
                        {currentStudy.invitations.map((invitation) => {
                          const roles = Array.isArray(invitation.roles) && invitation.roles.length > 0 ? invitation.roles : [invitation.role];
                          return (
                            <EntityCard
                              key={text(invitation.id, `${invitation.email}-${invitation.createdAt}`)}
                              onClick={() => openDetail("invitation", String(invitation.id), "team")}
                              title={text(invitation.email, "Invitation")}
                              subtitle={`Expires ${formatDate(invitation.expiresAt)}`}
                              status={<StatusTag value={status(invitation.status, "PENDING")} />}
                              meta={[`${roles.length} study role${roles.length === 1 ? "" : "s"}`]}
                              actionsMenu={<EntityActionMenu items={[{ key: "view", label: "View invitation", icon: <EyeOutlined />, onClick: () => openDetail("invitation", String(invitation.id), "team") }]} />}
                            >
                              <span className="fedlify-role-chip-list is-left">
                                {roles.map((role: string) => (
                                  <StatusTag key={role} value={role} />
                                ))}
                              </span>
                            </EntityCard>
                          );
                        })}
                      </CardGrid>
                    )}
                  </div>
                )
              }
            ]}
          />
        </div>
      );
    }

    if (section === "sites") {
      const readySites = readyStudySites(currentStudy);
      const connectedSites = connectedStudySites(currentStudy);
      return (
        <div className="fedlify-section-stack">
          {siteToken ? (
            <Alert
              type="success"
              showIcon
              message="Participant site token created"
              description={`Store this token in the participant site's agent secret store: ${siteToken}`}
            />
          ) : null}
          <Tabs
            className="fedlify-card-tabs fedlify-workspace-tabs"
            activeKey={sitesTab}
            onChange={setSitesTab}
            items={[
              {
                key: "sites",
                label: "Participant sites",
                children: (
                  <div className="fedlify-tab-panel">
                    <SectionHeader
                      title="Participant sites"
                      description="Institutions participating in the federated study."
                    />
                    {(currentStudy.studySites?.length ?? 0) === 0 ? (
                      <EmptyState
                        icon={<ClusterOutlined />}
                        title="No participant sites"
                        description="Register at least one institution before generating site-specific kits."
                      />
                    ) : (
                      <CardGrid>
                        {currentStudy.studySites.map((site) => (
                          <EntityCard
                            key={text(site.id, site.name)}
                            onClick={() => openDetail("site", String(site.id), "sites")}
                            title={text(site.name, "Site")}
                            subtitle={text(site.institutionName, "Institution not recorded")}
                            status={<StatusTag value={status(site.participationStatus, "OFFLINE")} />}
                            meta={[
                              `PI: ${text(site.principalInvestigator, "Not set")}`,
                              `Data: ${text(site.dataProfile?.modality, "Not set")}`,
                              `Readiness: ${displayEnum(site.readinessChecks?.[0]?.status, "Pending")}`
                            ]}
                            actionsMenu={
                              <EntityActionMenu
                                items={[
                                  { key: "view", label: "View site", icon: <EyeOutlined />, onClick: () => openDetail("site", String(site.id), "sites") },
                                  { key: "dashboard", label: "Open onboarding dashboard", icon: <ClusterOutlined />, onClick: () => router.push(`/sites/${site.id}`) }
                                ]}
                              />
                            }
                          />
                        ))}
                      </CardGrid>
                    )}
                  </div>
                )
              },
              {
                key: "readiness",
                label: "Readiness & data",
                children: (
                  <div className="fedlify-tab-panel">
                    <SectionHeader
                      title="Readiness and data profiles"
                      description={`${readySites.length}/${currentStudy.studySites?.length ?? 0} sites ready, ${connectedSites.length} connected. Fedlify stores cohort-level metadata only.`}
                    />
                    {(currentStudy.studySites?.length ?? 0) === 0 ? (
                      <EmptyState
                        icon={<ClusterOutlined />}
                        title="No site readiness state"
                        description="Register participant sites before tracking readiness and data profile completeness."
                      />
                    ) : (
                      <CardGrid>
                        {currentStudy.studySites.map((site) => (
                          <EntityCard
                            key={text(site.id, site.name)}
                            onClick={() => openDetail("site", String(site.id), "sites")}
                            title={text(site.name, "Site")}
                            subtitle={text(site.dataProfile?.datasetDescription, "Dataset summary not recorded")}
                            status={<StatusTag value={status(site.readinessChecks?.[0]?.status, "PENDING")} />}
                            meta={[
                              `Connection: ${displayEnum(site.nvflareStatuses?.[0]?.status, "Offline")}`,
                              `Modalities: ${text(site.dataProfile?.modality, "Not set")}`,
                              `Cohort: ${text(site.dataProfile?.cohortSizeRange, "Not set")}`,
                              `Resources: ${[
                                site.resourceProfile?.cpuCores ? `${site.resourceProfile.cpuCores} CPU` : null,
                                site.resourceProfile?.gpuCount ? `${site.resourceProfile.gpuCount} GPU` : null,
                                site.resourceProfile?.ramGb ? `${site.resourceProfile.ramGb} GB RAM` : null
                              ].filter(Boolean).join(" · ") || "Not recorded"}`
                            ]}
                            actionsMenu={
                              <EntityActionMenu
                                items={[
                                  { key: "view", label: "View site profile", icon: <EyeOutlined />, onClick: () => openDetail("site", String(site.id), "sites") },
                                  { key: "dashboard", label: "Open onboarding dashboard", icon: <ClusterOutlined />, onClick: () => router.push(`/sites/${site.id}`) }
                                ]}
                              />
                            }
                          />
                        ))}
                      </CardGrid>
                    )}
                  </div>
                )
              }
            ]}
          />
        </div>
      );
    }

    if (section === "pipeline") {
      const pipelineVersions = (currentStudy.pipelineProjects ?? []).flatMap((project) =>
        (project.versions ?? []).map((version: EntityRecord) => ({ ...version, project }))
      );
      const pipelineProposals = (currentStudy.pipelineProjects ?? []).flatMap((project) =>
        (project.proposals ?? []).map((proposal: EntityRecord) => ({ ...proposal, project }))
      );
      const approvedTemplatesForPipeline = approvedTemplateCatalog(templates);
      return (
        <div className="fedlify-section-stack">
          <WorkflowRail steps={pipelineWorkflowSteps(currentStudy)} />
          <Tabs
            className="fedlify-card-tabs fedlify-workspace-tabs"
            activeKey={pipelineTab}
            onChange={setPipelineTab}
            items={[
              {
                key: "templates",
                label: "Template sources",
                children: (
                  <div className="fedlify-tab-panel">
                    <SectionHeader
                      title="Template sources"
                      description="Approved public or study template sources that can be copied into a study-specific pipeline version."
                    />
                    {approvedTemplatesForPipeline.length === 0 ? (
                      <EmptyState
                        icon={<CodeOutlined />}
                        title="No approved template sources"
                        description="Publish a public template version or approve a study template before creating a runnable pipeline version."
                      />
                    ) : (
                      <CardGrid>
                        {approvedTemplatesForPipeline.map((template) => {
                          const version = template.currentApprovedVersion;
                          return (
                            <EntityCard
                              key={text(version?.id, template.id)}
                              onClick={() => router.push(`/templates/${template.id}`)}
                              title={text(template.name, template.templateKey)}
                              subtitle={templateScopeLabel(template)}
                              status={<StatusTag value={status(template.status ?? version?.approvalStatus, "APPROVED")} />}
                              meta={[
                                `Approved version: ${templateVersionLabel(version)}`,
                                `Framework: ${text(template.framework, "NVFLARE")}`,
                                `Workflow: ${text(template.templateKey, "Not recorded")}`
                              ]}
                              actionsMenu={
                                <EntityActionMenu
                                  items={[
                                    { key: "use", label: "Use template", icon: <PlayCircleOutlined />, onClick: () => openPipelineCreate(String(version.id)) },
                                    { key: "review", label: "Review source", icon: <CodeOutlined />, onClick: () => router.push(`/templates/${template.id}?tab=code`) },
                                    { key: "open", label: "Open template", icon: <EyeOutlined />, onClick: () => router.push(`/templates/${template.id}`) }
                                  ]}
                                />
                              }
                            />
                          );
                        })}
                      </CardGrid>
                    )}
                  </div>
                )
              },
              {
                key: "versions",
                label: "Pipeline versions",
                children: (
                  <div className="fedlify-tab-panel">
                    <SectionHeader
                      title="Pipeline versions"
                      description="Immutable study pipeline commits. A version must pass validation and be approved before it can run."
                    />
                    {pipelineVersions.length === 0 ? (
                      <EmptyState icon={<CodeOutlined />} title="No pipeline versions" description="Create a pipeline from a template to generate the first validated commit." />
                    ) : (
                      <CardGrid>
                        {pipelineVersions.map((version) => (
                          <EntityCard
                            key={String(version.id)}
                            onClick={() => openDetail("pipelineVersion", String(version.id), "pipeline")}
                            title={text(version.version, "Pipeline version")}
                            subtitle={text(version.project?.name, "Pipeline source workspace")}
                            status={<StatusTag value={version.approvalStatus ?? version.validationStatus} />}
                            meta={[
                              `State: ${pipelineVersionState(version)}`,
                              `Template: ${templateVersionLabel(version.templateVersion ?? version.project?.templateVersion)}`,
                              `Validation: ${displayEnum(version.validationStatus)}`,
                              `Approval: ${displayEnum(version.approvalStatus)}`,
                              `Commit: ${shortCommit(version.gitCommit)}`
                            ]}
                            actionsMenu={
                              <EntityActionMenu
                                items={[
                                  { key: "view", label: "View version", icon: <EyeOutlined />, onClick: () => openDetail("pipelineVersion", String(version.id), "pipeline") },
                                  { key: "code", label: "Review code", icon: <CodeOutlined />, onClick: () => openDetail("pipelineVersion", String(version.id), "pipeline") },
                                  {
                                    key: "approve",
                                    label: "Approve version",
                                    icon: <CheckCircleOutlined />,
                                    disabled: version.approvalStatus === "APPROVED" || version.validationStatus !== "PASSED",
                                    onClick: () =>
                                      void post(
                                        `/api/v1/pipeline-versions/${version.id}/approve`,
                                        { notes: "Approved after human review in Fedlify." },
                                        "Pipeline version approved."
                                      )
                                  }
                                ]}
                              />
                            }
                          />
                        ))}
                      </CardGrid>
                    )}
                  </div>
                )
              },
              {
                key: "proposals",
                label: "Draft PRs",
                children: (
                  <div className="fedlify-tab-panel">
                    <SectionHeader
                      title="Draft pipeline PRs"
                      description="Gitea branches generated for study pipeline versions. Review these before approving the immutable version."
                    />
                    {pipelineProposals.length === 0 ? (
                      <EmptyState icon={<RobotOutlined />} title="No draft pipeline PRs" description="Create a pipeline from a template to open the first study-scoped PR." />
                    ) : (
                      <CardGrid>
                        {pipelineProposals.map((proposal) => {
                          const pullRequestUrl = externalUrl(proposal.giteaPullRequestUrl);
                          const branchUrl = giteaBranchUrl(proposal.project?.giteaRepoUrl, proposal.branchName);
                          return (
                            <EntityCard
                              key={String(proposal.id)}
                              onClick={() => openDetail("pipelineProject", String(proposal.project?.id), "pipeline")}
                              title={text(proposal.title, proposal.project?.name)}
                              subtitle={templateSourceLabel(proposal.project?.template, proposal.project?.templateVersion)}
                              status={<StatusTag value={status(proposal.status, "DRAFT")} />}
                              meta={[
                                `Branch: ${text(proposal.branchName)}`,
                                `Commit: ${shortCommit(proposal.giteaHeadCommit)}`,
                                `PR: ${proposal.giteaPullRequestNumber ? `#${proposal.giteaPullRequestNumber}` : "Not opened"}`
                              ]}
                              actionsMenu={
                                <EntityActionMenu
                                  items={[
                                    { key: "view", label: "View pipeline source", icon: <EyeOutlined />, onClick: () => openDetail("pipelineProject", String(proposal.project?.id), "pipeline") },
                                    ...(pullRequestUrl ? [{ key: "pr", label: "Review PR", icon: <FileTextOutlined />, href: pullRequestUrl, target: "_blank" }] : []),
                                    ...(branchUrl ? [{ key: "code", label: "Open branch", icon: <CodeOutlined />, href: branchUrl, target: "_blank" }] : [])
                                  ]}
                                />
                              }
                            />
                          );
                        })}
                      </CardGrid>
                    )}
                  </div>
                )
              }
            ]}
          />
        </div>
      );
    }

    if (section === "run") {
      const activeDeployment = currentStudy.nvflareDeployments?.find((deployment) => deployment.active) ?? currentStudy.nvflareDeployments?.[0];
      return (
        <div className="fedlify-section-stack">
          <Tabs
            className="fedlify-card-tabs fedlify-workspace-tabs"
            activeKey={runTab}
            onChange={setRunTab}
            items={[
              {
                key: "readiness",
                label: "Readiness",
                children: (
                  <div className="fedlify-tab-panel">
                    <WorkflowRail steps={operationsWorkflowSteps(currentStudy)} />
                    <GateChecklist items={operationsGateItems(currentStudy)} />
                  </div>
                )
              },
              {
                key: "aggregator",
                label: "Aggregator",
                children: (
                  <div className="fedlify-tab-panel">
                    <SectionHeader
                      title="Aggregator deployment"
                      description="Provision and start the local NVFLARE aggregator before sites join the federation."
                      actions={
                        <Button icon={<ClusterOutlined />} type="primary" className="fedlify-dark-action" loading={formSubmitting} onClick={() => void provisionDeployment()}>
                          Provision deployment
                        </Button>
                      }
                    />
                    {(currentStudy.nvflareDeployments?.length ?? 0) === 0 ? (
                      <EmptyState
                        icon={<ClusterOutlined />}
                        title="No NVFLARE deployment"
                        description="Provision a local Docker aggregator after protocol activation and before submitting federated runs."
                      />
                    ) : (
                      <CardGrid>
                        {currentStudy.nvflareDeployments.map((deployment) => (
                          <EntityCard
                            key={text(deployment.id, deployment.createdAt)}
                            onClick={() => openDetail("deployment", String(deployment.id), "run")}
                            title={text(deployment.name, "NVFLARE deployment")}
                            subtitle={text(deployment.serverAddress, "Server address not assigned")}
                            status={<StatusTag value={status(deployment.status, "DRAFT")} />}
                            meta={[
                              `Runtime: ${text(deployment.runtimeMode, "local-docker")}`,
                              `Admin: ${text(deployment.activeAdminEmail)}`,
                              `Compose: ${text(deployment.composeProject)}`,
                              deployment.lastError ? `Last error: ${deployment.lastError}` : `Workspace: ${text(deployment.workspacePath)}`
                            ]}
                            actionsMenu={
                              <EntityActionMenu
                                items={[
                                  { key: "view", label: "View deployment", icon: <EyeOutlined />, onClick: () => openDetail("deployment", String(deployment.id), "run") },
                                  { key: "start", label: "Start aggregator", icon: <PlayCircleOutlined />, disabled: deployment.status === "ACTIVE", onClick: () => void startDeployment(deployment.id) },
                                  { key: "stop", label: "Stop aggregator", danger: true, disabled: deployment.status !== "ACTIVE", onClick: () => void stopDeployment(deployment.id) }
                                ]}
                              />
                            }
                          />
                        ))}
                      </CardGrid>
                    )}
                  </div>
                )
              },
              {
                key: "runs",
                label: "Federated runs",
                children: (
                  <div className="fedlify-tab-panel">
                    <CardGrid className="fedlify-stat-grid">
                      <StatCard
                        label="Connected sites"
                        value={(currentStudy.studySites ?? []).filter((site) => site.nvflareStatuses?.[0]?.status === "CONNECTED").length}
                        onClick={() => router.push(sectionUrl("sites"))}
                      />
                      <StatCard
                        label="Approved versions"
                        value={currentApprovedPipelineVersions(currentStudy).length}
                        onClick={() => router.push(sectionUrl("pipeline"))}
                      />
                      <StatCard
                        label="Federated runs"
                        value={currentStudy.nvflareJobs?.length ?? 0}
                        onClick={() => router.push(sectionUrl("run"))}
                      />
                      <StatCard
                        label="Aggregator"
                        value={activeDeployment?.status ?? "NONE"}
                        onClick={() => activeDeployment?.id ? openDetail("deployment", String(activeDeployment.id), "run") : undefined}
                      />
                    </CardGrid>
                    {(currentStudy.nvflareJobs?.length ?? 0) === 0 ? (
                      <EmptyState
                        icon={<MonitorOutlined />}
                        title="No federated runs"
                        description="Submit an approved pipeline version after sites pass readiness checks."
                      />
                    ) : (
                      <CardGrid>
                        {currentStudy.nvflareJobs.map((job) => (
                          <EntityCard
                            key={text(job.id, job.createdAt)}
                            onClick={() => openDetail("experimentRun", String(job.id), "run")}
                            title={text(job.nvflareJobId, WORKFLOW_TERMS.federatedRun)}
                            subtitle={text(job.pipelineVersion?.project?.name, "Pipeline source workspace")}
                            status={<StatusTag value={status(job.status, "DRAFT")} />}
                            meta={[
                              `Submitted ${formatDate(job.submittedAt ?? job.createdAt)}`,
                              `${job.events?.length ?? 0} events`,
                              `${job.logArtifacts?.length ?? 0} log artifacts`
                            ]}
                            actionsMenu={
                              <EntityActionMenu
                                items={[
                                  { key: "view", label: "View run", icon: <EyeOutlined />, onClick: () => openDetail("experimentRun", String(job.id), "run") },
                                  { key: "refresh", label: "Refresh state and logs", icon: <ReloadOutlined />, onClick: () => void openJobLogs(job) },
                                  {
                                    key: "abort",
                                    label: "Abort run",
                                    danger: true,
                                    disabled: ["COMPLETED", "FAILED", "ABORTED", "REJECTED"].includes(status(job.status)),
                                    onClick: () =>
                                      void post(
                                        `/api/v1/nvflare/jobs/${job.id}/abort`,
                                        { reason: "Aborted from Fedlify run dashboard." },
                                        "Federated run abort requested."
                                      )
                                  }
                                ]}
                              />
                            }
                          />
                        ))}
                      </CardGrid>
                    )}
                  </div>
                )
              }
            ]}
          />
        </div>
      );
    }

    if (section === "results") {
      const modelReleases = currentStudy.modelReleases ?? [];
      return (
        <div className="fedlify-section-stack">
          <Tabs
            className="fedlify-card-tabs fedlify-workspace-tabs"
            activeKey={resultsTab}
            onChange={setResultsTab}
            items={[
              {
                key: "models",
                label: "Trained model releases",
                children: (
                  <div className="fedlify-tab-panel">
                    <SectionHeader
                      title="Trained model releases"
                      description="Approved aggregate model artifacts promoted from completed federated runs."
                    />
                    {modelReleases.length === 0 ? (
                      <EmptyState icon={<CloudDownloadOutlined />} title="No trained model releases" description="Promote a completed federated run result from Run." />
                    ) : (
                      <CardGrid>
                        {modelReleases.map((release) => {
                          const modelArtifact = release.artifacts?.find((artifact: EntityRecord) => artifact.kind === "AGGREGATED_MODEL");
                          const sourceJob = release.sourceResult?.job;
                          return (
                            <EntityCard
                              key={release.id}
                              onClick={() => openDetail("modelRelease", String(release.id), "results")}
                              title={`Model ${release.version}`}
                              subtitle={`Source run ${text(sourceJob?.nvflareJobId, sourceJob?.id)}`}
                              status={<StatusTag value={release.status} />}
                              meta={[
                                sourceJob?.pipelineVersion?.version ? `Pipeline ${sourceJob.pipelineVersion.version}` : "Pipeline version not recorded",
                                release.checksum ? `${release.checksum.slice(0, 12)}...` : "No checksum",
                                `Approved ${formatDate(release.approvedAt)}`
                              ]}
                              actionsMenu={
                                <EntityActionMenu
                                  items={[
                                    { key: "view", label: "View model release", icon: <EyeOutlined />, onClick: () => openDetail("modelRelease", String(release.id), "results") },
                                    ...(modelArtifact ? [{ key: "model", label: "Download model", icon: <CloudDownloadOutlined />, onClick: () => void downloadModelReleaseArtifact(release.id, modelArtifact.id) }] : []),
                                    ...(release.artifacts ?? [])
                                      .filter((artifact: EntityRecord) => artifact.kind !== "AGGREGATED_MODEL")
                                      .slice(0, 3)
                                      .map((artifact: EntityRecord) => ({
                                        key: artifact.id,
                                        label: `Download ${displayEnum(artifact.kind)}`,
                                        icon: <CloudDownloadOutlined />,
                                        onClick: () => void downloadModelReleaseArtifact(release.id, artifact.id)
                                      }))
                                  ]}
                                />
                              }
                            />
                          );
                        })}
                      </CardGrid>
                    )}
                  </div>
                )
              },
              {
                key: "code",
                label: "Code and kit artifacts",
                children: (
                  <div className="fedlify-tab-panel">
                    <SectionHeader
                      title="Code and kit artifacts"
                      description="Approved startup kits, source bundles, and checksum manifests."
                    />
                    {currentStudy.releases.length === 0 ? (
                      <EmptyState
                        icon={<CloudDownloadOutlined />}
                        title="No code or kit releases"
                        description="Approved, immutable kit releases will appear after human review."
                      />
                    ) : (
                      <CardGrid>
                        {currentStudy.releases.map((release) => (
                          <EntityCard
                            key={release.id}
                            onClick={() => openDetail("codeRelease", release.id, "results")}
                            title={`Code/kit release ${release.version}`}
                            subtitle={`Approved ${formatDate(release.approvedAt)}`}
                            status={<StatusTag value={release.status} />}
                            meta={[`${release.artifacts?.length ?? 0} artifacts`, `${release.checksum.slice(0, 12)}...`]}
                            actionsMenu={
                              <EntityActionMenu
                                items={[
                                  { key: "view", label: "View code/kit release", icon: <EyeOutlined />, onClick: () => openDetail("codeRelease", release.id, "results") },
                                  ...(release.artifacts ?? []).slice(0, 4).map((artifact) => ({
                                    key: artifact.id,
                                    label: `Download ${displayEnum(artifact.kind)}`,
                                    icon: <CloudDownloadOutlined />,
                                    onClick: () => void downloadCodeReleaseArtifact(release.id, artifact.id)
                                  }))
                                ]}
                              />
                            }
                          />
                        ))}
                      </CardGrid>
                    )}
                  </div>
                )
              }
            ]}
          />
        </div>
      );
    }

    return (
      <div className="fedlify-section-stack">
        {currentStudy.auditEvents.length === 0 ? (
          <EmptyState
            icon={<AuditOutlined />}
            title="No audit events"
            description="Access, governance, artifact, and release actions will be recorded here."
          />
        ) : (
          <CardGrid>
            {currentStudy.auditEvents.map((event) => (
              <EntityCard
                key={text(event.id, `${event.action}-${event.createdAt}`)}
                onClick={() => openDetail("auditEvent", String(event.id), "audit")}
                title={text(event.action, "Audit event")}
                subtitle={text(event.targetId, "No target recorded")}
                status={<StatusTag value={text(event.targetType, "Audit")} />}
                meta={[formatDate(event.createdAt)]}
                actionsMenu={<EntityActionMenu items={[{ key: "view", label: "View audit event", icon: <EyeOutlined />, onClick: () => openDetail("auditEvent", String(event.id), "audit") }]} />}
              />
            ))}
          </CardGrid>
        )}
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <AppPage>
        <AppPageHeader
          title={activeCreateMeta?.title ?? activeSectionMeta.title}
          subtitle={activeCreateMeta?.subtitle ?? activeSectionMeta.subtitle}
          backLabel={activeCreateMeta?.backLabel}
          onBack={activeCreate ? closeCreate : undefined}
          actions={activeCreate ? null : renderHeaderAction(activeSection)}
        />

        {activeCreate ? renderInlineCreateForm(activeCreate) : renderCurrentSection(activeSection)}
      </AppPage>
    </>
  );
}
