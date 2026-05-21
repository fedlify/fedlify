type WorkflowRecord = Record<string, any>;

export const WORKFLOW_TERMS = {
  publicTemplate: "Public template",
  studyTemplate: "Study template",
  studyPipelineSource: "Study pipeline source",
  templateSource: "Template source",
  pipelineVersion: "Pipeline version",
  federatedRun: "Federated run",
  modelRelease: "Model release",
  trainedModelRelease: "Trained model release",
  codeKitArtifacts: "Code and kit artifacts",
  createPipelineVersion: "Create pipeline version",
  submitFederatedRun: "Submit federated run",
  createOrEditWithAi: "Create or edit with AI",
  proposeReusableTemplateUpdate: "Propose reusable template update"
} as const;

export function workflowText(value: unknown, fallback = "Not set") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

export function workflowEnumLabel(value: unknown, fallback = "Not set") {
  if (!value || typeof value !== "string") return fallback;
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace("Pdf", "PDF")
    .replace("Nvflare", "NVFLARE");
}

export function workflowShortCommit(value: unknown) {
  return typeof value === "string" && value ? value.slice(0, 12) : "None";
}

export function templateScopeLabel(template?: WorkflowRecord | null) {
  if (template?.scope === "STUDY_TEMPLATE") return WORKFLOW_TERMS.studyTemplate;
  if (template?.scope === "PUBLIC_TEMPLATE") return WORKFLOW_TERMS.publicTemplate;
  if (template?.scope === "STUDY_PIPELINE") return WORKFLOW_TERMS.studyPipelineSource;
  return WORKFLOW_TERMS.templateSource;
}

export function templateVersionLabel(version?: WorkflowRecord | null) {
  if (!version) return "No approved version";
  return `${workflowText(version.version)} · ${workflowShortCommit(version.gitCommit)}`;
}

export function templateSourceLabel(template?: WorkflowRecord | null, version?: WorkflowRecord | null) {
  return `${templateScopeLabel(template)} · ${workflowText(template?.name, template?.templateKey ?? "NVFLARE template")} · ${templateVersionLabel(version ?? template?.currentApprovedVersion)}`;
}

export function approvedTemplateCatalog(templates: WorkflowRecord[]) {
  return templates.filter((template) => {
    const version = template.currentApprovedVersion;
    return version?.approvalStatus === "APPROVED" && version?.validationStatus === "PASSED";
  });
}

export function pipelineVersionState(version?: WorkflowRecord | null) {
  if (!version) return "No pipeline version";
  if (version.approvalStatus === "APPROVED") return "Approved for federated runs";
  if (version.validationStatus === "PASSED") return "Validated, awaiting approval";
  if (version.validationStatus === "FAILED") return "Validation failed";
  return workflowEnumLabel(version.validationStatus ?? version.approvalStatus, "Draft");
}

export function federatedRunState(run?: WorkflowRecord | null) {
  if (!run) return "No federated run";
  const value = workflowEnumLabel(run.fedlifyStatus ?? run.status, "Draft");
  return value === "Submitted" ? "Submitted" : value;
}

export function templateCatalogEmptyCopy(scope: "public" | "study" = "public") {
  if (scope === "study") {
    return {
      title: "No study template sources",
      description: "Fork a public template or create a study template with AI before creating a pipeline version."
    };
  }
  return {
    title: "No reusable template sources",
    description: "Create a public template proposal to initialize the reusable catalog."
  };
}
