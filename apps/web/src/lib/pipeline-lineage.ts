/**
 * Lineage rules for a new pipeline project. Pure, shared by the clone and import routes.
 *
 * sourceKind says how the project started; a parent pipeline (and optionally one of its versions) is only valid for
 * "copy". The routes still have to check that the parent belongs to the study.
 */

export type SourceKind = "template" | "assistant" | "import" | "copy";

export type LineageInput = { sourceKind?: SourceKind; parentProjectId?: string | null; parentVersion?: string | null };
export type LineageResult = { ok: true; sourceKind: SourceKind } | { ok: false; message: string; code: "invalid_lineage" };

const bad = (message: string): LineageResult => ({ ok: false, message, code: "invalid_lineage" });

export function checkLineage(input: LineageInput): LineageResult {
  const { parentProjectId, parentVersion } = input;
  const sourceKind = input.sourceKind ?? (parentProjectId ? "copy" : "template");
  if ((parentProjectId || parentVersion) && sourceKind !== "copy") return bad("A parent pipeline can only be given when copying.");
  if (sourceKind === "copy" && !parentProjectId) return bad("Copying needs the pipeline to copy from.");
  if (parentVersion && !parentProjectId) return bad("A parent version needs a parent pipeline.");
  return { ok: true, sourceKind };
}

/** Whether two commit ids (full or abbreviated, at least 7 characters) name the same commit. */
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || (Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x)));
}
