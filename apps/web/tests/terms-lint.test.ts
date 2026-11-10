/**
 * Vocabulary lint: user-visible strings must not use banned technical terms, except where recorded in
 * tests/terms-allowlist.json. The allowlist can only shrink: exceeding it fails, and so does an allowance that is
 * higher than the real count.
 *
 * Regenerate after removing terms:
 *   cd apps/web && UPDATE_TERMS_ALLOWLIST=1 npx vitest run tests/terms-lint.test.ts
 *   (or: npm run terms:allowlist)
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const ALLOWLIST_PATH = path.join(__dirname, "terms-allowlist.json");

export const BANNED_TERMS = [
  "aggregator",
  "nvflare",
  "startup kit",
  "join package",
  "heartbeat",
  "participant site",
  "participating site",
  "save to main",
  "attestation",
  "machine evidence",
  "source workspace",
  "compose project",
  "gitea",
  "digest",
  "sha256",
  "study image",
  "readiness check"
];

const SKIPPED_ATTRIBUTES = new Set([
  "className", "key", "id", "href", "src", "htmlType", "type", "name", "rel", "target", "style", "role", "size", "variant",
  "status", "color", "placement", "mode", "layout", "direction", "align", "value", "dataIndex", "rowKey", "htmlFor", "autoComplete",
  "icon", "tone", "kind", "tab", "activeKey", "defaultActiveKey", "action", "method", "viewBox", "d", "fill", "stroke"
]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function scannedFiles(): string[] {
  const src = path.join(ROOT, "src");
  const files: string[] = [];
  const appDir = path.join(src, "app", "(app)");
  files.push(...walk(appDir).filter((f) => f.endsWith(".tsx")));
  files.push(...walk(path.join(src, "app", "get-ready")).filter((f) => /\.(tsx|ts)$/.test(f)));
  files.push(...walk(path.join(src, "components")).filter((f) => f.endsWith(".tsx")));
  for (const name of ["pipeline-stage.ts", "site-runtime.ts", "study-summary.ts", "governance.ts", "site-image.ts", "diagnostics.ts", "get-ready.ts"]) files.push(path.join(src, "lib", name));
  return files.sort();
}

function looksLikeCodeString(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith("/") || /^https?:/.test(t) || t.includes("/api/") || t.startsWith("@/") || t.startsWith("./") || t.startsWith("../")) return true;
  if (/^[\w.:/#-]+$/.test(t) && !/^[A-Z][a-z]+$/.test(t)) return true; // identifiers, keys, paths, single words
  return false;
}

/** Collect user-visible text fragments from a source file. */
export function visibleStrings(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];

  function skipLiteral(node: ts.Node): boolean {
    const parent = node.parent;
    if (!parent) return false;
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) return true;
    if (ts.isImportTypeNode(parent) || ts.isLiteralTypeNode(parent)) return true;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
    if (ts.isPropertySignature(parent) || ts.isEnumMember(parent)) return true;
    if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
    if (ts.isCaseClause(parent)) return true;
    if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(parent.operatorToken.kind)) return true;
    if (ts.isJsxAttribute(parent)) {
      const attr = parent.name.getText(sf);
      return SKIPPED_ATTRIBUTES.has(attr) || attr.startsWith("data-") || attr === "aria-controls";
    }
    if (ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent)) {
      const attr = parent.parent.name.getText(sf);
      return SKIPPED_ATTRIBUTES.has(attr) || attr.startsWith("data-");
    }
    if (ts.isCallExpression(parent)) {
      const callee = parent.expression.getText(sf);
      if (/^(require|import|fetch|useState|useRef|URLSearchParams|Object\.keys|\w+\.(get|set|has|delete|append|getAll|includes|startsWith|endsWith|replace|replaceAll|split|test|querySelector|push))$/.test(callee)) return true;
    }
    return false;
  }

  function visit(node: ts.Node) {
    if (ts.isJsxText(node)) {
      const value = node.getText(sf).replace(/\s+/g, " ").trim();
      if (value) found.push(value);
    } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !skipLiteral(node)) {
      if (!looksLikeCodeString(node.text)) found.push(node.text);
    } else if (ts.isTemplateExpression(node) && !skipLiteral(node)) {
      const pieces = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
      if (!looksLikeCodeString(pieces)) found.push(pieces);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

export function countBanned(strings: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of strings) {
    const lower = s.toLowerCase();
    for (const term of BANNED_TERMS) {
      let from = 0;
      for (;;) {
        const at = lower.indexOf(term, from);
        if (at < 0) break;
        counts[term] = (counts[term] ?? 0) + 1;
        from = at + term.length;
      }
    }
  }
  return counts;
}

function scanAll(): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const file of scannedFiles()) {
    const counts = countBanned(visibleStrings(file));
    if (Object.keys(counts).length > 0) result[path.relative(ROOT, file).split(path.sep).join("/")] = counts;
  }
  return result;
}

function sorted(obj: Record<string, Record<string, number>>) {
  return Object.fromEntries(
    Object.keys(obj)
      .sort()
      .map((file) => [file, Object.fromEntries(Object.keys(obj[file]).sort().map((term) => [term, obj[file][term]]))])
  );
}

describe("terms lint", () => {
  const actual = scanAll();

  if (process.env.UPDATE_TERMS_ALLOWLIST === "1") {
    writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(sorted(actual), null, 2)}\n`);
  }

  const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) as Record<string, Record<string, number>>;

  it("scans a non-trivial set of files", () => {
    expect(scannedFiles().length).toBeGreaterThan(10);
  });

  it("does not use banned terms beyond the allowlist", () => {
    const over: string[] = [];
    for (const [file, counts] of Object.entries(actual)) {
      for (const [term, count] of Object.entries(counts)) {
        const allowed = allowlist[file]?.[term] ?? 0;
        if (count > allowed) over.push(`${file}: "${term}" used ${count} times, allowed ${allowed}`);
      }
    }
    expect(over).toEqual([]);
  });

  it("keeps no allowance higher than the real count (the list can only shrink)", () => {
    const stale: string[] = [];
    for (const [file, counts] of Object.entries(allowlist)) {
      for (const [term, allowed] of Object.entries(counts)) {
        const count = actual[file]?.[term] ?? 0;
        if (allowed > count) stale.push(`${file}: "${term}" allowed ${allowed}, real ${count}. Regenerate the allowlist.`);
      }
    }
    expect(stale).toEqual([]);
  });
});
