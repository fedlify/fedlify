import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { activationGate } from "@/lib/governance";
import { json, problem } from "@/lib/json";
import {
  allocateNvflarePorts,
  composeProjectName,
  deploymentWorkspacePath,
  provisionNvflareDeployment,
  serverAddressForPort
} from "@/lib/nvflare-runtime";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { nvflareAdminEmail, runtimeMode } from "@/lib/runtime-config";

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

  const deployments = await prisma.nvflareDeployment.findMany({
    where: { studyId },
    orderBy: { createdAt: "desc" }
  });
  return json({ deployments });
}

export async function POST(request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "submitJob");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const study = await prisma.study.findUnique({
    where: { id: studyId },
    include: {
      ethics: { orderBy: { createdAt: "desc" }, take: 1 },
      studySites: { include: { site: true } },
      nvflareDeployments: true
    }
  });
  if (!study) return problem(404, "Study not found.", "not_found");

  const gate = activationGate({
    title: study.title,
    goal: study.goal,
    researchQuestion: study.researchQuestion,
    studyDesign: study.studyDesign,
    clinicalUseCase: study.clinicalUseCase,
    population: study.population,
    eligibilityCriteria: study.eligibilityCriteria,
    dataModalities: study.dataModalities,
    primaryOutcome: study.primaryOutcome,
    primaryEndpointDetails: study.primaryEndpointDetails,
    analysisPlan: study.analysisPlan,
    dataHandlingPlan: study.dataHandlingPlan,
    intendedUse: study.intendedUse,
    ethics: study.ethics,
    studySites: study.studySites
  });
  if (!gate.allowed) {
    return problem(409, `NVFLARE deployment provisioning is blocked by missing requirements: ${gate.missing.join(", ")}.`, "activation_gate");
  }

  const created = await prisma.nvflareDeployment.create({
    data: {
      studyId,
      name: `${study.title} local Docker FLARE deployment`,
      runtimeMode: runtimeMode(),
      activeAdminEmail: nvflareAdminEmail(),
      status: "DRAFT"
    }
  });
  const ports = allocateNvflarePorts(study.nvflareDeployments.length);
  const serverAddress = serverAddressForPort(ports.server);
  const composeProject = composeProjectName(studyId, created.id);
  const workspacePath = deploymentWorkspacePath(studyId, created.id);
  let artifactResult: Awaited<ReturnType<typeof provisionNvflareDeployment>> | null = null;
  let lastError: string | null = null;
  try {
    artifactResult = await provisionNvflareDeployment({
      study,
      deploymentId: created.id,
      composeProject,
      workspacePath,
      ports,
      serverAddress,
      sites: study.studySites
    });
  } catch (error) {
    lastError = error instanceof Error ? error.message : "NVFLARE provisioning failed.";
  }

  const deployment = await prisma.nvflareDeployment.update({
    where: { id: created.id },
    data: {
      status: artifactResult ? "PROVISIONED" : "DRAFT",
      serverAddress,
      adminAddress: `${serverAddress} (${nvflareAdminEmail()})`,
      composeProject,
      workspacePath,
      ports: ports as Prisma.InputJsonObject,
      serverStartupKitStorageKey: artifactResult?.serverStartupKitStorageKey,
      adminStartupKitStorageKey: artifactResult?.adminStartupKitStorageKey,
      serverStartupPath: artifactResult?.serverStartupPath,
      adminStartupPath: artifactResult?.adminStartupPath,
      clientStartupPaths: artifactResult?.clientStartupPaths as Prisma.InputJsonObject | undefined,
      lastError
    }
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: study.orgId,
    studyId,
    action: "nvflare.deployment.provision",
    targetType: "NvflareDeployment",
    targetId: deployment.id,
    metadata: { serverAddress, composeProject, ports, artifactUploadError: lastError },
    request
  });

  return json({ deployment }, { status: 201 });
}
