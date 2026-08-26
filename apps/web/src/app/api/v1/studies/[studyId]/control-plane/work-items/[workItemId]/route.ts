import { z } from "zod";
import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { controlError, controlRequestContext } from "@/lib/control-api";
import { controlStateSchema } from "@/lib/control-plane";
import { transitionWorkItem } from "@/lib/control-plane-store";
import { json } from "@/lib/json";

type Params = { params: Promise<{ studyId: string; workItemId: string }> };
const bodySchema = z.object({
  targetState: controlStateSchema,
  stopCondition: z.enum([
    "STOP_1_INTAKE", "STOP_2_EVIDENCE", "STOP_3_READINESS", "STOP_4_DETERMINISTIC_VERIFICATION",
    "STOP_5_POLICY", "STOP_6_HUMAN_APPROVAL", "STOP_7_EXPORT_RUNTIME"
  ]).optional()
});

export async function PATCH(request: NextRequest, { params }: Params) {
  const { studyId, workItemId } = await params;
  try {
    const context = await controlRequestContext(request, studyId, "runAgent");
    if ("response" in context) return context.response;
    const input = bodySchema.parse(await request.json());
    const result = await transitionWorkItem(context.mutation, workItemId, input.targetState, input.stopCondition);
    await audit({ actorUserId: context.userId, studyId, action: "control.work-item.transition", targetType: "WorkItem", targetId: workItemId, request });
    return json({ workItem: result });
  } catch (error) {
    return controlError(error);
  }
}
