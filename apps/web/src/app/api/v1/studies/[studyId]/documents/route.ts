import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { detectPhiWarning, detectRawClinicalData } from "@/lib/policy";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

const documentSchema = z.object({
  kind: z.enum(["REQUIREMENTS_PDF", "ETHICS_APPROVAL", "DATA_PROCESSING_AGREEMENT", "SITE_POLICY", "OTHER"]),
  filename: z.string().trim().min(1).max(240),
  contentType: z.string().trim().min(3).max(200),
  sizeBytes: z.number().int().min(1).max(100 * 1024 * 1024),
  storageKey: z.string().trim().min(3).max(1000),
  sha256: z.string().trim().length(64).optional(),
  extractedText: z.string().trim().max(25000).optional()
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

  const documents = await prisma.document.findMany({
    where: { studyId },
    orderBy: { createdAt: "desc" }
  });

  return json({ documents });
}

export async function POST(request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "uploadDocument");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = documentSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid document.");

  const blockReason = detectRawClinicalData(parsed.data.filename, parsed.data.contentType);
  if (blockReason) return problem(422, blockReason, "raw_data_blocked");

  const study = await prisma.study.findUnique({ where: { id: studyId }, select: { orgId: true } });
  if (!study) return problem(404, "Study not found.", "not_found");

  const phiWarnings = detectPhiWarning(parsed.data.extractedText);
  const lastVersion = await prisma.document.findFirst({
    where: { studyId, kind: parsed.data.kind },
    orderBy: { version: "desc" },
    select: { version: true }
  });

  const document = await prisma.document.create({
    data: {
      studyId,
      uploadedById: authResult.userId,
      kind: parsed.data.kind,
      filename: parsed.data.filename,
      contentType: parsed.data.contentType,
      sizeBytes: BigInt(parsed.data.sizeBytes),
      storageKey: parsed.data.storageKey,
      version: (lastVersion?.version ?? 0) + 1,
      sha256: parsed.data.sha256,
      extractedText: parsed.data.extractedText,
      scanStatus: phiWarnings.length > 0 ? "WARNING" : "CLEAN",
      phiWarning: phiWarnings.length > 0
    }
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: study.orgId,
    studyId,
    action: "document.create",
    targetType: "Document",
    targetId: document.id,
    metadata: { kind: document.kind, phiWarning: document.phiWarning, warnings: phiWarnings },
    request
  });

  return json({ document, warnings: phiWarnings }, { status: 201 });
}
