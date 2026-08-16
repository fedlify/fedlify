import type { TemplateAgentIntake } from "@/lib/template-agent";

export type FedlifyAgentSkillId =
  | "study_intake_eligibility"
  | "data_readiness_federation_design"
  | "governance_privacy_safety_review"
  | "workflow_planning_orchestration"
  | "template_bound_code_generation"
  | "monitoring_failure_triage"
  | "reproducibility_audit_reporting";

export type FedlifyAgentSkillStatus = "READY" | "WAITING_FOR_INPUT" | "BLOCKED_BY_GUARDRAIL";

export type FedlifyAgentSkillCard = {
  id: FedlifyAgentSkillId;
  title: string;
  trigger: string;
  requiredInputs: Array<keyof TemplateAgentIntake>;
  instruction: string;
  outputs: string[];
  validationChecks: string[];
  guardrails: string[];
  evidenceBasis: string[];
};

export type FedlifyAgentSkillState = {
  id: FedlifyAgentSkillId;
  title: string;
  status: FedlifyAgentSkillStatus;
  missingInputs: string[];
  guardrailFindings: string[];
};

export type FedlifyAgentEvidenceReference = {
  key: string;
  title: string;
  year: number;
  url: string;
  relevance: string;
};

export type FedlifyAgentAspectCard = {
  id:
    | "collaboration_setting"
    | "data_distribution"
    | "data_modality"
    | "system_topology"
    | "privacy_security"
    | "training_strategy"
    | "clinical_application"
    | "disease_category"
    | "challenge_profile";
  title: string;
  whyItMatters: string;
  intakeField: keyof TemplateAgentIntake;
  options: string[];
  agentInstruction: string;
  sampleQuestions: string[];
  sampleStructuredAnswers: string[];
  guidelines: string[];
  evidenceRefs: string[];
};

export const FEDLIFY_AGENT_RUNTIME_CONTRACT = [
  "trigger",
  "required_inputs",
  "agent_instruction",
  "allowed_tools",
  "output_schema",
  "validation_tests",
  "stop_conditions",
  "human_approval_gate",
  "evidence_basis"
] as const;

