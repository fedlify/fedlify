import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { controlError, controlRequestContext } from "@/lib/control-api";
import { contentHash } from "@/lib/control-plane";
import { json } from "@/lib/json";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ studyId: string }> };
const expectedCounts = { "420": 3600, "243": 2700, "73": 2431, "188": 2299, "122": 2186, "252": 1930 };
const createSchema = z.object({
  action: z.literal("create"),
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/i),
  datasetSchema: z.array(z.string()).length(31),
  featureContract: z.record(z.string(), z.unknown()),
  preprocessing: z.record(z.string(), z.unknown()),
  jobSpecifications: z.array(z.record(z.string(), z.unknown())).length(5)
});
const approveSchema = z.object({ action: z.literal("approve"), protocolId: z.string().min(1), protocolHash: z.string().regex(/^[a-f0-9]{64}$/i) });
const metricSchema = z.object({
  action: z.literal("metric"), runId: z.string().min(1), hospitalId: z.number().int().optional(), split: z.string().min(1),
  metric: z.string().min(1), value: z.number().finite(), ciLower: z.number().finite().optional(), ciUpper: z.number().finite().optional(),
  baselineValue: z.number().finite().optional(), metadata: z.record(z.string(), z.unknown()).optional()
});
const bodySchema = z.discriminatedUnion("action", [createSchema, approveSchema, metricSchema]);

export async function GET(_request: NextRequest, { params }: Params) {
  const { studyId } = await params;
  const { requireUser } = await import("@/lib/api");
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  try {
    const { assertStudyAccess } = await import("@/lib/rbac");
    await assertStudyAccess(authResult.userId, studyId, "read");
    return json({ protocols: await prisma.caseStudyProtocol.findMany({ where: { studyId }, include: { runs: { include: { metrics: true } } }, orderBy: { createdAt: "desc" } }) });
  } catch (error) { return controlError(error); }
}

export async function POST(request: NextRequest, { params }: Params) {
  const { studyId } = await params;
  try {
    const raw = bodySchema.parse(await request.json());
    const action = raw.action === "approve" ? "approvePipeline" : raw.action === "metric" ? "submitJob" : "runAgent";
    const context = await controlRequestContext(request, studyId, action);
    if ("response" in context) return context.response;
    if (raw.action === "create") {
      const material = { datasetHash: raw.datasetHash, datasetSchema: raw.datasetSchema, trainingHospitals: [420, 243, 73, 188, 122], validationHospital: 252, expectedCounts, featureContract: raw.featureContract, preprocessing: raw.preprocessing, jobSpecifications: raw.jobSpecifications };
      const protocolHash = contentHash(material);
      const protocol = await prisma.caseStudyProtocol.upsert({
        where: { protocolHash }, update: {}, create: { studyId, protocolHash, datasetHash: raw.datasetHash, datasetSchema: raw.datasetSchema as Prisma.InputJsonValue, trainingHospitals: [420, 243, 73, 188, 122], validationHospital: 252, expectedCounts, featureContract: raw.featureContract as Prisma.InputJsonValue, preprocessing: raw.preprocessing as Prisma.InputJsonValue, jobSpecifications: raw.jobSpecifications as Prisma.InputJsonValue, createdById: context.userId }
      });
      await audit({ actorUserId: context.userId, studyId, action: "case-study.protocol.create", targetType: "CaseStudyProtocol", targetId: protocol.id, request });
      return json({ protocol }, { status: 201 });
    }
    if (raw.action === "approve") {
      const protocol = await prisma.caseStudyProtocol.findFirst({ where: { id: raw.protocolId, studyId, protocolHash: raw.protocolHash } });
      if (!protocol) throw new Error("Case-study protocol not found or hash mismatch.");
      const approved = await prisma.$transaction(async (tx) => {
        const updated = await tx.caseStudyProtocol.update({ where: { id: protocol.id }, data: { status: "APPROVED", approvedById: context.userId, approvedAt: new Date() } });
        const jobs = protocol.jobSpecifications as Array<Record<string, unknown>>;
        await Promise.all(jobs.map((job) => tx.caseStudyRun.upsert({
          where: { protocolId_algorithm_seed: { protocolId: protocol.id, algorithm: String(job.algorithm), seed: Number(job.seed) } },
          update: {}, create: { protocolId: protocol.id, algorithm: String(job.algorithm), seed: Number(job.seed), status: "APPROVED" }
        })));
        return updated;
      });
      await audit({ actorUserId: context.userId, studyId, action: "case-study.protocol.approve", targetType: "CaseStudyProtocol", targetId: protocol.id, request });
      return json({ protocol: approved });
    }
    const run = await prisma.caseStudyRun.findFirst({ where: { id: raw.runId, protocol: { studyId } } });
    if (!run) throw new Error("Case-study run not found.");
    const existingMetric = await prisma.caseStudyMetric.findFirst({ where: { runId: run.id, hospitalId: raw.hospitalId ?? null, split: raw.split, metric: raw.metric } });
    const metricData = { value: raw.value, ciLower: raw.ciLower, ciUpper: raw.ciUpper, baselineValue: raw.baselineValue, difference: raw.baselineValue === undefined ? undefined : raw.value - raw.baselineValue, metadata: raw.metadata as Prisma.InputJsonValue | undefined };
    const metric = existingMetric
      ? await prisma.caseStudyMetric.update({ where: { id: existingMetric.id }, data: metricData })
      : await prisma.caseStudyMetric.create({ data: { runId: run.id, hospitalId: raw.hospitalId, split: raw.split, metric: raw.metric, ...metricData } });
    return json({ metric }, { status: 201 });
  } catch (error) { return controlError(error); }
}
