import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sha256 } from "@/lib/crypto";
import { readObject } from "@/lib/storage";
import {
  CONTROL_POLICY_VERSION,
  SIGNING_KEY_ID,
  assertTransition,
  canonicalJson,
  classifyEvidence,
  contentHash,
  createWorkItemSchema,
  evidenceIntakeSchema,
  hasCredentialMaterial,
  metadataForPersistence,
  signControlPayload,
  type ControlState
} from "@/lib/control-plane";
import {
  evidenceBindingHash,
  evaluateApprovalPayload,
  evaluateExportPayload,
  evaluateVerification,
  evaluateWorkItemPolicy
} from "@/lib/control-enforcement";

type MutationContext = {
  studyId: string;
  actorUserId: string;
  idempotencyKey: string;
  expectedVersion: number;
};

async function artifactPayload(storageLocator: string, expectedHash: string): Promise<string> {
  if (!storageLocator.startsWith("s3://")) return "";
  const body = await readObject(storageLocator.slice("s3://".length));
  if (sha256(body) !== expectedHash) throw new Error("Stored artifact content hash does not match its immutable revision.");
  return body.toString("utf8");
}

export async function findMutationReceipt(context: MutationContext, request?: unknown) {
  const receipt = await prisma.mutationReceipt.findUnique({
    where: {
      studyId_actorUserId_idempotencyKey: {
        studyId: context.studyId,
        actorUserId: context.actorUserId,
        idempotencyKey: context.idempotencyKey
      }
    }
  });
  if (receipt && request !== undefined && receipt.requestHash !== contentHash(request)) {
    throw new Error("Idempotency key was already used for a different request.");
  }
  return receipt;
}

async function recordReceipt(
  tx: Prisma.TransactionClient,
  context: MutationContext,
  operation: string,
  request: unknown,
  targetType: string,
  targetId: string,
  response: unknown
) {
  return tx.mutationReceipt.create({
    data: {
      studyId: context.studyId,
      actorUserId: context.actorUserId,
      idempotencyKey: context.idempotencyKey,
      operation,
      requestHash: contentHash(request),
      targetType,
      targetId,
      response: response as Prisma.InputJsonValue
    }
  });
}

export async function intakeEvidence(context: MutationContext, raw: unknown) {
  const input = evidenceIntakeSchema.parse(raw);
  if (context.expectedVersion !== 1) throw new Error("Evidence intake version conflict.");
  const previous = await findMutationReceipt(context, input);
  if (previous) return previous.response;
  const disposition = classifyEvidence(input);
  const persistedSourceLocator = hasCredentialMaterial(input.sourceLocator)
    ? `redacted://${contentHash(input.sourceLocator)}`
    : input.sourceLocator;

  return prisma.$transaction(async (tx) => {
    if (disposition.classification === "QUARANTINED" || disposition.classification === "REJECTED") {
      const quarantine = await tx.quarantineRecord.create({
        data: {
          studyId: context.studyId,
          sourceType: input.sourceType,
          sourceLocator: persistedSourceLocator,
          contentHash: input.contentHash,
          reasonCodes: disposition.reasonCodes,
          metadata: metadataForPersistence(input.metadata) as Prisma.InputJsonValue | undefined,
          quarantinedById: context.actorUserId
        }
      });
      const response = {
        disposition,
        quarantineId: quarantine.id,
        controlState: disposition.classification === "REJECTED" ? "STOPPED" : "QUARANTINED"
      };
      await recordReceipt(tx, context, "evidence.intake", input, "QuarantineRecord", quarantine.id, response);
      return response;
    }

    const evidence = await tx.evidenceRecord.create({
      data: {
        studyId: context.studyId,
        sourceType: input.sourceType,
        sourceLocator: persistedSourceLocator,
        sourceVersion: input.sourceVersion,
        contentHash: input.contentHash,
        classification: disposition.classification,
        freshnessExpiresAt: input.freshnessExpiresAt,
        containsSensitive: input.containsSensitive,
        metadata: metadataForPersistence(input.metadata) as Prisma.InputJsonValue | undefined,
        classifiedById: context.actorUserId
      }
    });
    const response = { disposition, evidenceId: evidence.id, controlState: "CLASSIFIED" };
    await recordReceipt(tx, context, "evidence.intake", input, "EvidenceRecord", evidence.id, response);
    return response;
  });
}

