import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CONTROL_POLICY_VERSION, contentHash, signControlPayload } from "@/lib/control-plane";
import type { AuthoritativeIntake, CoordinatorAdvisory, IntakeResolution } from "@/lib/control-intake";

export type IntakeMutationContext = {
  studyId: string;
  actorUserId: string;
  idempotencyKey: string;
  expectedVersion: number;
};

type AdvisoryExecution = {
  role: "COORDINATOR";
  provider: string;
  model: string;
  reasoningEffort?: string;
  promptHash: string;
  outputHash: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  durationMs: number;
  stopReason: string;
};

export async function priorIntakeResponse(context: IntakeMutationContext, requestHash: string) {
  const receipt = await prisma.mutationReceipt.findUnique({
    where: { studyId_actorUserId_idempotencyKey: {
      studyId: context.studyId,
      actorUserId: context.actorUserId,
      idempotencyKey: context.idempotencyKey
    } }
  });
  if (!receipt) return null;
  if (receipt.requestHash !== requestHash) throw new Error("Idempotency key was already used for a different request.");
  return receipt.response;
}

export async function actorAuthorityContext(studyId: string, actorUserId: string) {
  const study = await prisma.study.findUnique({ where: { id: studyId }, select: { orgId: true } });
  if (!study) throw new Error("Study not found.");
  const [studyRoles, orgRoles] = await Promise.all([
    prisma.studyMember.findMany({ where: { studyId, userId: actorUserId }, select: { role: true } }),
    prisma.orgMembership.findMany({ where: { orgId: study.orgId, userId: actorUserId, status: "ACTIVE" }, select: { role: true } })
  ]);
  return {
    authenticatedUserId: actorUserId,
    studyRoles: studyRoles.map(({ role }) => role),
    organizationRoles: orgRoles.map(({ role }) => role)
  };
}

