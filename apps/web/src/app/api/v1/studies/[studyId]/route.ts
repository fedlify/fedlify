import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { activationGate } from "@/lib/governance";
import { normalizeNullableMultiSelectValue } from "@/lib/governance-options";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

const optionalNullableGovernanceString = (max: number) =>
  z.preprocess((value) => normalizeNullableMultiSelectValue(value), z.string().trim().max(max).nullable().optional());

const optionalNullableText = (max: number) => z.string().trim().max(max).nullable().optional();

const patchStudySchema = z.object({
  action: z.enum(["updateDetails", "activate", "archive", "reactivate"]),
  title: z.string().trim().min(3).max(200).optional(),
  description: optionalNullableText(8000),
  goal: optionalNullableText(8000),
  researchQuestion: optionalNullableText(8000),
  hypothesis: optionalNullableText(8000),
  secondaryObjectives: optionalNullableText(8000),
  clinicalUseCase: optionalNullableGovernanceString(1000),
  studyDesign: optionalNullableText(8000),
  population: z.string().trim().max(2000).nullable().optional(),
  eligibilityCriteria: optionalNullableText(8000),
  dataModalities: optionalNullableGovernanceString(1000),
  primaryOutcome: z.string().trim().max(2000).nullable().optional(),
  primaryEndpointDetails: optionalNullableText(8000),
  secondaryOutcomes: optionalNullableText(8000),
  sampleSizeRationale: optionalNullableText(8000),
  analysisPlan: optionalNullableText(8000),
  dataHandlingPlan: optionalNullableText(8000),
  humanAiWorkflow: optionalNullableText(8000),
  fairnessPlan: optionalNullableText(8000),
  disseminationPlan: optionalNullableText(8000),
  riskLevel: z.enum(["LOW", "MODERATE", "HIGH"]).optional(),
  intendedUse: optionalNullableGovernanceString(2000)
});

const seededEthicsNotes = new Set([
  "Ethics status must be recorded before release approval.",
  "Ethics approval must be completed before generated kits can be released."
]);

function isSeededEthicsPlaceholder(record: {
  status?: string;
  approvalNumber?: string | null;
  approvingBody?: string | null;
  documentId?: string | null;
  notes?: string | null;
}) {
  return (
    record.status === "PENDING" &&
    !record.approvalNumber &&
    !record.approvingBody &&
    !record.documentId &&
    Boolean(record.notes && seededEthicsNotes.has(record.notes))
  );
}

