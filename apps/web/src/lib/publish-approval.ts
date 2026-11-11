/**
 * The two-person rule at Publish, and the approval record for a published version. Enforced studies only.
 *
 * The rule: one person may accept their own change, but if the person who publishes made changes in this version (accepted
 * an assistant change, or saved by hand) AND the study has two or more people who may publish (approvePipeline), someone
 * else has to publish. A study with a single publisher is never blocked.
 *
 * "In this version" = since the previous published version of this pipeline. Choice of boundary: the creation time of the
 * latest earlier version that actually published (publishedAt set), compared with the time a change was accepted
 * (AgentProposal.decidedAt) or saved (the audit event of the Save route). Ancestry by commit was not used: the code host
 * is not asked here, force-pushes and squashes can break ancestry, and a failed earlier publish must not shorten the window.
 * A version's creation time is the moment its commit was frozen, so everything accepted or saved after it belongs to the next one.
 * Shared versions: if the publisher made changes AND another approver also made changes in the same version, the rule does not
 * refuse (otherwise two people who each changed something would lock each other out). The binding is still marked self-approved.
 * Accepted proposals are found by status and decision time only (not by acceptedCommit): the commit id is written after the
 * commit lands and a failed write must not hide a self-accepted change. "Active" approver = holds a study role with
 * approvePipeline, the same test the Publish permission uses.
 * Manual saves are read from the audit log (action pipeline_project.save, actor and project), which the Save route writes
 * after every save that changed something. Saves made by other tools are not seen.
 */

import { prisma } from "@/lib/prisma";
import { contentHash } from "@/lib/control-plane";
import { CONTROL_POLICY_VERSION } from "@/lib/control-plane";
import { createRevision } from "@/lib/assistant-artifacts";
import { roleCan } from "@/lib/rbac";
import { joinNames } from "@/lib/preflight";
import type { Prisma } from "@prisma/client";

export const PUBLISH_ARTIFACT_TYPE = "published_pipeline_version";
const SAVE_ACTION = "pipeline_project.save";

export type SecondApproverCheck = {
  /** The study has two or more people who may publish. */
  active: boolean;
  /** The publisher made changes in this version and another approver exists: they may not publish it. */
  required: boolean;
  approverCount: number;
  others: Array<{ id: string; name: string }>;
  selfChanges: { proposalIds: string[]; manualSaves: number };
  /** Another approver also changed this version (accepted a change or saved by hand), so the publisher is not alone on it. */
  othersChanged: boolean;
  acceptedProposals: Array<{ id: string; artifactRevisionId: string | null; acceptedById: string | null }>;
  windowStart: Date | null;
};

export async function evaluateSecondApprover(input: { studyId: string; projectId: string; publisherId: string; publisherCanApprove?: boolean; excludeVersionId?: string | null }): Promise<SecondApproverCheck> {
  const { studyId, projectId, publisherId } = input;
  // Names only: another member's email address is never put in a message or checklist.
  const members = await prisma.studyMember.findMany({ where: { studyId }, include: { user: { select: { id: true, name: true } } } });
  const approvers = new Map<string, string>();
  for (const member of members) {
    if (roleCan(member.role, "approvePipeline") && member.user) approvers.set(member.userId, member.user.name?.trim() || "another approver");
  }
  const publisherCounts = input.publisherCanApprove !== false;
  const ids = new Set(approvers.keys());
  if (publisherCounts) ids.add(publisherId);
  const others = [...approvers.entries()].filter(([id]) => id !== publisherId).map(([id, name]) => ({ id, name }));

  const previous = await prisma.pipelineVersion.findFirst({
    where: { projectId, publishedAt: { not: null }, ...(input.excludeVersionId ? { id: { not: input.excludeVersionId } } : {}) },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true }
  });
  const windowStart = previous?.createdAt ?? null;
  const accepted = await prisma.agentProposal.findMany({
    where: { projectId, status: "ACCEPTED", ...(windowStart ? { decidedAt: { gt: windowStart } } : {}) },
    select: { id: true, artifactRevisionId: true, acceptedById: true }
  });
  const manualSaves = await prisma.auditEvent.count({
    where: { studyId, action: SAVE_ACTION, targetType: "PipelineProject", targetId: projectId, actorUserId: publisherId, ...(windowStart ? { createdAt: { gt: windowStart } } : {}) }
  });
  const proposalIds = accepted.filter((row) => row.acceptedById === publisherId).map((row) => row.id);
  const active = ids.size >= 2;
  const ownChanges = proposalIds.length > 0 || manualSaves > 0;
  // Two approvers who each made changes would otherwise lock each other out (each is refused, the other is named, and nobody
  // can publish). A version that another approver also changed is a shared version: it is not the publisher's work alone.
  const otherIds = others.map((other) => other.id);
  let othersChanged = false;
  if (active && ownChanges && otherIds.length > 0) {
    othersChanged = accepted.some((row) => row.acceptedById !== null && otherIds.includes(row.acceptedById));
    if (!othersChanged) {
      const otherSaves = await prisma.auditEvent.count({
        where: { studyId, action: SAVE_ACTION, targetType: "PipelineProject", targetId: projectId, actorUserId: { in: otherIds }, ...(windowStart ? { createdAt: { gt: windowStart } } : {}) }
      });
      othersChanged = otherSaves > 0;
    }
  }
  return {
    active,
    required: active && ownChanges && !othersChanged,
    approverCount: ids.size,
    others,
    selfChanges: { proposalIds, manualSaves },
    othersChanged,
    acceptedProposals: accepted,
    windowStart
  };
}

