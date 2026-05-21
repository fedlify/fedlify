import type { EthicsStatus } from "@prisma/client";

const rawDataExtensions = [
  ".csv",
  ".tsv",
  ".parquet",
  ".dcm",
  ".dicom",
  ".nii",
  ".nii.gz",
  ".h5",
  ".hdf5",
  ".sav",
  ".sas7bdat"
];

const phiPatterns = [
  /\b(patient|mrn|medical record|health card|ohip|ssn|sin)\b/i,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b\d{4}[-\s]?\d{3}[-\s]?\d{3}\b/,
  /\b(date of birth|dob)\b/i
];

export function detectRawClinicalData(filename: string, contentType: string): string | null {
  const lower = filename.toLowerCase();
  const matchedExtension = rawDataExtensions.find((extension) => lower.endsWith(extension));
  if (matchedExtension) {
    return `Files ending in ${matchedExtension} look like source clinical data. Fedlify only accepts study metadata, approvals, requirements, and generated artifacts.`;
  }

  if (contentType === "text/csv" || contentType === "application/vnd.apache.parquet") {
    return "This content type looks like tabular or analytic source data. Keep clinical datasets at the hospital site.";
  }

  return null;
}

export function detectPhiWarning(text: string | null | undefined): string[] {
  if (!text) return [];
  return phiPatterns
    .filter((pattern) => pattern.test(text))
    .map((pattern) => `Potential sensitive identifier matched policy pattern: ${pattern.source}`);
}

export function ethicsAllowsRelease(status: EthicsStatus | null | undefined): boolean {
  return status === "APPROVED" || status === "NOT_REQUIRED";
}

export function normalizeEthicsStatus(status: EthicsStatus | null | undefined): EthicsStatus {
  return status ?? "PENDING";
}
