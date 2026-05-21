import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { normalizeNullableMultiSelectValue } from "@/lib/governance-options";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertSiteAccess, isForbiddenError } from "@/lib/rbac";
import { readinessStatus } from "@/lib/site-onboarding";

const optionalNullableGovernanceString = (max: number) =>
  z.preprocess((value) => normalizeNullableMultiSelectValue(value), z.string().trim().max(max).nullable().optional());

const governanceSchema = z.object({
  principalInvestigator: z.string().trim().max(240).nullable().optional(),
  resourceProfile: z
    .object({
      cpuCores: z.number().int().min(0).max(1024).nullable().optional(),
      gpuCount: z.number().int().min(0).max(128).nullable().optional(),
      gpuModel: z.string().trim().max(160).nullable().optional(),
      ramGb: z.number().int().min(0).max(100000).nullable().optional(),
      storageGb: z.number().int().min(0).max(1000000).nullable().optional(),
      networkBandwidthMbps: z.number().int().min(0).max(1000000).nullable().optional(),
      runtimeConstraints: z.string().trim().max(4000).nullable().optional(),
      dependencySummary: z.string().trim().max(4000).nullable().optional(),
      allowByoc: z.boolean().optional()
    })
    .optional(),
  dataProfile: z
    .object({
      modality: optionalNullableGovernanceString(200),
      datasetDescription: z.string().trim().max(4000).nullable().optional(),
      cohortSizeRange: z.string().trim().max(120).nullable().optional(),
      inclusionCriteria: z.string().trim().max(4000).nullable().optional(),
      exclusionCriteria: z.string().trim().max(4000).nullable().optional(),
      dataResidency: z.string().trim().max(240).nullable().optional(),
      deidentificationSummary: z.string().trim().max(4000).nullable().optional()
    })
    .optional(),
  readiness: z
    .object({
      connectivityVerified: z.boolean().optional(),
      kitInstalled: z.boolean().optional(),
      dependenciesVerified: z.boolean().optional(),
      policyAccepted: z.boolean().optional(),
      notes: z.string().trim().max(4000).optional()
    })
    .optional()
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ siteId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { siteId } = await context.params;

  try {
    await assertSiteAccess(authResult.userId, siteId, "manageProfile");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = governanceSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid site governance update.");

  const studySite = await prisma.studySite.findUnique({ where: { id: siteId }, include: { study: true } });
  if (!studySite) return problem(404, "Participant site not found.", "not_found");

  const updated = await prisma.$transaction(async (tx) => {
    if (parsed.data.principalInvestigator !== undefined) {
      await tx.studySite.update({
        where: { id: siteId },
        data: { principalInvestigator: parsed.data.principalInvestigator }
      });
    }

    if (parsed.data.resourceProfile) {
      await tx.siteResourceProfile.upsert({
        where: { studySiteId: siteId },
        update: parsed.data.resourceProfile,
        create: { studySiteId: siteId, ...parsed.data.resourceProfile }
      });
    }

    if (parsed.data.dataProfile) {
      await tx.siteDataProfile.upsert({
        where: { studySiteId: siteId },
        update: parsed.data.dataProfile,
        create: { studySiteId: siteId, ...parsed.data.dataProfile }
      });
    }

    if (parsed.data.readiness) {
      await tx.siteReadinessCheck.create({
        data: {
          studySiteId: siteId,
          checkedById: authResult.userId,
          connectivityVerified: parsed.data.readiness.connectivityVerified ?? false,
          kitInstalled: parsed.data.readiness.kitInstalled ?? false,
          dependenciesVerified: parsed.data.readiness.dependenciesVerified ?? false,
          policyAccepted: parsed.data.readiness.policyAccepted ?? false,
          policyAcceptedById: parsed.data.readiness.policyAccepted ? authResult.userId : null,
          policyAcceptedAt: parsed.data.readiness.policyAccepted ? new Date() : null,
          status: readinessStatus(parsed.data.readiness),
          notes: parsed.data.readiness.notes
        }
      });
    }

    return tx.studySite.findUnique({
      where: { id: siteId },
      include: {
        resourceProfile: true,
        dataProfile: true,
        readinessChecks: { orderBy: { createdAt: "desc" }, take: 1 },
        members: { include: { user: { select: { id: true, name: true, email: true } } } },
        nvflareStatuses: { orderBy: { observedAt: "desc" }, take: 1 }
      }
    });
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: studySite.study.orgId,
    studyId: studySite.studyId,
    action: "site.governance.update",
    targetType: "StudySite",
    targetId: siteId,
    metadata: {
      resourceProfile: Boolean(parsed.data.resourceProfile),
      dataProfile: Boolean(parsed.data.dataProfile),
      readiness: Boolean(parsed.data.readiness)
    },
    request
  });

  return json({ studySite: updated });
}
