import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { ensureStudyGiteaWorkspace } from "@/lib/gitea-workspaces";
import { activationGate } from "@/lib/governance";
import { normalizeMultiSelectValue } from "@/lib/governance-options";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/slug";

const optionalGovernanceString = (max: number) =>
  z.preprocess((value) => normalizeMultiSelectValue(value), z.string().trim().max(max).optional());

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

const createStudySchema = z.object({
  orgId: z.string().min(1),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(4000).optional(),
  goal: z.string().trim().max(4000).optional(),
  researchQuestion: z.string().trim().max(2000).optional(),
  clinicalUseCase: optionalGovernanceString(1000),
  population: z.string().trim().max(2000).optional(),
  dataModalities: optionalGovernanceString(1000),
  primaryOutcome: z.string().trim().max(2000).optional(),
  riskLevel: z.enum(["LOW", "MODERATE", "HIGH"]).default("MODERATE"),
  intendedUse: optionalGovernanceString(2000)
});

export async function GET(request: NextRequest) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;

  const user = await prisma.user.findUnique({
    where: { id: authResult.userId },
    select: { platformRole: true }
  });

  const status = request.nextUrl.searchParams.get("status");
  const statusWhere: Prisma.StudyWhereInput =
    status === "active" ? { status: { not: "ARCHIVED" } } : status === "archived" ? { status: "ARCHIVED" } : {};
  const accessWhere: Prisma.StudyWhereInput =
    user?.platformRole === "PLATFORM_ADMIN" || user?.platformRole === "AUDITOR"
      ? {}
      : {
          OR: [
            { members: { some: { userId: authResult.userId } } },
            { organization: { memberships: { some: { userId: authResult.userId, status: "ACTIVE", role: "ORG_ADMIN" } } } }
          ]
        };

  const studies = await prisma.study.findMany({
    where: { AND: [accessWhere, statusWhere] },
    include: {
      organization: true,
      ethics: { orderBy: { createdAt: "desc" }, take: 1 },
      _count: { select: { members: true, documents: true, agentRuns: true, releases: true, sites: true } }
    },
    orderBy: { updatedAt: "desc" }
  });

  return json({
    studies: studies.map((study) => ({
      ...study,
      ethics: study.ethics.filter((record) => !isSeededEthicsPlaceholder(record))
    }))
  });
}

export async function POST(request: NextRequest) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;

  const parsed = createStudySchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid study.");

  const membership = await prisma.orgMembership.findUnique({
    where: { orgId_userId: { orgId: parsed.data.orgId, userId: authResult.userId } }
  });

  if (!membership || membership.status !== "ACTIVE" || membership.role !== "ORG_ADMIN") {
    return problem(403, "Only organization admins can create studies.", "forbidden");
  }

  const baseSlug = slugify(parsed.data.title);
  const slug = `${baseSlug}-${Date.now().toString(36)}`;

  const study = await prisma.$transaction(async (tx) => {
    const created = await tx.study.create({
      data: {
        orgId: parsed.data.orgId,
        title: parsed.data.title,
        slug,
        description: parsed.data.description,
        goal: parsed.data.goal,
        researchQuestion: parsed.data.researchQuestion,
        clinicalUseCase: parsed.data.clinicalUseCase,
        population: parsed.data.population,
        dataModalities: parsed.data.dataModalities,
        primaryOutcome: parsed.data.primaryOutcome,
        riskLevel: parsed.data.riskLevel,
        intendedUse: parsed.data.intendedUse,
        governanceStatus: activationGate({
          title: parsed.data.title,
          goal: parsed.data.goal,
          researchQuestion: parsed.data.researchQuestion,
          clinicalUseCase: parsed.data.clinicalUseCase,
          population: parsed.data.population,
          dataModalities: parsed.data.dataModalities,
          primaryOutcome: parsed.data.primaryOutcome,
          intendedUse: parsed.data.intendedUse,
          ethics: [],
          studySites: []
        }).status,
        createdById: authResult.userId,
        status: "DRAFT"
      }
    });

    await tx.studyMember.create({
      data: {
        studyId: created.id,
        userId: authResult.userId,
        role: "PRINCIPAL_INVESTIGATOR"
      }
    });

    return created;
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: parsed.data.orgId,
    studyId: study.id,
    action: "study.create",
    targetType: "Study",
    targetId: study.id,
    request
  });

  const giteaWorkspace = await ensureStudyGiteaWorkspace({ studyId: study.id, userId: authResult.userId });

  return json({ study, giteaWorkspace }, { status: 201 });
}
