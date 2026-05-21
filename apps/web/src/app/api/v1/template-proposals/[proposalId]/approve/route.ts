import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { nextTemplateVersion } from "@/lib/pipeline-template-code";
import { prisma } from "@/lib/prisma";

const approveSchema = z.object({
  notes: z.string().trim().max(4000).optional()
});

async function canPublishTemplate(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { platformRole: true } });
  if (user?.platformRole === "PLATFORM_ADMIN") return true;
  const releaseApprover = await prisma.studyMember.findFirst({
    where: { userId, role: { in: ["RELEASE_APPROVER", "PRINCIPAL_INVESTIGATOR", "STUDY_OWNER"] } },
    select: { id: true }
  });
  return Boolean(releaseApprover);
}

export async function POST(request: NextRequest, context: { params: Promise<{ proposalId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { proposalId } = await context.params;

  const parsed = approveSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid template proposal approval.");

  if (!(await canPublishTemplate(authResult.userId))) {
    return problem(403, "You do not have permission to publish reusable templates.", "forbidden");
  }

  const proposal = await prisma.templateProposal.findUnique({
    where: { id: proposalId },
    include: { template: { include: { templateVersions: { select: { id: true } } } } }
  });
  if (!proposal) return problem(404, "Template proposal not found.", "not_found");
  if (proposal.template.scope !== "PUBLIC_TEMPLATE") {
    return problem(409, "Study-scoped template proposals must be approved from the study template approval flow.", "study_template_approval_required");
  }
  if (proposal.validationStatus !== "PASSED") {
    return problem(409, "Template proposal must pass validation before publishing.", "validation_required");
  }
  if (!proposal.giteaHeadCommit) {
    return problem(409, "Template proposal must reference a Gitea commit before publishing.", "git_commit_required");
  }

  const version = nextTemplateVersion(proposal.template.templateVersions.length);
  const updated = await prisma.$transaction(async (tx) => {
    const templateVersion = await tx.pipelineTemplateVersion.create({
      data: {
        templateId: proposal.templateId,
        version,
        gitCommit: proposal.giteaHeadCommit!,
        gitBranch: proposal.branchName,
        validationStatus: "PASSED",
        approvalStatus: "APPROVED",
        approvedById: authResult.userId,
        approvedAt: new Date(),
        immutable: true
      }
    });
    const template = await tx.pipelineTemplate.update({
      where: { id: proposal.templateId },
      data: {
        status: "APPROVED",
        currentApprovedVersionId: templateVersion.id,
        version,
        active: true
      },
      include: { currentApprovedVersion: true, templateVersions: true, templateProposals: true }
    });
    await tx.templateProposal.update({
      where: { id: proposal.id },
      data: {
        status: "MERGED",
        resultSummary: [proposal.resultSummary, parsed.data.notes ? `Approval notes: ${parsed.data.notes}` : null].filter(Boolean).join(" ")
      }
    });
    return { template, templateVersion };
  });

  await audit({
    actorUserId: authResult.userId,
    action: "pipeline_template.proposal.approve",
    targetType: "TemplateProposal",
    targetId: proposal.id,
    metadata: {
      templateId: proposal.templateId,
      version,
      gitCommit: proposal.giteaHeadCommit,
      notes: parsed.data.notes
    },
    request
  });

  return json(updated);
}