export async function createSignedWorkItem(context: MutationContext, raw: unknown) {
  const input = createWorkItemSchema.parse(raw);
  if (context.expectedVersion !== 1) throw new Error("Work item version conflict.");
  const previous = await findMutationReceipt(context, input);
  if (previous) return previous.response;

  const contract = await prisma.skillContract.findFirst({
    where: { id: input.skillContractId, studyId: context.studyId, active: true }
  });
  if (!contract) throw new Error("Active skill contract not found for this study.");

  const evidence = await prisma.evidenceRecord.findMany({
    where: { id: { in: input.evidenceIds }, studyId: context.studyId }
  });
  if (evidence.length !== input.evidenceIds.length || evidence.some((item) =>
    item.classification !== "CURATED" || (item.freshnessExpiresAt !== null && item.freshnessExpiresAt <= new Date())
  )) {
    throw new Error("A signed work item may reference only curated evidence from the same study.");
  }
  if (input.allowedTools.some((tool) => !contract.allowedTools.includes(tool))) {
    throw new Error("Work item requests a tool outside the selected skill contract.");
  }
  const policy = evaluateWorkItemPolicy(input.purpose, [...evidence, { metadata: input.input }]);
  if (!policy.passed) {
    throw new Error(`Work item policy rejected the request: ${policy.reasonCodes.join(", ")}.`);
  }

  const inputHash = contentHash(input.input);
  const signedPayload = buildWorkItemSignedPayload({
    studyId: context.studyId,
    requestedById: context.actorUserId,
    contract,
    purpose: input.purpose,
    inputHash,
    evidenceIds: input.evidenceIds,
    allowedTools: input.allowedTools,
    tokenBudget: input.tokenBudget ?? contract.tokenBudget,
    timeBudgetSeconds: input.timeBudgetSeconds ?? contract.timeBudgetSeconds,
    expiresAt: input.expiresAt ?? null
  });
  const signature = signControlPayload(signedPayload);

  return prisma.$transaction(async (tx) => {
    const item = await tx.workItem.create({
      data: {
        studyId: context.studyId,
        skillContractId: contract.id,
        requestedById: context.actorUserId,
        idempotencyKey: context.idempotencyKey,
        status: "SIGNED",
        controlState: "WORK_ITEM_SIGNED",
        purpose: input.purpose,
        inputHash,
        evidenceIds: input.evidenceIds,
        allowedTools: input.allowedTools,
        tokenBudget: input.tokenBudget ?? contract.tokenBudget,
        timeBudgetSeconds: input.timeBudgetSeconds ?? contract.timeBudgetSeconds,
        signature,
        signatureKeyId: SIGNING_KEY_ID,
        expiresAt: input.expiresAt
      }
    });
    const response = { workItem: item, signedPayload };
    await recordReceipt(tx, context, "work-item.create", input, "WorkItem", item.id, response);
    return response;
  });
}

export async function transitionWorkItem(
  context: MutationContext,
  workItemId: string,
  targetState: ControlState,
  stopCondition?: string
) {
  const receiptRequest = { targetState, stopCondition };
  const previous = await findMutationReceipt(context, receiptRequest);
  if (previous) return previous.response;
  const item = await prisma.workItem.findFirst({ where: { id: workItemId, studyId: context.studyId } });
  if (!item) throw new Error("Work item not found.");
  if (item.version !== context.expectedVersion) throw new Error("Work item version conflict.");
  assertTransition(item.controlState as ControlState, targetState);
  if (targetState === "HUMAN_APPROVED" || targetState === "EXPORTED") {
    throw new Error("Approval and export require their dedicated platform endpoints.");
  }
  if (["WORKER_COMPLETED", "DETERMINISTIC_VERIFIED", "SEMANTIC_VERIFIED"].includes(targetState)) {
    throw new Error("Worker completion and verification require their dedicated platform endpoints.");
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.workItem.update({
      where: { id: item.id },
      data: {
        controlState: targetState,
        status:
          targetState === "STOPPED" ? "FAILED" : targetState === "WORKER_COMPLETED" ? "COMPLETED" : item.status,
        stopCondition: stopCondition as never,
        version: { increment: 1 },
        startedAt: targetState === "EVIDENCE_ASSEMBLED" ? new Date() : item.startedAt,
        completedAt: targetState === "WORKER_COMPLETED" || targetState === "STOPPED" ? new Date() : item.completedAt
      }
    });
    await recordReceipt(tx, context, "work-item.transition", receiptRequest, "WorkItem", item.id, updated);
    return updated;
  });
}

