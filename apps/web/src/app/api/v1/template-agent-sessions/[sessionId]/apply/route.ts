import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { createGiteaTemplateProposal, GiteaApiError, isRuntimeConfigurationError } from "@/lib/gitea";
import { ensurePublicTemplateWorkspace, ensureStudyGiteaWorkspace } from "@/lib/gitea-workspaces";
import { json, problem } from "@/lib/json";
import { missingTemplateAgentFields, templateIntakeAnswersFromAgent, type TemplateAgentIntake } from "@/lib/template-agent";
import { buildTemplateRepositoryFiles, templateKeyForName, templateRepoName, validateTemplateRepositoryFiles } from "@/lib/pipeline-template-code";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { slugify } from "@/lib/slug";

type Params = { params: Promise<{ sessionId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { sessionId } = await params;
  const session = await prisma.templateAgentSession.findUnique({
    where: { id: sessionId },
    include: { template: { include: { currentApprovedVersion: true } } }
  });
  if (!session) return problem(404, "Template agent session was not found.", "not_found");

  if (session.studyId) {
    try {
      await assertStudyAccess(authResult.userId, session.studyId, "runAgent");
    } catch (error) {
      if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
      throw error;
    }
  } else if (session.requestedById !== authResult.userId) {
    return problem(403, "You do not have permission to apply this template agent session.", "forbidden");
  }

  const intake = (session.intake ?? {}) as TemplateAgentIntake;
  const missing = missingTemplateAgentFields(intake);
  if (missing.length > 0) {
    return problem(409, `Template intake is incomplete: ${missing.join(", ")}.`, "template_intake_incomplete");
  }

  const name = String(intake.templateName);
  const templateKey = session.template?.templateKey ?? templateKeyForName(name);
  const files = await buildTemplateRepositoryFiles({
    name,
    templateKey,
    description: typeof intake.description === "string" ? intake.description : undefined,
    prompt: String(intake.agentRequest),
    intake: templateIntakeAnswersFromAgent(intake)
  });
  const validation = validateTemplateRepositoryFiles(files);
  if (validation.status !== "PASSED") return problem(422, validation.summary, "template_validation_failed");

  const isStudyScoped = Boolean(session.studyId);
  let owner: string;
  try {
    owner = isStudyScoped
      ? (await ensureStudyGiteaWorkspace({ studyId: session.studyId!, userId: authResult.userId })).owner
      : (await ensurePublicTemplateWorkspace()).owner;
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (error instanceof GiteaApiError) return problem(502, error.message, "gitea_api_error");
    throw error;
  }

  const repoName = session.template?.giteaRepo ?? templateRepoName(name);
  const branchName = `fedlify/agent-${slugify(name).slice(0, 42)}-${Date.now().toString(36)}`;
  let gitea;
  try {
    gitea = await createGiteaTemplateProposal({
      owner,
      repoName,
      templateName: name,
      description: typeof intake.description === "string" ? intake.description : `Fedlify NVFLARE template: ${name}`,
      branchName,
      files,
      pullRequestBody: [
        `Agent-generated template proposal: ${name}`,
        `Session: ${session.id}`,
        "",
        "The Fedlify template agent generated this branch from structured intake and chat.",
        "Publishing or study-use approval still requires human review.",
        "",
        validation.summary
      ].join("\n")
    });
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (error instanceof GiteaApiError) return problem(502, error.message, "gitea_api_error");
    throw error;
  }

  const result = await prisma.$transaction(async (tx) => {
    const sourceTemplate = session.template;
    const existing = session.mode === "FROM_PUBLIC_TEMPLATE" && isStudyScoped ? null : session.template;
    const template =
      existing ??
      (await tx.pipelineTemplate.create({
        data: {
          name,
          templateKey,
          scope: isStudyScoped ? "STUDY_TEMPLATE" : "PUBLIC_TEMPLATE",
          studyId: session.studyId,
          sourceTemplateId: session.mode === "FROM_PUBLIC_TEMPLATE" && sourceTemplate?.scope === "PUBLIC_TEMPLATE" ? sourceTemplate.id : null,
          sourceTemplateVersionId:
            session.mode === "FROM_PUBLIC_TEMPLATE" && sourceTemplate?.currentApprovedVersionId
              ? sourceTemplate.currentApprovedVersionId
              : null,
          forkedFromCommit:
            session.mode === "FROM_PUBLIC_TEMPLATE" && sourceTemplate?.currentApprovedVersion?.gitCommit
              ? sourceTemplate.currentApprovedVersion.gitCommit
              : null,
          framework: "nvflare",
          description: typeof intake.description === "string" ? intake.description : undefined,
          version: "1.0.0",
          spec: templateIntakeAnswersFromAgent(intake),
          active: true,
          status: "VALIDATED",
          giteaOwner: gitea.owner,
          giteaRepo: gitea.repo,
          giteaRepoUrl: gitea.repoUrl,
          giteaDefaultBranch: gitea.baseBranch,
          createdById: authResult.userId
        }
      }));

    if (existing) {
      await tx.pipelineTemplate.update({
        where: { id: existing.id },
        data: {
          name,
          description: typeof intake.description === "string" ? intake.description : existing.description,
          spec: templateIntakeAnswersFromAgent(intake),
          status: "VALIDATED",
          giteaOwner: gitea.owner,
          giteaRepo: gitea.repo,
          giteaRepoUrl: gitea.repoUrl,
          giteaDefaultBranch: gitea.baseBranch
        }
      });
    }

    const proposal = await tx.templateProposal.create({
      data: {
        templateId: template.id,
        requestedById: authResult.userId,
        kind: existing ? "CHANGE_TEMPLATE" : "NEW_TEMPLATE",
        intakeAnswers: templateIntakeAnswersFromAgent(intake),
        prompt: String(intake.agentRequest),
        branchName: gitea.branchName,
        giteaPullRequestUrl: gitea.pullRequestUrl,
        giteaPullRequestNumber: gitea.pullRequestNumber,
        giteaHeadCommit: gitea.commitSha,
        giteaBaseBranch: gitea.baseBranch,
        status: "OPEN",
        validationStatus: "PASSED",
        resultSummary: validation.summary
      }
    });

    const updatedSession = await tx.templateAgentSession.update({
      where: { id: session.id },
      data: {
        status: "APPLIED",
        templateId: template.id,
        generatedFiles: files,
        resultSummary: validation.summary,
        giteaOwner: gitea.owner,
        giteaRepo: gitea.repo,
        branchName: gitea.branchName,
        giteaPullRequestUrl: gitea.pullRequestUrl,
        giteaHeadCommit: gitea.commitSha
      }
    });

    return { session: updatedSession, template, proposal };
  });

  await audit({
    actorUserId: authResult.userId,
    studyId: session.studyId,
    action: "template_agent.apply",
    targetType: "TemplateAgentSession",
    targetId: session.id,
    metadata: {
      templateId: result.template.id,
      proposalId: result.proposal.id,
      giteaRepo: `${gitea.owner}/${gitea.repo}`,
      branchName: gitea.branchName,
      pullRequestNumber: gitea.pullRequestNumber,
      gitCommit: gitea.commitSha
    },
    request
  });

  return json(result);
}
