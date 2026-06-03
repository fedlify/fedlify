import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { runTemplateAgentAssistant, type TemplateAgentIntake } from "@/lib/template-agent";

const sessionSchema = z.object({
  mode: z.enum(["FROM_PUBLIC_TEMPLATE", "FROM_STUDY_TEMPLATE", "FROM_SCRATCH"]),
  studyId: z.string().min(1).optional(),
  templateId: z.string().min(1).optional(),
  intake: z.record(z.string(), z.unknown()).optional()
});

export async function POST(request: NextRequest) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;

  const parsed = sessionSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid template agent session.");

  if (parsed.data.studyId) {
    try {
      await assertStudyAccess(authResult.userId, parsed.data.studyId, "runAgent");
    } catch (error) {
      if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
      throw error;
    }
  }

  // Load existing template spec when adjusting — pre-populate intake so agent has full context
  let templateSpec: Record<string, unknown> | null = null;
  let templateName: string | null = null;
  let templateDescription: string | null = null;

  if (parsed.data.templateId) {
    const template = await prisma.pipelineTemplate.findUnique({
      where: { id: parsed.data.templateId },
      select: { scope: true, studyId: true, name: true, description: true, spec: true }
    });
    if (!template) return problem(404, "Template was not found.", "template_not_found");
    if (template.scope === "STUDY_TEMPLATE" && template.studyId !== parsed.data.studyId) {
      return problem(404, "Study template was not found in this study workspace.", "template_not_found");
    }
    templateSpec = typeof template.spec === "object" && template.spec !== null
      ? template.spec as Record<string, unknown>
      : null;
    templateName = template.name;
    templateDescription = template.description ?? null;
  }

  // Merge: caller-provided intake overrides template spec defaults
  const specIntake: TemplateAgentIntake = templateSpec ? {
    templateName: templateName ?? undefined,
    agentRequest: templateDescription ?? (templateName ? `Adjust the existing ${templateName} federated learning pipeline` : undefined),
    purpose: String(templateSpec.purpose ?? "training"),
    clinicalUseCase: templateSpec.clinicalUseCase ? String(templateSpec.clinicalUseCase) : undefined,
    dataModalities: Array.isArray(templateSpec.dataModalities) ? templateSpec.dataModalities.map(String) : undefined,
    siteLocalInputs: templateSpec.siteLocalInputs ? String(templateSpec.siteLocalInputs) : undefined,
    syntheticFixtures: templateSpec.syntheticFixtures ? String(templateSpec.syntheticFixtures) : undefined,
    nvflareWorkflow: templateSpec.workflow ? String(templateSpec.workflow) : (templateSpec.nvflareWorkflow ? String(templateSpec.nvflareWorkflow) : undefined),
    minClients: templateSpec.runtimeDefaults ? Number((templateSpec.runtimeDefaults as Record<string,unknown>).minClients ?? 2) : 2,
    numRounds: templateSpec.runtimeDefaults ? Number((templateSpec.runtimeDefaults as Record<string,unknown>).numRounds ?? 5) : 5,
    aggregation: templateSpec.aggregation
      ? String(templateSpec.aggregation)
      : templateSpec.runtimeDefaults
      ? String((templateSpec.runtimeDefaults as Record<string,unknown>).aggregation ?? "weighted FedAvg")
      : "weighted FedAvg",
    privacyConstraints: templateSpec.privacyConstraints ? String(templateSpec.privacyConstraints) : undefined,
    dependencyPolicy: templateSpec.dependencyPolicy ? String(templateSpec.dependencyPolicy) : undefined,
    artifactOutputs: templateSpec.artifactOutputs ? String(templateSpec.artifactOutputs) : undefined,
    reviewExpectations: templateSpec.reviewExpectations ? String(templateSpec.reviewExpectations) : undefined,
  } : {};

  const intake = { ...specIntake, ...(parsed.data.intake ?? {}) } as TemplateAgentIntake;

  // For adjust mode with an existing template, tell the agent what it's modifying
  const sourceSummary = templateName
    ? `Existing pipeline: "${templateName}". ${templateDescription ?? ""}`.trim()
    : undefined;
  const userMessage = parsed.data.mode === "FROM_STUDY_TEMPLATE" && templateName
    ? `I want to adjust the existing "${templateName}" pipeline. The current spec is pre-loaded. What changes would you like to make?`
    : "Start template agent session.";

  const assistant = await runTemplateAgentAssistant({
    mode: parsed.data.mode,
    intake,
    userMessage,
    sourceSummary
  });
  const now = new Date().toISOString();
  const session = await prisma.templateAgentSession.create({
    data: {
      studyId: parsed.data.studyId,
      templateId: parsed.data.templateId,
      requestedById: authResult.userId,
      mode: parsed.data.mode,
      status: assistant.missing.length > 0 ? "INTAKE" : "CODING",
      intake,
      messages: [
        {
          role: "assistant",
          content: assistant.message,
          createdAt: now,
          modelUsed: assistant.modelUsed,
          openAiUsed: assistant.openAiUsed,
          missing: assistant.missing
        }
      ]
    }
  });

  return json({ session, missing: assistant.missing }, { status: 201 });
}
