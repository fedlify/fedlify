"use client";

import {
  AuditOutlined,
  CheckCircleOutlined,
  CloudDownloadOutlined,
  ClusterOutlined,
  CodeOutlined,
  EditOutlined,
  EyeOutlined,
  FileTextOutlined,
  GithubOutlined,
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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppPage, AppPageHeader, SectionHeader } from "@/components/AppPage";
import { CodeReviewPanel } from "@/components/CodeReviewPanel";
import {
  CardGrid,
  EntityCard,
  StatCard,
  WorkspaceActionCard,
  WorkspaceCardGrid,
  WorkspaceEmptyCard,
  WorkspaceRecordCard,
  WorkspaceReviewCard
} from "@/components/DataCards";
import { ArtifactList, EntityActionMenu, EntityDetailView, FieldGrid, FieldRow, TimelineList } from "@/components/EntityDetail";
import { FormError } from "@/components/FormFeedback";
import { CardGridSkeleton, EmptyState, InlineLoadError } from "@/components/LoadStates";
import { normalizeRichTextValue, RichTextContent, RichTextEditor, richTextHasText } from "@/components/RichTextEditor";
import { StatusTag } from "@/components/StatusTag";
import { GateChecklist, WorkflowRail, type GateItem, type WorkflowStep } from "@/components/WorkflowRail";
import { missingProtocolFields as missingCoreProtocolFields } from "@/lib/governance";
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
  summaryReadinessItems
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

