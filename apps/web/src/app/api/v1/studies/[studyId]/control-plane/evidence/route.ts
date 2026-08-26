import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { controlError, controlRequestContext } from "@/lib/control-api";
import { intakeEvidence } from "@/lib/control-plane-store";
import { json } from "@/lib/json";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ studyId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { studyId } = await params;
  const { requireUser } = await import("@/lib/api");
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  try {
    const { assertStudyAccess } = await import("@/lib/rbac");
    await assertStudyAccess(authResult.userId, studyId, "read");
    const [evidence, quarantine] = await Promise.all([
      prisma.evidenceRecord.findMany({ where: { studyId }, orderBy: { createdAt: "desc" } }),
      prisma.quarantineRecord.findMany({ where: { studyId }, orderBy: { createdAt: "desc" } })
    ]);
    return json({ evidence, quarantine });
  } catch (error) {
    return controlError(error);
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const { studyId } = await params;
  try {
    const context = await controlRequestContext(request, studyId, "uploadDocument");
    if ("response" in context) return context.response;
    const result = await intakeEvidence(context.mutation, await request.json());
    await audit({ actorUserId: context.userId, studyId, action: "control.evidence.intake", targetType: "Evidence", request });
    return json(result, { status: 201 });
  } catch (error) {
    return controlError(error);
  }
}