export async function createArtifactRevision(
  context: MutationContext,
  input: {
    workItemId: string;
    artifactType: string;
    storageLocator: string;
    contentHash: string;
    sourceCommit?: string;
    metadata?: Record<string, unknown>;
  }
) {
  const previous = await findMutationReceipt(context, input);
  if (previous) return previous.response;
  if (hasCredentialMaterial(input)) throw new Error("Artifact metadata contains credential material.");
  const item = await prisma.workItem.findFirst({ where: { id: input.workItemId, studyId: context.studyId } });
  if (!item || item.controlState !== "EVIDENCE_ASSEMBLED") {
    throw new Error("Artifact creation requires an evidence-assembled work item.");
  }
  if (item.version !== context.expectedVersion) throw new Error("Work item version conflict.");
  const latest = await prisma.artifactRevision.aggregate({
    where: { studyId: context.studyId, artifactType: input.artifactType },
    _max: { revision: true }
  });

  return prisma.$transaction(async (tx) => {
    const artifact = await tx.artifactRevision.create({
      data: {
        studyId: context.studyId,
        workItemId: item.id,
        artifactType: input.artifactType,
        revision: (latest._max.revision ?? 0) + 1,
        contentHash: input.contentHash,
        storageLocator: input.storageLocator,
        sourceCommit: input.sourceCommit,
        policyVersion: CONTROL_POLICY_VERSION,
        metadata: metadataForPersistence(input.metadata) as Prisma.InputJsonValue | undefined,
        createdById: context.actorUserId
      }
    });
    await tx.workItem.update({
      where: { id: item.id },
      data: { controlState: "WORKER_COMPLETED", status: "COMPLETED", version: { increment: 1 }, completedAt: new Date() }
    });
    await tx.provenanceEdge.create({
      data: {
        studyId: context.studyId,
        fromType: "WorkItem",
        fromId: item.id,
        fromHash: item.inputHash,
        toType: "ArtifactRevision",
        toId: artifact.id,
        toHash: artifact.contentHash,
        relation: "PRODUCED"
      }
    });
    await recordReceipt(tx, context, "artifact.create", input, "ArtifactRevision", artifact.id, artifact);
    return artifact;
  });
}

export async function recordVerification(
  context: MutationContext,
  input: {
    workItemId: string;
    artifactRevisionId: string;
    kind: "DETERMINISTIC" | "SEMANTIC";
    status: "PASSED" | "FAILED" | "BLOCKED";
    verifier: string;
    checks: unknown;
    findings?: unknown;
    modelProfile?: string;
    promptHash?: string;
  }
) {
  const previous = await findMutationReceipt(context, input);
  if (previous) return previous.response;
  const [item, artifact] = await Promise.all([
    prisma.workItem.findFirst({ where: { id: input.workItemId, studyId: context.studyId } }),
    prisma.artifactRevision.findFirst({ where: { id: input.artifactRevisionId, studyId: context.studyId } })
  ]);
  if (!item || !artifact || artifact.workItemId !== item.id) throw new Error("Work item and artifact do not match.");
  if (item.version !== context.expectedVersion) throw new Error("Work item version conflict.");
  const requiredState = input.kind === "DETERMINISTIC" ? "WORKER_COMPLETED" : "DETERMINISTIC_VERIFIED";
  if (item.controlState !== requiredState) throw new Error(`${input.kind} verification requires ${requiredState}.`);
  const evidence = await prisma.evidenceRecord.findMany({ where: { id: { in: item.evidenceIds }, studyId: context.studyId } });
  const payload = await artifactPayload(artifact.storageLocator, artifact.contentHash);
  const platformDecision = evaluateVerification(input.kind, [...evidence, { metadata: { artifactPayload: payload } }]);
  const platformStatus = platformDecision.passed ? "PASSED" : "FAILED";
  const nextState = platformStatus === "PASSED"
    ? input.kind === "DETERMINISTIC" ? "DETERMINISTIC_VERIFIED" : "SEMANTIC_VERIFIED"
    : "STOPPED";

  return prisma.$transaction(async (tx) => {
    const run = await tx.verificationRun.create({
      data: {
        studyId: context.studyId,
        workItemId: item.id,
        artifactRevisionId: artifact.id,
        kind: input.kind,
        status: platformStatus,
        verifier: `platform:${input.kind.toLowerCase()}:v1`,
        checks: { submitted: input.checks, platformRules: platformDecision.reasonCodes } as Prisma.InputJsonValue,
        findings: platformDecision.findings as Prisma.InputJsonValue,
        inputHash: contentHash({ artifact: artifact.contentHash, evidence: evidence.map(({ contentHash: hash }) => hash) }),
        outputHash: contentHash({ status: platformStatus, findings: platformDecision.findings }),
        modelProfile: input.modelProfile,
        promptHash: input.promptHash,
        startedAt: new Date(),
        completedAt: new Date()
      }
    });
    await tx.workItem.update({
      where: { id: item.id },
      data: {
        controlState: nextState,
        stopCondition: platformStatus === "PASSED" ? null : "STOP_4_DETERMINISTIC_VERIFICATION",
        version: { increment: 1 }
      }
    });
    await recordReceipt(tx, context, "verification.record", input, "VerificationRun", run.id, run);
    return run;
  });
}

