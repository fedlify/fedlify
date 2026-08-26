import { z } from "zod";
import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { controlError, controlRequestContext } from "@/lib/control-api";
import { exportApprovedArtifact } from "@/lib/control-plane-store";
import { json } from "@/lib/json";

type Params = { params: Promise<{ studyId: string }> };
const bodySchema = z.object({
  workItemId: z.string().min(1),
  approvalBindingId: z.string().min(1),
  artifactIds: z.array(z.string().min(1)).min(1).max(100)
});

export async function POST(request: NextRequest, { params }: Params) {
  const { studyId } = await params;
  try {
    const context = await controlRequestContext(request, studyId, "approveRelease");
    if ("response" in context) return context.response;
    const result = await exportApprovedArtifact(context.mutation, bodySchema.parse(await request.json()));
    await audit({ actorUserId: context.userId, studyId, action: "control.export.create", targetType: "ExportManifest", request });
    return json({ export: result }, { status: 201 });
  } catch (error) {
    return controlError(error);
  }
}
