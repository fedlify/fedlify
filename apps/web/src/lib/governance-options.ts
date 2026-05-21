export type GovernanceOption = {
  value: string;
  label: string;
};

export type GovernanceOptionGroup = {
  label: string;
  options: GovernanceOption[];
};

export const DATA_MODALITY_OPTIONS: GovernanceOption[] = [
  { value: "EHR", label: "EHR / structured clinical data" },
  { value: "LABS", label: "Labs" },
  { value: "IMAGING", label: "Medical imaging" },
  { value: "PATHOLOGY", label: "Pathology" },
  { value: "GENOMICS", label: "Genomics / omics" },
  { value: "WAVEFORMS", label: "Waveforms / signals" },
  { value: "NOTES", label: "Clinical notes / text" },
  { value: "CLAIMS", label: "Claims / administrative" },
  { value: "REGISTRY", label: "Registry" },
  { value: "WEARABLES", label: "Wearables / remote monitoring" }
];

export const CLINICAL_USE_CASE_OPTIONS: GovernanceOptionGroup[] = [
  {
    label: "Prediction / Prognosis",
    options: [
      { value: "RISK_PREDICTION", label: "Risk prediction" },
      { value: "DISEASE_PROGRESSION_PREDICTION", label: "Disease progression prediction" },
      { value: "OUTCOME_FORECASTING", label: "Outcome forecasting" },
      { value: "TREATMENT_RESPONSE", label: "Treatment response prediction" },
      { value: "READMISSION_PREDICTION", label: "Readmission prediction" }
    ]
  },
  {
    label: "Diagnosis / Triage",
    options: [
      { value: "DIAGNOSTIC_SUPPORT", label: "Diagnostic support" },
      { value: "IMAGING_TRIAGE", label: "Imaging triage" },
      { value: "CLINICAL_TRIAGE", label: "Clinical triage" },
      { value: "EARLY_WARNING_DETERIORATION", label: "Early warning / deterioration detection" }
    ]
  },
  {
    label: "Treatment / Care Support",
    options: [
      { value: "TREATMENT_PLANNING_SUPPORT", label: "Treatment planning support" },
      { value: "PATIENT_MONITORING", label: "Patient monitoring" },
      { value: "CARE_PATHWAY_OPTIMIZATION", label: "Care pathway optimization" }
    ]
  },
  {
    label: "Cohort / Research",
    options: [
      { value: "COHORT_DISCOVERY", label: "Cohort discovery" },
      { value: "PATIENT_PHENOTYPING", label: "Patient phenotyping" },
      { value: "CLINICAL_TRIAL_MATCHING", label: "Clinical trial matching" }
    ]
  },
  {
    label: "Safety / Surveillance",
    options: [
      { value: "MEDICATION_SAFETY_MONITORING", label: "Medication safety monitoring" },
      { value: "ADVERSE_EVENT_DETECTION", label: "Adverse event detection" },
      { value: "QUALITY_SAFETY", label: "Quality and safety monitoring" }
    ]
  },
  {
    label: "Operations",
    options: [
      { value: "POPULATION_HEALTH_MANAGEMENT", label: "Population health management" },
      { value: "OPERATIONAL_PLANNING", label: "Clinical operations planning" },
      { value: "RESOURCE_ALLOCATION", label: "Resource allocation" },
      { value: "WORKFLOW_AUTOMATION", label: "Workflow automation" },
      { value: "DOCUMENTATION_SUPPORT", label: "Documentation support" }
    ]
  }
];

export const INTENDED_USE_OPTIONS: GovernanceOption[] = [
  { value: "RESEARCH_ONLY", label: "Research only" },
  { value: "RETROSPECTIVE_VALIDATION", label: "Retrospective validation" },
  { value: "PROSPECTIVE_VALIDATION", label: "Prospective validation" },
  { value: "CLINICAL_DECISION_SUPPORT", label: "Clinical decision support" },
  { value: "QUALITY_IMPROVEMENT", label: "Quality improvement" },
  { value: "OPERATIONAL_MONITORING", label: "Operational monitoring" },
  { value: "REGULATORY_EVIDENCE", label: "Regulatory evidence generation" }
];

export function normalizeMultiSelectValue(value: unknown) {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => String(item).trim()).filter(Boolean);
    return normalized.length > 0 ? normalized.join(", ") : undefined;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }

  return undefined;
}

export function normalizeNullableMultiSelectValue(value: unknown) {
  if (value === null) return null;
  return normalizeMultiSelectValue(value);
}

export function splitMultiSelectValue(value?: string | null) {
  if (!value) return [];
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function governanceOptionLabel(options: GovernanceOption[] | GovernanceOptionGroup[], value?: string | null) {
  if (!value) return undefined;
  const flattened = options.flatMap((option) => ("options" in option ? option.options : [option]));
  return flattened.find((option) => option.value === value)?.label ?? value;
}