export const FEDLIFY_AGENT_EVIDENCE: FedlifyAgentEvidenceReference[] = [
  {
    key: "kairouz2021openproblems",
    title: "Advances and Open Problems in Federated Learning",
    year: 2021,
    url: "https://www.emerald.com/ftmal/article/14/1-2/1/1332154/Advances-and-Open-Problems-in-Federated-Learning",
    relevance: "Defines FL as collaborative training over decentralized data and discusses cross-device/cross-silo settings and core technical challenges."
  },
  {
    key: "yang2019fml",
    title: "Federated Machine Learning: Concept and Applications",
    year: 2019,
    url: "https://arxiv.org/abs/1902.04885",
    relevance: "Introduces horizontal FL, vertical FL, and federated transfer learning as a data-distribution taxonomy."
  },
  {
    key: "rieke2020digitalhealth",
    title: "The Future of Digital Health with Federated Learning",
    year: 2020,
    url: "https://www.nature.com/articles/s41746-020-00323-1",
    relevance: "Summarizes health FL opportunities and real-world considerations for moving from research to clinical practice."
  },
  {
    key: "kaissis2020medicalimaging",
    title: "Secure, Privacy-Preserving and Federated Machine Learning in Medical Imaging",
    year: 2020,
    url: "https://www.nature.com/articles/s42256-020-0186-1",
    relevance: "Grounds privacy/security controls and attacks in medical imaging FL."
  },
  {
    key: "lee2024medicalapplications",
    title: "Survey of Medical Applications of Federated Learning",
    year: 2024,
    url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC10879826/",
    relevance: "Categorizes medical FL studies by data type, target disease, datasets, local model, neural network model, heterogeneity, and security."
  },
  {
    key: "edensin2025governance",
    title: "A Scoping Review of the Governance of Federated Learning in Healthcare",
    year: 2025,
    url: "https://www.nature.com/articles/s41746-025-01836-3",
    relevance: "Identifies procedural, relational, and structural governance mechanisms for health FL."
  },
  {
    key: "karimireddy2024fedcompass",
    title: "FedCompass: Efficient Cross-Silo Federated Learning on Heterogeneous Client Devices Using a Computing Power Aware Scheduler",
    year: 2024,
    url: "https://openreview.net/forum?id=msXxrttLOi",
    relevance: "Motivates synchronous, asynchronous, and semi-asynchronous choices for heterogeneous cross-silo deployments."
  },
  {
    key: "ma2023apfl",
    title: "Asynchronous Personalized Federated Learning with Irregular Clients",
    year: 2023,
    url: "https://proceedings.mlr.press/v189/ma23b/ma23b.pdf",
    relevance: "Grounds personalized and asynchronous FL when clients have heterogeneous distributions and participation."
  },
  {
    key: "liu2024structuredhealth",
    title: "Federated Learning in Health Care Using Structured Medical Data",
    year: 2023,
    url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC10208416/",
    relevance: "Reviews FL over structured medical data across multicenter healthcare studies."
  },
  {
    key: "karargyris2024medperf",
    title: "Federated Benchmarking of Medical Artificial Intelligence with MedPerf",
    year: 2024,
    url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC11068064/",
    relevance: "Supports reproducible, controlled federated evaluation and benchmark workflows."
  },
  {
    key: "yu2024publichealth",
    title: "Federated Learning in Public Health: A Systematic Review of Applications, Barriers, and Future Directions",
    year: 2025,
    url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC12607528/",
    relevance: "Documents barriers such as non-IID data, interoperability gaps, compute/network limits, legal pathways, and governance concerns."
  },
  {
    key: "benmalek2025biasfl",
    title: "Bias in Federated Learning: A Comprehensive Survey",
    year: 2025,
    url: "https://dl.acm.org/doi/10.1145/3735125",
    relevance: "Provides a taxonomy of bias sources and mitigation needs in FL."
  }
];

