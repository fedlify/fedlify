import { sha256 } from "@/lib/crypto";

/** Read-side helpers for the study audit log: query parsing, secret redaction, export formatting. Pure, no I/O. */

export const AUDIT_PAGE_SIZE_DEFAULT = 25;
export const AUDIT_PAGE_SIZE_MAX = 100;
export const AUDIT_EXPORT_MAX_ROWS = 5000;

export type AuditQuery = {
  page: number;
  pageSize: number;
  actor?: string;
  action?: string;
  targetType?: string;
  target?: string;
  /** A run (NvflareJob id): events about the job, its synced result and its model release. */
  run?: string;
  from?: Date;
  to?: Date;
  format: "page" | "csv" | "json";
};

function clean(value: string | null, max = 200): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseAuditQuery(params: URLSearchParams): AuditQuery {
  const format = params.get("format");
  return {
    page: Math.min(positiveInt(params.get("page"), 1), 100000),
    pageSize: Math.min(positiveInt(params.get("pageSize"), AUDIT_PAGE_SIZE_DEFAULT), AUDIT_PAGE_SIZE_MAX),
    actor: clean(params.get("actor")),
    action: clean(params.get("action")),
    targetType: clean(params.get("targetType")),
    target: clean(params.get("target")),
    run: clean(params.get("run")),
    from: parseDate(params.get("from")),
    to: parseDate(params.get("to")),
    format: format === "csv" || format === "json" ? format : "page"
  };
}

/** Ids an audit event about a run can point at: the job, its synced result, its model release. */
export type RunAuditTargets = { jobId: string; resultId?: string | null; releaseId?: string | null };

export function runAuditClause(targets: RunAuditTargets | null) {
  if (!targets) return { id: { in: [] as string[] } }; // unknown run or a run of another study: match nothing
  const ids = [targets.jobId, targets.resultId, targets.releaseId].filter((id): id is string => Boolean(id));
  return { OR: [{ targetId: { in: ids } }, { metadata: { path: ["jobId"], equals: targets.jobId } }] };
}

export function auditWhere(studyId: string, query: AuditQuery, runTargets?: RunAuditTargets | null) {
  return {
    studyId,
    ...(query.run ? runAuditClause(runTargets ?? null) : {}),
    ...(query.actor ? { actorUserId: query.actor } : {}),
    ...(query.action ? { action: { contains: query.action, mode: "insensitive" as const } } : {}),
    ...(query.targetType ? { targetType: query.targetType } : {}),
    ...(query.target ? { targetId: query.target } : {}),
    ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {})
  };
}

const SECRET_KEY = /(token|secret|password|passphrase|credential|authorization|api[-_]?key|private|cookie|signature|presigned|session|bearer|cert|key$)/i;
const SECRET_VALUE = /(X-Amz-Signature|X-Amz-Credential|-----BEGIN [A-Z ]*PRIVATE KEY|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|:\/\/[^/\s:@]+:[^/\s@]+@)/i;
const REDACTED = "[redacted]";

/** Audit metadata is free-form JSON written by many routes. Mask anything that looks like a secret before it leaves the server. */
export function redactMetadata(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return SECRET_VALUE.test(value) ? REDACTED : value.length > 500 ? `${value.slice(0, 500)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactMetadata(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redactMetadata(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

export type AuditEventRow = {
  id: string;
  createdAt: Date | string;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: unknown;
  actorUserId: string | null;
  actor: { name: string | null; email: string | null } | null;
};

export type AuditEventDto = {
  id: string;
  createdAt: string;
  action: string;
  targetType: string;
  targetId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  metadata: unknown;
};

/** Explicit allowlist of fields: ipHash and userAgent are never returned. */
export function toAuditDto(row: AuditEventRow): AuditEventDto {
  return {
    id: row.id,
    createdAt: new Date(row.createdAt).toISOString(),
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    actorUserId: row.actorUserId,
    actorName: row.actor?.name ?? null,
    actorEmail: row.actor?.email ?? null,
    metadata: redactMetadata(row.metadata)
  };
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  // Neutralise spreadsheet formula injection from user-controlled text.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const AUDIT_CSV_HEADER = ["time", "actor", "actor_email", "action", "target_type", "target_id", "metadata"] as const;

export function auditToCsv(events: AuditEventDto[]): string {
  const lines = [AUDIT_CSV_HEADER.join(",")];
  for (const event of events) {
    lines.push([event.createdAt, event.actorName, event.actorEmail, event.action, event.targetType, event.targetId, event.metadata].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** SHA-256 over the exported events, in order. It identifies this export; it is not a tamper-evident chain. */
export function auditHeadHash(events: AuditEventDto[]): string {
  return sha256(JSON.stringify(events));
}
