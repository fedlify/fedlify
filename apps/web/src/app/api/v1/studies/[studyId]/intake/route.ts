import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { controlError, controlRequestContext } from "@/lib/control-api";
import { authoritativeIntakeSchema, resolveAuthoritativeIntake, resolveDeterministicIntake } from "@/lib/control-intake";
import { actorAuthorityContext, persistAuthoritativeIntake, priorIntakeResponse } from "@/lib/control-intake-store";
import { contentHash } from "@/lib/control-plane";
import { json, problem } from "@/lib/json";
import { analyzeIntakeThroughOrchestrator } from "@/lib/orchestrator-client";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ studyId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { studyId } = await params;
  const { requireUser } = await import("@/lib/api");
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  try {
    const { assertStudyAccess } = await import("@/lib/rbac");
    await assertStudyAccess(authResult.userId, studyId, "read");
    const decisions = await prisma.decisionRecord.findMany({
      where: { studyId, decisionType: "AUTHORITATIVE_INTAKE" },
      orderBy: { createdAt: "desc" },
      take: 100
    });
    return json({ decisions });
  } catch (error) {
    return controlError(error);
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const { studyId } = await params;
  try {
    const context = await controlRequestContext(request, studyId, "runAgent");
    if ("response" in context) return context.response;
    const parsed = authoritativeIntakeSchema.parse(await request.json());
    const requestHash = contentHash(parsed);
    const prior = await priorIntakeResponse(context.mutation, requestHash);
    if (prior) return json(prior);

    // A request the deterministic cascade would already reject/stop/redirect must never
    // reach the model first just because the model call happens to run before that rule
    // does — so the FULL cascade (not just the intake quarantine check) gates whether the
    // orchestrator is consulted at all.
    const deterministic = resolveDeterministicIntake(parsed);
    let advisoryResult: Awaited<ReturnType<typeof analyzeIntakeThroughOrchestrator>> | undefined;
    if (!deterministic) {
      const authority = await actorAuthorityContext(studyId, context.userId);
      advisoryResult = await analyzeIntakeThroughOrchestrator({
        profile: parsed.profile,
        intake: {
          actor: JSON.stringify(authority),
          studyContext: parsed.studyContext,
          prompt: parsed.requestText,
          fixtureName: parsed.attachments.map(({ name }) => name).join(", ") || "no-attachment",
          fixtureContent: parsed.attachments.map(({ name, content }) => `--- ${name} ---\n${content ?? "[content unavailable; hash only]"}`).join("\n")
        }
      });
    }
    const resolution = deterministic ?? resolveAuthoritativeIntake(parsed, advisoryResult?.output);
    const result = await persistAuthoritativeIntake({
      context: context.mutation,
      request: parsed,
      requestHash,
      resolution,
      advisory: advisoryResult?.output,
      execution: advisoryResult?.execution
    });
    await audit({
      actorUserId: context.userId,
      studyId,
      action: "control.intake.authoritative",
      targetType: "DecisionRecord",
      targetId: typeof result === "object" && result && "requestId" in result ? String(result.requestId) : undefined,
      request,
      metadata: { inputHash: requestHash, authoritativeLayer: resolution.authoritativeLayer, modelConsulted: Boolean(advisoryResult) }
    });
    return json(result, { status: 201 });
  } catch (error) {
    if (error instanceof Error && /Orchestrator rejected|orchestrator is not configured|model.*access|model_not_found/i.test(error.message)) {
      return problem(503, "The configured coordinator profile is unavailable; no fallback model was used.", "provider_unavailable");
    }
    return controlError(error);
  }
}
