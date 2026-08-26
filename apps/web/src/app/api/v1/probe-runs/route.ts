import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { mutationHeaders } from "@/lib/control-plane";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

const createSchema = z.object({
  studyId: z.string().optional(), suiteVersion: z.literal("1.0"), suiteHash: z.string().regex(/^[a-f0-9]{64}$/i),
  providerProfile: z.enum(["hosted", "local"]), repetition: z.number().int().positive(), sourceManifest: z.record(z.string(), z.unknown())
});

export async function GET(request: NextRequest) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const studyId = request.nextUrl.searchParams.get("studyId") ?? undefined;
  try {
    if (studyId) await assertStudyAccess(authResult.userId, studyId, "audit");
    return json({ runs: await prisma.probeRun.findMany({ where: { studyId }, include: { results: true }, orderBy: { createdAt: "desc" }, take: 50 }) });
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }
}

export async function POST(request: NextRequest) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  try {
    mutationHeaders(request.headers);
    const input = createSchema.parse(await request.json());
    if (input.studyId) await assertStudyAccess(authResult.userId, input.studyId, "audit");
    const run = await prisma.probeRun.create({ data: { ...input, sourceManifest: input.sourceManifest as Prisma.InputJsonValue, startedById: authResult.userId, status: "PENDING" } });
    return json({ run }, { status: 201 });
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    return problem(400, error instanceof Error ? error.message : "Invalid probe run.");
  }
}