export async function bindApproval(
  context: MutationContext,
  input: { workItemId: string; artifactRevisionId: string; evidenceHash: string; expiresAt?: Date }
) {
  const previous = await findMutationReceipt(context, input);
  if (previous) return previous.response;
  const [item, artifact] = await Promise.all([
    prisma.workItem.findFirst({ where: { id: input.workItemId, studyId: context.studyId } }),
    prisma.artifactRevision.findFirst({ where: { id: input.artifactRevisionId, studyId: context.studyId } })
  ]);
  if (!item || !artifact || item.controlState !== "SEMANTIC_VERIFIED") {
    throw new Error("Approval requires a semantically verified work item and matching artifact.");
  }
  if (item.version !== context.expectedVersion) throw new Error("Work item version conflict.");
  if (context.actorUserId === item.requestedById || context.actorUserId === artifact.createdById) {
    throw new Error("Approval separation of duties requires an independent authorized approver.");
  }
  if (input.expiresAt && input.expiresAt <= new Date()) throw new Error("Approval expiry must be in the future.");
  const passedVerifications = await prisma.verificationRun.findMany({
    where: { studyId: context.studyId, artifactRevisionId: artifact.id, status: "PASSED" },
    select: { kind: true }
  });
  const kinds = new Set(passedVerifications.map((verification) => verification.kind));
  if (!kinds.has("DETERMINISTIC") || !kinds.has("SEMANTIC")) {
    throw new Error("Approval requires passed deterministic and semantic verification records for the exact artifact.");
  }
  const evidence = await prisma.evidenceRecord.findMany({ where: { id: { in: item.evidenceIds }, studyId: context.studyId } });
  const approvalDecision = evaluateApprovalPayload(evidence);
  if (!approvalDecision.passed) {
    throw new Error(`Approval policy rejected the request: ${approvalDecision.reasonCodes.join(", ")}.`);
  }
  if (evidence.length !== item.evidenceIds.length || input.evidenceHash !== evidenceBindingHash(evidence)) {
    throw new Error("Approval evidence hash does not match the exact curated evidence bundle.");
  }

  return prisma.$transaction(async (tx) => {
    const binding = await tx.approvalBinding.create({
      data: {
        studyId: context.studyId,
        artifactRevisionId: artifact.id,
        artifactHash: artifact.contentHash,
        sourceCommit: artifact.sourceCommit,
        policyVersion: artifact.policyVersion,
        evidenceHash: input.evidenceHash,
        status: "APPROVED",
        approvedById: context.actorUserId,
        approvedAt: new Date(),
        expiresAt: input.expiresAt
      }
    });
    await tx.workItem.update({ where: { id: item.id }, data: { controlState: "HUMAN_APPROVED", version: { increment: 1 } } });
    await recordReceipt(tx, context, "approval.bind", input, "ApprovalBinding", binding.id, binding);
    return binding;
  });
}