export const FEDLIFY_AGENT_ASPECTS: FedlifyAgentAspectCard[] = [
  {
    id: "collaboration_setting",
    title: "Collaboration setting",
    whyItMatters: "The actor type determines trust assumptions, participation stability, governance model, and whether the workflow resembles cross-silo, cross-device, or hybrid FL.",
    intakeField: "collaborationSetting",
    options: ["cross-silo hospitals", "cross-device wearables", "hybrid"],
    agentInstruction: "Classify who participates, who coordinates, who approves releases, and whether participants are stable organizations or dynamic devices.",
    sampleQuestions: [
      "Are the participants hospitals/research sites, patient devices/wearables, or both?",
      "Which organization coordinates the collaboration and which sites approve participation?"
    ],
    sampleStructuredAnswers: [
      "cross-silo hospitals; two hospitals act as training clients and one academic center coordinates",
      "hybrid; hospital EHR clients plus wearable-device summary streams"
    ],
    guidelines: [
      "Prefer cross-silo when participants are identifiable institutions with stable infrastructure.",
      "Use cross-device only when the study explicitly involves many end-user or wearable devices.",
      "Record coordinator, participant roles, and expected availability before topology or training choices."
    ],
    evidenceRefs: ["kairouz2021openproblems", "rieke2020digitalhealth", "edensin2025governance"]
  },
  {
    id: "data_distribution",
    title: "Data distribution",
    whyItMatters: "Horizontal, vertical, and partial-overlap distributions imply different ID alignment, feature harmonization, privacy, and algorithm requirements.",
    intakeField: "dataDistribution",
    options: ["horizontal: different patients/same features", "vertical: same or overlapping patients/different features", "partial overlap / federated transfer"],
    agentInstruction: "Determine whether sites share feature schema, patient/entity overlap, label definitions, and whether private entity resolution or transfer learning is needed.",
    sampleQuestions: [
      "Do sites have the same feature schema over different patients, different feature sets over overlapping patients, or only partial overlap?",
      "Is a privacy-preserving linkage step needed before learning?"
    ],
    sampleStructuredAnswers: [
      "horizontal; sites use the same tabular feature dictionary and each site has different patients",
      "partial overlap; sites have different features and limited entity overlap, so direct FedAvg is not suitable"
    ],
    guidelines: [
      "Use horizontal FL for standard cross-silo training when sites share schema and label definitions.",
      "Escalate vertical or partial-overlap settings because they need alignment, linkage, or different algorithms.",
      "Do not infer patient overlap from institution names; require explicit metadata."
    ],
    evidenceRefs: ["yang2019fml", "lee2024medicalapplications", "liu2024structuredhealth"]
  },
  {
    id: "data_modality",
    title: "Data modality",
    whyItMatters: "EHR/tabular, imaging, waveform, genomics, text, and wearable data have different loaders, preprocessing, privacy risks, model families, and validation needs.",
    intakeField: "dataModalities",
    options: ["EHR/tabular", "medical imaging", "waveforms", "genomics", "clinical text", "wearables"],
    agentInstruction: "Map modalities to local data contracts, preprocessing assumptions, synthetic fixtures, dependency policy, and validation checks.",
    sampleQuestions: [
      "Which modalities are in scope, and what local format or data dictionary can each site provide?",
      "Are there modality-specific constraints such as DICOM handling, tokenization, variant representation, or wearable sampling?"
    ],
    sampleStructuredAnswers: [
      "EHR/tabular with labs, vitals, demographics, and binary endpoint columns",
      "medical imaging with local DICOM-to-tensor preprocessing; no images leave sites"
    ],
    guidelines: [
      "Require modality-specific schema metadata before code generation.",
      "Use synthetic fixtures only for smoke tests.",
      "Avoid raw-file examples in prompts; use format descriptions and aggregate metadata."
    ],
    evidenceRefs: ["lee2024medicalapplications", "rieke2020digitalhealth", "kaissis2020medicalimaging"]
  },
  {
    id: "system_topology",
    title: "System topology",
    whyItMatters: "Centralized aggregation, peer-to-peer decentralization, and hierarchical aggregation change trust, failure modes, communication, and deployment complexity.",
    intakeField: "systemTopology",
    options: ["centralized aggregation", "decentralized / peer-to-peer", "hierarchical"],
    agentInstruction: "Select topology from trust and infrastructure constraints, then generate only compatible workflow states, networking assumptions, and failure handling.",
    sampleQuestions: [
      "Is a coordinating server acceptable, or must sites exchange updates without a central aggregator?",
      "Do sites need a regional or departmental hierarchy before global aggregation?"
    ],
    sampleStructuredAnswers: [
      "centralized aggregation through the coordinating hospital server",
      "hierarchical aggregation with hospital-level clients grouped by health network"
    ],
    guidelines: [
      "Default to centralized cross-silo aggregation when a trusted coordinator exists.",
      "Use decentralized only when governance rejects a central aggregator or resilience requires peer-to-peer operation.",
      "Use hierarchical when sites naturally cluster by region, institution, or network."
    ],
    evidenceRefs: ["kairouz2021openproblems", "rieke2020digitalhealth", "yu2024publichealth"]
  },
  {
    id: "privacy_security",
    title: "Privacy and security controls",
    whyItMatters: "FL reduces raw data movement but model updates, logs, metadata, and artifacts can still leak sensitive information or be attacked.",
    intakeField: "privacySecurityPlan",
    options: ["secure aggregation", "differential privacy", "homomorphic encryption", "hardware-based trust", "attacks and defenses"],
    agentInstruction: "Identify the privacy/security controls required for the study and convert them into validation checks and stop conditions.",
    sampleQuestions: [
      "Are secure aggregation, differential privacy, homomorphic encryption, or hardware-based trust required by policy?",
      "What attacks must the study consider: gradient leakage, poisoning, inference, membership inference, or malicious clients?"
    ],
    sampleStructuredAnswers: [
      "secure aggregation plus signed startup kits; no raw-data paths in code or prompts",
      "differential privacy requested, but epsilon/noise budget must be approved before execution"
    ],
    guidelines: [
      "Treat privacy controls as explicit requirements, not default assumptions.",
      "Record utility trade-offs and approval status for differential privacy or encryption.",
      "Block release if secrets, identifiers, raw-data paths, or unapproved controls appear."
    ],
    evidenceRefs: ["kaissis2020medicalimaging", "kairouz2021openproblems", "edensin2025governance"]
  },
  {
    id: "training_strategy",
    title: "Training strategy",
    whyItMatters: "Synchronous, asynchronous, semi-asynchronous, and personalized FL respond differently to non-IID data, stragglers, and site heterogeneity.",
    intakeField: "trainingStrategy",
    options: ["synchronous", "asynchronous", "semi-asynchronous", "personalized FL"],
    agentInstruction: "Choose training strategy from participation reliability, compute constraints, non-IID risk, and whether global or site-adapted models are needed.",
    sampleQuestions: [
      "Can all sites participate in every round, or are stragglers/dropouts expected?",
      "Is the desired output one global model, site-personalized models, or both?"
    ],
    sampleStructuredAnswers: [
      "synchronous FedAvg because both hospitals can join every round",
      "personalized FL because sites have different patient populations and local calibration matters"
    ],
    guidelines: [
      "Use synchronous when sites are few, stable, and similarly provisioned.",
      "Use asynchronous or semi-asynchronous when compute/network heterogeneity creates stragglers.",
      "Use personalized FL when non-IID data threatens global-model utility or fairness."
    ],
    evidenceRefs: ["karimireddy2024fedcompass", "ma2023apfl", "kairouz2021openproblems"]
  },
  {
    id: "clinical_application",
    title: "Clinical application",
    whyItMatters: "Diagnosis, prognosis, treatment support, clinical research, and operations have different intended use, risk, outcome definition, validation, and approval paths.",
    intakeField: "clinicalApplication",
    options: ["diagnosis", "prognosis", "treatment support", "clinical research", "hospital operations"],
    agentInstruction: "Classify the intended clinical/research use and constrain the generated workflow to research, evaluation, or operations as approved.",
    sampleQuestions: [
      "Is the workflow for diagnosis, prognosis, treatment support, clinical research, or hospital operations?",
      "Will outputs support research only, retrospective evaluation, or a future clinical workflow?"
    ],
    sampleStructuredAnswers: [
      "prognosis; retrospective readmission-risk research only",
      "clinical research; cohort-level biomarker exploration, not clinical decision support"
    ],
    guidelines: [
      "Do not claim clinical decision support approval from an intake answer.",
      "Record intended use, output users, and whether the output is research-only.",
      "Require stronger validation and governance for treatment-support or diagnosis workflows."
    ],
    evidenceRefs: ["rieke2020digitalhealth", "lee2024medicalapplications", "edensin2025governance"]
  },
  {
    id: "disease_category",
    title: "Disease category",
    whyItMatters: "Disease area drives cohort definition, endpoints, modality choices, sample-size constraints, external validity, and benchmark expectations.",
    intakeField: "diseaseCategory",
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
    ],
    agentInstruction: "Capture disease category as study metadata and use it to guide endpoint wording, validation assumptions, and literature-aware cautions.",
    sampleQuestions: [
      "Which disease category best describes the study?",
      "Are disease-specific endpoints, cohort definitions, or subgroup analyses required?"
    ],
    sampleStructuredAnswers: [
      "cancer and oncology; imaging classification endpoint",
      "critical care; ICU mortality prediction using structured EHR data"
    ],
    guidelines: [
      "Use disease category to guide examples and README wording, not to infer labels.",
      "Ask for disease-specific endpoint definitions instead of inventing clinical outcomes.",
      "Flag rare-disease or small-cohort settings as likely sample-size and fairness risks."
    ],
    evidenceRefs: ["lee2024medicalapplications", "liu2024structuredhealth", "yu2024publichealth"]
  },
  {
    id: "challenge_profile",
    title: "Challenge profile",
    whyItMatters: "Real deployments fail on non-IID data, imbalance, compute, network, deployment complexity, privacy-utility trade-offs, communication, reproducibility, integration, benchmarking, fairness, incentives, and governance.",
    intakeField: "challengeProfile",
    options: [
      "data heterogeneity / non-IID",
      "small or imbalanced datasets",
      "compute constraints",
      "network instability",
      "deployment complexity",
      "privacy-utility trade-off",
      "communication efficiency",
      "reproducibility",
      "clinical workflow integration",
      "standardized benchmarking",
      "fairness and bias mitigation",
      "adaptive FL",
      "incentive mechanisms",
      "governance-aware platform"
    ],
    agentInstruction: "Convert anticipated challenges into workflow checks, warnings, validation tasks, and human approval gates.",
    sampleQuestions: [
      "Which risks are expected: non-IID data, imbalance, compute/network limits, privacy-utility trade-off, fairness, benchmarking, or governance?",
      "Which challenges should block generation and which should become warnings or validation checks?"
    ],
    sampleStructuredAnswers: [
      "non-IID data, small site sample sizes, limited compute, and human release approval required",
      "fairness risk across hospitals; require subgroup metrics and benchmark report"
    ],
    guidelines: [
      "Treat non-IID, small cohorts, and fairness as validation risks rather than code-generation details only.",
      "Surface deployment and network constraints before choosing synchronous training.",
      "Require reproducibility records and benchmark/evaluation plans before reporting results."
    ],
    evidenceRefs: ["kairouz2021openproblems", "yu2024publichealth", "karargyris2024medperf", "benmalek2025biasfl"]
  }
];

