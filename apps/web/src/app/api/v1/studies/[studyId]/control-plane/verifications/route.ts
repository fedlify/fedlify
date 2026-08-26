import { z } from "zod";
import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { controlError, controlRequestContext } from "@/lib/control-api";
import { recordVerification } from "@/lib/control-plane-store";
import { json } from "@/lib/json";

type Params = { params: Promise<{ studyId: string }> };
const bodySchema = z.object({
  workItemId: z.string().min(1),
  artifactRevisionId: z.string().min(1),
  kind: z.enum(["DETERMINISTIC", "SEMANTIC"]),
  status: z.enum(["PASSED", "FAILED", "BLOCKED"]),
  verifier: z.string().trim().min(1).max(200),
  checks: z.unknown(),
  findings: z.unknown().optional(),
  modelProfile: z.string().max(200).optional(),
  promptHash: z.string().regex(/^[a-f0-9]{64}$/i).optional()
});

export async function POST(request: NextRequest, { params }: Params) {
  const { studyId } = await params;
  try {
    const context = await controlRequestContext(request, studyId, "runAgent");
    if ("response" in context) return context.response;
    const result = await recordVerification(context.mutation, bodySchema.parse(await request.json()));
    await audit({ actorUserId: context.userId, studyId, action: "control.verification.record", targetType: "VerificationRun", request });
    return json({ verification: result }, { status: 201 });
  } catch (error) {
    return controlError(error);
  }
}
