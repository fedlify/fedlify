import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { controlError, controlRequestContext } from "@/lib/control-api";
import { contentHash } from "@/lib/control-plane";
import { evaluateWorkItemPolicy } from "@/lib/control-enforcement";
import { buildWorkItemSignedPayload } from "@/lib/control-plane-store";
import { json } from "@/lib/json";
import { executeThroughOrchestrator } from "@/lib/orchestrator-client";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ studyId: string; workItemId: string }> };
const bodySchema = z.object({
  profile: z.enum(["hosted", "local"]),
  input: z.unknown(),
  evidence: z.array(z.object({ id: z.string().min(1), content: z.unknown() })).max(100)
});

export async function POST(request: NextRequest, { params }: Params) {
  const { studyId, workItemId } = await params;
  try {
    const context = await controlRequestContext(request, studyId, "runAgent");
    if ("response" in context) return context.response;
    const input = bodySchema.parse(await request.json());
    const workItem = await prisma.workItem.findFirst({ where: { id: workItemId, studyId } });
    if (!workItem || !workItem.signature) throw new Error("Signed work item not found.");
    if (workItem.version !== context.mutation.expectedVersion) throw new Error("Work item version conflict.");
    if (workItem.status !== "SIGNED" || workItem.controlState !== "WORK_ITEM_SIGNED") throw new Error("Work item is not executable.");
    if (workItem.expiresAt && workItem.expiresAt <= new Date()) throw new Error("Work item has expired.");
    if (contentHash(input.input) !== workItem.inputHash) throw new Error("Execution input does not match the signed input hash.");
    const [contract, evidenceRecords] = await Promise.all([
      prisma.skillContract.findUnique({ where: { id: workItem.skillContractId } }),
      prisma.evidenceRecord.findMany({ where: { id: { in: workItem.evidenceIds }, studyId, classification: "CURATED" } })
    ]);
    if (!contract || evidenceRecords.length !== workItem.evidenceIds.length) throw new Error("Signed evidence set is unavailable or no longer curated.");
    if (evidenceRecords.some((record) => record.freshnessExpiresAt && record.freshnessExpiresAt <= new Date())) {
      throw new Error("Signed evidence set contains stale evidence.");
    }
    const supplied = new Map(input.evidence.map((item) => [item.id, item.content]));
    for (const evidence of evidenceRecords) {
      if (!supplied.has(evidence.id) || contentHash(supplied.get(evidence.id)) !== evidence.contentHash) {
        throw new Error(`Evidence hash mismatch for ${evidence.id}.`);
      }
    }
    const executionPolicy = evaluateWorkItemPolicy(
      workItem.purpose,
      evidenceRecords.map((record) => ({ metadata: supplied.get(record.id) }))
    );
    if (!executionPolicy.passed) {
      throw new Error(`Execution evidence policy rejected the request: ${executionPolicy.reasonCodes.join(", ")}.`);
    }
    const signedPayload = buildWorkItemSignedPayload({
      studyId, requestedById: workItem.requestedById, contract, purpose: workItem.purpose,
      inputHash: workItem.inputHash, evidenceIds: workItem.evidenceIds, allowedTools: workItem.allowedTools,
      tokenBudget: workItem.tokenBudget, timeBudgetSeconds: workItem.timeBudgetSeconds, expiresAt: workItem.expiresAt
    });
    const result = await executeThroughOrchestrator({
      profile: input.profile,
      workItem: {
        id: workItem.id, studyId, skillContractId: contract.id, role: contract.role, purpose: workItem.purpose,
        input: input.input, inputHash: workItem.inputHash,
        evidence: evidenceRecords.map((record) => ({ id: record.id, contentHash: record.contentHash, content: supplied.get(record.id) })),
        allowedTools: workItem.allowedTools, tokenBudget: workItem.tokenBudget ?? undefined,
        timeBudgetSeconds: workItem.timeBudgetSeconds ?? undefined, signature: workItem.signature, signedPayload
      }
    });
    await prisma.$transaction([
      prisma.workItem.update({ where: { id: workItem.id }, data: { controlState: "EVIDENCE_ASSEMBLED", status: "RUNNING", startedAt: new Date(), version: { increment: 1 } } }),
      prisma.agentExecution.create({
        data: {
          studyId, workItemId, role: result.execution.role, provider: result.execution.provider ?? input.profile,
          model: result.execution.model, reasoningEffort: result.execution.reasoningEffort,
          promptHash: result.execution.promptHash, evidenceHash: result.execution.evidenceHash ?? contentHash(workItem.evidenceIds),
          outputHash: result.execution.outputHash, stopReason: result.execution.stopReason, completedAt: new Date(),
          inputTokens: result.execution.inputTokens, outputTokens: result.execution.outputTokens,
          verificationStatus: "UNVERIFIED"
        }
      })
    ]);
    await audit({ actorUserId: context.userId, studyId, action: "control.work-item.execute", targetType: "WorkItem", targetId: workItemId, metadata: { profile: input.profile } as Prisma.InputJsonObject, request });
    return json(result);
  } catch (error) {
    return controlError(error);
  }
}
