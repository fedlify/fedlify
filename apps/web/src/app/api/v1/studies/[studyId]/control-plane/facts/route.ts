import { z } from "zod";
import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { controlError, controlRequestContext } from "@/lib/control-api";
import { confirmProjectFact, proposeProjectFact } from "@/lib/control-plane-store";
import { json } from "@/lib/json";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ studyId: string }> };
const proposeSchema = z.object({ action: z.literal("propose"), key: z.string().trim().min(1).max(200), value: z.unknown(), sourceIds: z.array(z.string()).min(1).max(100), workItemId: z.string().optional() });
const confirmSchema = z.object({ action: z.literal("confirm"), proposalId: z.string().min(1), rationale: z.string().trim().min(3).max(4000) });
const bodySchema = z.discriminatedUnion("action", [proposeSchema, confirmSchema]);

export async function GET(_request: NextRequest, { params }: Params) {
  const { studyId } = await params;
  const { requireUser } = await import("@/lib/api");
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  try {
    const { assertStudyAccess } = await import("@/lib/rbac");
    await assertStudyAccess(authResult.userId, studyId, "read");
    const [facts, proposals, invalidations] = await Promise.all([
      prisma.projectFact.findMany({ where: { studyId }, orderBy: [{ key: "asc" }, { version: "desc" }] }),
      prisma.factProposal.findMany({ where: { studyId, status: "PROPOSED" }, orderBy: { createdAt: "desc" } }),
      prisma.dependencyInvalidation.findMany({ where: { studyId, status: "OPEN" }, orderBy: { detectedAt: "desc" } })
    ]);
    return json({ facts, proposals, invalidations });
  } catch (error) { return controlError(error); }
}

export async function POST(request: NextRequest, { params }: Params) {
  const { studyId } = await params;
  try {
    const input = bodySchema.parse(await request.json());
    const context = await controlRequestContext(request, studyId, input.action === "confirm" ? "approvePipeline" : "runAgent");
    if ("response" in context) return context.response;
    const result = input.action === "confirm"
      ? await confirmProjectFact(context.mutation, input.proposalId, input.rationale)
      : await proposeProjectFact(context.mutation, input);
    await audit({ actorUserId: context.userId, studyId, action: `control.fact.${input.action}`, targetType: input.action === "confirm" ? "ProjectFact" : "FactProposal", request });
    return json(result, { status: input.action === "propose" ? 201 : 200 });
  } catch (error) { return controlError(error); }
}
