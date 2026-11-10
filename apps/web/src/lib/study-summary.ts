type SummaryRecord = Record<string, any>;

export type StudySummaryInput = {
  status?: string;
  governanceStatus?: string;
  ethics?: SummaryRecord[];
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

export function protocolReadinessDetail(study: StudySummaryInput) {
  if (studyProtocolReady(study)) return "The study design and ethics decision are complete.";
  if (!studyEthicsReady(study)) return "Record the ethics decision (approved or not required) first.";
  return `Study protocol status: ${displayEnum(study.governanceStatus, "Incomplete")}. Finish the study design, then activate the study.`;
}