export async function exportApprovedArtifact(
  context: MutationContext,
  input: { workItemId: string; approvalBindingId: string; artifactIds: string[] }
) {
  const previous = await findMutationReceipt(context, input);
  if (previous) return previous.response;
  const [item, approval, artifacts] = await Promise.all([
    prisma.workItem.findFirst({ where: { id: input.workItemId, studyId: context.studyId } }),
    prisma.approvalBinding.findFirst({ where: { id: input.approvalBindingId, studyId: context.studyId } }),
    prisma.artifactRevision.findMany({ where: { id: { in: input.artifactIds }, studyId: context.studyId } })
  ]);
  if (!item || item.controlState !== "HUMAN_APPROVED" || !approval || approval.status !== "APPROVED") {
    throw new Error("Export requires a current human approval binding.");
  }
  if (item.version !== context.expectedVersion) throw new Error("Work item version conflict.");
  if (approval.expiresAt && approval.expiresAt <= new Date()) throw new Error("Approval binding has expired.");
  const invalidation = await prisma.dependencyInvalidation.findFirst({
    where: { studyId: context.studyId, targetType: "ApprovalBinding", targetId: approval.id, status: "OPEN" }
  });
  if (invalidation) throw new Error("Approval binding has an unresolved dependency invalidation.");
  if (artifacts.length !== 1 || input.artifactIds.length !== 1 || artifacts[0]?.id !== approval.artifactRevisionId ||
      artifacts[0].contentHash !== approval.artifactHash || artifacts[0].policyVersion !== approval.policyVersion) {
    throw new Error("Export artifacts do not match the approval binding.");
  }
  const currentEvidenceHash = evidenceBindingHash(await prisma.evidenceRecord.findMany({
    where: { id: { in: item.evidenceIds }, studyId: context.studyId }
  }));
  if (currentEvidenceHash !== approval.evidenceHash) throw new Error("Approval evidence binding no longer matches the work item.");
  const evidence = await prisma.evidenceRecord.findMany({ where: { id: { in: item.evidenceIds }, studyId: context.studyId } });
  const payloads = await Promise.all(artifacts.map((artifact) => artifactPayload(artifact.storageLocator, artifact.contentHash)));
  const exportDecision = evaluateExportPayload({ artifacts, payloads, evidence: evidence.map(({ metadata }) => metadata) });
  if (!exportDecision.passed) {
    throw new Error(`Export inspection rejected the package: ${exportDecision.reasonCodes.join(", ")}.`);
  }
  const manifest = {
    schemaVersion: "1.0",
    studyId: context.studyId,
    approvalBindingId: approval.id,
    policyVersion: approval.policyVersion,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      type: artifact.artifactType,
      revision: artifact.revision,
      sha256: artifact.contentHash,
      sourceCommit: artifact.sourceCommit
    }))
  };
  if (hasCredentialMaterial(manifest)) throw new Error("Credential material detected in export manifest.");
  const manifestHash = contentHash(manifest);
  const signature = signControlPayload(manifest);

  return prisma.$transaction(async (tx) => {
    const exported = await tx.exportManifest.create({
      data: {
        studyId: context.studyId,
        approvalBindingId: approval.id,
        artifactIds: input.artifactIds,
        manifest: manifest as Prisma.InputJsonValue,
        manifestHash,
        signature,
        signatureKeyId: SIGNING_KEY_ID,
        exportedById: context.actorUserId
      }
    });
    await tx.workItem.update({ where: { id: item.id }, data: { controlState: "EXPORTED", version: { increment: 1 } } });
    await recordReceipt(tx, context, "artifact.export", input, "ExportManifest", exported.id, exported);
    return exported;
  });
}

export async function proposeProjectFact(
  context: MutationContext,
  input: { key: string; value: unknown; sourceIds: string[]; workItemId?: string }
) {
  if (context.expectedVersion !== 1) throw new Error("Fact proposal version conflict.");
  const previous = await findMutationReceipt(context, input);
  if (previous) return previous.response;
  const factClassification = classifyEvidence({
    sourceType: "FACT_PROPOSAL",
    sourceLocator: `fact://${contentHash(input.key)}`,
    sourceVersion: CONTROL_POLICY_VERSION,
    contentHash: contentHash(input.value),
    containsSensitive: false,
    metadata: { content: input.value }
  });
  if (["QUARANTINED", "REJECTED"].includes(factClassification.classification) || hasCredentialMaterial(input.value)) {
    throw new Error("Fact proposal contains a prohibited or sensitive input class.");
  }
  const sources = await prisma.evidenceRecord.findMany({
    where: { id: { in: input.sourceIds }, studyId: context.studyId, classification: "CURATED" }
  });
  if (sources.length !== input.sourceIds.length) throw new Error("Fact proposals require curated evidence from the same study.");
  if (input.workItemId) {
    const item = await prisma.workItem.findFirst({ where: { id: input.workItemId, studyId: context.studyId } });
    if (!item) throw new Error("Work item not found.");
  }
  return prisma.$transaction(async (tx) => {
    const proposal = await tx.factProposal.create({
      data: {
        studyId: context.studyId,
        workItemId: input.workItemId,
        key: input.key,
        value: input.value as Prisma.InputJsonValue,
        valueHash: contentHash(input.value),
        sourceIds: input.sourceIds,
        proposedById: context.actorUserId
      }
    });
    await recordReceipt(tx, context, "fact.propose", input, "FactProposal", proposal.id, proposal);
    return proposal;
  });
}

