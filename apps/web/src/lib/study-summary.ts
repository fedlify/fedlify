import { siteSignedOff } from "@/lib/site-signoff";
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
  return (study.studySites ?? []).filter((site) => siteSignedOff(site.readinessChecks?.[0]));
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
  if (studyProtocolReady(study)) return "The study design and ethics decision are complete.";
  if (!studyEthicsReady(study)) return "Record the ethics decision (approved or not required) first.";
  return `Study protocol status: ${displayEnum(study.governanceStatus, "Incomplete")}. Finish the study design, then activate the study.`;
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
      title: studyEthicsReady(study) ? "Complete study design" : "Record ethics decision",
      detail: protocolReadinessDetail(study),
      buttonLabel: "Open study protocol",
      section: "protocol",
      state: "needs_attention"
    };
  }

  if (approvedVersions.length === 0) {
    return {
      title: validatedVersions.length > 0 ? "Publish the pipeline" : "Write the pipeline",
      detail:
        validatedVersions.length > 0
          ? "A pipeline version has passed its checks and is waiting to be published."
          : "Write the pipeline in Code & run, save it, and publish it so the study server can use it.",
      buttonLabel: "Open Code & run",
      section: "pipeline",
      state: "needs_attention"
    };
  }

  if (totalSites === 0) {
    return {
      title: "Add sites",
      detail: "Add the hospitals or institutions that will take part and keep their data on site.",
      buttonLabel: "Open sites",
      section: "sites",
      state: "needs_attention"
    };
  }

  if (normalizedStatus(deployment?.status) !== "ACTIVE") {
    return {
      title: deployment ? "Start the study server" : "Publish the pipeline",
      detail: "Publish the pipeline so the study server is running before sites can connect and take part in runs.",
      buttonLabel: "Open Code & run",
      section: "run",
      state: "needs_attention"
    };
  }

  if (readySites.length === 0 || connectedSites.length === 0) {
    return {
      title: "Get sites connected",
      detail: `${readySites.length} of ${totalSites} sites have signed off and ${connectedSites.length} are connected. Each site installs the runner from its site kit and signs off.`,
      buttonLabel: "Open sites",
      section: "sites",
      state: "needs_attention"
    };
  }

  if (submittedRuns.length === 0) {
    return {
      title: "Start run",
      detail: "Everything is in place. Start a run of the published pipeline.",
      buttonLabel: "Open Code & run",
      section: "run",
      state: "ready"
    };
  }

  if ((study.modelReleases ?? []).length === 0) {
    return {
      title: "Review run results",
      detail: "A run has started. When it finishes, review the results and create a model release.",
      buttonLabel: "Open results",
      section: "results",
      state: "ready"
    };
  }

  return {
    title: "Review the model release",
    detail: "At least one model release is available to review or download.",
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
      label: "Study protocol",
      detail: protocolReadinessDetail(study),
      buttonLabel: studyProtocolReady(study) ? "Review study protocol" : "Open study protocol",
      section: "protocol",
      state: studyProtocolReady(study) ? "ready" : "needs_attention"
    },
    {
      key: "sites",
      label: "Sites",
      detail: `${readySites.length} of ${totalSites} signed off, ${connectedSites.length} connected`,
      buttonLabel: sitesReady ? "Review sites" : "Open sites",
      section: "sites",
      state: sitesReady ? "ready" : "needs_attention"
    },
    {
      key: "pipeline",
      label: "Pipeline",
      detail: approvedVersions.length > 0 ? `${approvedVersions.length} pipeline version(s) published` : "No pipeline version published yet.",
      buttonLabel: approvedVersions.length > 0 ? "Review pipeline" : "Write pipeline",
      section: "pipeline",
      state: approvedVersions.length > 0 ? "ready" : "needs_attention"
    },
    {
      key: "run",
      label: "Run",
      detail:
        submittedRuns.length > 0
          ? `${submittedRuns.length} run(s) started`
          : allSubmitGatesReady(study)
            ? "Ready to start a run of the published pipeline."
            : deploymentReady
              ? "Start a run after the study design, pipeline and sites are ready."
              : "Publish the pipeline so the study server is running before starting a run.",
      buttonLabel: "Open Code & run",
      section: "run",
      state: submittedRuns.length > 0 ? "done" : allSubmitGatesReady(study) ? "ready" : "needs_attention"
    },
    {
      key: "results",
      label: "Results",
      detail:
        (study.modelReleases ?? []).length > 0
          ? `${study.modelReleases?.length ?? 0} model release(s)`
          : submittedRuns.length > 0
            ? "When the run finishes, review the results and create a model release."
            : "Results appear after a run completes.",
      buttonLabel: (study.modelReleases ?? []).length > 0 ? "View releases" : "Open results",
      section: "results",
      state: (study.modelReleases ?? []).length > 0 ? "done" : submittedRuns.length > 0 ? "ready" : "needs_attention"
    }
  ];
}
