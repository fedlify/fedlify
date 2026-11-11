/**
 * POST /api/v1/studies/[studyId]/probe-executor
 *
 * Drives ONE probe through the real assistant path (the safety check, then the plan, proposal or ask runner) and
 * returns the observation that evaluation/probes/run_probes.py scores. Proposals are created but never accepted.
 *
 * OFF unless PROBE_EXECUTOR_ENABLED="true" (answers 404 otherwise). Callable only by a platform admin or with
 * "Authorization: Bearer <PROBE_EXECUTOR_TOKEN>" (acting as PROBE_EXECUTOR_USER_ID). The study must be listed by id in
 * ASSISTANT_CONTROL_ENFORCE_STUDIES: probes always run under enforcement.
 */

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { createThread, setThreadStatus } from "@/lib/agent-thread-store";
import { runAskTurn, runPlanTurn } from "@/lib/agent-thread-runner";
import { runProposal } from "@/lib/agent-proposal-run";
import { rateLimit } from "@/lib/rate-limit";
import { CONTROL_POLICY_VERSION } from "@/lib/control-plane";
import { assistantModelConfig, assistantModelRoute, effectiveControlMode } from "@/lib/runtime-config";
import { bearerMatches, executeProbe, probeExecutorEnabled, probeRequestSchema, studyListedForEnforcement, type ProbeDeps } from "@/lib/probe-executor";

type Params = { params: Promise<{ studyId: string }> };

async function readWorkItem(input: { studyId: string; sourceId: string; clientTurnId: string }) {
  const where = { studyId: input.studyId, idempotencyKey: { startsWith: `turn:${input.sourceId}:${input.clientTurnId}` } };
  const pick = { select: { id: true, status: true, controlState: true, stopCondition: true }, orderBy: { createdAt: "desc" as const } };
  // The work item is finished a moment after the answer is sent: look again briefly while it is still open.
  let row = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    row = await prisma.workItem.findFirst({ where, ...pick }).catch(() => null);
    if (row && ["COMPLETED", "CANCELLED", "EXPIRED", "FAILED"].includes(String(row.status))) break;
    if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return row ? { id: row.id, status: String(row.status), controlState: String(row.controlState), stopCondition: row.stopCondition ? String(row.stopCondition) : null } : null;
}

/** A probe token shorter than this is treated as not configured. */
const MIN_TOKEN_LENGTH = 32;
const FAILED_ATTEMPTS = 10;

function callerKey(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

const deps = (studyId: string): ProbeDeps => ({
  config: assistantModelConfig(),
  runtime: {
    buildId: (process.env.APP_BUILD_ID ?? process.env.GIT_COMMIT ?? "unknown").trim() || "unknown",
    modelRoute: assistantModelRoute(),
    controlMode: effectiveControlMode(studyId),
    policyVersion: CONTROL_POLICY_VERSION
  },
  createThread: (input) => createThread(input),
  archiveThread: async (threadId) => void (await setThreadStatus(threadId, "ARCHIVED")),
  readWorkItem,
  runPlanTurn: (input) => runPlanTurn(input),
  runProposal: (input) => runProposal(input),
  runAskTurn: (input) => runAskTurn(input)
});

export async function POST(request: NextRequest, { params }: Params) {
  if (!probeExecutorEnabled()) return problem(404, "Not found.", "not_found");
  const { studyId } = await params;

  // Authentication: the bearer token (acts as the configured user) or a signed-in platform admin.
  let userId: string | null = null;
  const header = request.headers.get("authorization");
  if (header) {
    const failKey = `probe-executor-fail:${callerKey(request)}`;
    // Failed attempts are counted per caller; once over the limit even a correct token waits for the window to pass.
    if (!rateLimit(failKey, FAILED_ATTEMPTS, 60_000, { consume: false })) return problem(429, "Too many failed attempts. Try again later.", "rate_limited");
    const configured = (process.env.PROBE_EXECUTOR_TOKEN ?? "").trim();
    if (configured.length < MIN_TOKEN_LENGTH) return problem(503, "The probe executor token is not configured.", "probe_token_missing");
    if (!bearerMatches(header, configured)) {
      rateLimit(failKey, FAILED_ATTEMPTS, 60_000);
      return problem(401, "Authentication required.", "unauthorized");
    }
    userId = (process.env.PROBE_EXECUTOR_USER_ID ?? "").trim() || null;
    if (!userId) return problem(503, "The probe executor has no user to act as.", "probe_user_missing");
    const actor = await prisma.user.findUnique({ where: { id: userId }, select: { platformRole: true } });
    if (actor?.platformRole !== "PLATFORM_ADMIN") return problem(503, "The probe executor user must be a platform admin.", "probe_user_invalid");
  } else {
    const authResult = await requireUser();
    if ("response" in authResult) return authResult.response;
    const user = await prisma.user.findUnique({ where: { id: authResult.userId }, select: { platformRole: true } });
    if (user?.platformRole !== "PLATFORM_ADMIN") return problem(403, "Only a platform admin can run probes.", "forbidden");
    userId = authResult.userId;
  }

  if (!studyListedForEnforcement(studyId)) {
    return problem(409, "Probes only run in a study that is listed for enforcement.", "enforcement_required");
  }

  const parsed = probeRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid probe request.");
  const project = await prisma.pipelineProject.findUnique({ where: { id: parsed.data.projectId }, select: { studyId: true } });
  if (!project || project.studyId !== studyId) return problem(404, "Pipeline project not found for this study.", "not_found");

  const observation = await executeProbe({ request, userId, studyId, probe: parsed.data }, deps(studyId));
  return json(observation);
}
