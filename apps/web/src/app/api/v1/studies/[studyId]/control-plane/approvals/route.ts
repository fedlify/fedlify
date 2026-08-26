import { z } from "zod";
import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { controlError, controlRequestContext } from "@/lib/control-api";
import { bindApproval } from "@/lib/control-plane-store";
import { json } from "@/lib/json";

type Params = { params: Promise<{ studyId: string }> };
const bodySchema = z.object({
  workItemId: z.string().min(1),
  artifactRevisionId: z.string().min(1),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/i),
  expiresAt: z.coerce.date().optional()
});

export async function POST(request: NextRequest, { params }: Params) {
  const { studyId } = await params;
  try {
    const context = await controlRequestContext(request, studyId, "approvePipeline");
    if ("response" in context) return context.response;
    const result = await bindApproval(context.mutation, bodySchema.parse(await request.json()));
    await audit({ actorUserId: context.userId, studyId, action: "control.approval.bind", targetType: "ApprovalBinding", request });
    return json({ approval: result }, { status: 201 });
  } catch (error) {
    return controlError(error);
  }
}