export const FEDLIFY_AGENT_SKILLS: FedlifyAgentSkillCard[] = [
  {
    id: "study_intake_eligibility",
    title: "Study intake and eligibility triage",
    trigger: "A researcher starts or resumes a Fedlify study from the chatbot.",
    requiredInputs: [
      "agentRequest",
      "clinicalUseCase",
      "clinicalApplication",
      "diseaseCategory",
      "collaborationSetting",
      "dataModalities",
      "outcomeDefinition",
      "participatingSites",
      "governanceContact"
    ],
    instruction:
      "Extract the study goal, cohort, modality, label/outcome, FL motivation, participating institutions, expected outputs, and missing requirements. Classify the study as ready, incomplete, or not yet suitable for FL.",
    outputs: ["study intake record", "missing information list", "FL suitability status"],
    validationChecks: [
      "research goal is present",
      "clinical or biomedical task is present",
      "at least one data modality is selected",
      "outcome or label definition is present",
      "participating sites are listed",
      "governance contact is named"
    ],
    guardrails: [
      "do not request raw patient records, identifiers, secrets, credentials, or data extracts",
      "collect metadata only",
      "require user confirmation before moving to planning"
    ],
    evidenceBasis: [
      "healthcare FL deployment barriers include organizational and regulatory readiness",
      "human-network coordination is often a bigger deployment blocker than model training code"
    ]
  },
  {
    id: "data_readiness_federation_design",
    title: "Data-readiness and federation design",
    trigger: "Study intake is present and sites describe local data availability.",
    requiredInputs: ["dataDistribution", "dataModalities", "siteLocalInputs", "outcomeDefinition", "dataReadinessSummary", "siteConstraints", "challengeProfile"],
    instruction:
      "Convert site descriptions into a data-readiness matrix. Identify horizontal FL, vertical FL, federated transfer learning, or not-yet-alignable design. Flag non-IID risk, incompatible labels, missing feature definitions, small site sample sizes, and modality constraints.",
    outputs: ["site readiness matrix", "federation design recommendation", "data gap report"],
    validationChecks: [
      "site-local input contract is described",
      "label definition is consistent with the study outcome",
      "data readiness summary names counts/schema/label availability or states why unknown",
      "site constraints are recorded"
    ],
    guardrails: [
      "accept aggregate counts and data dictionaries only",
      "do not infer clinical labels without user approval",
      "do not harmonize variables silently"
    ],
    evidenceBasis: [
      "FL feasibility depends on partition setting, modality, privacy reporting, and heterogeneity",
      "non-IID data and inconsistent labels are recurring cross-site risks"
    ]
  },
  {
    id: "governance_privacy_safety_review",
    title: "Governance, privacy, and safety review",
    trigger: "A workflow is about to be frozen or a site, data source, privacy rule, or execution mode changes.",
    requiredInputs: ["governanceContact", "privacyConstraints", "privacySecurityPlan", "approvalStatus", "siteConstraints", "reviewExpectations"],
    instruction:
      "Map the study to governance requirements, access roles, stakeholder responsibilities, privacy-preserving mechanisms, audit expectations, and unresolved ethics or data-sharing blockers.",
    outputs: ["governance checklist", "privacy and security checklist", "role matrix", "blocker log"],
    validationChecks: [
      "responsible governance contact is present",
      "privacy constraints are explicit",
      "approval status is recorded",
      "review expectations are defined",
      "blockers are surfaced before kit generation"
    ],
    guardrails: [
      "do not waive policy, ethics, privacy, or security requirements",
      "stop progression on unresolved governance blockers",
      "never claim production approval"
    ],
    evidenceBasis: [
      "WHO AI health guidance emphasizes human oversight, transparency, accountability, and data protection",
      "NIST AI RMF emphasizes lifecycle risk management and govern/map/measure/manage controls"
    ]
  },
  {
    id: "workflow_planning_orchestration",
    title: "Workflow planning and orchestration",
    trigger: "Intake, data readiness, and governance checks are complete.",
    requiredInputs: [
      "templateName",
      "collaborationSetting",
      "systemTopology",
      "trainingStrategy",
      "nvflareWorkflow",
      "minClients",
      "numRounds",
      "aggregation",
      "siteConstraints",
      "approvalStatus"
    ],
    instruction:
      "Produce a state machine for collaboration creation, site onboarding, configuration, approval, workflow freeze, kit generation, local execution, aggregation, monitoring, completion, and reporting.",
    outputs: ["workflow plan", "state transition list", "approval checklist", "runbook"],
    validationChecks: [
      "each execution step has an owner",
      "each execution step has a precondition",
      "each execution step has an expected artifact",
      "rollback or escalation path is present"
    ],
    guardrails: [
      "draft plans only until a human approval gate is satisfied",
      "do not mark approvals complete",
      "do not execute production steps from chat"
    ],
    evidenceBasis: [
      "real FL deployments require provisioning, networking, coordination, monitoring, and provenance",
      "workflow orchestration gaps appear in many FL framework comparisons"
    ]
  },
  {
    id: "template_bound_code_generation",
    title: "Template-bound code and configuration generation",
    trigger: "Workflow planning is complete and the user requests code generation.",
    requiredInputs: [
      "templateName",
      "agentRequest",
      "siteLocalInputs",
      "dataDistribution",
      "systemTopology",
      "trainingStrategy",
      "privacySecurityPlan",
      "syntheticFixtures",
      "nvflareWorkflow",
      "aggregation",
      "dependencyPolicy",
      "artifactOutputs",
      "reviewExpectations"
    ],
    instruction:
      "Generate bounded artifacts only: framework configuration, site manifests, container/run instructions, data-loader skeletons, validation scripts, and execution-kit contents from approved templates and explicit user choices.",
    outputs: ["code and configuration bundle", "manifest", "diff-style summary", "validation summary"],
    validationChecks: [
      "repository shape is preserved",
      "manifest is valid JSON",
      "runtime parameters remain configurable",
      "synthetic tests are used for validation",
      "no prohibited data-like paths are present"
    ],
    guardrails: [
      "do not invent new FL algorithms",
      "do not add unapproved dependencies",
      "do not include credentials or patient-level paths",
      "do not release kits without approval"
    ],
    evidenceBasis: [
      "tool-using and ReAct-style agents are more reliable when actions are tool mediated",
      "code generation must be bounded by validation and review"
    ]
  },
  {
    id: "monitoring_failure_triage",
    title: "Monitoring, failure triage, and remediation planning",
    trigger: "Site setup, local execution, aggregation, validation, or deployment reports a status or error.",
    requiredInputs: ["challengeProfile", "reviewExpectations", "siteConstraints", "privacyConstraints", "privacySecurityPlan"],
    instruction:
      "Summarize observed state, classify the failure, identify affected site/stage/artifact, and propose bounded remediation steps. Distinguish infrastructure, configuration, data-readiness, governance, and framework-runtime failures.",
    outputs: ["monitoring summary", "failure classification", "remediation proposal"],
    validationChecks: [
      "observed state is separated from inference",
      "affected site/stage/artifact is identified where available",
      "high-impact remediation requires human confirmation"
    ],
    guardrails: [
      "do not silently retry steps affecting privacy, permissions, data movement, or released artifacts",
      "recommend but do not override site controls"
    ],
    evidenceBasis: [
      "coordination, monitoring, networking, and failure handling remain major barriers in deployed FL"
    ]
  },
  {
    id: "reproducibility_audit_reporting",
    title: "Reproducibility, audit, and report drafting",
    trigger: "Workflow freeze, kit generation, execution, completion, or report drafting occurs.",
    requiredInputs: ["artifactOutputs", "reviewExpectations", "privacyConstraints", "approvalStatus", "clinicalApplication", "diseaseCategory", "challengeProfile"],
    instruction:
      "Record who approved what, which configuration was used, which artifacts were generated, which sites participated, what validation passed, and what outputs were produced. Draft report text from observed evidence only.",
    outputs: ["audit trail", "reproducibility package", "artifact index", "methods/report draft"],
    validationChecks: [
      "artifact outputs are named",
      "review expectations are present",
      "approval status is recorded",
      "generated narrative distinguishes observed facts from recommendations"
    ],
    guardrails: [
      "exclude raw patient data from logs and reports",
      "do not fabricate provenance, approvals, metrics, or results",
      "do not convert unverified summaries into scientific findings"
    ],
    evidenceBasis: [
      "biomedical FL needs traceability, provenance, interoperability, and repeatable workflow records"
    ]
  }
];

