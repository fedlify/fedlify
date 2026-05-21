import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { nextTemplateVersion } from "@/lib/pipeline-template-code";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

const approveSchema = z.object({
  proposalId: z.string().min(1).optional(),
  version: z.string().trim().min(1).max(40).optional()
});

type Params = { params: Promise<{ templateId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { templateId } = await params;
  const parsed = approveSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid study template approval request.");

  const template = await prisma.pipelineTemplate.findUnique({
    where: { id: templateId },
    include: {
      templateVersions: true,
      templateProposals: { orderBy: { createdAt: "desc" } }
    }
  });
  if (!template || template.scope !== "STUDY_TEMPLATE" || !template.studyId) {
    return problem(404, "Study template was not found.", "template_not_found");
  }

  try {
    await assertStudyAccess(authResult.userId, template.studyId, "approvePipeline");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const proposal = parsed.data.proposalId
    ? template.templateProposals.find((item) => item.id === parsed.data.proposalId)
    : template.templateProposals.find((item) => item.validationStatus === "PASSED" && item.giteaHeadCommit);
  if (!proposal?.giteaHeadCommit) {
    return problem(409, "A passed draft PR commit is required before approving this study template.", "template_proposal_required");
  }
  if (proposal.validationStatus !== "PASSED") {
    return problem(409, "Template validation must pass before approval.", "template_validation_required");
  }

  const versionLabel = parsed.data.version ?? nextTemplateVersion(template.templateVersions.length);
  const result = await prisma.$transaction(async (tx) => {
    const version = await tx.pipelineTemplateVersion.create({
      data: {
        templateId: template.id,
        version: versionLabel,
        gitCommit: proposal.giteaHeadCommit!,
        gitBranch: proposal.branchName,
        validationStatus: "PASSED",
        approvalStatus: "APPROVED",
        approvedById: authResult.userId,
        approvedAt: new Date(),
        immutable: true
      }
    });

    const updated = await tx.pipelineTemplate.update({
      where: { id: template.id },
      data: {
        currentApprovedVersionId: version.id,
        status: "APPROVED"
      },
      include: { currentApprovedVersion: true }
    });

    await tx.templateProposal.update({
      where: { id: proposal.id },
      data: { status: "MERGED" }
    });

    return { template: updated, version };
  });

  await audit({
    actorUserId: authResult.userId,
    studyId: template.studyId,
    action: "study_template.approve",
    targetType: "PipelineTemplateVersion",
    targetId: result.version.id,
    metadata: {
      templateId: template.id,
      proposalId: proposal.id,
      gitCommit: result.version.gitCommit,
      version: result.version.version
    },
    request
  });

  return json(result);
}
