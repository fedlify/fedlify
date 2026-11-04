/**
 * Static publish-time checks, ported from deploy/images/study/validate_repo.py so they can run in-process
 * on files read from Gitea. Keep the two in step. NOT covered here (they run only at publish, in CI):
 * Python syntax compilation and the unit tests.
 */

export type RepoFile = {
  path: string;
  content: string;
  /** True when the host could not read the file body (for example Gitea returned no inline content). */
  unreadable?: boolean;
};

export type CheckStatus = "pass" | "fail" | "not_run";

export type RepoCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  errors: string[];
  /** Why a check was not run, shown to the user. */
  note?: string;
};

export type RepoCheckReport = {
  /** True when every check that ran passed. Says nothing about the checks that only run at publish. */
  ok: boolean;
  checks: RepoCheck[];
  errors: string[];
  notice: string;
};

export const REQUIRED_FILES = [
  "fedlify-pipeline.json",
  "client.py",
  "job/meta.conf",
  "job/app/config/config_fed_server.conf",
  "job/app/config/config_fed_client.conf"
];

const DATA_SUFFIXES = new Set([
  ".csv", ".tsv", ".parquet", ".feather", ".sqlite", ".db", ".xlsx", ".xls", ".h5", ".hdf5", ".pkl", ".pickle", ".npz", ".npy"
]);
const DATA_PATH_PATTERNS = [/patients?/i, /clinical[-_ ]?extract/i, /raw[-_ ]?data/i];
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{8,}['"]/i
];
const TEXT_SUFFIXES = new Set([".py", ".json", ".conf", ".yaml", ".yml", ".txt", ".md", ".sh", ".env", ".ini", ".cfg"]);
/** Python str.splitlines() boundaries: \n, \r, \r\n, \v, \f, \x1c-\x1e, \x85, \u2028, \u2029. */
const PY_LINE_BREAKS = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;
/** Identifiers and time-offset columns must never be model features. Keep in step with validate_repo.py. */
const IDENTIFIER_FEATURES = new Set(["patientunitstayid", "patienthealthsystemstayid", "uniquepid"]);
const OFFSET_LIKE = /offset/i;
export function isForbiddenFeatureName(name: string): boolean {
  return IDENTIFIER_FEATURES.has(name.trim().toLowerCase()) || OFFSET_LIKE.test(name);
}
export const LAUNCHER_PATH = "/opt/fedlify/code/";
export const MAX_REPO_BYTES = 20 * 1024 * 1024;

export const CHECKS_NOTICE =
  "These are the static publish rules only. Python syntax and the unit tests run when you publish, not here.";

/** Python's Path.suffix: text after the last dot of the basename, empty for dotfiles such as ".env". */
function suffixOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

function isScannedForSecrets(path: string): boolean {
  if (TEXT_SUFFIXES.has(suffixOf(path))) return true;
  // Stricter than validate_repo.py: also scan dotfiles such as ".env" and ".env.local".
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base === ".env" || base.startsWith(".env.");
}

