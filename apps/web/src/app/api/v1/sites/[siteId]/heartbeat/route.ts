import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { hashIp, safeEqual, sha256 } from "@/lib/crypto";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { clientIp } from "@/lib/client-ip";
import { rateLimit } from "@/lib/rate-limit";
import { canAccessStudy } from "@/lib/rbac";
import { sanitizeHeartbeatMetadata } from "@/lib/site-presence";

const heartbeatSchema = z.object({
  status: z.enum(["INVITED", "KIT_RELEASED", "CONNECTED", "DEGRADED", "OFFLINE", "DISABLED"]),
  version: z.string().trim().max(120).optional(),
  computeRunId: z.string().trim().max(120).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const HEARTBEAT_LIMIT_PER_MINUTE = 20;
const FAILED_TOKEN_LIMIT_PER_MINUTE = 10;
/** A runner that holds a site token may only report liveness. Lifecycle states belong to people and the server. */
const RUNNER_STATUSES = new Set(["CONNECTED", "DEGRADED", "OFFLINE"]);

export async function POST(request: NextRequest, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const parsed = heartbeatSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid heartbeat.");

  // Look the site up first so limiter buckets exist only for real sites (bounded memory).
  const site = await prisma.site.findUnique({ where: { id: siteId }, include: { study: true, studySite: true } });
  if (!site) return problem(404, "Site not found.", "not_found");

  // Limits are keyed on siteId, never on a client-supplied header, so they cannot be dodged by rotating a header value.
  // Failed-token attempts have their own bucket so a guesser cannot lock the real runner out. Per-process limits.
  if (!rateLimit(`heartbeat:${siteId}`, HEARTBEAT_LIMIT_PER_MINUTE, 60_000, { consume: false })) {
    return problem(429, "Too many heartbeats from this site. Slow down.", "rate_limited");
  }
  if (!rateLimit(`heartbeat-fail:${siteId}`, FAILED_TOKEN_LIMIT_PER_MINUTE, 60_000, { consume: false })) {
    return problem(429, "Too many failed attempts for this site. Try again later.", "rate_limited");
  }

  const token = request.headers.get("x-site-token");
  let actorUserId: string | null = null;
  let tokenAuthenticated = false;

  if (site.apiTokenHash) {
    if (!token || !safeEqual(sha256(token), site.apiTokenHash)) {
      rateLimit(`heartbeat-fail:${siteId}`, FAILED_TOKEN_LIMIT_PER_MINUTE, 60_000);
      return problem(401, "Invalid site token.", "unauthorized");
    }
    tokenAuthenticated = true;
  } else {
    const authResult = await requireUser();
    if ("response" in authResult) return authResult.response;
    actorUserId = authResult.userId;
    if (!(await canAccessStudy(authResult.userId, site.studyId, "manage"))) {
      return problem(403, "You do not have permission to update this site.", "forbidden");
    }
  }
  rateLimit(`heartbeat:${siteId}`, HEARTBEAT_LIMIT_PER_MINUTE, 60_000);

  if (tokenAuthenticated) {
    // An administrator's DISABLED state is final for the runner: it can neither override it nor report it.
    if (site.status === "DISABLED" || site.studySite?.participationStatus === "DISABLED") {
      return problem(403, "This site is disabled for the study.", "site_disabled");
    }
    if (!RUNNER_STATUSES.has(parsed.data.status)) {
      return problem(400, "A site runner may report only CONNECTED, DEGRADED or OFFLINE.", "invalid_status");
    }
  }

  const metadata = sanitizeHeartbeatMetadata(parsed.data.metadata);
  const ip = clientIp(request);
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
          details: metadata
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
        metadata
      }
    });
  });

  // Routine beats are not audited (about 2,880 a day per site would bury governance events). Audit transitions only.
  if (site.status !== parsed.data.status) await audit({
    actorUserId,
    orgId: site.study.orgId,
    studyId: site.studyId,
    action: "site.status_changed",
    targetType: "Site",
    targetId: site.id,
    metadata: { from: site.status, status: parsed.data.status, version: parsed.data.version },
    request
  });

  // Published studies: tell the site runner which study image it should run (`fedlify-runner.sh update`).
  const publishedDeployment = await prisma.nvflareDeployment.findFirst({
    where: { studyId: site.studyId, active: true, runtimeMode: "k8s" },
    select: { imageDigest: true, hostname: true }
  });

  return json(
    { heartbeat, desiredImageDigest: publishedDeployment?.imageDigest ?? null, aggregator: publishedDeployment?.hostname ?? null },
    { status: 201 }
  );
}
