import type { StudyWorkspaceSection } from "@/lib/study-workspace";

type SummaryRecord = Record<string, any>;

export type StudySummaryInput = {
  status?: string;
  governanceStatus?: string;
  ethics?: SummaryRecord[];
  members?: SummaryRecord[];
  sites?: SummaryRecord[];
  studySites?: SummaryRecord[];
  pipelineProjects?: SummaryRecord[];
  nvflareDeployments?: SummaryRecord[];
  nvflareJobs?: SummaryRecord[];
  modelReleases?: SummaryRecord[];
};

export type SummaryReadinessState = "ready" | "needs_attention" | "done";

export type StudySummaryNextAction = {
  title: string;
  detail: string;
  buttonLabel: string;
  section: StudyWorkspaceSection;
  state: SummaryReadinessState;
};

export type StudySummaryReadinessItem = {
  key: "protocol" | "sites" | "pipeline" | "run" | "results";
  label: string;
  detail: string;
  buttonLabel: string;
  section: StudyWorkspaceSection;
  state: SummaryReadinessState;
};

function normalizedStatus(value?: unknown) {
  return String(value ?? "").toUpperCase();
}

function displayEnum(value?: unknown, fallback = "Not recorded") {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  return text
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function latestEthicsStatus(study: StudySummaryInput) {
  return study.ethics?.[0]?.status;
}

export function studyEthicsReady(study: StudySummaryInput) {
  const latest = normalizedStatus(latestEthicsStatus(study));
  return latest === "APPROVED" || latest === "NOT_REQUIRED";
}

export function studyProtocolReady(study: StudySummaryInput) {
  return normalizedStatus(study.status) === "ACTIVE" && studyEthicsReady(study);
}

export function approvedPipelineVersions(study: StudySummaryInput) {
  return (study.pipelineProjects ?? [])
    .flatMap((project) => (project.versions ?? []).map((version: SummaryRecord) => ({ ...version, project })))
    .filter((version) => normalizedStatus(version.approvalStatus) === "APPROVED");
}

function validatedPipelineVersions(study: StudySummaryInput) {
  return (study.pipelineProjects ?? [])
    .flatMap((project) => (project.versions ?? []).map((version: SummaryRecord) => ({ ...version, project })))
    .filter((version) => normalizedStatus(version.validationStatus) === "PASSED");
}

export function activeDeployment(study: StudySummaryInput) {
  return study.nvflareDeployments?.find((deployment) => deployment.active) ?? study.nvflareDeployments?.[0];
}

export function readyStudySites(study: StudySummaryInput) {
  return (study.studySites ?? []).filter((site) => normalizedStatus(site.readinessChecks?.[0]?.status) === "PASSED");
}

export function connectedStudySites(study: StudySummaryInput) {
  return (study.studySites ?? []).filter((site) => normalizedStatus(site.nvflareStatuses?.[0]?.status) === "CONNECTED");
}

export function submittedExperimentRuns(study: StudySummaryInput) {
  return (study.nvflareJobs ?? []).filter((job) =>
    ["SUBMITTED", "SCHEDULED", "RUNNING", "COMPLETED"].includes(normalizedStatus(job.status))
  );
}

export function protocolReadinessDetail(study: StudySummaryInput) {
  if (studyProtocolReady(study)) return "Protocol metadata and ethics are ready for runtime.";
  if (!studyEthicsReady(study)) return "Ethics approval or exemption is required before runtime.";
  return `Protocol status is ${displayEnum(study.governanceStatus, "Incomplete")}; activate the study when metadata is complete.`;
}

function allSubmitGatesReady(study: StudySummaryInput) {
  const deployment = activeDeployment(study);
  return (
    studyProtocolReady(study) &&
    approvedPipelineVersions(study).length > 0 &&
    normalizedStatus(deployment?.status) === "ACTIVE" &&
    readyStudySites(study).length > 0 &&
    connectedStudySites(study).length > 0
  );
}

export function resolveStudyNextAction(study: StudySummaryInput): StudySummaryNextAction {
  const approvedVersions = approvedPipelineVersions(study);
  const validatedVersions = validatedPipelineVersions(study);
  const deployment = activeDeployment(study);
  const totalSites = study.studySites?.length ?? study.sites?.length ?? 0;
  const readySites = readyStudySites(study);
  const connectedSites = connectedStudySites(study);
  const submittedRuns = submittedExperimentRuns(study);

  if (!studyProtocolReady(study)) {
    return {
      title: studyEthicsReady(study) ? "Complete protocol metadata" : "Complete ethics review",
      detail: protocolReadinessDetail(study),
      buttonLabel: "Fix protocol",
      section: "protocol",
      state: "needs_attention"
    };
  }

  if (approvedVersions.length === 0) {
    return {
      title: validatedVersions.length > 0 ? "Approve a pipeline version" : "Create a pipeline version",
      detail:
        validatedVersions.length > 0
          ? "A validated immutable commit is waiting for human approval."
          : "Choose an approved template source and create a validated study pipeline version.",
      buttonLabel: validatedVersions.length > 0 ? "Approve pipeline" : "Open pipeline",
      section: "pipeline",
      state: "needs_attention"
    };
  }

  if (totalSites === 0) {
    return {
      title: "Register participant sites",
      detail: "Add the institutions that will host site-local data and NVFLARE clients.",
      buttonLabel: "Open sites",
      section: "sites",
      state: "needs_attention"
    };
  }

  if (normalizedStatus(deployment?.status) !== "ACTIVE") {
    return {
      title: deployment ? "Start aggregator" : "Provision aggregator",
      detail: "Start the local Docker aggregator before sites can join and receive jobs.",
      buttonLabel: "Open run",
      section: "run",
      state: "needs_attention"
    };
  }

  if (readySites.length === 0 || connectedSites.length === 0) {
    return {
      title: "Bring sites online",
      detail: `${readySites.length}/${totalSites} sites ready and ${connectedSites.length} connected.`,
      buttonLabel: "Open sites",
      section: "sites",
      state: "needs_attention"
    };
  }

  if (submittedRuns.length === 0) {
    return {
      title: "Submit federated run",
      detail: "All runtime gates are ready for an approved pipeline run.",
      buttonLabel: "Submit run",
      section: "run",
      state: "ready"
    };
  }

  if ((study.modelReleases ?? []).length === 0) {
    return {
      title: "Review training output",
      detail: "A federated run exists. Sync results and promote a governed model release when complete.",
      buttonLabel: "Open results",
      section: "results",
      state: "ready"
    };
  }

  return {
    title: "Review trained model release",
    detail: "At least one governed model release is available for review or download.",
    buttonLabel: "Open results",
    section: "results",
    state: "done"
  };
}

export function summaryReadinessItems(study: StudySummaryInput): StudySummaryReadinessItem[] {
  const approvedVersions = approvedPipelineVersions(study);
  const deployment = activeDeployment(study);
  const readySites = readyStudySites(study);
  const connectedSites = connectedStudySites(study);
  const totalSites = study.studySites?.length ?? study.sites?.length ?? 0;
  const submittedRuns = submittedExperimentRuns(study);
  const deploymentReady = normalizedStatus(deployment?.status) === "ACTIVE";
  const sitesReady = readySites.length > 0 && connectedSites.length > 0;

  return [
    {
      key: "protocol",
      label: "Protocol",
      detail: protocolReadinessDetail(study),
      buttonLabel: studyProtocolReady(study) ? "Review protocol" : "Fix protocol",
      section: "protocol",
      state: studyProtocolReady(study) ? "ready" : "needs_attention"
    },
    {
      key: "sites",
      label: "Sites",
      detail: `${readySites.length}/${totalSites} ready, ${connectedSites.length} connected`,
      buttonLabel: sitesReady ? "Review sites" : "Open sites",
      section: "sites",
      state: sitesReady ? "ready" : "needs_attention"
    },
    {
      key: "pipeline",
      label: "Pipeline",
      detail: approvedVersions.length > 0 ? `${approvedVersions.length} approved pipeline version(s)` : "No approved pipeline version.",
      buttonLabel: approvedVersions.length > 0 ? "Review pipeline" : "Create pipeline version",
      section: "pipeline",
      state: approvedVersions.length > 0 ? "ready" : "needs_attention"
    },
    {
      key: "run",
      label: "Run",
      detail:
        submittedRuns.length > 0
          ? `${submittedRuns.length} federated run(s) submitted`
          : allSubmitGatesReady(study)
            ? "Ready to submit an approved federated run."
            : deploymentReady
              ? "Submit after protocol, pipeline, and sites are ready."
              : "Start the aggregator before submitting a federated run.",
      buttonLabel: submittedRuns.length > 0 ? "View run" : "Open run",
      section: "run",
      state: submittedRuns.length > 0 ? "done" : allSubmitGatesReady(study) ? "ready" : "needs_attention"
    },
    {
      key: "results",
      label: "Results",
      detail:
        (study.modelReleases ?? []).length > 0
          ? `${study.modelReleases?.length ?? 0} trained model release(s)`
          : submittedRuns.length > 0
            ? "Sync completed run results and promote a model release."
            : "Results appear after a federated run completes.",
      buttonLabel: (study.modelReleases ?? []).length > 0 ? "View releases" : "Open results",
      section: "results",
      state: (study.modelReleases ?? []).length > 0 ? "done" : submittedRuns.length > 0 ? "ready" : "needs_attention"
    }
  ];
}
