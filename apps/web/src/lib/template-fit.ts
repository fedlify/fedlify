/**
 * Template gallery metadata and the deterministic "fit" of a template for a study. Pure: no I/O, no model.
 *
 * The fit only ever states what the study protocol and the sites' data profiles support. Where they do not say
 * (for example a profile with no column list) the answer is "unknown" and the overall fit cannot be "fits".
 * Overall result:
 *   different  the study's data type or outcome type contradicts the template
 *   partial    something is contradicted at some sites, or something relevant is unknown
 *   fits       every check had evidence and every check matched
 */

export type FitStatus = "match" | "mismatch" | "unknown";
export type FitResult = "fits" | "partial" | "different";
export type FitAspect = "data_type" | "task" | "contract_columns" | "sites";

export type FitReason = { aspect: FitAspect; status: FitStatus; message: string; siteCode?: string };

export type FitReport = { fit: FitResult; reasons: FitReason[]; unknownCount: number; mismatchCount: number };

export type TaskKind = "binary_classification" | "regression" | "survival";
export type DataType = "tabular" | "imaging" | "time_series" | "text";

export const TASK_LABELS: Record<TaskKind, string> = {
  binary_classification: "Binary classification",
  regression: "Regression",
  survival: "Survival"
};
export const DATA_TYPE_LABELS: Record<DataType, string> = {
  tabular: "Tabular EHR",
  imaging: "Imaging",
  time_series: "Time series",
  text: "Clinical text"
};

export type ContractSummary = {
  label: string | null;
  positiveValue: string | null;
  featureCount: number;
  features: string[];
  minimumRows: number | null;
  numRounds: number | null;
  minClients: number | null;
};

