import type { TemplateAgentIntake } from "@/lib/template-agent";
import { CLINICAL_USE_CASE_OPTIONS, DATA_MODALITY_OPTIONS } from "@/lib/governance-options";

export type GuidedAnswerOption = {
  id: string;
  icon: GuidedIconKey;
  label: string;
  description: string;
  value: string | number | string[];
  message: string;
};

export type GuidedQuestionConfig = {
  key: keyof TemplateAgentIntake;
  label: string;
  title: string;
  helper: string;
  input: "text" | "textarea" | "number" | "select" | "multiselect";
  icon: GuidedIconKey;
  placeholder?: string;
  defaultValue?: string | number | string[];
  min?: number;
  allowCustom: boolean;
  options?: Array<{ value: string; label: string }>;
  curatedOptions: [GuidedAnswerOption, GuidedAnswerOption, GuidedAnswerOption];
  buildCustomMessage: (value: string | number | string[]) => string;
};

export type GuidedIconKey =
  | "artifacts"
  | "automation"
  | "check"
  | "code"
  | "data"
  | "files"
  | "governance"
  | "name"
  | "privacy"
  | "runtime"
  | "workflow";

export type PipelineAgentLayoutMode = "chat-focus" | "editing";

const clinicalOptions = CLINICAL_USE_CASE_OPTIONS as unknown as Array<{ value: string; label: string }>;
const modalityOptions = DATA_MODALITY_OPTIONS as unknown as Array<{ value: string; label: string }>;

function labelForOption(options: Array<{ value: string; label: string }>, value: string, fallback: string): string {
  return options.find((option) => option.value === value)?.label ?? fallback;
}