/** Same rule validate_repo.py applies to every file except README.md and fedlify-pipeline.json. */
export function isDataLikePath(path: string): boolean {
  if (path === "README.md" || path === "fedlify-pipeline.json") return false;
  return DATA_SUFFIXES.has(suffixOf(path)) || DATA_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** True when the file would be scanned and matches a credential pattern. Never returns the matched text. */
export function fileHasSecret(path: string, content: string): boolean {
  return isScannedForSecrets(path) && SECRET_PATTERNS.some((pattern) => pattern.test(content));
}

function isEmptyish(value: unknown): boolean {
  if (value == null || value === false || value === 0 || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function checkRepoFiles(allFiles: RepoFile[]): RepoCheckReport {
  const files = allFiles.filter((file) => !file.path.split("/").includes(".git"));
  const byPath = new Map(files.map((file) => [file.path, file.content]));

  const layout: string[] = [];
  const data: string[] = [];
  const secrets: string[] = [];
  const contract: string[] = [];
  const launcher: string[] = [];
  const requirementsErrors: string[] = [];

  for (const file of files) {
    if (file.unreadable) layout.push(`could not read file contents, so it was not fully checked: ${file.path}`);
  }
  for (const name of REQUIRED_FILES) {
    if (!byPath.has(name)) layout.push(`missing required file: ${name}`);
  }
  const total = files.reduce((sum, file) => sum + new TextEncoder().encode(file.content).length, 0);
  if (total > MAX_REPO_BYTES) {
    layout.push(
      `repository is ${Math.floor(total / 1024)} KB; the limit is ${MAX_REPO_BYTES / 1024} KB (code only, no data or models)`
    );
  }

  for (const file of files) {
    if (file.path === "README.md" || file.path === "fedlify-pipeline.json") continue;
    if (DATA_SUFFIXES.has(suffixOf(file.path)) || DATA_PATH_PATTERNS.some((pattern) => pattern.test(file.path))) {
      data.push(`data-like file is not allowed in a study repository: ${file.path}`);
    }
    if (isScannedForSecrets(file.path)) {
      const hit = SECRET_PATTERNS.find((pattern) => pattern.test(file.content));
      // Report the file and rule only, never the matched text.
      if (hit) secrets.push(`possible credential in ${file.path} (matched ${hit.source.slice(0, 30)}...)`);
    }
  }

  const pipelineJson = byPath.get("fedlify-pipeline.json");
  if (pipelineJson !== undefined) {
    try {
      const config: unknown = JSON.parse(pipelineJson);
      if (!isRecord(config)) {
        contract.push("fedlify-pipeline.json must be a JSON object");
      } else {
        if (config.packageType !== "fedlify-study-pipeline") {
          contract.push('fedlify-pipeline.json: packageType must be "fedlify-study-pipeline"');
        }
        const entrypoint = config.entrypoint === undefined ? "client.py" : config.entrypoint;
        if (typeof entrypoint !== "string" || !byPath.has(entrypoint)) {
          contract.push(`fedlify-pipeline.json: entrypoint ${entrypoint === null ? "None" : String(entrypoint)} does not exist`);
        }
        const dataContract = isRecord(config.dataContract) ? config.dataContract : {};
        if (isEmptyish(dataContract.label) || isEmptyish(dataContract.features)) {
          contract.push("fedlify-pipeline.json: dataContract needs a label and a features list");
        }
        if (Array.isArray(dataContract.features)) {
          for (const feature of dataContract.features) {
            const name = String(feature);
            if (isForbiddenFeatureName(name)) {
              contract.push(`fedlify-pipeline.json: feature ${name} is an identifier or time-offset column and cannot be a model feature`);
            }
          }
        }
      }
    } catch (error) {
      contract.push(`fedlify-pipeline.json is not valid JSON: ${error instanceof Error ? error.message : "parse error"}`);
    }
  }

  const clientConf = byPath.get("job/app/config/config_fed_client.conf");
  if (clientConf !== undefined && !clientConf.includes(LAUNCHER_PATH)) {
    launcher.push(`job client config must launch code from ${LAUNCHER_PATH} (code is baked into the image)`);
  }

  const requirements = byPath.get("requirements.txt");
  if (requirements !== undefined) {
    requirements.split(PY_LINE_BREAKS).forEach((raw, index) => {
      const line = raw.split("#", 1)[0].trim();
      if (line && (!line.includes("==") || /^(-|git\+|http)/.test(line))) {
        requirementsErrors.push(`requirements.txt:${index + 1}: pin an exact version from PyPI (package==x.y.z): ${line}`);
      }
    });
  }

  const ran = (id: string, label: string, errors: string[]): RepoCheck => ({
    id,
    label,
    status: errors.length === 0 ? "pass" : "fail",
    errors
  });
  const checks: RepoCheck[] = [
    ran("layout", "Required files and size", layout),
    ran("data-files", "No data files", data),
    ran("secrets", "No credentials", secrets),
    ran("contract", "Pipeline file and data contract", contract),
    ran("launcher", "Job launches baked-in code", launcher),
    ran("requirements", "Pinned requirements", requirementsErrors),
    {
      id: "python-syntax",
      label: "Python syntax",
      status: "not_run",
      errors: [],
      note: "Runs at publish (needs the Python compiler)."
    },
    { id: "unit-tests", label: "Unit tests", status: "not_run", errors: [], note: "Run only at publish, in CI." }
  ];

  const errors = checks.flatMap((check) => check.errors);
  return { ok: errors.length === 0, checks, errors, notice: CHECKS_NOTICE };
}

// ---- redaction for text that leaves the platform -----------------------------------------------------------

/** Extra patterns used only for redaction (publish checks keep parity with validate_repo.py). */
const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED]"],
  // Credentials embedded in URLs: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]+:[^\s/@'"]+@/gi, "$1[REDACTED]@"],
  // Authorization headers and bare bearer/basic tokens.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/g, "$1 [REDACTED]"],
  // Unquoted or quoted KEY=VALUE / KEY: VALUE where the key names a secret (also FOO_PASSWORD, DB_SECRET_KEY...).
  [
    /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|token|credential|authorization)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(['"]?)[^\s'"#]{4,}\3/gi,
    "$1$2[REDACTED]"
  ],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]"]
];

/** Files whose contents must never be sent to a model provider, whatever the redaction rules say. */
export function isSensitiveFilePath(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (base === ".env" || base.startsWith(".env.") || base.endsWith(".env")) return true;
  if (/\.(pem|key|crt|cer|p12|pfx|jks|keystore|asc|gpg)$/.test(base)) return true;
  return /^(id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|\.netrc|\.npmrc|\.pypirc)$/.test(base);
}

/** Replace anything that looks like a credential before text leaves the platform (e.g. to a model provider). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`), "[REDACTED]");
  }
  for (const [pattern, replacement] of REDACTION_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
