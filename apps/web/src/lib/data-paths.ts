/**
 * Paths that must never enter a pipeline repository: they look like patient data. Pure, so both the server routes
 * and the browser (alignment report, import preview) apply exactly the same rule.
 */
const prohibitedPathPatterns = [/patient/i, /patients/i, /clinical[-_ ]?extract/i, /raw[-_ ]?data/i, /\.csv$/i, /\.parquet$/i];

export function isProhibitedDataPath(filePath: string): boolean {
  if (filePath === "README.md" || filePath === "fedlify-pipeline.json") return false;
  return prohibitedPathPatterns.some((pattern) => pattern.test(filePath));
}