function formatAnswerValue(value: string | number | string[]): string {
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

export function derivePipelineAgentLayoutMode(input: { explorerOpen: boolean; openTabs: string[] }): PipelineAgentLayoutMode {
  return input.explorerOpen || input.openTabs.length > 0 ? "editing" : "chat-focus";
}

export function closePipelineAgentTab(input: {
  openTabs: string[];
  selectedPath: string | null;
  path: string;
}): { openTabs: string[]; selectedPath: string | null; explorerOpen: boolean; workspaceOpen: boolean; layoutMode: PipelineAgentLayoutMode } {
  const nextTabs = input.openTabs.filter((item) => item !== input.path);
  const nextSelectedPath = input.selectedPath === input.path ? nextTabs[nextTabs.length - 1] ?? null : input.selectedPath;
  const explorerOpen = nextTabs.length > 0;
  const workspaceOpen = nextTabs.length > 0;
  return {
    openTabs: nextTabs,
    selectedPath: nextSelectedPath,
    explorerOpen,
    workspaceOpen,
    layoutMode: derivePipelineAgentLayoutMode({ explorerOpen, openTabs: nextTabs })
  };
}

export function nextGuidedMissingField(missing: string[], completedFieldOrder: string[] = []): string | null {
  const unresolved = missing.filter((label) => label in GUIDED_QUESTIONS);
  return unresolved.find((label) => !completedFieldOrder.includes(label)) ?? unresolved[0] ?? null;
}

export function buildGuidedIntakeMessage(label: string, value: string | number | string[]): string {
  const config = GUIDED_QUESTIONS[label];
  if (!config) return `Updated ${label} to ${formatAnswerValue(value)}.`;
  const curatedOption = config.curatedOptions.find((option) => {
    if (Array.isArray(option.value) && Array.isArray(value)) {
      return option.value.length === value.length && option.value.every((item, index) => item === value[index]);
    }
    return option.value === value;
  });
  if (curatedOption) return curatedOption.message;
  return config.buildCustomMessage(value);
}

export const GUIDED_QUESTIONS: Record<string, GuidedQuestionConfig> = {
  "template name": {
    key: "templateName",
    label: "template name",
    title: "What should we call this pipeline template?",
    helper: "Pick a clear repository-facing name. The template key and Git workspace will follow this choice.",
    input: "text",
    icon: "name",
    placeholder: "e.g. fedavg-ehr-sepsis-prediction",
    allowCustom: true,
    curatedOptions: [
      {
        id: "template-name-tabular",
        icon: "name",
        label: "Tabular training",
        description: "Use a stable slug for cross-site tabular model training.",
        value: "fedavg-tabular-risk-prediction",
        message: "Set the template name to fedavg-tabular-risk-prediction."
      },
      {
        id: "template-name-imaging",
        icon: "name",
        label: "Imaging training",
        description: "Use a slug suited to a medical imaging federated workflow.",
        value: "fedavg-imaging-classification",
        message: "Set the template name to fedavg-imaging-classification."
      },
      {
        id: "template-name-evaluation",
        icon: "name",
        label: "Evaluation pack",
        description: "Use a slug for a validation or evaluation oriented template.",
        value: "federated-model-evaluation",
        message: "Set the template name to federated-model-evaluation."
      }
    ],
    buildCustomMessage: (value) => `Set the template name to ${formatAnswerValue(value)}.`
  },
  "what the template should do": {
    key: "agentRequest",
    label: "what the template should do",
    title: "What should the pipeline do?",
    helper: "Give the agent the job to accomplish so code generation stays scoped to the study workflow.",
    input: "textarea",
    icon: "automation",
    placeholder: "Describe the pipeline goal.",
    allowCustom: true,
    curatedOptions: [
      {
        id: "agent-request-train",
        icon: "automation",
        label: "Train a model",
        description: "Generate a supervised cross-site training workflow with server aggregation.",
        value: "Build a federated supervised learning pipeline that trains a site-local model and aggregates updates on the server.",
        message: "Set the template goal to a federated supervised training workflow with server aggregation."
      },
      {
        id: "agent-request-evaluate",
        icon: "automation",
        label: "Evaluate a model",
        description: "Focus the pipeline on distributed evaluation and metrics reporting.",
        value: "Build a federated evaluation workflow that runs site-local validation and aggregates global metrics without updating the model.",
        message: "Set the template goal to distributed evaluation with aggregated metrics."
      },
      {
        id: "agent-request-preprocess",
        icon: "automation",
        label: "Prepare features",
        description: "Generate a preprocessing-oriented workflow for site-local data transforms.",
        value: "Build a federated preprocessing pipeline that standardizes site-local tabular features before downstream training.",
        message: "Set the template goal to site-local preprocessing before downstream training."
      }
    ],
    buildCustomMessage: (value) => `Set the template goal to ${formatAnswerValue(value)}.`
  },
  "template purpose": {
    key: "purpose",
    label: "template purpose",
    title: "What is the primary purpose?",
    helper: "This controls the main workflow framing and the language used in the generated README and manifest.",
    input: "select",
    icon: "code",
    options: ["training", "evaluation", "preprocessing", "metrics", "model export"].map((value) => ({ value, label: value })),
    defaultValue: "training",
    allowCustom: true,
    curatedOptions: [
      { id: "purpose-training", icon: "code", label: "Training", description: "Generate a training-first template.", value: "training", message: "Set the template purpose to training." },
      { id: "purpose-evaluation", icon: "check", label: "Evaluation", description: "Generate an evaluation-first template.", value: "evaluation", message: "Set the template purpose to evaluation." },
      { id: "purpose-preprocessing", icon: "data", label: "Preprocessing", description: "Generate a preprocessing-first template.", value: "preprocessing", message: "Set the template purpose to preprocessing." }
    ],
    buildCustomMessage: (value) => `Set the template purpose to ${formatAnswerValue(value)}.`
  },
  "clinical AI use case": {
    key: "clinicalUseCase",
    label: "clinical AI use case",
    title: "Which clinical AI use case fits best?",
    helper: "Choose the closest use case so the examples, README, and code comments match the domain.",
    input: "select",
    icon: "governance",
    options: clinicalOptions,
    allowCustom: true,
    curatedOptions: [
      {
        id: "clinical-usecase-risk",
        icon: "governance",
        label: "Risk prediction",
        description: "Use a common structured-data prediction workflow.",
        value: clinicalOptions[0]?.value ?? "Risk prediction",
        message: `Set the clinical AI use case to ${labelForOption(clinicalOptions, clinicalOptions[0]?.value ?? "Risk prediction", "risk prediction")}.`
      },
      {
        id: "clinical-usecase-imaging",
        icon: "governance",
        label: "Medical imaging",
        description: "Use an imaging-oriented task for distributed training.",
        value: clinicalOptions[1]?.value ?? "Medical imaging",
        message: `Set the clinical AI use case to ${labelForOption(clinicalOptions, clinicalOptions[1]?.value ?? "Medical imaging", "medical imaging")}.`
      },
      {
        id: "clinical-usecase-nlp",
        icon: "governance",
        label: "Clinical NLP",
        description: "Use a text or notes-based clinical language modeling task.",
        value: clinicalOptions[2]?.value ?? "Clinical NLP",
        message: `Set the clinical AI use case to ${labelForOption(clinicalOptions, clinicalOptions[2]?.value ?? "Clinical NLP", "clinical NLP")}.`
      }
    ],
    buildCustomMessage: (value) => `Set the clinical AI use case to ${formatAnswerValue(value)}.`
  },
  "clinical application": {
    key: "clinicalApplication",
    label: "clinical application",
    title: "Why is this FL workflow needed clinically?",
    helper: "Choose the practical application so validation and governance match the intended use.",
    input: "select",
    icon: "governance",
    options: ["diagnosis", "prognosis", "treatment support", "clinical research", "hospital operations"].map((value) => ({ value, label: value })),
    defaultValue: "clinical research",
    allowCustom: true,
    curatedOptions: [
      {
        id: "clinical-app-prognosis",
        icon: "governance",
        label: "Prognosis",
        description: "Predict future risk or outcome using site-local data.",
        value: "prognosis",
        message: "Set the clinical application to prognosis."
      },
      {
        id: "clinical-app-research",
        icon: "governance",
        label: "Research",
        description: "Use FL for retrospective or exploratory clinical research.",
        value: "clinical research",
        message: "Set the clinical application to clinical research."
      },
      {
        id: "clinical-app-ops",
        icon: "governance",
        label: "Operations",
        description: "Use aggregate learning for hospital operations or quality improvement.",
        value: "hospital operations",
        message: "Set the clinical application to hospital operations."
      }
    ],
    buildCustomMessage: (value) => `Set the clinical application to ${formatAnswerValue(value)}.`
  },
  "disease category": {
    key: "diseaseCategory",
    label: "disease category",
    title: "Which disease category is in scope?",
    helper: "Use the closest category so endpoints, examples, and cautions are domain-aware without inventing labels.",
    input: "select",
    icon: "governance",
    options: [
      "cancer and oncology",
      "cardiovascular and vascular diseases",
      "neurological disorders",
      "psychiatric and mental health",
      "respiratory and lung conditions",
      "kidney and renal diseases",
      "infectious diseases",
      "critical care",
      "surgical and trauma conditions",
      "reproductive, pregnancy, and neonatal health",
      "gastroenterology and hepatology",
      "other"
    ].map((value) => ({ value, label: value })),
    defaultValue: "other",
    allowCustom: true,
    curatedOptions: [
      {
        id: "disease-oncology",
        icon: "governance",
        label: "Oncology",
        description: "Cancer imaging, pathology, genomics, or risk prediction.",
        value: "cancer and oncology",
        message: "Set the disease category to cancer and oncology."
      },
      {
        id: "disease-cardiovascular",
        icon: "governance",
        label: "Cardiovascular",
        description: "Cardiovascular or vascular disease prediction and monitoring.",
        value: "cardiovascular and vascular diseases",
        message: "Set the disease category to cardiovascular and vascular diseases."
      },
      {
        id: "disease-critical-care",
        icon: "governance",
        label: "Critical care",
        description: "ICU, sepsis, mortality, deterioration, or acute-care workflows.",
        value: "critical care",
        message: "Set the disease category to critical care."
      }
    ],
    buildCustomMessage: (value) => `Set the disease category to ${formatAnswerValue(value)}.`
  },
  "collaboration setting": {
    key: "collaborationSetting",
    label: "collaboration setting",
    title: "Who is collaborating?",
    helper: "This determines trust, participation stability, governance, and whether the workflow is cross-silo, cross-device, or hybrid.",
    input: "select",
    icon: "workflow",
    options: [
      { value: "cross-silo hospitals", label: "Cross-silo hospitals" },
      { value: "cross-device wearables", label: "Cross-device wearables" },
      { value: "hybrid", label: "Hybrid" }
    ],
    defaultValue: "cross-silo hospitals",
    allowCustom: true,
    curatedOptions: [
      {
        id: "collab-cross-silo",
        icon: "workflow",
        label: "Hospitals",
        description: "Stable institutional clients such as hospitals or research centers.",
        value: "cross-silo hospitals",
        message: "Set the collaboration setting to cross-silo hospitals."
      },
      {
        id: "collab-cross-device",
        icon: "workflow",
        label: "Wearables",
        description: "Many user/device clients with variable availability.",
        value: "cross-device wearables",
        message: "Set the collaboration setting to cross-device wearables."
      },
      {
        id: "collab-hybrid",
        icon: "workflow",
        label: "Hybrid",
        description: "Combine institutional sites with device or wearable sources.",
        value: "hybrid",
        message: "Set the collaboration setting to a hybrid collaboration."
      }
    ],
    buildCustomMessage: (value) => `Set the collaboration setting to ${formatAnswerValue(value)}.`
  },
  "data modalities": {
    key: "dataModalities",
    label: "data modalities",
    title: "What data modalities are in scope?",
    helper: "Pick the closest data shape so the agent generates the right local loading and validation expectations.",
    input: "multiselect",
    icon: "data",
    options: modalityOptions,
    allowCustom: true,
    curatedOptions: [
      {
        id: "modalities-tabular",
        icon: "data",
        label: "Tabular EHR",
        description: "Structured clinical features such as labs, vitals, and demographics.",
        value: [modalityOptions[0]?.value ?? "tabular"],
        message: `Set the data modalities to ${labelForOption(modalityOptions, modalityOptions[0]?.value ?? "tabular", "tabular")} only.`
      },
      {
        id: "modalities-imaging",
        icon: "data",
        label: "Imaging",
        description: "Radiology or pathology image workflows.",
        value: [modalityOptions[1]?.value ?? "imaging"],
        message: `Set the data modalities to ${labelForOption(modalityOptions, modalityOptions[1]?.value ?? "imaging", "imaging")} only.`
      },
      {
        id: "modalities-mixed",
        icon: "data",
        label: "Multimodal",
        description: "Combine structured clinical features with one secondary modality.",
        value: [modalityOptions[0]?.value ?? "tabular", modalityOptions[1]?.value ?? "imaging"],
        message: `Set the data modalities to ${[labelForOption(modalityOptions, modalityOptions[0]?.value ?? "tabular", "tabular"), labelForOption(modalityOptions, modalityOptions[1]?.value ?? "imaging", "imaging")].join(" and ")}.`
      }
    ],
    buildCustomMessage: (value) => `Set the data modalities to ${formatAnswerValue(value)}.`
  },
  "data distribution": {
    key: "dataDistribution",
    label: "data distribution",
    title: "How is data distributed across sites?",
    helper: "This determines whether standard horizontal FL is appropriate or whether vertical/transfer methods need review.",
    input: "select",
    icon: "data",
    options: [
      { value: "horizontal: different patients/same features", label: "Horizontal" },
      { value: "vertical: same or overlapping patients/different features", label: "Vertical" },
      { value: "partial overlap / federated transfer", label: "Partial overlap" }
    ],
    defaultValue: "horizontal: different patients/same features",
    allowCustom: true,
    curatedOptions: [
      {
        id: "distribution-horizontal",
        icon: "data",
        label: "Horizontal",
        description: "Sites share feature/label schema but have different patients.",
        value: "horizontal: different patients/same features",
        message: "Set data distribution to horizontal FL with different patients and shared feature schema."
      },
      {
        id: "distribution-vertical",
        icon: "data",
        label: "Vertical",
        description: "Sites have overlapping patients but different feature sets.",
        value: "vertical: same or overlapping patients/different features",
        message: "Set data distribution to vertical FL with overlapping patients and different features."
      },
      {
        id: "distribution-transfer",
        icon: "data",
        label: "Partial overlap",
        description: "Sites differ in both samples and features, requiring transfer-style review.",
        value: "partial overlap / federated transfer",
        message: "Set data distribution to partial overlap / federated transfer."
      }
    ],
    buildCustomMessage: (value) => `Set data distribution to ${formatAnswerValue(value)}.`
  },
  "outcome / label definition": {
    key: "outcomeDefinition",
    label: "outcome / label definition",
    title: "What outcome or label will sites produce?",
    helper: "Define the endpoint the local pipeline should expect. Keep it as metadata, not patient examples.",
    input: "textarea",
    icon: "check",
    placeholder: "e.g. Binary 30-day readmission label derived locally from each site's EHR.",
    allowCustom: true,
    curatedOptions: [
      {
        id: "outcome-binary-risk",
        icon: "check",
        label: "Binary risk",
        description: "Each site maps local records to a binary supervised label.",
        value: "Binary clinical risk label generated locally at each site using the approved study endpoint definition.",
        message: "Set the outcome to a locally generated binary clinical risk label."
      },
      {
        id: "outcome-imaging-class",
        icon: "check",
        label: "Image class",
        description: "Each site provides a locally governed class label for images.",
        value: "Locally governed imaging class label with the same class definitions across participating sites.",
        message: "Set the outcome to locally governed imaging class labels with shared class definitions."
      },
      {
        id: "outcome-metrics-only",
        icon: "check",
        label: "Metrics only",
        description: "Use site-local evaluation labels and export aggregate metrics.",
        value: "Site-local validation labels are used only to compute aggregate evaluation metrics; no patient-level outputs leave sites.",
        message: "Set the outcome to site-local evaluation labels with aggregate metrics only."
      }
    ],
    buildCustomMessage: (value) => `Set the outcome / label definition to ${formatAnswerValue(value)}.`
  },
  "participating sites": {
    key: "participatingSites",
    label: "participating sites",
    title: "Which sites are expected to participate?",
    helper: "Name institutions or site codes and expected roles. Do not include patient lists or local file paths.",
    input: "textarea",
    icon: "workflow",
    placeholder: "e.g. Site A and Site B as training clients; coordinating site as admin/server.",
    allowCustom: true,
    curatedOptions: [
      {
        id: "sites-two-hospital",
        icon: "workflow",
        label: "Two hospitals",
        description: "Two training clients and one coordinating admin/server role.",
        value: "Two hospital sites participate as training clients; the coordinating institution manages admin/server operations.",
        message: "Set participating sites to two hospital training clients plus a coordinating institution."
      },
      {
        id: "sites-multi-center",
        icon: "workflow",
        label: "Multi-center",
        description: "Three or more sites participate as cross-silo clients.",
        value: "Three or more institutions participate as cross-silo FL clients, with one named coordinating site for workflow administration.",
        message: "Set participating sites to a multi-center cross-silo collaboration."
      },
      {
        id: "sites-evaluation",
        icon: "workflow",
        label: "Evaluation sites",
        description: "Sites run validation only and return aggregate metrics.",
        value: "Participating sites run site-local evaluation and return only aggregate validation metrics to the coordinator.",
        message: "Set participating sites to site-local evaluation clients with aggregate metrics only."
      }
    ],
    buildCustomMessage: (value) => `Set participating sites to ${formatAnswerValue(value)}.`
  },
  "governance contact": {
    key: "governanceContact",
    label: "governance contact",
    title: "Who is responsible for governance review?",
    helper: "Use a role or named project contact. Avoid personal identifiers beyond normal study responsibility metadata.",
    input: "text",
    icon: "governance",
    placeholder: "e.g. study PI, privacy officer, or institutional data steward.",
    allowCustom: true,
    curatedOptions: [
      {
        id: "governance-pi",
        icon: "governance",
        label: "Study PI",
        description: "The principal investigator owns the governance decision path.",
        value: "Study principal investigator is responsible for governance review and escalation.",
        message: "Set the governance contact to the study principal investigator."
      },
      {
        id: "governance-privacy-officer",
        icon: "governance",
        label: "Privacy officer",
        description: "Privacy/security lead must approve data and release controls.",
        value: "Institutional privacy/security officer must review privacy controls, release rules, and site data boundaries.",
        message: "Set the governance contact to the institutional privacy/security officer."
      },
      {
        id: "governance-data-steward",
        icon: "governance",
        label: "Data steward",
        description: "A site data steward owns data readiness and policy checks.",
        value: "Named site data steward is responsible for data readiness, local policy checks, and governance escalation.",
        message: "Set the governance contact to the site data steward."
      }
    ],
    buildCustomMessage: (value) => `Set governance contact to ${formatAnswerValue(value)}.`
  },
  "site-local input contract": {
    key: "siteLocalInputs",
    label: "site-local input contract",
    title: "What site-local input contract should the code expect?",
    helper: "Keep this concrete. The generated executor and README will use it as the local data contract.",
    input: "textarea",
    icon: "files",
    placeholder: "e.g. CSV with age, vitals, labs, and label columns.",
    allowCustom: true,
    curatedOptions: [
      {
        id: "input-contract-csv",
        icon: "files",
        label: "CSV table",
        description: "Each site provides a CSV file with feature columns and a label column.",
        value: "CSV with demographics, vitals, labs, and one target label column per row.",
        message: "Set the site-local input contract to a CSV table with feature columns and one target label."
      },
      {
        id: "input-contract-numpy",
        icon: "files",
        label: "NumPy arrays",
        description: "Sites load local `.npy` or `.npz` tensors for training.",
        value: "Local NumPy arrays stored as .npy or .npz files with one tensor for inputs and one tensor for labels.",
        message: "Set the site-local input contract to local NumPy arrays in .npy or .npz form."
      },
      {
        id: "input-contract-folder",
        icon: "files",
        label: "Folder dataset",
        description: "Sites provide a folder-based dataset layout with metadata.",
        value: "A folder-based site-local dataset with one manifest file and modality-specific subdirectories.",
        message: "Set the site-local input contract to a folder dataset with a manifest and modality-specific directories."
      }
    ],
    buildCustomMessage: (value) => `Set the site-local input contract to ${formatAnswerValue(value)}.`
  },
  "data readiness summary": {
    key: "dataReadinessSummary",
    label: "data readiness summary",
    title: "What is known about site data readiness?",
    helper: "Summarize aggregate counts, schema/feature availability, labels, and missingness without patient rows or file names.",
    input: "textarea",
    icon: "data",
    placeholder: "e.g. Each site has aggregate sample counts, a feature dictionary, label availability, and missingness summary.",
    allowCustom: true,
    curatedOptions: [
      {
        id: "readiness-complete",
        icon: "data",
        label: "Ready",
        description: "Sites can provide counts, schema, label availability, and missingness.",
        value: "Each site can provide aggregate sample counts, feature/schema dictionary, label availability, and missingness summary before workflow freeze.",
        message: "Set data readiness to aggregate counts, schema, label availability, and missingness available."
      },
      {
        id: "readiness-partial",
        icon: "data",
        label: "Partial",
        description: "Some metadata is available but harmonization gaps remain.",
        value: "Sites can provide aggregate sample counts and modality descriptions, but feature/schema harmonization and label consistency still need review.",
        message: "Set data readiness to partial with harmonization and label-consistency gaps."
      },
      {
        id: "readiness-evaluation",
        icon: "data",
        label: "Evaluation ready",
        description: "Sites can run validation locally and return aggregate metrics.",
        value: "Sites can run local validation using approved labels and return aggregate metrics; training readiness is not assumed.",
        message: "Set data readiness to local validation with aggregate metrics only."
      }
    ],
    buildCustomMessage: (value) => `Set data readiness summary to ${formatAnswerValue(value)}.`
  },
  "site constraints": {
    key: "siteConstraints",
    label: "site constraints",
    title: "What site constraints must the workflow respect?",
    helper: "Capture operational limits such as networking, containers, compute, release review, and local policy.",
    input: "textarea",
    icon: "runtime",
    placeholder: "e.g. outbound-only networking, container review, no patient-level exports, release approval required.",
    allowCustom: true,
    curatedOptions: [
      {
        id: "constraints-outbound",
        icon: "runtime",
        label: "Outbound only",
        description: "Clients connect outward; no inbound site network exposure.",
        value: "Sites require outbound-only networking, local container review, and no patient-level exports.",
        message: "Set site constraints to outbound-only networking with local container review."
      },
      {
        id: "constraints-approval",
        icon: "runtime",
        label: "Release gate",
        description: "Human approval required before kits or outputs are released.",
        value: "Human release approval is required before startup kits, model artifacts, logs, or aggregate reports are released.",
        message: "Set site constraints to require a human release gate."
      },
      {
        id: "constraints-limited-compute",
        icon: "runtime",
        label: "Limited compute",
        description: "Keep runtime light and configurable for constrained sites.",
        value: "Sites have limited compute; runtime parameters, dependency set, and local epochs must stay configurable and lightweight.",
        message: "Set site constraints to limited compute with configurable lightweight runtime."
      }
    ],
    buildCustomMessage: (value) => `Set site constraints to ${formatAnswerValue(value)}.`
  },
  "system topology": {
    key: "systemTopology",
    label: "system topology",
    title: "Where should aggregation happen?",
    helper: "Choose the topology that fits the trust model and operational constraints.",
    input: "select",
    icon: "workflow",
    options: [
      { value: "centralized aggregation", label: "Centralized aggregation" },
      { value: "decentralized / peer-to-peer", label: "Decentralized / peer-to-peer" },
      { value: "hierarchical", label: "Hierarchical" }
    ],
    defaultValue: "centralized aggregation",
    allowCustom: true,
    curatedOptions: [
      {
        id: "topology-central",
        icon: "workflow",
        label: "Central server",
        description: "A coordinating server aggregates client updates.",
        value: "centralized aggregation",
        message: "Set system topology to centralized aggregation."
      },
      {
        id: "topology-peer",
        icon: "workflow",
        label: "Peer-to-peer",
        description: "No central aggregator; sites exchange updates through a decentralized pattern.",
        value: "decentralized / peer-to-peer",
        message: "Set system topology to decentralized / peer-to-peer."
      },
      {
        id: "topology-hierarchical",
        icon: "workflow",
        label: "Hierarchical",
        description: "Aggregate within groups first, then aggregate globally.",
        value: "hierarchical",
        message: "Set system topology to hierarchical aggregation."
      }
    ],
    buildCustomMessage: (value) => `Set system topology to ${formatAnswerValue(value)}.`
  },
  "training strategy": {
    key: "trainingStrategy",
    label: "training strategy",
    title: "How should training handle site availability and heterogeneity?",
    helper: "This should reflect site reliability, compute heterogeneity, and whether the output is global or personalized.",
    input: "select",
    icon: "runtime",
    options: [
      { value: "synchronous", label: "Synchronous" },
      { value: "asynchronous", label: "Asynchronous" },
      { value: "semi-asynchronous", label: "Semi-asynchronous" },
      { value: "personalized FL", label: "Personalized FL" }
    ],
    defaultValue: "synchronous",
    allowCustom: true,
    curatedOptions: [
      {
        id: "training-sync",
        icon: "runtime",
        label: "Synchronous",
        description: "Stable sites participate in each round.",
        value: "synchronous",
        message: "Set training strategy to synchronous FL."
      },
      {
        id: "training-async",
        icon: "runtime",
        label: "Asynchronous",
        description: "Handle slow or intermittently available sites.",
        value: "asynchronous",
        message: "Set training strategy to asynchronous FL."
      },
      {
        id: "training-personalized",
        icon: "runtime",
        label: "Personalized",
        description: "Use site-adapted models when non-IID data threatens a single global model.",
        value: "personalized FL",
        message: "Set training strategy to personalized FL."
      }
    ],
    buildCustomMessage: (value) => `Set training strategy to ${formatAnswerValue(value)}.`
  },
  "challenge profile": {
    key: "challengeProfile",
    label: "challenge profile",
    title: "Which real-world challenges should the agent plan for?",
    helper: "These become warnings, validation checks, and approval gates in the generated workflow.",
    input: "textarea",
    icon: "check",
    placeholder: "e.g. non-IID data, small site cohorts, limited compute, network instability, fairness risk, benchmarking requirements.",
    allowCustom: true,
    curatedOptions: [
      {
        id: "challenge-noniid-small",
        icon: "check",
        label: "Non-IID + small cohorts",
        description: "Data heterogeneity, imbalance, and fairness need explicit validation.",
        value: "Non-IID data, small/imbalanced site datasets, and fairness risk require subgroup metrics and cautious interpretation.",
        message: "Set challenge profile to non-IID data, small/imbalanced datasets, and fairness risk."
      },
      {
        id: "challenge-infra",
        icon: "check",
        label: "Infrastructure",
        description: "Compute, network, deployment, and communication limits drive workflow design.",
        value: "Compute constraints, network instability, deployment complexity, and communication efficiency must be handled in the workflow plan.",
        message: "Set challenge profile to infrastructure and communication constraints."
      },
      {
        id: "challenge-governance",
        icon: "check",
        label: "Governance",
        description: "Reproducibility, benchmarking, privacy-utility trade-off, incentives, and governance need records.",
        value: "Privacy-utility trade-off, reproducibility, standardized benchmarking, incentive mechanisms, and governance-aware approvals must be documented.",
        message: "Set challenge profile to governance, benchmarking, reproducibility, incentives, and privacy-utility trade-offs."
      }
    ],
    buildCustomMessage: (value) => `Set challenge profile to ${formatAnswerValue(value)}.`
  },
  "allowed synthetic fixtures": {
    key: "syntheticFixtures",
    label: "allowed synthetic fixtures",
    title: "What synthetic test data is allowed?",
    helper: "This constrains the smoke-test fixtures the repository can include for safe validation.",
    input: "text",
    icon: "data",
    defaultValue: "Synthetic numpy arrays for smoke tests only.",
    allowCustom: true,
    curatedOptions: [
      {
        id: "fixtures-numpy",
        icon: "data",
        label: "NumPy smoke test",
        description: "Use tiny synthetic NumPy arrays only for local smoke tests.",
        value: "Synthetic numpy arrays for smoke tests only.",
        message: "Set the allowed synthetic fixtures to synthetic NumPy arrays for smoke tests only."
      },
      {
        id: "fixtures-csv",
        icon: "data",
        label: "Tiny CSV fixture",
        description: "Use a minimal de-identified CSV fixture for parser validation.",
        value: "Tiny synthetic CSV fixtures for parser validation only.",
        message: "Set the allowed synthetic fixtures to tiny synthetic CSV fixtures for parser validation only."
      },
      {
        id: "fixtures-manifest",
        icon: "data",
        label: "Manifest only",
        description: "Keep fixtures limited to metadata and config-shape validation.",
        value: "Manifest-only synthetic fixtures with no model training data.",
        message: "Set the allowed synthetic fixtures to manifest-only synthetic fixtures with no training data."
      }
    ],
    buildCustomMessage: (value) => `Set the allowed synthetic fixtures to ${formatAnswerValue(value)}.`
  },
  "NVFLARE workflow type": {
    key: "nvflareWorkflow",
    label: "NVFLARE workflow type",
    title: "Which NVFLARE workflow should we scaffold?",
    helper: "Choose the runtime pattern so the generated configs and control flow align with the training strategy.",
    input: "select",
    icon: "workflow",
    options: [
      { value: "scatter_and_gather", label: "Scatter and Gather (FedAvg)" },
      { value: "cyclic", label: "Cyclic" }
    ],
    defaultValue: "scatter_and_gather",
    allowCustom: true,
    curatedOptions: [
      {
        id: "workflow-fedavg",
        icon: "workflow",
        label: "Scatter and gather",
        description: "Standard FedAvg style server aggregation between rounds.",
        value: "scatter_and_gather",
        message: "Set the NVFLARE workflow type to scatter and gather."
      },
      {
        id: "workflow-cyclic",
        icon: "workflow",
        label: "Cyclic",
        description: "Pass the model sequentially between sites instead of central aggregation.",
        value: "cyclic",
        message: "Set the NVFLARE workflow type to cyclic."
      },
      {
        id: "workflow-fedavg-release",
        icon: "workflow",
        label: "FedAvg release",
        description: "Use the standard FedAvg workflow with explicit release review steps.",
        value: "scatter_and_gather",
        message: "Set the NVFLARE workflow type to scatter and gather with release review gates."
      }
    ],
    buildCustomMessage: (value) => `Set the NVFLARE workflow type to ${formatAnswerValue(value)}.`
  },
  "minimum clients": {
    key: "minClients",
    label: "minimum clients",
    title: "How many clients are required per round?",
    helper: "Pick the minimum site quorum needed before server aggregation can proceed.",
    input: "number",
    icon: "runtime",
    min: 1,
    defaultValue: 2,
    allowCustom: true,
    curatedOptions: [
      { id: "min-clients-2", icon: "runtime", label: "2 sites", description: "Allow the smallest practical cross-site quorum.", value: 2, message: "Set minimum clients to 2." },
      { id: "min-clients-3", icon: "runtime", label: "3 sites", description: "Require a moderate quorum before aggregation.", value: 3, message: "Set minimum clients to 3." },
      { id: "min-clients-5", icon: "runtime", label: "5 sites", description: "Use a larger quorum for broader site participation.", value: 5, message: "Set minimum clients to 5." }
    ],
    buildCustomMessage: (value) => `Set minimum clients to ${formatAnswerValue(value)}.`
  },
  "federated rounds": {
    key: "numRounds",
    label: "federated rounds",
    title: "How many federated rounds should run?",
    helper: "Set the baseline training length. The runtime config will keep it adjustable later.",
    input: "number",
    icon: "runtime",
    min: 1,
    defaultValue: 5,
    allowCustom: true,
    curatedOptions: [
      { id: "rounds-5", icon: "runtime", label: "5 rounds", description: "Good default for a smoke-test or short pilot.", value: 5, message: "Set federated rounds to 5." },
      { id: "rounds-10", icon: "runtime", label: "10 rounds", description: "Balanced default for a routine training draft.", value: 10, message: "Set federated rounds to 10." },
      { id: "rounds-20", icon: "runtime", label: "20 rounds", description: "Longer training for more stable convergence experiments.", value: 20, message: "Set federated rounds to 20." }
    ],
    buildCustomMessage: (value) => `Set federated rounds to ${formatAnswerValue(value)}.`
  },
  "aggregation behavior": {
    key: "aggregation",
    label: "aggregation behavior",
    title: "How should the server aggregate updates?",
    helper: "Choose the starting aggregation strategy. The generated configs will keep the runtime parameter reviewable.",
    input: "text",
    icon: "workflow",
    defaultValue: "weighted FedAvg",
    placeholder: "weighted FedAvg",
    allowCustom: true,
    curatedOptions: [
      {
        id: "aggregation-weighted-fedavg",
        icon: "workflow",
        label: "Weighted FedAvg",
        description: "Use client-size weighted averaging on the server.",
        value: "weighted FedAvg",
        message: "Set aggregation behavior to weighted FedAvg."
      },
      {
        id: "aggregation-uniform-fedavg",
        icon: "workflow",
        label: "Uniform FedAvg",
        description: "Average client updates without client-size weighting.",
        value: "uniform FedAvg",
        message: "Set aggregation behavior to uniform FedAvg."
      },
      {
        id: "aggregation-fedprox",
        icon: "workflow",
        label: "FedProx-style",
        description: "Keep server aggregation simple but shape the workflow for FedProx local training.",
        value: "FedProx-compatible aggregation",
        message: "Set aggregation behavior to a FedProx-compatible strategy."
      }
    ],
    buildCustomMessage: (value) => `Set aggregation behavior to ${formatAnswerValue(value)}.`
  },
  "output artifacts": {
    key: "artifactOutputs",
    label: "output artifacts",
    title: "Which output artifacts should the pipeline produce?",
    helper: "Choose the review outputs that should always be present after generation and validation.",
    input: "text",
    icon: "artifacts",
    defaultValue: "server.npy, metrics summary, logs, manifest",
    allowCustom: true,
    curatedOptions: [
      {
        id: "artifacts-default",
        icon: "artifacts",
        label: "Model + metrics",
        description: "Return a server checkpoint, metrics summary, logs, and manifest.",
        value: "server.npy, metrics summary, logs, manifest",
        message: "Set output artifacts to server.npy, metrics summary, logs, and manifest."
      },
      {
        id: "artifacts-eval",
        icon: "artifacts",
        label: "Metrics only",
        description: "Focus outputs on evaluation reports and logs.",
        value: "metrics summary, site metrics, logs, manifest",
        message: "Set output artifacts to metrics summaries, site metrics, logs, and manifest."
      },
      {
        id: "artifacts-training-bundle",
        icon: "artifacts",
        label: "Training bundle",
        description: "Return model weights, training diagnostics, and release metadata.",
        value: "server.npy, training diagnostics, logs, manifest, release notes",
        message: "Set output artifacts to model weights, training diagnostics, logs, manifest, and release notes."
      }
    ],
    buildCustomMessage: (value) => `Set output artifacts to ${formatAnswerValue(value)}.`
  },
  "dependency policy": {
    key: "dependencyPolicy",
    label: "dependency policy",
    title: "What dependency policy should the repo follow?",
    helper: "Constrain the generated code to the stack your study can support.",
    input: "select",
    icon: "code",
    options: [
      { value: "Use standard NVFLARE and scikit-learn only.", label: "scikit-learn" },
      { value: "Use standard NVFLARE and PyTorch only.", label: "PyTorch" },
      { value: "Use standard NVFLARE and NumPy only.", label: "NumPy only" }
    ],
    defaultValue: "Use standard NVFLARE and scikit-learn only.",
    allowCustom: true,
    curatedOptions: [
      {
        id: "deps-sklearn",
        icon: "code",
        label: "scikit-learn",
        description: "Stay with classic tabular ML and a lighter dependency set.",
        value: "Use standard NVFLARE and scikit-learn only.",
        message: "Set the dependency policy to standard NVFLARE and scikit-learn only."
      },
      {
        id: "deps-pytorch",
        icon: "code",
        label: "PyTorch",
        description: "Use PyTorch for neural-network or tensor-heavy local training.",
        value: "Use standard NVFLARE and PyTorch only.",
        message: "Set the dependency policy to standard NVFLARE and PyTorch only."
      },
      {
        id: "deps-numpy",
        icon: "code",
        label: "NumPy only",
        description: "Keep the executor to basic numerical processing dependencies.",
        value: "Use standard NVFLARE and NumPy only.",
        message: "Set the dependency policy to standard NVFLARE and NumPy only."
      }
    ],
    buildCustomMessage: (value) => `Set the dependency policy to ${formatAnswerValue(value)}.`
  },
  "privacy constraints": {
    key: "privacyConstraints",
    label: "privacy constraints",
    title: "Which privacy constraints must be enforced?",
    helper: "Choose the guardrails the generated code and docs should repeat consistently.",
    input: "text",
    icon: "privacy",
    defaultValue: "Raw clinical data remains site-local. No patient files in Git.",
    allowCustom: true,
    curatedOptions: [
      {
        id: "privacy-site-local",
        icon: "privacy",
        label: "Site-local only",
        description: "No raw patient data leaves a site and nothing sensitive enters Git.",
        value: "Raw clinical data remains site-local. No patient files in Git.",
        message: "Set privacy constraints so raw clinical data stays site-local and patient files never enter Git."
      },
      {
        id: "privacy-deidentified",
        icon: "privacy",
        label: "De-identified exports",
        description: "Allow only de-identified summary outputs outside the site boundary.",
        value: "Only de-identified aggregate metrics may leave the site. No patient-level data or file paths in Git.",
        message: "Set privacy constraints so only de-identified aggregate metrics may leave the site."
      },
      {
        id: "privacy-strict-review",
        icon: "privacy",
        label: "Strict review gate",
        description: "Require human review before release and forbid raw-data references.",
        value: "Raw clinical data remains site-local. Human release review is required. No raw-data paths in code or Git.",
        message: "Set privacy constraints to enforce site-local data, human release review, and no raw-data paths."
      }
    ],
    buildCustomMessage: (value) => `Set privacy constraints to ${formatAnswerValue(value)}.`
  },
  "privacy & security plan": {
    key: "privacySecurityPlan",
    label: "privacy & security plan",
    title: "Which privacy and security controls are required?",
    helper: "Choose concrete controls the workflow must validate. These are requirements, not claims of approval.",
    input: "textarea",
    icon: "privacy",
    placeholder: "e.g. secure aggregation, signed artifacts, DP after approval, no raw-data paths, threat review.",
    allowCustom: true,
    curatedOptions: [
      {
        id: "privacy-security-secagg",
        icon: "privacy",
        label: "Secure aggregation",
        description: "Use signed artifacts and aggregate updates without exposing individual site updates where supported.",
        value: "Secure aggregation where supported, signed startup kits/artifacts, no raw-data paths, and human review before release.",
        message: "Set privacy & security plan to secure aggregation, signed artifacts, no raw-data paths, and release review."
      },
      {
        id: "privacy-security-dp",
        icon: "privacy",
        label: "DP review",
        description: "Differential privacy is required but budget/noise needs approval.",
        value: "Differential privacy is required, but epsilon/noise budget and utility impact must be approved before execution.",
        message: "Set privacy & security plan to differential privacy with approval of budget and utility trade-off."
      },
      {
        id: "privacy-security-threat",
        icon: "privacy",
        label: "Threat review",
        description: "Explicitly review gradient leakage, poisoning, inference, and malicious-client risks.",
        value: "Threat review must cover gradient leakage, membership inference, poisoning, malicious clients, signed artifacts, and audit logs.",
        message: "Set privacy & security plan to explicit threat review with signed artifacts and audit logs."
      }
    ],
    buildCustomMessage: (value) => `Set privacy & security plan to ${formatAnswerValue(value)}.`
  },
  "approval status": {
    key: "approvalStatus",
    label: "approval status",
    title: "What approval status applies now?",
    helper: "Record whether the work is draft, pending review, or approved for a bounded next step. The agent cannot approve it.",
    input: "select",
    icon: "governance",
    options: [
      { value: "draft", label: "Draft / not approved" },
      { value: "pending-governance-review", label: "Pending governance review" },
      { value: "approved-for-template-development", label: "Approved for template development" },
      { value: "approved-for-synthetic-smoke-test", label: "Approved for synthetic smoke test" }
    ],
    defaultValue: "draft",
    allowCustom: true,
    curatedOptions: [
      {
        id: "approval-draft",
        icon: "governance",
        label: "Draft",
        description: "Planning and template drafting only; no execution approval.",
        value: "draft",
        message: "Set approval status to draft / not approved."
      },
      {
        id: "approval-pending",
        icon: "governance",
        label: "Pending review",
        description: "Governance review is required before workflow freeze or kit release.",
        value: "pending-governance-review",
        message: "Set approval status to pending governance review."
      },
      {
        id: "approval-template",
        icon: "governance",
        label: "Template only",
        description: "Approved for template development, not production execution.",
        value: "approved-for-template-development",
        message: "Set approval status to approved for template development only."
      }
    ],
    buildCustomMessage: (value) => `Set approval status to ${formatAnswerValue(value)}.`
  },
  "validation expectations": {
    key: "reviewExpectations",
    label: "validation expectations",
    title: "What validation checks should always pass?",
    helper: "These checks shape the generated review language and validation expectations for the repository.",
    input: "text",
    icon: "check",
    defaultValue: "README, manifest, NVFLARE job shape, and no raw-data paths must pass.",
    allowCustom: true,
    curatedOptions: [
      {
        id: "validation-default",
        icon: "check",
        label: "Repository basics",
        description: "Check README, manifest, job shape, and raw-data safety.",
        value: "README, manifest, NVFLARE job shape, and no raw-data paths must pass.",
        message: "Set validation expectations to README, manifest, NVFLARE job shape, and raw-data path checks."
      },
      {
        id: "validation-code-review",
        icon: "check",
        label: "Code review ready",
        description: "Add import validity and config consistency checks for review readiness.",
        value: "README, manifest, config consistency, import validity, and no raw-data paths must pass.",
        message: "Set validation expectations to README, manifest, config consistency, import validity, and raw-data path checks."
      },
      {
        id: "validation-runtime",
        icon: "check",
        label: "Runtime smoke test",
        description: "Require repository checks plus a synthetic runtime smoke test.",
        value: "README, manifest, NVFLARE job shape, synthetic smoke test, and no raw-data paths must pass.",
        message: "Set validation expectations to include a synthetic smoke test in addition to repository checks."
      }
    ],
    buildCustomMessage: (value) => `Set validation expectations to ${formatAnswerValue(value)}.`
  }
};