const FIELD_LABELS: Partial<Record<keyof TemplateAgentIntake, string>> = {
  agentRequest: "study goal",
  clinicalUseCase: "clinical AI use case",
  clinicalApplication: "clinical application",
  diseaseCategory: "disease category",
  collaborationSetting: "collaboration setting",
  dataDistribution: "data distribution",
  dataModalities: "data modalities",
  outcomeDefinition: "outcome / label definition",
  participatingSites: "participating sites",
  governanceContact: "governance contact",
  dataReadinessSummary: "data readiness summary",
  siteConstraints: "site constraints",
  systemTopology: "system topology",
  privacySecurityPlan: "privacy & security plan",
  trainingStrategy: "training strategy",
  challengeProfile: "challenge profile",
  approvalStatus: "approval status",
  privacyConstraints: "privacy constraints",
  reviewExpectations: "validation expectations",
  siteLocalInputs: "site-local input contract",
  templateName: "template name",
  nvflareWorkflow: "NVFLARE workflow type",
  minClients: "minimum clients",
  numRounds: "federated rounds",
  aggregation: "aggregation behavior",
  syntheticFixtures: "allowed synthetic fixtures",
  dependencyPolicy: "dependency policy",
  artifactOutputs: "output artifacts"
};

const SECRET_OR_IDENTIFIER_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:mrn|medical record number|health card|ssn|sin)\b/i,
  /\b(?:api[_-]?key|secret|password|token|private[_-]?key)\b/i,
  /\b(?:s3|gs|az):\/\/[^\s]+/i,
  /\/(?:Users|home|mnt|data|datasets|patient|patients)\/[^\s]+/i,
  /\b[\w.-]+\.(?:csv|tsv|parquet|xlsx|xls|dcm|nii|nii\.gz)\b/i
];