type DetailPageMeta = {
  title: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  backLabel?: string;
};

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
  hypothesis?: string;
  secondaryObjectives?: string;
  clinicalUseCase?: string;
  studyDesign?: string;
  population?: string;
  eligibilityCriteria?: string;
  dataModalities?: string;
  primaryOutcome?: string;
  primaryEndpointDetails?: string;
  secondaryOutcomes?: string;
  sampleSizeRationale?: string;
  analysisPlan?: string;
  dataHandlingPlan?: string;
  humanAiWorkflow?: string;
  fairnessPlan?: string;
  disseminationPlan?: string;
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
  studyDesign: {
    title: "Edit study design",
    subtitle: "Update the study design, scientific question, outcomes, analysis, and AI/federated governance plans.",
    backLabel: "Study protocol"
  },
  invite: {
    title: "Add study member",
    subtitle: "Invite one person and assign one or more study roles.",
    backLabel: "Team and access"
  },
  ethics: {
    title: "Record ethics decision",
    subtitle: "Document the review status, approval identifier, responsible body, and notes.",
    backLabel: "Study protocol"
  },
  document: {
    title: "Register study document",
    subtitle: "Add a study protocol, ethics, policy, or agreement document for study governance.",
    backLabel: "Study protocol"
  },
  site: {
    title: "Register participant site",
    subtitle: "Add the institution identity first. Data and resource profiles are completed from the site view.",
    backLabel: "Sites and data"
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

const STUDY_PROTOCOL_FIELD_LABELS: Record<string, string> = {
  title: "Study title",
  goal: "Primary objective",
  researchQuestion: "Research question",
  studyDesign: "Study design",
  clinicalUseCase: "Clinical use case",
  population: "Population",
  eligibilityCriteria: "Eligibility criteria",
  dataModalities: "Data modalities",
  primaryOutcome: "Primary endpoint",
  primaryEndpointDetails: "Endpoint details",
  analysisPlan: "Analysis plan",
  dataHandlingPlan: "Data handling plan",
  intendedUse: "Intended use"
};

const RICH_STUDY_DESIGN_FIELDS = [
  "description",
  "goal",
  "researchQuestion",
  "hypothesis",
  "secondaryObjectives",
  "studyDesign",
  "eligibilityCriteria",
  "primaryEndpointDetails",
  "secondaryOutcomes",
  "sampleSizeRationale",
  "analysisPlan",
  "dataHandlingPlan",
  "humanAiWorkflow",
  "fairnessPlan",
  "disseminationPlan"
];

function normalizeStudyDesignPayload(values: Record<string, unknown>) {
  return RICH_STUDY_DESIGN_FIELDS.reduce(
    (payload, field) => ({
      ...payload,
      [field]: normalizeRichTextValue(values[field])
    }),
    { ...values }
  );
}

function readableList(items: string[]) {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function summarizeMissingLabels(items: string[], maxItems = 3) {
  if (items.length <= maxItems) return readableList(items);
  return `${readableList(items.slice(0, maxItems))}, and ${items.length - maxItems} more`;
}

const REQUIRED_RICH_TEXT_RULE = {
  validator: (_: unknown, value: unknown) =>
    richTextHasText(value) ? Promise.resolve() : Promise.reject(new Error("This field is required."))
};

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

function renderGovernanceField(label: string, value: unknown, className?: string, rich = false) {
  return (
    <div className={["fedlify-governance-field", className].filter(Boolean).join(" ")}>
      <span className="fedlify-governance-label">{label}</span>
      {rich ? <RichTextContent value={typeof value === "string" ? value : null} /> : <span className="fedlify-governance-value">{text(value)}</span>}
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

function GovernanceSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="fedlify-governance-section">
      <div className="fedlify-governance-section-title">{title}</div>
      {children}
    </section>
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
      label: "1. Generate or select pipeline code",
      detail: latestProject
        ? `Using: ${templateSourceLabel(latestProject.template, latestProject.templateVersion)}`
        : "Use the AI agent to generate code, or pick an approved template",
      state: workflowState(Boolean(latestProject))
    },
    {
      label: "2. Review the code in Gitea",
      detail: latestProposal?.giteaPullRequestUrl
        ? "Pull request open — inspect and edit the code"
        : "Fedlify opens a Gitea branch and pull request for review",
      state: workflowState(Boolean(latestProposal?.giteaPullRequestUrl), !latestProject),
      meta: latestProposal?.giteaHeadCommit ? `Commit ${String(latestProposal.giteaHeadCommit).slice(0, 12)}` : undefined
    },
    {
      label: "3. Pass CI validation",
      detail: validated.length > 0
        ? `${validated.length} version(s) passed — ready for approval`
        : "CI checks must pass on the exact commit before approval",
      state: workflowState(validated.length > 0, !latestProposal)
    },
    {
      label: "4. Approve for deployment",
      detail: approved.length > 0
        ? `${approved.length} approved version(s) — ready to run`
        : "A reviewer marks the validated commit as approved",
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
      label: "Study protocol",
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

function workflowReviewStatus(state: WorkflowStep["state"]) {
  if (state === "done") return "READY";
  if (state === "blocked") return "BLOCKED";
  if (state === "waiting") return "OPTIONAL";
  return "NEEDS_ATTENTION";
}

function workflowReviewTone(state: WorkflowStep["state"]) {
  if (state === "done") return "ready";
  if (state === "blocked") return "blocked";
  if (state === "waiting") return "optional";
  return "needs_attention";
}

function summaryStateStatus(state: "ready" | "needs_attention" | "done") {
  if (state === "done") return "DONE";
  if (state === "ready") return "READY";
  return "NEEDS_ATTENTION";
}

function summaryStateTone(state: "ready" | "needs_attention" | "done") {
  return state === "needs_attention" ? "needs_attention" : "ready";
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
  const [activeCreate, setActiveCreate] = useState<"studyDesign" | "invite" | "ethics" | "document" | "site" | "job" | null>(null);
  const [protocolTab, setProtocolTab] = useState("review");
  const [teamTab, setTeamTab] = useState("members");
  const [sitesTab, setSitesTab] = useState("sites");
  const [runTab, setRunTab] = useState("readiness");
  const [resultsTab, setResultsTab] = useState("models");
  const [ethicsEditingRecord, setEthicsEditingRecord] = useState<EntityRecord | null>(null);
  const [memberRoleEditingId, setMemberRoleEditingId] = useState<string | null>(null);
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
    setEthicsEditingRecord(null);
    setMemberRoleEditingId(null);
    if (activeSection !== "protocol") setProtocolTab("review");
    if (activeSection !== "team") setTeamTab("members");
    if (activeSection !== "sites") setSitesTab("sites");
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
  const activeDetailMeta = !activeCreate && activeDetail ? detailMetaFor(study, activeDetail) : null;

  function renderHeaderAction(section: StudyWorkspaceSection) {
    void section;
    return null;
  }

  function renderStudyDesignEditForm() {
    const currentStudy = study!;
    return (
      <div className="fedlify-inline-create-card">
        <Form
          layout="vertical"
          className="fedlify-inline-create-form"
          initialValues={{
            title: currentStudy.title,
            description: currentStudy.description,
            goal: currentStudy.goal,
            researchQuestion: currentStudy.researchQuestion,
            hypothesis: currentStudy.hypothesis,
            secondaryObjectives: currentStudy.secondaryObjectives,
            clinicalUseCase: currentStudy.clinicalUseCase,
            studyDesign: currentStudy.studyDesign,
            population: currentStudy.population,
            eligibilityCriteria: currentStudy.eligibilityCriteria,
            dataModalities: splitMultiSelectValue(currentStudy.dataModalities),
            primaryOutcome: currentStudy.primaryOutcome,
            primaryEndpointDetails: currentStudy.primaryEndpointDetails,
            secondaryOutcomes: currentStudy.secondaryOutcomes,
            sampleSizeRationale: currentStudy.sampleSizeRationale,
            analysisPlan: currentStudy.analysisPlan,
            dataHandlingPlan: currentStudy.dataHandlingPlan,
            humanAiWorkflow: currentStudy.humanAiWorkflow,
            fairnessPlan: currentStudy.fairnessPlan,
            disseminationPlan: currentStudy.disseminationPlan,
            riskLevel: currentStudy.riskLevel ?? "MODERATE",
            intendedUse: currentStudy.intendedUse
          }}
          onFinish={async (values) => {
            const result = await patch(
              `/api/v1/studies/${studyId}`,
              {
                action: "updateDetails",
                ...normalizeStudyDesignPayload(values),
                dataModalities: normalizeMultiSelectValue(values.dataModalities)
              },
              "Study design saved."
            );
            if (result) closeCreate();
          }}
        >
          <FormError title="Study design was not saved" message={formError} />
          <GovernanceSection title="Overview">
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
              <Form.Item name="description" label="Study summary" className="fedlify-intake-full">
                <RichTextEditor minRows={4} placeholder="Summarize the study rationale, context, and scope." />
              </Form.Item>
              <Form.Item name="clinicalUseCase" label="Clinical use case" rules={[{ required: true }]}>
                <Select
                  showSearch
                  options={CLINICAL_USE_CASE_OPTIONS}
                  optionFilterProp="label"
                  placeholder="Select clinical use case"
                />
              </Form.Item>
              <Form.Item name="intendedUse" label="Intended use" rules={[{ required: true }]}>
                <Select
                  showSearch
                  options={INTENDED_USE_OPTIONS}
                  optionFilterProp="label"
                  placeholder="Select intended use"
                />
              </Form.Item>
            </div>
          </GovernanceSection>
          <GovernanceSection title="Scientific question">
            <div className="fedlify-intake-field-grid">
              <Form.Item name="goal" label="Primary objective" className="fedlify-intake-full" rules={[REQUIRED_RICH_TEXT_RULE]}>
                <RichTextEditor minRows={3} placeholder="State the primary scientific or operational objective." />
              </Form.Item>
              <Form.Item
                name="researchQuestion"
                label="Research question"
                className="fedlify-intake-full"
                rules={[REQUIRED_RICH_TEXT_RULE]}
              >
                <RichTextEditor minRows={3} placeholder="State the health-AI question this federation should answer." />
              </Form.Item>
              <Form.Item name="hypothesis" label="Hypothesis" className="fedlify-intake-full">
                <RichTextEditor minRows={3} placeholder="Optional: state the hypothesis if this study is hypothesis-driven." />
              </Form.Item>
              <Form.Item name="secondaryObjectives" label="Secondary objectives" className="fedlify-intake-full">
                <RichTextEditor minRows={4} placeholder="Optional: add secondary objectives or exploratory questions." />
              </Form.Item>
            </div>
          </GovernanceSection>
          <GovernanceSection title="Design and population">
            <div className="fedlify-intake-field-grid">
              <Form.Item name="studyDesign" label="Study design" className="fedlify-intake-full" rules={[REQUIRED_RICH_TEXT_RULE]}>
                <RichTextEditor minRows={4} placeholder="Describe the study type, timing, data flow, and federation design." />
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
              <Form.Item
                name="eligibilityCriteria"
                label="Eligibility criteria"
                className="fedlify-intake-full"
                rules={[REQUIRED_RICH_TEXT_RULE]}
              >
                <RichTextEditor minRows={4} placeholder="Define inclusion, exclusion, site, and cohort criteria." />
              </Form.Item>
            </div>
          </GovernanceSection>
          <GovernanceSection title="Outcomes and analysis">
            <div className="fedlify-intake-field-grid">
              <Form.Item name="primaryOutcome" label="Primary endpoint / outcome" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item
                name="primaryEndpointDetails"
                label="Endpoint details"
                className="fedlify-intake-full"
                rules={[REQUIRED_RICH_TEXT_RULE]}
              >
                <RichTextEditor minRows={4} placeholder="Describe how the primary endpoint is measured and evaluated." />
              </Form.Item>
              <Form.Item name="secondaryOutcomes" label="Secondary outcomes" className="fedlify-intake-full">
                <RichTextEditor minRows={4} placeholder="Optional: list secondary or exploratory outcomes." />
              </Form.Item>
              <Form.Item name="sampleSizeRationale" label="Sample size / rationale" className="fedlify-intake-full">
                <RichTextEditor minRows={4} placeholder="Optional: explain sample size, site count, or cohort availability rationale." />
              </Form.Item>
              <Form.Item name="analysisPlan" label="Analysis plan" className="fedlify-intake-full" rules={[REQUIRED_RICH_TEXT_RULE]}>
                <RichTextEditor minRows={5} placeholder="Describe statistical, model-performance, validation, and aggregation methods." />
              </Form.Item>
            </div>
          </GovernanceSection>
          <GovernanceSection title="AI/federated governance">
            <div className="fedlify-intake-field-grid">
              <Form.Item name="dataHandlingPlan" label="Data handling plan" className="fedlify-intake-full" rules={[REQUIRED_RICH_TEXT_RULE]}>
                <RichTextEditor minRows={5} placeholder="Describe site-local data handling, privacy boundaries, artifacts, and outputs." />
              </Form.Item>
              <Form.Item name="humanAiWorkflow" label="Human-AI workflow" className="fedlify-intake-full">
                <RichTextEditor minRows={4} placeholder="Optional: describe human review, overrides, and AI-assisted decision points." />
              </Form.Item>
              <Form.Item name="fairnessPlan" label="Fairness / subgroup plan" className="fedlify-intake-full">
                <RichTextEditor minRows={4} placeholder="Optional: describe subgroup checks, fairness risks, and mitigation steps." />
              </Form.Item>
              <Form.Item name="disseminationPlan" label="Dissemination plan" className="fedlify-intake-full">
                <RichTextEditor minRows={4} placeholder="Optional: describe release, reporting, and communication plans." />
              </Form.Item>
            </div>
          </GovernanceSection>
          <Space className="fedlify-form-actions">
            <Button onClick={closeCreate} disabled={formSubmitting}>
              Cancel
            </Button>
            <Button type="primary" htmlType="submit" className="fedlify-dark-action" loading={formSubmitting}>
              Save study design
            </Button>
          </Space>
        </Form>
      </div>
    );
  }

  function renderInlineCreateForm(mode: NonNullable<typeof activeCreate>) {
    if (activeCreate !== mode) return null;

    if (mode === "studyDesign") {
      return renderStudyDesignEditForm();
    }

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

    return null;
  }

  function detailVersions(study: StudyDetail) {
    return (study.pipelineProjects ?? []).flatMap((project) =>
      (project.versions ?? []).map((version: EntityRecord) => ({ ...version, project }))
    );
  }

  function protocolStatus(study: StudyDetail) {
    const missingProtocolFields = missingCoreProtocolFields(study);
    const missingProtocolFieldLabels = missingProtocolFields.map(
      (field) => STUDY_PROTOCOL_FIELD_LABELS[field] ?? displayEnum(field)
    );
    const protocolMetadataReady = missingProtocolFields.length === 0;
    const ethicsReady = ethicsGatePassed(study);
    const participantSiteCount = study.studySites?.length ?? study.sites.length;
    const hasParticipantSite = participantSiteCount > 0;
    const missingActivationItems = [
      ...missingProtocolFieldLabels,
      ethicsReady ? null : "Ethics decision",
      hasParticipantSite ? null : "Participant site"
    ].filter(Boolean) as string[];
    return {
      missingProtocolFields,
      missingProtocolFieldLabels,
      missingActivationItems,
      protocolMetadataReady,
      ethicsReady,
      participantSiteCount,
      hasParticipantSite,
      activationReady: protocolMetadataReady && ethicsReady && hasParticipantSite
    };
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

  function detailMetaFor(study: StudyDetail, detail: StudyDetailState): DetailPageMeta {
    const record = detailRecordFor(study, detail);
    if (!record) {
      return {
        title: "Record not found",
        subtitle: "This item is no longer available in the current study payload.",
        backLabel: activeSectionMeta.title
      };
    }

    if (detail.kind === "member") {
      const memberships = Array.isArray(record.memberships) ? record.memberships : [record];
      const roles = record.roles ?? uniqueValues(memberships.map((membership: EntityRecord) => membership.role));
      const targetUserId = record.user?.id ?? record.userId ?? memberships[0]?.userId;
      const isEditingRoles = memberRoleEditingId === String(record.id);
      return {
        title: text(record.user?.name, record.user?.email),
        subtitle: text(record.user?.email),
        status: <StatusTag value={`${roles.length} study role${roles.length === 1 ? "" : "s"}`} />,
        actions: targetUserId ? (
          <Button icon={<EditOutlined />} onClick={() => setMemberRoleEditingId(isEditingRoles ? null : String(record.id))}>
            {isEditingRoles ? "Close role editor" : "Edit study roles"}
          </Button>
        ) : null,
        backLabel: activeSectionMeta.title
      };
    }

    if (detail.kind === "invitation") {
      return {
        title: text(record.email, "Invitation"),
        subtitle: "Study role invitation",
        status: <StatusTag value={status(record.status, "PENDING")} />,
        backLabel: activeSectionMeta.title
      };
    }

    if (detail.kind === "ethics") {
      const title = text(record.approvalNumber, record.status === "PENDING" ? "Pending ethics review" : "Ethics decision");
      return {
        title,
        subtitle: text(record.approvingBody, "Review body not recorded"),
        status: <StatusTag value={status(record.status)} />,
        actions: (
          <Button
            icon={<EditOutlined />}
            onClick={() => {
              router.push(sectionUrl("protocol"));
              openEthicsForm(record);
            }}
          >
            Edit decision
          </Button>
        ),
        backLabel: "Study protocol"
      };
    }

    if (detail.kind === "document") {
      return {
        title: text(record.filename, "Study document"),
        subtitle: displayEnum(record.kind, "Document"),
        status: <StatusTag value={status(record.scanStatus, "PENDING")} />,
        backLabel: "Study protocol"
      };
    }

    if (detail.kind === "site") {
      return {
        title: text(record.name, "Participant site"),
        subtitle: text(record.institutionName, "Institution not recorded"),
        status: <StatusTag value={status(record.participationStatus, "INVITED")} />,
        actions: <Button icon={<ClusterOutlined />} onClick={() => router.push(`/sites/${record.id}`)}>Open onboarding dashboard</Button>,
        backLabel: "Sites and data"
      };
    }

    if (detail.kind === "pipelineProject" || detail.kind === "pipelineVersion") {
      const project = detail.kind === "pipelineProject" ? record : record.project;
      const versions = detail.kind === "pipelineProject" ? (record.versions ?? []) : [record];
      const activeVersion = detail.kind === "pipelineVersion" ? record : versions[0];
      const sourceTemplateVersion = activeVersion?.templateVersion ?? project?.templateVersion ?? project?.template?.currentApprovedVersion;
      return {
        title:
          detail.kind === "pipelineVersion"
            ? `${text(project?.name, "Pipeline source workspace")} ${text(record.version, "")}`.trim()
            : text(project?.name, "Pipeline source workspace"),
        subtitle: templateSourceLabel(project?.template, sourceTemplateVersion),
        status: <StatusTag value={detail.kind === "pipelineVersion" ? (record.approvalStatus ?? record.validationStatus) : status(project?.status, "DRAFT")} />,
        backLabel: "Pipeline"
      };
    }

    if (detail.kind === "deployment") {
      return {
        title: text(record.name, "NVFLARE deployment"),
        subtitle: text(record.serverAddress, "No server address"),
        status: <StatusTag value={status(record.status, "DRAFT")} />,
        backLabel: activeSectionMeta.title
      };
    }

    if (detail.kind === "experimentRun") {
      const payload = jobLogDetail?.job?.id === record.id ? jobLogDetail : null;
      const state = payload?.state ?? record;
      return {
        title: text(record.nvflareJobId, WORKFLOW_TERMS.federatedRun),
        subtitle: text(record.pipelineVersion?.project?.name, "Pipeline source workspace"),
        status: <StatusTag value={status(state.fedlifyStatus ?? record.status, "DRAFT")} />,
        backLabel: "Federated run"
      };
    }

    if (detail.kind === "modelRelease") {
      const sourceJob = record.sourceResult?.job;
      return {
        title: `Model release ${text(record.version)}`,
        subtitle: `Source run ${text(sourceJob?.nvflareJobId, sourceJob?.id)}`,
        status: <StatusTag value={record.status} />,
        backLabel: "Results"
      };
    }

    if (detail.kind === "codeRelease") {
      return {
        title: `Code/kit release ${text(record.version)}`,
        subtitle: "Startup kits, source bundles, and checksum manifests",
        status: <StatusTag value={record.status} />,
        backLabel: "Results"
      };
    }

    return {
      title: text(record.action, "Audit event"),
      subtitle: formatDate(record.createdAt),
      status: <StatusTag value={text(record.targetType, "Audit")} />,
      backLabel: "Audit"
    };
  }

  function renderEntityDetail(study: StudyDetail, detail: StudyDetailState) {
    const record = detailRecordFor(study, detail);
    if (!record) {
      return (
        <EntityDetailView bodyOnly title="Record not found" subtitle="This item is no longer available in the current study payload." onBack={closeDetail}>
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
          bodyOnly
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
        <EntityDetailView bodyOnly title={text(record.email, "Invitation")} subtitle="Study role invitation" status={<StatusTag value={status(record.status, "PENDING")} />} onBack={closeDetail}>
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
          bodyOnly
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
        <EntityDetailView bodyOnly title={text(record.filename, "Study document")} subtitle={displayEnum(record.kind, "Document")} status={<StatusTag value={status(record.scanStatus, "PENDING")} />} onBack={closeDetail}>
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
          bodyOnly
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
          bodyOnly
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
        <EntityDetailView bodyOnly title={text(record.name, "NVFLARE deployment")} subtitle={text(record.serverAddress, "No server address")} status={<StatusTag value={status(record.status, "DRAFT")} />} onBack={closeDetail}>
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
        <EntityDetailView bodyOnly title={text(record.nvflareJobId, WORKFLOW_TERMS.federatedRun)} subtitle={text(record.pipelineVersion?.project?.name, "Pipeline source workspace")} status={<StatusTag value={status(state.fedlifyStatus ?? record.status, "DRAFT")} />} onBack={closeDetail} technicalMetadata={payload?.flareMeta?.meta}>
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
        <EntityDetailView bodyOnly title={`Model release ${text(record.version)}`} subtitle={`Source run ${text(sourceJob?.nvflareJobId, sourceJob?.id)}`} status={<StatusTag value={record.status} />} onBack={closeDetail}>
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
        <EntityDetailView bodyOnly title={`Code/kit release ${text(record.version)}`} subtitle="Startup kits, source bundles, and checksum manifests" status={<StatusTag value={record.status} />} onBack={closeDetail}>
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
      <EntityDetailView bodyOnly title={text(record.action, "Audit event")} subtitle={formatDate(record.createdAt)} status={<StatusTag value={text(record.targetType, "Audit")} />} onBack={closeDetail} technicalMetadata={record.metadata}>
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
      const readinessByKey = new Map(readinessItems.map((item) => [item.key, item]));
      const dashboardCards = [
        {
          key: "protocol",
          label: "Study protocol",
          description: readinessByKey.get("protocol")?.detail ?? protocolReadinessDetail(currentStudy),
          state: readinessByKey.get("protocol")?.state ?? "needs_attention",
          section: "protocol" as StudyWorkspaceSection,
          icon: <SafetyCertificateOutlined />,
          meta: [
            `Governance: ${displayEnum(currentStudy.governanceStatus, "Incomplete")}`,
            `Ethics: ${studyEthicsReady(currentStudy) ? displayEnum(latestEthicsStatus(currentStudy), "Ready") : "Needs review"}`
          ]
        },
        {
          key: "sites",
          label: "Sites & Data",
          description: readinessByKey.get("sites")?.detail ?? `${ready.length}/${totalSites} ready, ${connected.length} connected`,
          state: readinessByKey.get("sites")?.state ?? "needs_attention",
          section: "sites" as StudyWorkspaceSection,
          icon: <ClusterOutlined />,
          meta: [`${totalSites} registered`, `${ready.length} ready`, `${connected.length} connected`, "Site-local data only"]
        },
        {
          key: "team",
          label: "Team & Access",
          description:
            memberGroups.length > 0
              ? `${memberGroups.length} member${memberGroups.length === 1 ? "" : "s"} assigned to this study.`
              : "Invite study members and assign workspace roles.",
          state: memberGroups.length > 0 ? "ready" : "needs_attention",
          section: "team" as StudyWorkspaceSection,
          icon: <MailOutlined />,
          meta: [`${roleAssignmentCount} role assignment${roleAssignmentCount === 1 ? "" : "s"}`, `${currentStudy.invitations.length} pending invitation${currentStudy.invitations.length === 1 ? "" : "s"}`]
        },
        {
          key: "pipeline",
          label: "Pipeline",
          description: readinessByKey.get("pipeline")?.detail ?? `${approvedVersions.length} approved pipeline version(s)`,
          state: readinessByKey.get("pipeline")?.state ?? "needs_attention",
          section: "pipeline" as StudyWorkspaceSection,
          icon: <CodeOutlined />,
          meta: [`${currentStudy.pipelineProjects?.length ?? 0} source workspace(s)`, `${approvedVersions.length} approved version${approvedVersions.length === 1 ? "" : "s"}`]
        },
        {
          key: "run",
          label: "Run",
          description: readinessByKey.get("run")?.detail ?? `${currentStudy.nvflareJobs?.length ?? 0} federated run(s)`,
          state: readinessByKey.get("run")?.state ?? "needs_attention",
          section: "run" as StudyWorkspaceSection,
          icon: <MonitorOutlined />,
          meta: [
            activeRuntimeDeployment?.serverAddress ? `Aggregator: ${activeRuntimeDeployment.serverAddress}` : "Aggregator not started",
            `${currentStudy.nvflareJobs?.length ?? 0} run${(currentStudy.nvflareJobs?.length ?? 0) === 1 ? "" : "s"}`
          ]
        },
        {
          key: "results",
          label: "Results & Releases",
          description: readinessByKey.get("results")?.detail ?? "Trained model plus code/kit releases.",
          state: readinessByKey.get("results")?.state ?? "needs_attention",
          section: "results" as StudyWorkspaceSection,
          icon: <CloudDownloadOutlined />,
          meta: [`${currentStudy.modelReleases?.length ?? 0} model release${(currentStudy.modelReleases?.length ?? 0) === 1 ? "" : "s"}`, `${currentStudy.releases.length} code/kit release${currentStudy.releases.length === 1 ? "" : "s"}`]
        },
        {
          key: "audit",
          label: "Audit",
          description: "Governance, access, and runtime actions are recorded here.",
          state: currentStudy.auditEvents.length > 0 ? "done" : "ready",
          section: "audit" as StudyWorkspaceSection,
          icon: <AuditOutlined />,
          meta: [
            `${currentStudy.auditEvents.length} event${currentStudy.auditEvents.length === 1 ? "" : "s"}`,
            currentStudy.auditEvents[0]?.createdAt ? `Latest: ${formatDate(currentStudy.auditEvents[0].createdAt)}` : "No recent events"
          ]
        }
      ];

      return (
        <div className="fedlify-section-stack">
          <WorkspaceCardGrid className="fedlify-summary-dashboard-grid">
            {dashboardCards.map((card) => {
              const isNext = nextAction.section === card.section;
              return (
                <WorkspaceRecordCard
                  key={card.key}
                  icon={card.icon}
                  title={card.label}
                  description={isNext ? nextAction.detail : card.description}
                  status={
                    <Space size={6} wrap>
                      {isNext ? <StatusTag value="NEXT" /> : null}
                      <StatusTag value={summaryStateStatus(card.state as "ready" | "needs_attention" | "done")} />
                    </Space>
                  }
                  meta={isNext ? [`Next: ${nextAction.title}`, ...card.meta] : card.meta}
                  tone={summaryStateTone(card.state as "ready" | "needs_attention" | "done") as "ready" | "needs_attention"}
                  onClick={() => router.push(sectionUrl(card.section))}
                  ariaLabel={`Open ${card.label}`}
                />
              );
            })}
          </WorkspaceCardGrid>
        </div>
      );
    }

    if (section === "protocol") {
      const dataModalityLabels = splitMultiSelectValue(currentStudy.dataModalities).map(
        (value) => governanceOptionLabel(DATA_MODALITY_OPTIONS, value) ?? value
      );
      const {
        missingProtocolFieldLabels,
        missingActivationItems,
        protocolMetadataReady,
        ethicsReady,
        participantSiteCount,
        hasParticipantSite,
        activationReady
      } = protocolStatus(currentStudy);
      const protocolModules = [
        {
          key: "metadata",
          title: "Study design",
          detail: protocolMetadataReady
            ? "Core study design fields meet Health AI readiness requirements."
            : `Complete ${summarizeMissingLabels(missingProtocolFieldLabels)}.`,
          status: protocolMetadataReady ? "READY" : "NEEDS_ATTENTION",
          icon: <FileTextOutlined />,
          action: "Open study design",
          onClick: () => setProtocolTab("metadata")
        },
        {
          key: "ethics",
          title: "Ethics decision",
          detail: ethicsReady ? displayEnum(latestEthicsStatus(currentStudy), "Approved") : "Record approval, exemption, or not-required status.",
          status: ethicsReady ? "READY" : "NEEDS_ATTENTION",
          icon: <SafetyCertificateOutlined />,
          action: "Open ethics",
          onClick: () => setProtocolTab("ethics")
        },
        {
          key: "documents",
          title: "Governance documents",
          detail:
            currentStudy.documents.length > 0
              ? `${currentStudy.documents.length} governed document(s) registered.`
              : "Add study protocol, ethics, policy, or agreement files if needed.",
          status: currentStudy.documents.length > 0 ? "READY" : "OPTIONAL",
          icon: <UploadOutlined />,
          action: "Open documents",
          onClick: () => setProtocolTab("documents")
        },
        {
          key: "sites",
          title: "Participant sites",
          detail: hasParticipantSite
            ? `${participantSiteCount} participant site(s) registered.`
            : "Add at least one participant site before activation.",
          status: hasParticipantSite ? "READY" : "NEEDS_ATTENTION",
          icon: <ClusterOutlined />,
          action: hasParticipantSite ? "Review sites" : "Add sites",
          onClick: () => router.push(sectionUrl("sites"))
        },
        {
          key: "activation",
          title: "Activation",
          detail: activationReady ? "Study is ready for activation." : `Missing: ${summarizeMissingLabels(missingActivationItems)}.`,
          status: currentStudy.status === "ACTIVE" ? "ACTIVE" : activationReady ? "READY" : "BLOCKED",
          icon: <CheckCircleOutlined />,
          action: currentStudy.status === "ACTIVE" ? "Activated" : "Review activation",
          onClick: () => setProtocolTab("activation")
        }
      ];
      const renderProtocolActionCard = ({
        title,
        detail,
        icon,
        onClick,
        disabled = false,
        state
      }: {
        title: string;
        detail: string;
        icon: ReactNode;
        onClick: () => void;
        disabled?: boolean;
        state?: "ACTIVE" | "BLOCKED";
      }) => (
        <WorkspaceActionCard
          icon={icon}
          title={title}
          description={detail}
          status={state ? <StatusTag value={state} /> : undefined}
          disabled={disabled}
          tone={state === "ACTIVE" ? "active" : state === "BLOCKED" ? "blocked" : "default"}
          onClick={onClick}
        />
      );
      const metadataActionCard = renderProtocolActionCard({
        title: "Edit study design",
        detail: "Update Health AI core fields and optional best-practice details.",
        icon: <EditOutlined />,
        onClick: () => openCreate("studyDesign")
      });
      const ethicsActionCard = renderProtocolActionCard({
        title: currentStudy.ethics.length === 0 ? "Record first ethics decision" : "Record ethics decision",
        detail:
          currentStudy.ethics.length === 0
            ? "No ethics records yet. Add approval, exemption, expiry, or pending review state."
            : "Add approval, exemption, expiry, or pending review state.",
        icon: <PlusOutlined />,
        onClick: () => openEthicsForm()
      });
      const documentActionCard = renderProtocolActionCard({
        title: currentStudy.documents.length === 0 ? "Register first document" : "Register document",
        detail:
          currentStudy.documents.length === 0
            ? "No study documents yet. Add a study protocol, ethics, policy, or agreement file."
            : "Add a study protocol, ethics, policy, or agreement file.",
        icon: <UploadOutlined />,
        onClick: () => openCreate("document")
      });
      const activationActionCard = renderProtocolActionCard({
        title: currentStudy.status === "ACTIVE" ? "Study active" : "Activate study",
        detail:
          currentStudy.status === "ACTIVE"
            ? "Runtime gates are already enabled for this study."
            : activationReady
              ? "Enable runtime provisioning and experiment submission."
              : `Resolve: ${summarizeMissingLabels(missingActivationItems)}.`,
        icon: <CheckCircleOutlined />,
        disabled: currentStudy.status === "ACTIVE" || !activationReady,
        state: currentStudy.status === "ACTIVE" ? "ACTIVE" : !activationReady ? "BLOCKED" : undefined,
        onClick: () => void patch(`/api/v1/studies/${studyId}`, { action: "activate" }, "Study activated.")
      });
      const activationBlockedMessage =
        missingActivationItems.length > 0
          ? `Activation is blocked until ${summarizeMissingLabels(missingActivationItems)} ${
              missingActivationItems.length === 1 ? "is complete" : "are complete"
            }. The Readiness tab shows the current state.`
          : "Activation is blocked until the required readiness items pass. The Readiness tab shows the current state.";

      return (
        <div className="fedlify-section-stack">
          <Tabs
            className="fedlify-card-tabs fedlify-protocol-tabs"
            activeKey={protocolTab}
            onChange={(key) => {
              setFormError(null);
              setProtocolTab(key);
            }}
            items={[
              {
                key: "review",
                label: "Readiness",
                children: (
                  <WorkspaceCardGrid className="fedlify-workspace-review-grid">
                    {protocolModules.map((module) => (
                      <WorkspaceReviewCard
                        key={module.key}
                        icon={module.icon}
                        title={module.title}
                        description={module.detail}
                        status={<StatusTag value={module.status} />}
                        tone={module.status.toLowerCase() as "ready" | "needs_attention" | "optional" | "active" | "blocked"}
                        onClick={module.onClick}
                        aria-label={`${module.action}: ${module.title}`}
                      />
                    ))}
                  </WorkspaceCardGrid>
                )
              },
              {
                key: "metadata",
                label: "Study design",
                children: (
                  <section className="fedlify-protocol-module is-wide">
                    <WorkspaceCardGrid>
                      {metadataActionCard}
                    </WorkspaceCardGrid>
                    <GovernanceSection title="Overview">
                      <div className="fedlify-governance-grid">
                        {renderGovernanceField("Study title", currentStudy.title)}
                        {renderGovernanceField("Risk level", displayEnum(currentStudy.riskLevel))}
                        {renderGovernanceField("Study summary", currentStudy.description, "fedlify-governance-full", true)}
                        {renderGovernanceField(
                          "Clinical use case",
                          governanceOptionLabel(CLINICAL_USE_CASE_OPTIONS, currentStudy.clinicalUseCase)
                        )}
                        {renderGovernanceField("Intended use", governanceOptionLabel(INTENDED_USE_OPTIONS, currentStudy.intendedUse))}
                      </div>
                    </GovernanceSection>
                    <GovernanceSection title="Scientific question">
                      <div className="fedlify-governance-grid">
                        {renderGovernanceField("Primary objective", currentStudy.goal, "fedlify-governance-full", true)}
                        {renderGovernanceField("Research question", currentStudy.researchQuestion, "fedlify-governance-full", true)}
                        {renderGovernanceField("Hypothesis", currentStudy.hypothesis, "fedlify-governance-full", true)}
                        {renderGovernanceField("Secondary objectives", currentStudy.secondaryObjectives, "fedlify-governance-full", true)}
                      </div>
                    </GovernanceSection>
                    <GovernanceSection title="Design and population">
                      <div className="fedlify-governance-grid">
                        {renderGovernanceField("Study design", currentStudy.studyDesign, "fedlify-governance-full", true)}
                        {renderGovernanceField("Population", currentStudy.population)}
                        {renderGovernanceTags("Data modalities", dataModalityLabels)}
                        {renderGovernanceField("Eligibility criteria", currentStudy.eligibilityCriteria, "fedlify-governance-full", true)}
                      </div>
                    </GovernanceSection>
                    <GovernanceSection title="Outcomes and analysis">
                      <div className="fedlify-governance-grid">
                        {renderGovernanceField("Primary endpoint / outcome", currentStudy.primaryOutcome)}
                        {renderGovernanceField("Endpoint details", currentStudy.primaryEndpointDetails, "fedlify-governance-full", true)}
                        {renderGovernanceField("Secondary outcomes", currentStudy.secondaryOutcomes, "fedlify-governance-full", true)}
                        {renderGovernanceField("Sample size / rationale", currentStudy.sampleSizeRationale, "fedlify-governance-full", true)}
                        {renderGovernanceField("Analysis plan", currentStudy.analysisPlan, "fedlify-governance-full", true)}
                      </div>
                    </GovernanceSection>
                    <GovernanceSection title="AI/federated governance">
                      <div className="fedlify-governance-grid">
                        {renderGovernanceField("Data handling plan", currentStudy.dataHandlingPlan, "fedlify-governance-full", true)}
                        {renderGovernanceField("Human-AI workflow", currentStudy.humanAiWorkflow, "fedlify-governance-full", true)}
                        {renderGovernanceField("Fairness / subgroup plan", currentStudy.fairnessPlan, "fedlify-governance-full", true)}
                        {renderGovernanceField("Dissemination plan", currentStudy.disseminationPlan, "fedlify-governance-full", true)}
                      </div>
                    </GovernanceSection>
                  </section>
                )
              },
              {
                key: "ethics",
                label: "Ethics",
                children: (
                  <section className="fedlify-protocol-module is-wide">
                    <WorkspaceCardGrid>
                      {ethicsActionCard}
                      {currentStudy.ethics.map((record) => {
                        const title = text(record.approvalNumber, record.status === "PENDING" ? "Pending ethics review" : "Ethics decision");
                        return (
                          <WorkspaceRecordCard
                            key={text(record.id, `${record.status}-${record.createdAt}`)}
                            icon={<SafetyCertificateOutlined />}
                            title={title}
                            description={`${text(record.approvingBody, "Review body not recorded")} · ${formatDate(record.createdAt)}`}
                            status={<StatusTag value={status(record.status)} />}
                            onClick={() => openDetail("ethics", String(record.id), "protocol")}
                          />
                        );
                      })}
                    </WorkspaceCardGrid>
                  </section>
                )
              },
              {
                key: "documents",
                label: "Documents",
                children: (
                  <section className="fedlify-protocol-module is-wide">
                    <Alert
                      type="warning"
                      showIcon
                      className="fedlify-protocol-note"
                      message="Do not upload raw or participant-level clinical datasets."
                    />
                    <WorkspaceCardGrid>
                      {documentActionCard}
                      {currentStudy.documents.map((document) => (
                        <WorkspaceRecordCard
                          key={text(document.id, document.filename)}
                          icon={<FileTextOutlined />}
                          title={text(document.filename, "Study document")}
                          description={`${displayEnum(document.kind, "Other")} · Version ${text(document.version, "1")}`}
                          status={<StatusTag value={status(document.scanStatus, "PENDING")} />}
                          onClick={() => openDetail("document", String(document.id), "protocol")}
                        />
                      ))}
                    </WorkspaceCardGrid>
                  </section>
                )
              },
              {
                key: "activation",
                label: "Activation",
                children: (
                  <section className="fedlify-protocol-module is-wide">
                    <Alert
                      type={activationReady ? "success" : "warning"}
                      showIcon
                      className="fedlify-protocol-note"
                      message={
                        activationReady
                          ? "This study has the study design, ethics decision, and participant site information required for activation."
                          : activationBlockedMessage
                      }
                    />
                    <WorkspaceCardGrid>
                      {activationActionCard}
                    </WorkspaceCardGrid>
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
                    <WorkspaceCardGrid>
                      <WorkspaceActionCard
                        icon={<PlusOutlined />}
                        title={memberGroups.length === 0 ? "Add first study member" : "Add study member"}
                        description={
                          memberGroups.length === 0
                            ? "No study members yet. Invite people and assign one or more study roles."
                            : "Invite people and assign one or more study roles."
                        }
                        onClick={() => openCreate("invite")}
                      />
                      {memberGroups.map((member) => {
                        const roles = member.roles ?? uniqueValues(member.memberships.map((membership: EntityRecord) => membership.role));
                        return (
                          <WorkspaceRecordCard
                            key={member.id}
                            icon={<MailOutlined />}
                            title={member.user.name ?? member.user.email}
                            description={member.user.email}
                            meta={[
                              `${roles.length} study role${roles.length === 1 ? "" : "s"} assigned`,
                              roles.map((role: string) => displayEnum(role)).join(", ")
                            ]}
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
                            onClick={() => openDetail("member", member.id, "team")}
                          />
                        );
                      })}
                    </WorkspaceCardGrid>
                  </div>
                )
              },
              {
                key: "invitations",
                label: "Pending invitations",
                children: (
                  <div className="fedlify-tab-panel">
                    <WorkspaceCardGrid>
                      <WorkspaceActionCard
                        icon={<PlusOutlined />}
                        title={currentStudy.invitations.length === 0 ? "Send first invitation" : "Send invitation"}
                        description={
                          currentStudy.invitations.length === 0
                            ? "No invitations issued. Add study members or site staff when they need study-scoped access."
                            : "Invite study members or site staff when they need study-scoped access."
                        }
                        onClick={() => openCreate("invite")}
                      />
                      {currentStudy.invitations.map((invitation) => {
                        const roles = Array.isArray(invitation.roles) && invitation.roles.length > 0 ? invitation.roles : [invitation.role];
                        return (
                          <WorkspaceRecordCard
                            key={text(invitation.id, `${invitation.email}-${invitation.createdAt}`)}
                            icon={<MailOutlined />}
                            title={text(invitation.email, "Invitation")}
                            description={`Expires ${formatDate(invitation.expiresAt)}`}
                            status={<StatusTag value={status(invitation.status, "PENDING")} />}
                            meta={[`${roles.length} study role${roles.length === 1 ? "" : "s"}`, roles.map((role: string) => displayEnum(role)).join(", ")]}
                            actionsMenu={<EntityActionMenu items={[{ key: "view", label: "View invitation", icon: <EyeOutlined />, onClick: () => openDetail("invitation", String(invitation.id), "team") }]} />}
                            onClick={() => openDetail("invitation", String(invitation.id), "team")}
                          />
                        );
                      })}
                    </WorkspaceCardGrid>
                  </div>
                )
              }
            ]}
          />
        </div>
      );
    }

    if (section === "sites") {
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
                    <WorkspaceCardGrid>
                      <WorkspaceActionCard
                        icon={<PlusOutlined />}
                        title={(currentStudy.studySites?.length ?? 0) === 0 ? "Register first site" : "Register site"}
                        description={
                          (currentStudy.studySites?.length ?? 0) === 0
                            ? "No participant sites yet. Register at least one institution before generating site-specific kits."
                            : "Add another institution participating in the federated study."
                        }
                        onClick={() => openCreate("site")}
                      />
                      {currentStudy.studySites.map((site) => (
                        <WorkspaceRecordCard
                          key={text(site.id, site.name)}
                          icon={<ClusterOutlined />}
                          title={text(site.name, "Site")}
                          description={text(site.institutionName, "Institution not recorded")}
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
                          onClick={() => openDetail("site", String(site.id), "sites")}
                        />
                      ))}
                    </WorkspaceCardGrid>
                  </div>
                )
              },
              {
                key: "readiness",
                label: "Readiness & data",
                children: (
                  <div className="fedlify-tab-panel">
                    {(currentStudy.studySites?.length ?? 0) === 0 ? (
                      <WorkspaceCardGrid>
                        <WorkspaceActionCard
                          icon={<PlusOutlined />}
                          title="Register first site"
                          description="No site readiness state yet. Register participant sites before tracking readiness and data profile completeness."
                          onClick={() => openCreate("site")}
                        />
                      </WorkspaceCardGrid>
                    ) : (
                      <WorkspaceCardGrid>
                        {currentStudy.studySites.map((site) => (
                          <WorkspaceRecordCard
                            key={text(site.id, site.name)}
                            icon={<ClusterOutlined />}
                            title={text(site.name, "Site")}
                            description={text(site.dataProfile?.datasetDescription, "Dataset summary not recorded")}
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
                            onClick={() => openDetail("site", String(site.id), "sites")}
                          />
                        ))}
                      </WorkspaceCardGrid>
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
      const approvedVersions = currentApprovedPipelineVersions(currentStudy);
      const approvedTemplatesForPipeline = approvedTemplateCatalog(templates);
      const latestProposal = pipelineProposals[0];
      // Latest validated (not yet approved) version for the approve button
      const pendingVersion = pipelineVersions.find((v) => v.validationStatus === "PASSED" && v.approvalStatus !== "APPROVED");
      const latestApprovedVersion = approvedVersions[0];

      // STATE A: no pipeline work started yet
      const isStateA = pipelineVersions.length === 0 && pipelineProposals.length === 0;
      // STATE B: work in progress (proposals or versions exist, nothing approved yet)
      const isStateB = !isStateA && approvedVersions.length === 0;
      // STATE C: at least one approved version ready to deploy
      const isStateC = approvedVersions.length > 0;

      return (
        <div className="fedlify-section-stack">
          <div className="fedlify-pipeline-state-panel">

            {/* ── State A: No pipeline yet ── */}
            {isStateA ? (
              <div className="fedlify-psp-content">
                <div className="fedlify-psp-icon"><RobotOutlined /></div>
                <div className="fedlify-psp-body">
                  <Typography.Title level={4} style={{ margin: 0 }}>Build your study pipeline</Typography.Title>
                  <Typography.Text type="secondary">
                    Describe your federated learning goal and the AI will generate NVFlare executor code,
                    or start from an existing approved template.
                  </Typography.Text>
                  <Space wrap style={{ marginTop: 8 }}>
                    <Button
                      type="primary"
                      className="fedlify-dark-action"
                      icon={<RobotOutlined />}
                      onClick={() => router.push(`/studies/${studyId}/pipeline-agent`)}
                    >
                      Describe to AI
                    </Button>
                    {approvedTemplatesForPipeline.length > 0 ? (
                      <Button
                        icon={<CodeOutlined />}
                        onClick={() => router.push(
                          `/studies/${studyId}/pipeline-agent?mode=from-template&templateId=${String(approvedTemplatesForPipeline[0].id)}`
                        )}
                      >
                        Start from a template
                      </Button>
                    ) : null}
                    <Button
                      icon={<EyeOutlined />}
                      onClick={() => router.push("/templates")}
                    >
                      Browse templates
                    </Button>
                  </Space>
                  {approvedTemplatesForPipeline.length > 0 ? (
                    <div className="fedlify-psp-template-list">
                      {approvedTemplatesForPipeline.slice(0, 4).map((tmpl) => (
                        <button
                          key={String(tmpl.id)}
                          type="button"
                          className="fedlify-psp-template-chip"
                          onClick={() => router.push(`/studies/${studyId}/pipeline-agent?mode=from-template&templateId=${String(tmpl.id)}`)}
                        >
                          <CodeOutlined />
                          <span>{text(tmpl.name, tmpl.templateKey)}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* ── State B: Pipeline in progress ── */}
            {isStateB ? (
              <div className="fedlify-psp-content">
                <div className="fedlify-psp-icon fedlify-psp-icon--progress"><CodeOutlined /></div>
                <div className="fedlify-psp-body">
                  <div className="fedlify-psp-title-row">
                    <Typography.Title level={4} style={{ margin: 0 }}>Pipeline code ready for review</Typography.Title>
                    {pendingVersion
                      ? <StatusTag value="PASSED" />
                      : latestProposal
                      ? <StatusTag value={latestProposal.status ?? "OPEN"} />
                      : null}
                  </div>
                  {latestProposal ? (
                    <Typography.Text type="secondary" className="fedlify-psp-meta">
                      Branch: <code>{latestProposal.branchName ?? "—"}</code>
                      {latestProposal.giteaHeadCommit ? <> · Commit: <code>{String(latestProposal.giteaHeadCommit).slice(0, 12)}</code></> : null}
                    </Typography.Text>
                  ) : null}
                  <Space wrap style={{ marginTop: 8 }}>
                    {pendingVersion ? (
                      <Button
                        type="primary"
                        className="fedlify-dark-action"
                        icon={<CheckCircleOutlined />}
                        onClick={() => void post(
                          `/api/v1/pipeline-versions/${String(pendingVersion.id)}/approve`,
                          { notes: "Approved after review in Fedlify." },
                          "Pipeline approved — ready to deploy."
                        )}
                      >
                        Approve this pipeline
                      </Button>
                    ) : null}
                    {latestProposal?.project?.template?.id ? (
                      <Button
                        icon={<CodeOutlined />}
                        onClick={() => router.push(`/templates/${String(latestProposal.project.template.id)}?studyId=${studyId}&tab=code`)}
                      >
                        Review code
                      </Button>
                    ) : null}
                    {latestProposal?.project?.template?.id ? (
                      <Button
                        icon={<RobotOutlined />}
                        onClick={() => router.push(`/studies/${studyId}/pipeline-agent?mode=adjust&templateId=${String(latestProposal.project.template.id)}`)}
                      >
                        Continue editing with AI
                      </Button>
                    ) : (
                      <Button icon={<RobotOutlined />} onClick={() => router.push(`/studies/${studyId}/pipeline-agent`)}>
                        Continue editing with AI
                      </Button>
                    )}
                  </Space>
                </div>
              </div>
            ) : null}

            {/* ── State C: Pipeline approved ── */}
            {isStateC ? (
              <div className="fedlify-psp-content">
                <div className="fedlify-psp-icon fedlify-psp-icon--done"><CheckCircleOutlined /></div>
                <div className="fedlify-psp-body">
                  <div className="fedlify-psp-title-row">
                    <Typography.Title level={4} style={{ margin: 0 }}>Pipeline approved — ready to deploy</Typography.Title>
                    <StatusTag value="APPROVED" />
                  </div>
                  <Typography.Text type="secondary" className="fedlify-psp-meta">
                    Version: <strong>{text(latestApprovedVersion?.version)}</strong>
                    {latestApprovedVersion?.gitCommit ? <> · Commit: <code>{String(latestApprovedVersion.gitCommit).slice(0, 12)}</code></> : null}
                  </Typography.Text>
                  <Space wrap style={{ marginTop: 8 }}>
                    <Button
                      type="primary"
                      className="fedlify-dark-action"
                      icon={<PlayCircleOutlined />}
                      onClick={() => router.push(sectionUrl("run"))}
                    >
                      Go to Run section
                    </Button>
                    <Button
                      icon={<RobotOutlined />}
                      onClick={() =>
                        latestApprovedVersion?.project?.template?.id
                          ? router.push(`/studies/${studyId}/pipeline-agent?mode=adjust&templateId=${String(latestApprovedVersion.project.template.id)}`)
                          : router.push(`/studies/${studyId}/pipeline-agent`)
                      }
                    >
                      Adjust & build v{(approvedVersions.length + 1).toString()}.0.0
                    </Button>
                    {latestApprovedVersion?.project?.template?.id ? (
                      <Button
                        icon={<EyeOutlined />}
                        onClick={() => router.push(`/templates/${String(latestApprovedVersion.project.template.id)}?studyId=${studyId}&tab=code`)}
                      >
                        View code
                      </Button>
                    ) : null}
                  </Space>
                </div>
              </div>
            ) : null}
          </div>

          {/* All pipeline versions — shown as a compact list below the state panel when not empty */}
          {pipelineVersions.length > 0 ? (
            <div className="fedlify-psp-history">
              <Typography.Text type="secondary" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 650 }}>
                All pipeline versions
              </Typography.Text>
              <WorkspaceCardGrid className="fedlify-psp-version-grid">
                {pipelineVersions.map((version) => (
                  <WorkspaceRecordCard
                    key={String(version.id)}
                    icon={<CodeOutlined />}
                    title={text(version.version, "Pipeline version")}
                    description={text(version.project?.name, "Pipeline")}
                    status={<StatusTag value={version.approvalStatus ?? version.validationStatus} />}
                    meta={[
                      `Validation: ${displayEnum(version.validationStatus)}`,
                      `Approval: ${displayEnum(version.approvalStatus)}`,
                      `Commit: ${shortCommit(version.gitCommit)}`
                    ]}
                    actionsMenu={
                      <EntityActionMenu
                        items={[
                          { key: "view", label: "View details", icon: <EyeOutlined />, onClick: () => openDetail("pipelineVersion", String(version.id), "pipeline") },
                          {
                            key: "adjust",
                            label: "Adjust with AI",
                            icon: <RobotOutlined />,
                            disabled: !version.project?.template?.giteaRepo,
                            onClick: () => router.push(`/studies/${studyId}/pipeline-agent?mode=adjust&templateId=${version.project?.template?.id ?? version.templateId ?? ""}`)
                          },
                          {
                            key: "approve",
                            label: "Approve version",
                            icon: <CheckCircleOutlined />,
                            disabled: version.approvalStatus === "APPROVED" || version.validationStatus !== "PASSED",
                            onClick: () => void post(
                              `/api/v1/pipeline-versions/${String(version.id)}/approve`,
                              { notes: "Approved after human review in Fedlify." },
                              "Pipeline version approved."
                            )
                          }
                        ]}
                      />
                    }
                    onClick={() => openDetail("pipelineVersion", String(version.id), "pipeline")}
                  />
                ))}
              </WorkspaceCardGrid>
            </div>
          ) : null}
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
                    <WorkspaceCardGrid>
                      <WorkspaceActionCard
                        icon={<ClusterOutlined />}
                        title={(currentStudy.nvflareDeployments?.length ?? 0) === 0 ? "Provision deployment" : "Provision another deployment"}
                        description={
                          (currentStudy.nvflareDeployments?.length ?? 0) === 0
                            ? "No NVFLARE deployment yet. Provision a local Docker aggregator before submitting federated runs."
                            : "Provision a new local Docker aggregator workspace."
                        }
                        onClick={() => void provisionDeployment()}
                      />
                      {currentStudy.nvflareDeployments.map((deployment) => (
                        <WorkspaceRecordCard
                          key={text(deployment.id, deployment.createdAt)}
                          icon={<ClusterOutlined />}
                          title={text(deployment.name, "NVFLARE deployment")}
                          description={text(deployment.serverAddress, "Server address not assigned")}
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
                          onClick={() => openDetail("deployment", String(deployment.id), "run")}
                        />
                      ))}
                    </WorkspaceCardGrid>
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
                    <WorkspaceCardGrid>
                      <WorkspaceActionCard
                        icon={<MonitorOutlined />}
                        title={(currentStudy.nvflareJobs?.length ?? 0) === 0 ? "Submit first federated run" : WORKFLOW_TERMS.submitFederatedRun}
                        description={
                          (currentStudy.nvflareJobs?.length ?? 0) === 0
                            ? "No federated runs yet. Submit an approved pipeline version after sites pass readiness checks."
                            : "Submit another approved pipeline version to the selected federation sites."
                        }
                        onClick={() => openCreate("job")}
                      />
                      {currentStudy.nvflareJobs.map((job) => (
                        <WorkspaceRecordCard
                          key={text(job.id, job.createdAt)}
                          icon={<MonitorOutlined />}
                          title={text(job.nvflareJobId, WORKFLOW_TERMS.federatedRun)}
                          description={text(job.pipelineVersion?.project?.name, "Pipeline source workspace")}
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
                          onClick={() => openDetail("experimentRun", String(job.id), "run")}
                        />
                      ))}
                    </WorkspaceCardGrid>
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
                    {modelReleases.length === 0 ? (
                      <WorkspaceCardGrid>
                        <WorkspaceEmptyCard
                          icon={<CloudDownloadOutlined />}
                          title="No trained model releases"
                          description="Promote a completed federated run result from Run."
                        />
                      </WorkspaceCardGrid>
                    ) : (
                      <WorkspaceCardGrid>
                        {modelReleases.map((release) => {
                          const modelArtifact = release.artifacts?.find((artifact: EntityRecord) => artifact.kind === "AGGREGATED_MODEL");
                          const sourceJob = release.sourceResult?.job;
                          return (
                            <WorkspaceRecordCard
                              key={release.id}
                              icon={<CloudDownloadOutlined />}
                              title={`Model ${release.version}`}
                              description={`Source run ${text(sourceJob?.nvflareJobId, sourceJob?.id)}`}
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
                              onClick={() => openDetail("modelRelease", String(release.id), "results")}
                            />
                          );
                        })}
                      </WorkspaceCardGrid>
                    )}
                  </div>
                )
              },
              {
                key: "code",
                label: "Code and kit artifacts",
                children: (
                  <div className="fedlify-tab-panel">
                    {currentStudy.releases.length === 0 ? (
                      <WorkspaceCardGrid>
                        <WorkspaceEmptyCard
                          icon={<CloudDownloadOutlined />}
                          title="No code or kit releases"
                          description="Approved, immutable kit releases will appear after human review."
                        />
                      </WorkspaceCardGrid>
                    ) : (
                      <WorkspaceCardGrid>
                        {currentStudy.releases.map((release) => (
                          <WorkspaceRecordCard
                            key={release.id}
                            icon={<CloudDownloadOutlined />}
                            title={`Code/kit release ${release.version}`}
                            description={`Approved ${formatDate(release.approvedAt)}`}
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
                            onClick={() => openDetail("codeRelease", release.id, "results")}
                          />
                        ))}
                      </WorkspaceCardGrid>
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
          <WorkspaceCardGrid>
            <WorkspaceEmptyCard
              icon={<AuditOutlined />}
              title="No audit events"
              description="Access, governance, artifact, and release actions will be recorded here."
            />
          </WorkspaceCardGrid>
        ) : (
          <WorkspaceCardGrid>
            {currentStudy.auditEvents.map((event) => (
              <WorkspaceRecordCard
                key={text(event.id, `${event.action}-${event.createdAt}`)}
                icon={<AuditOutlined />}
                title={text(event.action, "Audit event")}
                description={text(event.targetId, "No target recorded")}
                status={<StatusTag value={text(event.targetType, "Audit")} />}
                meta={[formatDate(event.createdAt)]}
                actionsMenu={<EntityActionMenu items={[{ key: "view", label: "View audit event", icon: <EyeOutlined />, onClick: () => openDetail("auditEvent", String(event.id), "audit") }]} />}
                onClick={() => openDetail("auditEvent", String(event.id), "audit")}
              />
            ))}
          </WorkspaceCardGrid>
        )}
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <AppPage className={activeDetailMeta ? "is-detail-mode" : undefined}>
        <AppPageHeader
          title={activeCreateMeta?.title ?? activeDetailMeta?.title ?? activeSectionMeta.title}
          subtitle={activeCreateMeta?.subtitle ?? activeDetailMeta?.subtitle ?? activeSectionMeta.subtitle}
          backLabel={activeCreateMeta?.backLabel ?? activeDetailMeta?.backLabel}
          onBack={activeCreate ? closeCreate : activeDetailMeta ? closeDetail : undefined}
          actions={activeCreate ? null : activeDetailMeta ? activeDetailMeta.actions : renderHeaderAction(activeSection)}
          badges={activeCreate ? null : activeDetailMeta?.status}
        />

        {activeCreate ? renderInlineCreateForm(activeCreate) : renderCurrentSection(activeSection)}
      </AppPage>
    </>
  );
}
