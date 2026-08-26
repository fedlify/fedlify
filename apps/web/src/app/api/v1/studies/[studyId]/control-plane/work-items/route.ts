import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { controlError, controlRequestContext } from "@/lib/control-api";
import { contentHash } from "@/lib/control-plane";
import { createSignedWorkItem, findMutationReceipt } from "@/lib/control-plane-store";
import { json } from "@/lib/json";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ studyId: string }> };

const contractSchema = z.object({
  contract: z.object({
    name: z.string().trim().min(1).max(200),
    role: z.enum(["COORDINATOR", "WORKER", "SEMANTIC_VERIFIER", "CODEX_WORKER"]),
    requirements: z.array(z.string().regex(/^R(?:0[1-9]|1\d|2\d)$/)).min(1),
    allowedTools: z.array(z.string().min(1)).max(30),
    allowedEvidence: z.array(z.string().min(1)).max(30),
    outputSchema: z.record(z.string(), z.unknown()),
    tokenBudget: z.number().int().positive().optional(),
    timeBudgetSeconds: z.number().int().positive().optional()
  })
});

export async function GET(_request: NextRequest, { params }: Params) {
  const { studyId } = await params;
  const { requireUser } = await import("@/lib/api");
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  try {
    const { assertStudyAccess } = await import("@/lib/rbac");
    await assertStudyAccess(authResult.userId, studyId, "read");
    const [contracts, workItems] = await Promise.all([
      prisma.skillContract.findMany({ where: { studyId, active: true }, orderBy: { createdAt: "desc" } }),
      prisma.workItem.findMany({ where: { studyId }, orderBy: { createdAt: "desc" }, take: 100 })
    ]);
    return json({ contracts, workItems });
  } catch (error) {
    return controlError(error);
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const { studyId } = await params;
  try {
    const context = await controlRequestContext(request, studyId, "runAgent");
    if ("response" in context) return context.response;
    const raw = await request.json();
    const contractRequest = contractSchema.safeParse(raw);
    if (contractRequest.success) {
      const value = contractRequest.data.contract;
      if (context.mutation.expectedVersion !== 1) throw new Error("Skill contract version conflict.");
      const previous = await findMutationReceipt(context.mutation, raw);
      if (previous) return json(previous.response);
      const response = await prisma.$transaction(async (tx) => {
        const latest = await tx.skillContract.aggregate({ where: { studyId, name: value.name }, _max: { version: true } });
        const contract = await tx.skillContract.create({
          data: {
            studyId,
            ...value,
            version: (latest._max.version ?? 0) + 1,
            outputSchema: value.outputSchema as Prisma.InputJsonValue,
            contractHash: contentHash({ studyId, value, version: (latest._max.version ?? 0) + 1 }),
            createdById: context.userId
          }
        });
        const result = { contract };
        await tx.mutationReceipt.create({
          data: {
            studyId,
            actorUserId: context.userId,
            idempotencyKey: context.mutation.idempotencyKey,
            operation: "skill-contract.create",
            requestHash: contentHash(raw),
            targetType: "SkillContract",
            targetId: contract.id,
            response: result as Prisma.InputJsonValue
          }
        });
        return result;
      });
      await audit({ actorUserId: context.userId, studyId, action: "control.skill-contract.create", targetType: "SkillContract", targetId: response.contract.id, request });
      return json(response, { status: 201 });
    }
    const result = await createSignedWorkItem(context.mutation, raw);
    await audit({ actorUserId: context.userId, studyId, action: "control.work-item.create", targetType: "WorkItem", request });
    return json(result, { status: 201 });
  } catch (error) {
    return controlError(error);
  }
}
