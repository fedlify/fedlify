import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { randomToken, sha256 } from "@/lib/crypto";
import { normalizeMultiSelectValue } from "@/lib/governance-options";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/slug";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

const optionalGovernanceString = (max: number) =>
  z.preprocess((value) => normalizeMultiSelectValue(value), z.string().trim().max(max).optional());

const siteSchema = z.object({
  name: z.string().trim().min(2).max(160),
  institutionName: z.string().trim().min(2).max(240),
  code: z.string().trim().min(2).max(64).optional(),
  principalInvestigator: z.string().trim().max(240).optional(),
  resourceProfile: z
    .object({
      cpuCores: z.number().int().min(0).max(1024).optional(),
      gpuCount: z.number().int().min(0).max(128).optional(),
      gpuModel: z.string().trim().max(160).optional(),
      ramGb: z.number().int().min(0).max(100000).optional(),
      storageGb: z.number().int().min(0).max(1000000).optional(),
      networkBandwidthMbps: z.number().int().min(0).max(1000000).optional(),
      runtimeConstraints: z.string().trim().max(4000).optional(),
      dependencySummary: z.string().trim().max(4000).optional(),
      allowByoc: z.boolean().optional()
    })
    .optional(),
  dataProfile: z
    .object({
      modality: optionalGovernanceString(200),
      datasetDescription: z.string().trim().max(4000).optional(),
      cohortSizeRange: z.string().trim().max(120).optional(),
      inclusionCriteria: z.string().trim().max(4000).optional(),
      exclusionCriteria: z.string().trim().max(4000).optional(),
      dataResidency: z.string().trim().max(240).optional(),
      deidentificationSummary: z.string().trim().max(4000).optional()
    })
    .optional()
});

export async function GET(_request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const sites = await prisma.site.findMany({
    where: { studyId },
    include: {
      heartbeats: { orderBy: { createdAt: "desc" }, take: 1 },
      studySite: {
        include: {
          resourceProfile: true,
          dataProfile: true,
          readinessChecks: { orderBy: { createdAt: "desc" }, take: 1 },
          members: { include: { user: { select: { id: true, name: true, email: true } } } },
          nvflareStatuses: { orderBy: { observedAt: "desc" }, take: 1 }
        }
      }
    },
    orderBy: { createdAt: "desc" }
  });

  return json({ sites });
}

export async function POST(request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "manageSites");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = siteSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid site.");

  const study = await prisma.study.findUnique({ where: { id: studyId }, select: { orgId: true } });
  if (!study) return problem(404, "Study not found.", "not_found");

  const token = randomToken();
  const code = parsed.data.code ? slugify(parsed.data.code) : `${slugify(parsed.data.name)}-${Date.now().toString(36)}`;

  const result = await prisma.$transaction(async (tx) => {
    const site = await tx.site.create({
      data: {
        studyId,
        organizationId: study.orgId,
        name: parsed.data.name,
        institutionName: parsed.data.institutionName,
        code,
        nvflareClientName: `site-${code}`,
        apiTokenHash: sha256(token)
      }
    });

    const studySite = await tx.studySite.create({
      data: {
        studyId,
        siteId: site.id,
        organizationId: study.orgId,
        name: parsed.data.name,
        institutionName: parsed.data.institutionName,
        code,
        principalInvestigator: parsed.data.principalInvestigator,
        participationStatus: "INVITED",
        resourceProfile: {
          create: {
            cpuCores: parsed.data.resourceProfile?.cpuCores,
            gpuCount: parsed.data.resourceProfile?.gpuCount,
            gpuModel: parsed.data.resourceProfile?.gpuModel,
            ramGb: parsed.data.resourceProfile?.ramGb,
            storageGb: parsed.data.resourceProfile?.storageGb,
            networkBandwidthMbps: parsed.data.resourceProfile?.networkBandwidthMbps,
            runtimeConstraints: parsed.data.resourceProfile?.runtimeConstraints,
            dependencySummary: parsed.data.resourceProfile?.dependencySummary,
            allowByoc: parsed.data.resourceProfile?.allowByoc ?? false
          }
        },
        dataProfile: {
          create: {
            modality: parsed.data.dataProfile?.modality,
            datasetDescription: parsed.data.dataProfile?.datasetDescription,
            cohortSizeRange: parsed.data.dataProfile?.cohortSizeRange,
            inclusionCriteria: parsed.data.dataProfile?.inclusionCriteria,
            exclusionCriteria: parsed.data.dataProfile?.exclusionCriteria,
            dataResidency: parsed.data.dataProfile?.dataResidency ?? "site-local",
            deidentificationSummary: parsed.data.dataProfile?.deidentificationSummary
          }
        },
        readinessChecks: {
          create: {
            checkedById: authResult.userId,
            status: "PENDING",
            notes: "Site registered. Connectivity, kit installation, dependencies, and policy acceptance are pending."
          }
        }
      },
      include: { resourceProfile: true, dataProfile: true, readinessChecks: true }
    });

    return { site, studySite };
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: study.orgId,
    studyId,
    action: "site.create",
    targetType: "Site",
    targetId: result.site.id,
    metadata: { code: result.site.code, studySiteId: result.studySite.id },
    request
  });

  return json({ site: result.site, studySite: result.studySite, apiToken: token }, { status: 201 });
}
