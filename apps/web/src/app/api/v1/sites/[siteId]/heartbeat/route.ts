import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { hashIp, sha256 } from "@/lib/crypto";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { canAccessStudy } from "@/lib/rbac";

const heartbeatSchema = z.object({
  status: z.enum(["INVITED", "KIT_RELEASED", "CONNECTED", "DEGRADED", "OFFLINE", "DISABLED"]),
  version: z.string().trim().max(120).optional(),
  computeRunId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export async function POST(request: NextRequest, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const parsed = heartbeatSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid heartbeat.");

  const site = await prisma.site.findUnique({ where: { id: siteId }, include: { study: true, studySite: true } });
  if (!site) return problem(404, "Site not found.", "not_found");

  const token = request.headers.get("x-site-token");
  let actorUserId: string | null = null;

  if (site.apiTokenHash) {
    if (!token || sha256(token) !== site.apiTokenHash) {
      return problem(401, "Invalid site token.", "unauthorized");
    }
  } else {
    const authResult = await requireUser();
    if ("response" in authResult) return authResult.response;
    actorUserId = authResult.userId;
    if (!(await canAccessStudy(authResult.userId, site.studyId, "manage"))) {
      return problem(403, "You do not have permission to update this site.", "forbidden");
    }
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip");
  const heartbeat = await prisma.$transaction(async (tx) => {
    await tx.site.update({ where: { id: site.id }, data: { status: parsed.data.status } });
    if (site.studySite) {
      await tx.studySite.update({ where: { id: site.studySite.id }, data: { participationStatus: parsed.data.status } });
      await tx.nvflareSiteStatus.create({
        data: {
          studySiteId: site.studySite.id,
          siteId: site.id,
          nvflareClientName: site.nvflareClientName,
          status: parsed.data.status,
          currentJobId: parsed.data.computeRunId,
          details: parsed.data.metadata as Prisma.InputJsonObject | undefined
        }
      });
    }
    return tx.siteHeartbeat.create({
      data: {
        siteId: site.id,
        computeRunId: parsed.data.computeRunId,
        status: parsed.data.status,
        version: parsed.data.version,
        ipHash: hashIp(ip ?? null),
        metadata: parsed.data.metadata as Prisma.InputJsonObject | undefined
      }
    });
  });

  await audit({
    actorUserId,
    orgId: site.study.orgId,
    studyId: site.studyId,
    action: "site.heartbeat",
    targetType: "Site",
    targetId: site.id,
    metadata: { status: parsed.data.status, version: parsed.data.version },
    request
  });

  return json({ heartbeat }, { status: 201 });
}
