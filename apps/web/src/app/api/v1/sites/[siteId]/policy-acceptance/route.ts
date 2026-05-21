import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertSiteAccess, isForbiddenError } from "@/lib/rbac";
import { readinessStatus } from "@/lib/site-onboarding";

const policyAcceptanceSchema = z.object({
  notes: z.string().trim().max(4000).optional()
});

export async function POST(request: NextRequest, context: { params: Promise<{ siteId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { siteId } = await context.params;

  try {
    await assertSiteAccess(authResult.userId, siteId, "acceptSitePolicy");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = policyAcceptanceSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid policy acceptance.");

  const studySite = await prisma.studySite.findUnique({
    where: { id: siteId },
    include: { readinessChecks: { orderBy: { createdAt: "desc" }, take: 1 } }
  });
  if (!studySite) return problem(404, "Participant site not found.", "not_found");

  const latest = studySite.readinessChecks[0];
  const readiness = {
    connectivityVerified: latest?.connectivityVerified ?? false,
    kitInstalled: latest?.kitInstalled ?? false,
    dependenciesVerified: latest?.dependenciesVerified ?? false,
    policyAccepted: true
  };

  const readinessCheck = await prisma.siteReadinessCheck.create({
    data: {
      studySiteId: siteId,
      checkedById: authResult.userId,
      ...readiness,
      policyAcceptedById: authResult.userId,
      policyAcceptedAt: new Date(),
      status: readinessStatus(readiness),
      notes: parsed.data.notes ?? "Local site policy accepted from the site onboarding dashboard."
    }
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: studySite.organizationId,
    studyId: studySite.studyId,
    action: "site.policy.accept",
    targetType: "StudySite",
    targetId: siteId,
    metadata: { readinessStatus: readinessCheck.status },
    request
  });

  return json({ readinessCheck });
}