function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.some((item) => String(item).trim().length > 0);
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "string") return value.trim().length >= 3;
  return value !== null && value !== undefined;
}

function fieldLabel(key: keyof TemplateAgentIntake): string {
  return FIELD_LABELS[key] ?? String(key);
}

export function detectAgentGuardrailFindings(intake: TemplateAgentIntake): string[] {
  const findings: string[] = [];
  for (const [key, value] of Object.entries(intake)) {
    const values = Array.isArray(value) ? value.map(String) : [String(value ?? "")];
    if (values.some((item) => SECRET_OR_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(item)))) {
      findings.push(`${FIELD_LABELS[key as keyof TemplateAgentIntake] ?? key} appears to contain a patient identifier, credential, raw-data path, or data file reference.`);
    }
  }
  return Array.from(new Set(findings));
}

export function evaluateFedlifyAgentSkills(intake: TemplateAgentIntake): FedlifyAgentSkillState[] {
  const guardrailFindings = detectAgentGuardrailFindings(intake);
  return FEDLIFY_AGENT_SKILLS.map((skill) => {
    const missingInputs = skill.requiredInputs.filter((key) => !hasValue(intake[key])).map(fieldLabel);
    return {
      id: skill.id,
      title: skill.title,
      status: guardrailFindings.length > 0 ? "BLOCKED_BY_GUARDRAIL" : missingInputs.length > 0 ? "WAITING_FOR_INPUT" : "READY",
      missingInputs,
      guardrailFindings
    };
  });
}

