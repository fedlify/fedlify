import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type SourceRef =
  | { kind: "current"; id: null }
  | { kind: "version"; id: string }
  | { kind: "proposal"; id: string };

export type ReviewSourceFile = {
  path: string;
  content: string;
  language: string;
};

const binaryExtensions = new Set([
  ".7z",
  ".bin",
  ".ckpt",
  ".dmg",
  ".gz",
  ".h5",
  ".jpg",
  ".jpeg",
  ".npy",
  ".onnx",
  ".parquet",
  ".pdf",
  ".png",
  ".pt",
  ".pth",
  ".tar",
  ".zip"
]);

const ignoredSegments = new Set([".git", "__pycache__", ".next", "node_modules"]);

export function parseSourceRef(value?: string | null): SourceRef {
  if (!value || value === "current") return { kind: "current", id: null };
  const [kind, ...rest] = value.split(":");
  const id = rest.join(":").trim();
  if ((kind === "version" || kind === "proposal") && id) return { kind, id };
  return { kind: "current", id: null };
}

export function isLegacyTemplateCommit(value?: string | null): boolean {
  return typeof value === "string" && value.startsWith("legacy-seed-");
}

export function languageForPath(filePath: string): string {
  const basename = path.basename(filePath).toLowerCase();
  const extension = path.extname(filePath).toLowerCase();
  if (basename === "dockerfile") return "dockerfile";
  if (basename === "makefile") return "makefile";
  if (basename === "readme.md" || extension === ".md") return "markdown";
  if (extension === ".py") return "python";
  if (extension === ".ts" || extension === ".tsx") return "typescript";
  if (extension === ".js" || extension === ".jsx" || extension === ".mjs" || extension === ".cjs") return "javascript";
  if (extension === ".json") return "json";
  if (extension === ".yml" || extension === ".yaml") return "yaml";
  if (extension === ".toml") return "toml";
  if (extension === ".conf" || extension === ".cfg" || extension === ".ini" || extension === ".env") return "config";
  if (extension === ".sh") return "shell";
  if (extension === ".sql") return "sql";
  return "text";
}

export function toReviewSourceFiles(files: Array<{ path: string; content: string }>): ReviewSourceFile[] {
  return files
    .filter((file) => file.path && !binaryExtensions.has(path.extname(file.path).toLowerCase()))
    .map((file) => ({ ...file, language: languageForPath(file.path) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function readLocalSourceFiles(root: string, maxFileBytes = 512_000): Promise<ReviewSourceFile[]> {
  const files: Array<{ path: string; content: string }> = [];

  async function walk(directory: string, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (ignoredSegments.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (binaryExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      const info = await stat(absolute);
      if (info.size > maxFileBytes) continue;
      const content = await readFile(absolute, "utf8").catch(() => null);
      if (content !== null) files.push({ path: relative, content });
    }
  }

  await walk(root);
  return toReviewSourceFiles(files);
}
