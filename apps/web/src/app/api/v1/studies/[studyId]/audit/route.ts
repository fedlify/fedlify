/**
 * GET /api/v1/studies/[studyId]/audit
 *
 * Paged, filterable study audit log. Requires the study "audit" permission (not just "read"). Responses carry
 * redacted metadata only; ipHash and userAgent are never returned. `format=csv|json` exports up to
 * AUDIT_EXPORT_MAX_ROWS matching events with an X-Fedlify-Audit-Head-Hash header, and the export itself is audited.
 */

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { AUDIT_EXPORT_MAX_ROWS, auditHeadHash, auditToCsv, auditWhere, parseAuditQuery, toAuditDto } from "@/lib/audit-query";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

type Params = { params: Promise<{ studyId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "audit");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const query = parseAuditQuery(request.nextUrl.searchParams);
  const where = auditWhere(studyId, query);
  const actorSelect = { actor: { select: { name: true, email: true } } };
  const order = [{ createdAt: "desc" as const }, { id: "desc" as const }];

  if (query.format !== "page") {
    const rows = await prisma.auditEvent.findMany({ where, include: actorSelect, orderBy: order, take: AUDIT_EXPORT_MAX_ROWS + 1 });
    const truncated = rows.length > AUDIT_EXPORT_MAX_ROWS;
    const events = rows.slice(0, AUDIT_EXPORT_MAX_ROWS).map(toAuditDto);
    const headHash = auditHeadHash(events);
    await audit({
      actorUserId: authResult.userId,
      studyId,
      action: "study.audit.export",
      targetType: "Study",
      targetId: studyId,
      metadata: { format: query.format, count: events.length, truncated, headHash },
      request
    });
    const headers = {
      "X-Fedlify-Audit-Head-Hash": headHash,
      "X-Fedlify-Audit-Truncated": String(truncated),
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="audit-${studyId}.${query.format}"`
    };
    if (query.format === "csv") return new Response(auditToCsv(events), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
    return new Response(JSON.stringify({ studyId, headHash, truncated, events }, null, 2), { headers: { ...headers, "Content-Type": "application/json" } });
  }

  const [total, rows, actions, actors] = await Promise.all([
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.findMany({ where, include: actorSelect, orderBy: order, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.auditEvent.groupBy({ by: ["action"], where: { studyId }, orderBy: { action: "asc" }, take: 200 }),
    prisma.auditEvent.groupBy({ by: ["actorUserId"], where: { studyId, actorUserId: { not: null } }, orderBy: { actorUserId: "asc" }, take: 200 })
  ]);
  const actorIds = actors.map((entry) => entry.actorUserId).filter((id): id is string => Boolean(id));
  const users = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } }) : [];

  return json(
    {
      events: rows.map(toAuditDto),
      page: query.page,
      pageSize: query.pageSize,
      total,
      facets: { actions: actions.map((entry) => entry.action), actors: users.map((user) => ({ id: user.id, name: user.name ?? user.email })) }
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