export async function GET(_request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  const exists = await prisma.study.findUnique({ where: { id: studyId }, select: { id: true } });
  if (!exists) return problem(404, "Study not found.", "not_found");

  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const study = await prisma.study.findUnique({
    where: { id: studyId },
    include: {
      organization: true,
      members: { include: { user: { select: { id: true, name: true, email: true } } } },
      invitations: { orderBy: { createdAt: "desc" } },
      ethics: { orderBy: { createdAt: "desc" } },
      documents: { orderBy: { createdAt: "desc" } },
      sites: { include: { heartbeats: { orderBy: { createdAt: "desc" }, take: 1 }, studySite: true } },
      studySites: {
        include: {
          resourceProfile: true,
          dataProfile: true,
          members: { include: { user: { select: { id: true, name: true, email: true } } } },
          readinessChecks: { orderBy: { createdAt: "desc" }, take: 1 },
          nvflareStatuses: { orderBy: { observedAt: "desc" }, take: 1 },
          site: true,
          logArtifacts: { orderBy: { createdAt: "desc" }, take: 5 }
        },
        orderBy: { createdAt: "desc" }
      },
      agentRuns: { include: { pipelineSpec: true, releases: true }, orderBy: { createdAt: "desc" } },
      pipelineProjects: {
        include: {
          template: true,
          templateVersion: true,
          versions: { include: { ciRuns: true, templateVersion: true }, orderBy: { createdAt: "desc" } },
          proposals: { include: { ciRuns: true }, orderBy: { createdAt: "desc" } }
        },
        orderBy: { updatedAt: "desc" }
      },
      nvflareDeployments: { orderBy: { createdAt: "desc" } },
      nvflareJobs: {
        include: {
          pipelineVersion: { include: { project: true } },
          events: { orderBy: { createdAt: "desc" }, take: 20 },
          logArtifacts: { orderBy: { createdAt: "desc" }, take: 10 },
          result: { include: { artifacts: true, modelRelease: { include: { artifacts: true } } } }
        },
        orderBy: { createdAt: "desc" }
      },
      modelReleases: {
        include: {
          artifacts: true,
          sourceResult: {
            include: {
              job: {
                include: {
                  pipelineVersion: { include: { project: true } }
                }
              }
            }
          }
        },
        orderBy: { createdAt: "desc" }
      },
      releases: { include: { artifacts: true }, orderBy: { createdAt: "desc" } },
      auditEvents: { orderBy: { createdAt: "desc" }, take: 50 }
    }
  });

  if (!study) return problem(404, "Study not found.", "not_found");
  return json({
    study: {
      ...study,
      ethics: study.ethics.filter((record) => !isSeededEthicsPlaceholder(record))
    }
  });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "manage");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = patchStudySchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid study update.");

  const current = await prisma.study.findUnique({
    where: { id: studyId },
    include: {
      ethics: { orderBy: { createdAt: "desc" }, take: 1 },
      studySites: true
    }
  });
  if (!current) return problem(404, "Study not found.", "not_found");

  const updateData =
    parsed.data.action === "updateDetails"
      ? {
          title: parsed.data.title ?? current.title,
          description: parsed.data.description !== undefined ? parsed.data.description : current.description,
          goal: parsed.data.goal !== undefined ? parsed.data.goal : current.goal,
          researchQuestion:
            parsed.data.researchQuestion !== undefined ? parsed.data.researchQuestion : current.researchQuestion,
          hypothesis: parsed.data.hypothesis !== undefined ? parsed.data.hypothesis : current.hypothesis,
          secondaryObjectives:
            parsed.data.secondaryObjectives !== undefined ? parsed.data.secondaryObjectives : current.secondaryObjectives,
          clinicalUseCase: parsed.data.clinicalUseCase !== undefined ? parsed.data.clinicalUseCase : current.clinicalUseCase,
          studyDesign: parsed.data.studyDesign !== undefined ? parsed.data.studyDesign : current.studyDesign,
          population: parsed.data.population !== undefined ? parsed.data.population : current.population,
          eligibilityCriteria:
            parsed.data.eligibilityCriteria !== undefined ? parsed.data.eligibilityCriteria : current.eligibilityCriteria,
          dataModalities: parsed.data.dataModalities !== undefined ? parsed.data.dataModalities : current.dataModalities,
          primaryOutcome: parsed.data.primaryOutcome !== undefined ? parsed.data.primaryOutcome : current.primaryOutcome,
          primaryEndpointDetails:
            parsed.data.primaryEndpointDetails !== undefined ? parsed.data.primaryEndpointDetails : current.primaryEndpointDetails,
          secondaryOutcomes:
            parsed.data.secondaryOutcomes !== undefined ? parsed.data.secondaryOutcomes : current.secondaryOutcomes,
          sampleSizeRationale:
            parsed.data.sampleSizeRationale !== undefined ? parsed.data.sampleSizeRationale : current.sampleSizeRationale,
          analysisPlan: parsed.data.analysisPlan !== undefined ? parsed.data.analysisPlan : current.analysisPlan,
          dataHandlingPlan:
            parsed.data.dataHandlingPlan !== undefined ? parsed.data.dataHandlingPlan : current.dataHandlingPlan,
          humanAiWorkflow:
            parsed.data.humanAiWorkflow !== undefined ? parsed.data.humanAiWorkflow : current.humanAiWorkflow,
          fairnessPlan: parsed.data.fairnessPlan !== undefined ? parsed.data.fairnessPlan : current.fairnessPlan,
          disseminationPlan:
            parsed.data.disseminationPlan !== undefined ? parsed.data.disseminationPlan : current.disseminationPlan,
          riskLevel: parsed.data.riskLevel ?? current.riskLevel,
          intendedUse: parsed.data.intendedUse !== undefined ? parsed.data.intendedUse : current.intendedUse
        }
      : current;

  const gate = activationGate({
    title: updateData.title,
    goal: updateData.goal,
    researchQuestion: updateData.researchQuestion,
    studyDesign: updateData.studyDesign,
    clinicalUseCase: updateData.clinicalUseCase,
    population: updateData.population,
    eligibilityCriteria: updateData.eligibilityCriteria,
    dataModalities: updateData.dataModalities,
    primaryOutcome: updateData.primaryOutcome,
    primaryEndpointDetails: updateData.primaryEndpointDetails,
    analysisPlan: updateData.analysisPlan,
    dataHandlingPlan: updateData.dataHandlingPlan,
    intendedUse: updateData.intendedUse,
    ethics: current.ethics,
    studySites: current.studySites
  });

  if (parsed.data.action === "activate" && !gate.allowed) {
    return problem(409, `Study activation is blocked by missing requirements: ${gate.missing.join(", ")}.`, "activation_gate");
  }

  const data =
    parsed.data.action === "updateDetails"
      ? {
          ...(parsed.data.title ? { title: parsed.data.title } : {}),
          ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
          ...(parsed.data.goal !== undefined ? { goal: parsed.data.goal } : {}),
          ...(parsed.data.researchQuestion !== undefined ? { researchQuestion: parsed.data.researchQuestion } : {}),
          ...(parsed.data.hypothesis !== undefined ? { hypothesis: parsed.data.hypothesis } : {}),
          ...(parsed.data.secondaryObjectives !== undefined ? { secondaryObjectives: parsed.data.secondaryObjectives } : {}),
          ...(parsed.data.clinicalUseCase !== undefined ? { clinicalUseCase: parsed.data.clinicalUseCase } : {}),
          ...(parsed.data.studyDesign !== undefined ? { studyDesign: parsed.data.studyDesign } : {}),
          ...(parsed.data.population !== undefined ? { population: parsed.data.population } : {}),
          ...(parsed.data.eligibilityCriteria !== undefined ? { eligibilityCriteria: parsed.data.eligibilityCriteria } : {}),
          ...(parsed.data.dataModalities !== undefined ? { dataModalities: parsed.data.dataModalities } : {}),
          ...(parsed.data.primaryOutcome !== undefined ? { primaryOutcome: parsed.data.primaryOutcome } : {}),
          ...(parsed.data.primaryEndpointDetails !== undefined ? { primaryEndpointDetails: parsed.data.primaryEndpointDetails } : {}),
          ...(parsed.data.secondaryOutcomes !== undefined ? { secondaryOutcomes: parsed.data.secondaryOutcomes } : {}),
          ...(parsed.data.sampleSizeRationale !== undefined ? { sampleSizeRationale: parsed.data.sampleSizeRationale } : {}),
          ...(parsed.data.analysisPlan !== undefined ? { analysisPlan: parsed.data.analysisPlan } : {}),
          ...(parsed.data.dataHandlingPlan !== undefined ? { dataHandlingPlan: parsed.data.dataHandlingPlan } : {}),
          ...(parsed.data.humanAiWorkflow !== undefined ? { humanAiWorkflow: parsed.data.humanAiWorkflow } : {}),
          ...(parsed.data.fairnessPlan !== undefined ? { fairnessPlan: parsed.data.fairnessPlan } : {}),
          ...(parsed.data.disseminationPlan !== undefined ? { disseminationPlan: parsed.data.disseminationPlan } : {}),
          ...(parsed.data.riskLevel ? { riskLevel: parsed.data.riskLevel } : {}),
          ...(parsed.data.intendedUse !== undefined ? { intendedUse: parsed.data.intendedUse } : {}),
          governanceStatus: gate.status
        }
      : parsed.data.action === "activate"
        ? { status: "ACTIVE" as const, governanceStatus: "APPROVED" as const }
        : parsed.data.action === "archive"
          ? { status: "ARCHIVED" as const }
          : { status: "DRAFT" as const };

  if (parsed.data.action === "updateDetails" && Object.keys(data).length === 0) {
    return problem(400, "Provide study details to update.");
  }

  const study = await prisma.study.update({
    where: { id: studyId },
    data,
    include: {
      organization: true,
      ethics: { orderBy: { createdAt: "desc" }, take: 1 },
      _count: { select: { members: true, documents: true, agentRuns: true, releases: true, sites: true, studySites: true } }
    }
  });

  const action =
    parsed.data.action === "archive"
      ? "study.archive"
      : parsed.data.action === "activate"
        ? "study.activate"
        : parsed.data.action === "reactivate"
        ? "study.reactivate"
        : "study.update";

  await audit({
    actorUserId: authResult.userId,
    orgId: current.orgId,
    studyId,
    action,
    targetType: "Study",
    targetId: studyId,
    metadata: { previousStatus: current.status, status: study.status },
    request
  });

  return json({ study });
}
