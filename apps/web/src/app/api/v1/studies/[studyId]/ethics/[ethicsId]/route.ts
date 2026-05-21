import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

const ethicsSchema = z.object({
  status: z.enum(["NOT_REQUIRED", "PENDING", "APPROVED", "REJECTED", "EXPIRED"]),
  approvalNumber: z.string().trim().max(200).nullable().optional(),
  approvingBody: z.string().trim().max(300).nullable().optional(),
  documentId: z.string().nullable().optional(),
  validFrom: z.string().datetime().nullable().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional()
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ studyId: string; ethicsId: string }> }
) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, ethicsId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "manageEthics");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = ethicsSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid ethics approval.");

  const current = await prisma.ethicsApproval.findFirst({
    where: { id: ethicsId, studyId },
    include: { study: { select: { orgId: true } } }
  });
  if (!current) return problem(404, "Ethics record not found.", "not_found");

  if (parsed.data.documentId) {
    const document = await prisma.document.findFirst({
      where: { id: parsed.data.documentId, studyId }
    });
    if (!document) return problem(400, "Ethics document does not belong to this study.", "invalid_document");
  }

  const approval = await prisma.ethicsApproval.update({
    where: { id: ethicsId },
    data: {
      status: parsed.data.status,
      approvalNumber: parsed.data.approvalNumber !== undefined ? parsed.data.approvalNumber : current.approvalNumber,
      approvingBody: parsed.data.approvingBody !== undefined ? parsed.data.approvingBody : current.approvingBody,
      documentId: parsed.data.documentId !== undefined ? parsed.data.documentId : current.documentId,
      approvedById:
        parsed.data.status === "APPROVED" || parsed.data.status === "NOT_REQUIRED" ? authResult.userId : null,
      validFrom:
        parsed.data.validFrom !== undefined
          ? parsed.data.validFrom
            ? new Date(parsed.data.validFrom)
            : null
          : current.validFrom,
      validUntil:
        parsed.data.validUntil !== undefined
          ? parsed.data.validUntil
            ? new Date(parsed.data.validUntil)
            : null
          : current.validUntil,
      notes: parsed.data.notes !== undefined ? parsed.data.notes : current.notes
    },
    include: { document: true }
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: current.study.orgId,
    studyId,
    action: "ethics.update",
    targetType: "EthicsApproval",
    targetId: approval.id,
    metadata: { previousStatus: current.status, status: approval.status },
    request
  });

  return json({ approval });
}
