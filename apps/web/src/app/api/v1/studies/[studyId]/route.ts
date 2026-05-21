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

const patchStudySchema = z.object({
  action: z.enum(["updateDetails", "activate", "archive", "reactivate"]),
  title: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  goal: z.string().trim().max(4000).nullable().optional(),
  researchQuestion: z.string().trim().max(2000).nullable().optional(),
  clinicalUseCase: optionalNullableGovernanceString(1000),
  population: z.string().trim().max(2000).nullable().optional(),
  dataModalities: optionalNullableGovernanceString(1000),
  primaryOutcome: z.string().trim().max(2000).nullable().optional(),
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
          clinicalUseCase: parsed.data.clinicalUseCase !== undefined ? parsed.data.clinicalUseCase : current.clinicalUseCase,
          population: parsed.data.population !== undefined ? parsed.data.population : current.population,
          dataModalities: parsed.data.dataModalities !== undefined ? parsed.data.dataModalities : current.dataModalities,
          primaryOutcome: parsed.data.primaryOutcome !== undefined ? parsed.data.primaryOutcome : current.primaryOutcome,
          riskLevel: parsed.data.riskLevel ?? current.riskLevel,
          intendedUse: parsed.data.intendedUse !== undefined ? parsed.data.intendedUse : current.intendedUse
        }
      : current;

  const gate = activationGate({
    title: updateData.title,
    goal: updateData.goal,
    researchQuestion: updateData.researchQuestion,
    clinicalUseCase: updateData.clinicalUseCase,
    population: updateData.population,
    dataModalities: updateData.dataModalities,
    primaryOutcome: updateData.primaryOutcome,
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
          ...(parsed.data.clinicalUseCase !== undefined ? { clinicalUseCase: parsed.data.clinicalUseCase } : {}),
          ...(parsed.data.population !== undefined ? { population: parsed.data.population } : {}),
          ...(parsed.data.dataModalities !== undefined ? { dataModalities: parsed.data.dataModalities } : {}),
          ...(parsed.data.primaryOutcome !== undefined ? { primaryOutcome: parsed.data.primaryOutcome } : {}),
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
    return problem(400, "Provide a title or description to update.");
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