export type TemplateTraits = {
  task: TaskKind | null;
  algorithm: string | null;
  dataType: DataType | null;
  /** Where each trait came from: written in fedlify-pipeline.json ("declared") or guessed from the name ("inferred"). */
  traitSource: "declared" | "inferred" | "none";
  contract: ContractSummary | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function summarizeContract(pipelineJson: unknown): ContractSummary | null {
  const config = record(pipelineJson);
  if (!config) return null;
  const contract = record(config.dataContract);
  if (!contract) return null;
  const features = Array.isArray(contract.features) ? contract.features.filter((f): f is string => typeof f === "string" && f.trim() !== "") : [];
  const defaults = record(config.runtimeDefaults);
  return {
    label: str(contract.label),
    positiveValue: typeof contract.positiveValue === "string" || typeof contract.positiveValue === "number" ? String(contract.positiveValue) : null,
    featureCount: features.length,
    features,
    minimumRows: num(contract.minimumRows),
    numRounds: num(defaults?.numRounds),
    minClients: num(defaults?.minClients)
  };
}

// ---- classification of free text ---------------------------------------------------------------------------------

/** Data types named in a piece of free text. Empty when the text says nothing recognisable. */
export function dataTypesIn(text: string | null | undefined): Set<DataType> {
  const found = new Set<DataType>();
  const value = (text ?? "").toLowerCase();
  if (!value.trim()) return found;
  if (/\b(tabular|ehr|emr|structured|csv|laboratory|lab results?|claims|registry|demographics|vitals?)\b/.test(value)) found.add("tabular");
  if (/\b(imag(?:e|es|ing)|radiolog\w*|mri|ct scans?|x-?rays?|dicom|pathology slides?|histopatholog\w*|ultrasound)\b/.test(value)) found.add("imaging");
  if (/\b(time[- ]?series|waveforms?|ecg|eeg|telemetry|continuous monitoring|sensor)\b/.test(value)) found.add("time_series");
  if (/\b(clinical notes?|free[- ]?text|nlp|discharge summar\w*|reports? text)\b/.test(value)) found.add("text");
  return found;
}

/** Outcome type implied by a study's primary outcome text; null when it does not say clearly (or says several things). */
export function taskFromOutcome(text: string | null | undefined): TaskKind | null {
  const value = (text ?? "").toLowerCase();
  if (!value.trim()) return null;
  const survival = /\b(time[- ]to[- ]event|time to|survival|hazard|censor\w*|kaplan)\b/.test(value);
  const regression = /\b(length of stay|continuous|regress\w*|change in|level of|score|concentration|duration)\b/.test(value);
  const binary = /\b(mortality|death|died|readmission|readmitted|binary|yes\/no|event within|diagnos\w*|occurrence|incidence|in-hospital|within \d+\s*(?:days?|hours?|months?)|classif\w*)\b/.test(value);
  const hits = [survival, regression, binary].filter(Boolean).length;
  if (hits !== 1) return null;
  return survival ? "survival" : regression ? "regression" : "binary_classification";
}

const TASK_VALUES: Record<string, TaskKind> = {
  binary_classification: "binary_classification",
  "binary classification": "binary_classification",
  classification: "binary_classification",
  regression: "regression",
  survival: "survival"
};
const DATA_TYPE_VALUES: Record<string, DataType> = { tabular: "tabular", imaging: "imaging", time_series: "time_series", "time series": "time_series", timeseries: "time_series", text: "text" };

function algorithmFrom(text: string): string | null {
  const t = text.toLowerCase();
  const strategy = /fedprox/.test(t) ? "FedProx" : /scaffold/.test(t) ? "SCAFFOLD" : /fedavg/.test(t) ? "FedAvg" : null;
  const model = /xgboost|gradient boost/.test(t) ? "histogram XGBoost" : /logistic/.test(t) ? "logistic regression" : /mlp|neural|deep/.test(t) ? "MLP" : /cox/.test(t) ? "Cox model" : null;
  if (strategy && model) return `${strategy} ${model}`;
  return strategy ?? model;
}

/**
 * Template traits. `catalog` in fedlify-pipeline.json (task, algorithm, dataType) is authoritative. Without it the
 * traits are guessed from the name and description, which is marked as "inferred" so the UI can say so.
 */
export function templateTraits(input: { name: string; description?: string | null; pipelineJson: unknown }): TemplateTraits {
  const config = record(input.pipelineJson);
  const catalog = record(config?.catalog);
  const contract = summarizeContract(input.pipelineJson);
  const declaredTask = TASK_VALUES[str(catalog?.task)?.toLowerCase() ?? ""] ?? null;
  const declaredType = DATA_TYPE_VALUES[str(catalog?.dataType)?.toLowerCase() ?? ""] ?? null;
  const declaredAlgorithm = str(catalog?.algorithm);
  if (declaredTask || declaredType || declaredAlgorithm) {
    return { task: declaredTask, dataType: declaredType, algorithm: declaredAlgorithm, traitSource: "declared", contract };
  }
  const text = [input.name, input.description ?? "", str(config?.name) ?? ""].join(" ");
  const task = /survival|cox/i.test(text) ? "survival" : /\bregression\b/i.test(text) && !/logistic/i.test(text) ? "regression" : /mortality|readmission|classif|logistic|binary|xgboost|mlp/i.test(text) ? "binary_classification" : null;
  const types = dataTypesIn(text);
  const dataType = types.size === 1 ? [...types][0] : null;
  const algorithm = algorithmFrom(text);
  const inferred = Boolean(task || dataType || algorithm);
  return { task, dataType, algorithm, traitSource: inferred ? "inferred" : "none", contract };
}

// ---- site profiles -----------------------------------------------------------------------------------------------

export type FitSite = {
  code: string;
  name: string;
  dataProfile?: { modality?: string | null; datasetDescription?: string | null } | null;
};

export type FitStudy = {
  dataModalities?: string | null;
  primaryOutcome?: string | null;
  primaryEndpointDetails?: string | null;
};

/**
 * Column names a site profile lists explicitly, from a line such as "Columns: age, sodium, glucose" (also
 * "Features:" / "Variables:") in the dataset description. Returns undefined when the profile has no such list:
 * nothing is guessed from prose.
 */
export function profileColumns(profile: FitSite["dataProfile"]): string[] | undefined {
  const text = profile?.datasetDescription;
  if (!text) return undefined;
  const match = /(?:^|\n)\s*(?:columns|features|variables|fields)\s*[:=]\s*([^\n]+)/i.exec(text);
  if (!match) return undefined;
  const names = match[1]
    .split(/[,;|]/)
    .map((name) => name.trim().replace(/^[`'"]|[`'"]$/g, ""))
    .filter(Boolean);
  return names.length > 0 ? names : undefined;
}

const norm = (value: string) => value.trim().toLowerCase();

export function computeTemplateFit(study: FitStudy, sites: FitSite[], traits: TemplateTraits): FitReport {
  const reasons: FitReason[] = [];
  const add = (reason: FitReason) => reasons.push(reason);
  let different = false;

  // 1. Data type: the study's stated modalities and each site's profile modality.
  const studyTypes = dataTypesIn(study.dataModalities);
  const perSiteTypes = sites.map((site) => ({ site, types: dataTypesIn(site.dataProfile?.modality) }));
  const allTypes = new Set<DataType>(studyTypes);
  perSiteTypes.forEach(({ types }) => types.forEach((t) => allTypes.add(t)));
  if (!traits.dataType) {
    add({ aspect: "data_type", status: "unknown", message: "The template does not say which data type it is built for." });
  } else if (allTypes.size === 0) {
    add({ aspect: "data_type", status: "unknown", message: `The protocol and site profiles do not name a data type, so ${DATA_TYPE_LABELS[traits.dataType]} cannot be confirmed.` });
  } else if (studyTypes.size > 0 && !studyTypes.has(traits.dataType)) {
    different = true;
    add({
      aspect: "data_type",
      status: "mismatch",
      message: `The protocol names ${[...studyTypes].map((t) => DATA_TYPE_LABELS[t]).join(", ")}; this template is for ${DATA_TYPE_LABELS[traits.dataType]}.`
    });
  } else if (studyTypes.size === 0 && !allTypes.has(traits.dataType)) {
    different = true;
    add({ aspect: "data_type", status: "mismatch", message: `The site profiles name ${[...allTypes].map((t) => DATA_TYPE_LABELS[t]).join(", ")}; this template is for ${DATA_TYPE_LABELS[traits.dataType]}.` });
  } else {
    add({ aspect: "data_type", status: "match", message: `${DATA_TYPE_LABELS[traits.dataType]} data, as named in the ${studyTypes.size > 0 ? "protocol" : "site profiles"}.` });
    for (const { site, types } of perSiteTypes) {
      if (types.size > 0 && !types.has(traits.dataType)) {
        add({ aspect: "sites", status: "mismatch", siteCode: site.code, message: `${site.name} lists ${[...types].map((t) => DATA_TYPE_LABELS[t]).join(", ")} data, not ${DATA_TYPE_LABELS[traits.dataType]}.` });
      }
    }
  }

  // 2. Task: the primary outcome text.
  const studyTask = taskFromOutcome(`${study.primaryOutcome ?? ""} ${study.primaryEndpointDetails ?? ""}`);
  if (!traits.task) {
    add({ aspect: "task", status: "unknown", message: "The template does not say which task it solves." });
  } else if (!studyTask) {
    add({ aspect: "task", status: "unknown", message: `The primary outcome does not clearly say whether it is binary, continuous or time-to-event, so ${TASK_LABELS[traits.task]} cannot be confirmed.` });
  } else if (studyTask !== traits.task) {
    different = true;
    add({ aspect: "task", status: "mismatch", message: `The primary outcome reads as ${TASK_LABELS[studyTask]}; this template does ${TASK_LABELS[traits.task]}.` });
  } else {
    add({ aspect: "task", status: "match", message: `The primary outcome reads as ${TASK_LABELS[traits.task]}, like this template.` });
  }

  // 3. Contract columns, per site, only where the profile lists columns.
  const contract = traits.contract;
  const required = contract ? [...(contract.label ? [contract.label] : []), ...contract.features] : [];
  if (!contract || required.length === 0) {
    add({ aspect: "contract_columns", status: "unknown", message: "The template does not list contract columns to compare." });
  } else if (sites.length === 0) {
    add({ aspect: "contract_columns", status: "unknown", message: "The study has no sites yet, so the contract columns cannot be compared with any data profile." });
  } else {
    const unknownSites: string[] = [];
    let compared = 0;
    for (const site of sites) {
      const columns = profileColumns(site.dataProfile);
      if (!columns) {
        unknownSites.push(site.name);
        continue;
      }
      compared += 1;
      const have = new Set(columns.map(norm));
      const missing = required.filter((name) => !have.has(norm(name)));
      if (missing.length === 0) {
        add({ aspect: "contract_columns", status: "match", siteCode: site.code, message: `${site.name} lists all ${required.length} contract columns.` });
      } else {
        const labelMissing = contract.label ? missing.includes(contract.label) : false;
        add({
          aspect: "contract_columns",
          status: "mismatch",
          siteCode: site.code,
          message: `${missing.length} contract column${missing.length === 1 ? "" : "s"} not in ${site.name}'s profile${labelMissing ? " (including the label)" : ""}: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", ..." : ""}.`
        });
      }
    }
    if (unknownSites.length > 0) {
      add({
        aspect: "contract_columns",
        status: "unknown",
        message: `Unknown for ${unknownSites.slice(0, 4).join(", ")}${unknownSites.length > 4 ? ` and ${unknownSites.length - 4} more` : ""}: ${unknownSites.length === 1 ? "the profile lists" : "their profiles list"} no columns.${compared === 0 ? " Add a \"Columns:\" line to the data profile to compare." : ""}`
      });
    }
  }

  const mismatchCount = reasons.filter((r) => r.status === "mismatch").length;
  const unknownCount = reasons.filter((r) => r.status === "unknown").length;
  const fit: FitResult = different ? "different" : mismatchCount > 0 || unknownCount > 0 ? "partial" : "fits";
  return { fit, reasons, unknownCount, mismatchCount };
}