/** The plain sentence for the 409. */
export function secondApproverMessage(check: Pick<SecondApproverCheck, "others">): string {
  return `You made changes in this version, so another approver has to publish it. ${joinNames(check.others.map((other) => other.name))} can publish it.`;
}

/**
 * The approval record for a published version, replacing the silent self-stamp as the evidence of approval. The artifact
 * revision is written first (with retries for its number); the binding and provenance edges go in the caller's transaction,
 * so a version never exists without its record.
 */
export async function prepareVersionApproval(input: { studyId: string; publisherId: string; projectId: string; gitCommit: string; versionTag: string; check: SecondApproverCheck }) {
  const digest = contentHash({ kind: "published_version", projectId: input.projectId, gitCommit: input.gitCommit, versionTag: input.versionTag });
  const artifact = await createRevision({
    studyId: input.studyId,
    userId: input.publisherId,
    workItemId: null,
    type: PUBLISH_ARTIFACT_TYPE,
    subjectId: `${input.projectId}:${input.versionTag}`,
    digest,
    sourceCommit: input.gitCommit,
    metadata: { projectId: input.projectId, versionTag: input.versionTag }
  });
  const sources = input.check.acceptedProposals.map((row) => row.artifactRevisionId).filter((id): id is string => Boolean(id));
  const sourceRevisions = sources.length ? await prisma.artifactRevision.findMany({ where: { id: { in: sources }, studyId: input.studyId }, select: { id: true, contentHash: true } }) : [];
  return { artifact, sourceRevisions };
}

export async function bindVersionApproval(
  tx: Prisma.TransactionClient,
  input: { studyId: string; publisherId: string; gitCommit: string; versionTag: string; check: SecondApproverCheck; prepared: Awaited<ReturnType<typeof prepareVersionApproval>> }
) {
  const { artifact, sourceRevisions } = input.prepared;
  const selfApproved = input.check.selfChanges.proposalIds.length > 0 || input.check.selfChanges.manualSaves > 0;
  const binding = await tx.approvalBinding.create({
    data: {
      studyId: input.studyId,
      artifactRevisionId: artifact.id,
      artifactHash: artifact.contentHash,
      sourceCommit: input.gitCommit,
      policyVersion: CONTROL_POLICY_VERSION,
      evidenceHash: contentHash({ versionTag: input.versionTag, acceptedProposalIds: input.check.acceptedProposals.map((row) => row.id).sort(), manualSaves: input.check.selfChanges.manualSaves, othersChanged: input.check.othersChanged, approverCount: input.check.approverCount }),
      status: "APPROVED",
      approvedById: input.publisherId,
      approvedAt: new Date(),
      selfApproved
    }
  });
  if (sourceRevisions.length > 0) {
    await tx.provenanceEdge.createMany({
      data: sourceRevisions.map((source) => ({ studyId: input.studyId, fromType: "ArtifactRevision", fromId: source.id, fromHash: source.contentHash, toType: "ArtifactRevision", toId: artifact.id, toHash: artifact.contentHash, relation: "PUBLISHED_AS" })),
      skipDuplicates: true
    });
  }
  return binding;
}