export async function persistAuthoritativeIntake(input: {
  context: IntakeMutationContext;
  request: AuthoritativeIntake;
  requestHash: string;
  resolution: IntakeResolution;
  advisory?: CoordinatorAdvisory;
  execution?: AdvisoryExecution;
}) {
  const { context, request, requestHash, resolution, advisory, execution } = input;
  if (context.expectedVersion !== 1) throw new Error("Authoritative intake version conflict.");
  const previous = await priorIntakeResponse(context, requestHash);
  if (previous) return previous;
  const requirements = resolution.requirements;
  const evidenceHash = contentHash(request.attachments.map(({ name, contentHash: hash, sourceVersion }) => ({ name, contentHash: hash, sourceVersion })));
  const stopCondition = resolution.stoppingCondition === "None" ? null : ({
    "1": "STOP_5_POLICY",
    "2": "STOP_6_HUMAN_APPROVAL",
    "3": "STOP_2_EVIDENCE",
    "4": "STOP_1_INTAKE",
    "5": "STOP_3_READINESS",
    "6": "STOP_4_DETERMINISTIC_VERIFICATION",
    "7": "STOP_7_EXPORT_RUNTIME"
  } as const)[resolution.stoppingCondition];

  return prisma.$transaction(async (tx) => {
    let quarantineId: string | null = null;
    if (resolution.controlState === "QUARANTINED") {
      const quarantine = await tx.quarantineRecord.create({
        data: {
          studyId: context.studyId,
          sourceType: "AUTHORITATIVE_INTAKE",
          sourceLocator: `intake://${requestHash}`,
          contentHash: evidenceHash,
          reasonCodes: resolution.reasonCodes,
          metadata: {
            attachments: request.attachments.map(({ name, contentHash: hash, contentType, sourceVersion }) => ({ name, contentHash: hash, contentType, sourceVersion }))
          },
          quarantinedById: context.actorUserId
        }
      });
      quarantineId = quarantine.id;
    }
    const contractName = resolution.selectedContractId;
    let contract = await tx.skillContract.findFirst({ where: { studyId: context.studyId, name: contractName, active: true } });
    if (!contract) {
      const definition = {
        name: contractName,
        role: "COORDINATOR",
        requirements,
        allowedTools: [],
        allowedEvidence: ["HASHED_INTAKE_REFERENCE"],
        outputSchema: { type: "object", required: ["authoritativeLayer", "disposition", "reasonCodes"] },
        tokenBudget: 8_000,
        timeBudgetSeconds: 120
      };
      contract = await tx.skillContract.create({
        data: {
          studyId: context.studyId,
          ...definition,
          outputSchema: definition.outputSchema as Prisma.InputJsonValue,
          contractHash: contentHash({ studyId: context.studyId, policyVersion: CONTROL_POLICY_VERSION, definition }),
          createdById: context.actorUserId
        }
      });
    }

    const signedPayload = {
      studyId: context.studyId,
      requestedById: context.actorUserId,
      skillContractId: contract.id,
      contractHash: contract.contractHash,
      inputHash: requestHash,
      evidenceHash,
      policyVersion: CONTROL_POLICY_VERSION
    };
    const failed = resolution.controlState === "STOPPED" || resolution.controlState === "QUARANTINED";
    const signed = resolution.controlState === "WORK_ITEM_SIGNED" || resolution.controlState === "POLICY_AUTHORIZED";
    const workItem = await tx.workItem.create({
      data: {
        studyId: context.studyId,
        skillContractId: contract.id,
        requestedById: context.actorUserId,
        idempotencyKey: context.idempotencyKey,
        status: failed ? "FAILED" : signed ? "SIGNED" : "COMPLETED",
        controlState: resolution.controlState,
        stopCondition,
        purpose: "Authoritative intake evaluation",
        inputHash: requestHash,
        evidenceIds: [],
        allowedTools: [],
        tokenBudget: contract.tokenBudget,
        timeBudgetSeconds: contract.timeBudgetSeconds,
        signature: signControlPayload(signedPayload),
        signatureKeyId: "fedlify-control-plane-v1",
        startedAt: new Date(),
        completedAt: signed ? null : new Date()
      }
    });

    if (execution) {
      await tx.agentExecution.create({
        data: {
          studyId: context.studyId,
          workItemId: workItem.id,
          role: execution.role,
          provider: execution.provider,
          model: execution.model,
          reasoningEffort: execution.reasoningEffort,
          promptHash: execution.promptHash,
          evidenceHash,
          outputHash: execution.outputHash,
          inputTokens: execution.inputTokens,
          outputTokens: execution.outputTokens,
          stopReason: execution.stopReason,
          verificationStatus: "ADVISORY_ONLY",
          completedAt: new Date()
        }
      });
    }

    const persistedDecision = {
      policyVersion: CONTROL_POLICY_VERSION,
      authoritativeLayer: resolution.authoritativeLayer,
      disposition: resolution.disposition,
      stoppingCondition: resolution.stoppingCondition,
      controlState: resolution.controlState,
      reasonCodes: resolution.reasonCodes,
      requirements,
      selectedContractId: contract.id,
      selectedContractKey: resolution.selectedContractId,
      stateTransition: resolution.stateTransition,
      workItemId: workItem.id,
      inputHash: requestHash,
      evidenceHash,
      modelConsulted: Boolean(advisory),
      quarantineId,
      advisory: advisory ? {
        intent: advisory.intent,
        requirementIds: advisory.requirementIds,
        riskSignals: advisory.riskSignals,
        confidence: advisory.confidence
      } : null,
      execution: execution ? {
        provider: execution.provider,
        model: execution.model,
        reasoningEffort: execution.reasoningEffort,
        promptHash: execution.promptHash,
        outputHash: execution.outputHash,
        inputTokens: execution.inputTokens,
        outputTokens: execution.outputTokens,
        totalTokens: execution.totalTokens,
        durationMs: execution.durationMs,
        stopReason: execution.stopReason
      } : null
    };
    const decision = await tx.decisionRecord.create({
      data: {
        studyId: context.studyId,
        decisionType: "AUTHORITATIVE_INTAKE",
        decision: persistedDecision as Prisma.InputJsonValue,
        rationale: resolution.reasonCodes.join(", ") || "Platform policy authorized bounded progression.",
        evidenceIds: [],
        artifactIds: [],
        decisionHash: contentHash({ studyId: context.studyId, requestHash, persistedDecision }),
        decidedById: context.actorUserId
      }
    });
    const response = { requestId: decision.id, ...persistedDecision };
    await tx.mutationReceipt.create({
      data: {
        studyId: context.studyId,
        actorUserId: context.actorUserId,
        idempotencyKey: context.idempotencyKey,
        operation: "intake.authoritative",
        requestHash,
        targetType: "DecisionRecord",
        targetId: decision.id,
        response: response as Prisma.InputJsonValue
      }
    });
    return response;
  });
}
