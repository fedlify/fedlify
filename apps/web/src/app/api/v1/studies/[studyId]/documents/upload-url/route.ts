import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { detectRawClinicalData } from "@/lib/policy";
import { json, problem } from "@/lib/json";
import { objectKey, createPresignedUploadUrl } from "@/lib/storage";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

const uploadUrlSchema = z.object({
  filename: z.string().trim().min(1).max(240),
  contentType: z.string().trim().min(3).max(200),
  kind: z.enum(["REQUIREMENTS_PDF", "ETHICS_APPROVAL", "DATA_PROCESSING_AGREEMENT", "SITE_POLICY", "OTHER"])
});

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

  const parsed = uploadUrlSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid upload request.");

  const blockReason = detectRawClinicalData(parsed.data.filename, parsed.data.contentType);
  if (blockReason) return problem(422, blockReason, "raw_data_blocked");

  const key = objectKey(["studies", studyId, "documents", parsed.data.kind.toLowerCase(), `${Date.now()}-${parsed.data.filename}`]);
  const uploadUrl = await createPresignedUploadUrl(key, parsed.data.contentType);

  return json({ storageKey: key, uploadUrl, expiresInSeconds: 600 });
}