export function routeNextFedlifyAgentSkill(intake: TemplateAgentIntake): FedlifyAgentSkillState {
  const states = evaluateFedlifyAgentSkills(intake);
  return states.find((state) => state.status !== "READY") ?? states[states.length - 1];
}

export function buildFedlifyAgentSkillContext(intake: TemplateAgentIntake) {
  const states = evaluateFedlifyAgentSkills(intake);
  const nextSkill = states.find((state) => state.status !== "READY") ?? states[states.length - 1];
  return {
    runtimeContract: [...FEDLIFY_AGENT_RUNTIME_CONTRACT],
    nextSkill,
    evidence: FEDLIFY_AGENT_EVIDENCE,
    aspects: FEDLIFY_AGENT_ASPECTS,
    skills: FEDLIFY_AGENT_SKILLS.map((skill) => ({
      id: skill.id,
      title: skill.title,
      trigger: skill.trigger,
      requiredInputs: skill.requiredInputs.map(fieldLabel),
      instruction: skill.instruction,
      outputs: skill.outputs,
      validationChecks: skill.validationChecks,
      guardrails: skill.guardrails,
      evidenceBasis: skill.evidenceBasis
    })),
    states
  };
}

export function fedlifyAgentSkillsMarkdown(): string {
  const aspectText = FEDLIFY_AGENT_ASPECTS.map((aspect) =>
    [
      `## ${aspect.title}`,
      `Why it matters: ${aspect.whyItMatters}`,
      `Options: ${aspect.options.join("; ")}`,
      `Instruction: ${aspect.agentInstruction}`,
      `Sample questions: ${aspect.sampleQuestions.join(" | ")}`,
      `Sample structured answers: ${aspect.sampleStructuredAnswers.join(" | ")}`,
      `Guidelines: ${aspect.guidelines.join("; ")}`,
      `Evidence: ${aspect.evidenceRefs.join(", ")}`
    ].join("\n")
  ).join("\n\n");

  const skillText = FEDLIFY_AGENT_SKILLS.map((skill) =>
    [
      `## ${skill.title}`,
      `Trigger: ${skill.trigger}`,
      `Instruction: ${skill.instruction}`,
      `Outputs: ${skill.outputs.join(", ")}`,
      `Validation: ${skill.validationChecks.join("; ")}`,
      `Guardrails: ${skill.guardrails.join("; ")}`,
      `Evidence basis: ${skill.evidenceBasis.join("; ")}`
    ].join("\n")
  ).join("\n\n");

  return ["# Minimum FL-health taxonomy aspects", aspectText, "# Executable Fedlify skills", skillText].join("\n\n");
}
