import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

const ethicsSchema = z.object({
  status: z.enum(["NOT_REQUIRED", "PENDING", "APPROVED", "REJECTED", "EXPIRED"]),
  approvalNumber: z.string().trim().max(200).optional(),
  approvingBody: z.string().trim().max(300).optional(),
  documentId: z.string().optional(),
  validFrom: z.string().datetime().optional(),
  validUntil: z.string().datetime().optional(),
  notes: z.string().trim().max(4000).optional()
});

export async function GET(_request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const approvals = await prisma.ethicsApproval.findMany({
    where: { studyId },
    include: { document: true },
    orderBy: { createdAt: "desc" }
  });

  return json({ approvals, latest: approvals[0] ?? null });
}

export async function POST(request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "manageEthics");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = ethicsSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid ethics approval.");

  const study = await prisma.study.findUnique({ where: { id: studyId }, select: { orgId: true } });
  if (!study) return problem(404, "Study not found.", "not_found");

  if (parsed.data.documentId) {
    const document = await prisma.document.findFirst({
      where: { id: parsed.data.documentId, studyId }
    });
    if (!document) return problem(400, "Ethics document does not belong to this study.", "invalid_document");
  }

  const approval = await prisma.ethicsApproval.create({
    data: {
      studyId,
      status: parsed.data.status,
      approvalNumber: parsed.data.approvalNumber,
      approvingBody: parsed.data.approvingBody,
      documentId: parsed.data.documentId,
      approvedById: parsed.data.status === "APPROVED" || parsed.data.status === "NOT_REQUIRED" ? authResult.userId : null,
      validFrom: parsed.data.validFrom ? new Date(parsed.data.validFrom) : undefined,
      validUntil: parsed.data.validUntil ? new Date(parsed.data.validUntil) : undefined,
      notes: parsed.data.notes
    }
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: study.orgId,
    studyId,
    action: "ethics.record",
    targetType: "EthicsApproval",
    targetId: approval.id,
    metadata: { status: approval.status },
    request
  });

  return json({ approval }, { status: 201 });
}