export async function confirmProjectFact(context: MutationContext, proposalId: string, rationale: string) {
  if (context.expectedVersion !== 1) throw new Error("Fact proposal version conflict.");
  const previous = await findMutationReceipt(context, { proposalId, rationale });
  if (previous) return previous.response;
  const proposal = await prisma.factProposal.findFirst({ where: { id: proposalId, studyId: context.studyId, status: "PROPOSED" } });
  if (!proposal) throw new Error("Pending fact proposal not found.");
  if (proposal.proposedById === context.actorUserId) throw new Error("Fact confirmation requires an independent authorized confirmer.");
  if (hasCredentialMaterial(rationale)) throw new Error("Fact confirmation rationale contains credential material.");
  const current = await prisma.projectFact.findFirst({
    where: { studyId: context.studyId, key: proposal.key, status: "CONFIRMED" },
    orderBy: { version: "desc" }
  });
  return prisma.$transaction(async (tx) => {
    if (current) {
      await tx.projectFact.update({ where: { id: current.id }, data: { status: "SUPERSEDED" } });
    }
    const fact = await tx.projectFact.create({
      data: {
        studyId: context.studyId,
        proposalId: proposal.id,
        key: proposal.key,
        value: proposal.value as Prisma.InputJsonValue,
        valueHash: proposal.valueHash,
        sourceIds: proposal.sourceIds,
        version: (current?.version ?? 0) + 1,
        confirmedById: context.actorUserId,
        supersedesId: current?.id
      }
    });
    await tx.factProposal.update({ where: { id: proposal.id }, data: { status: "CONFIRMED", reviewedById: context.actorUserId, reviewedAt: new Date() } });
    const decision = await tx.decisionRecord.create({
      data: {
        studyId: context.studyId,
        decisionType: "CONFIRM_PROJECT_FACT",
        decision: { proposalId: proposal.id, factId: fact.id, key: fact.key, version: fact.version },
        rationale,
        evidenceIds: proposal.sourceIds,
        artifactIds: [],
        decisionHash: contentHash({ proposalId: proposal.id, factId: fact.id, rationale }),
        decidedById: context.actorUserId
      }
    });
    if (current && current.valueHash !== fact.valueHash) {
      const approvals = await tx.approvalBinding.findMany({ where: { studyId: context.studyId, status: "APPROVED" } });
      for (const approval of approvals) {
        await tx.approvalBinding.update({
          where: { id: approval.id },
          data: { status: "INVALIDATED", invalidatedAt: new Date(), invalidationReason: `Confirmed fact ${fact.key} changed.` }
        });
        await tx.dependencyInvalidation.create({
          data: {
            studyId: context.studyId,
            sourceType: "ProjectFact",
            sourceId: fact.id,
            sourceHash: fact.valueHash,
            targetType: "ApprovalBinding",
            targetId: approval.id,
            reason: `Fact ${fact.key} superseded version ${current.version}.`
          }
        });
      }
    }
    const response = { fact, decision };
    await recordReceipt(tx, context, "fact.confirm", { proposalId, rationale }, "ProjectFact", fact.id, response);
    return response;
  });
}

export function verifyWorkItemSignature(payload: unknown, signature: string): boolean {
  return signControlPayload(payload) === signature;
}

export function buildWorkItemSignedPayload(input: {
  studyId: string;
  requestedById: string;
  contract: { id: string; contractHash: string };
  purpose: string;
  inputHash: string;
  evidenceIds: string[];
  allowedTools: string[];
  tokenBudget: number | null | undefined;
  timeBudgetSeconds: number | null | undefined;
  expiresAt: Date | null;
}) {
  return {
    studyId: input.studyId,
    skillContractId: input.contract.id,
    contractHash: input.contract.contractHash,
    requestedById: input.requestedById,
    purpose: input.purpose,
    inputHash: input.inputHash,
    evidenceIds: [...input.evidenceIds].sort(),
    allowedTools: [...input.allowedTools].sort(),
    tokenBudget: input.tokenBudget ?? null,
    timeBudgetSeconds: input.timeBudgetSeconds ?? null,
    expiresAt: input.expiresAt?.toISOString() ?? null
  };
}

export function summarizeAuthoritativeState(value: unknown): string {
  return canonicalJson(value);
}
