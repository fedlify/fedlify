import argon2 from "argon2";
import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { refundRateLimit, rateLimit } from "@/lib/rate-limit";

// Step-up: the signed-in user re-enters the account password before a site kit is created or downloaded. A hijacked
// web session alone must not be enough to obtain a kit (the kit holds the site's client key and a registry login).

export const STEP_UP_MAX_FAILURES = 5;
export const STEP_UP_WINDOW_MS = 15 * 60 * 1000;

export type StepUpContext = {
  userId: string;
  password: unknown;
  /** Audit routing and the action prefix, e.g. "site.join_package.create". */
  action: string;
  orgId?: string | null;
  studyId?: string | null;
  targetType: string;
  targetId?: string | null;
  request: NextRequest;
};

export type StepUpResult = { ok: true } | { ok: false; response: Response };

async function deny(context: StepUpContext, status: number, code: string, message: string): Promise<StepUpResult> {
  // The password (right or wrong) is never part of the audit metadata.
  await audit({
    actorUserId: context.userId,
    orgId: context.orgId,
    studyId: context.studyId,
    action: `${context.action}_failed`,
    targetType: context.targetType,
    targetId: context.targetId,
    metadata: { reason: code, step: "step_up" },
    request: context.request
  });
  return { ok: false, response: problem(status, message, code) };
}

export async function verifyStepUp(context: StepUpContext): Promise<StepUpResult> {
  const key = `kit-step-up:${context.userId}`;
  // The attempt is taken from the budget BEFORE any await, and given back on success. Check and consume are one
  // synchronous step, so N parallel guesses cannot all pass a check made before the first failure is recorded.
  // (The limiter is per process; with several replicas the effective cap is per replica.)
  if (!rateLimit(key, STEP_UP_MAX_FAILURES, STEP_UP_WINDOW_MS)) {
    return deny(context, 429, "step_up_rate_limited", "Too many failed password checks. Wait 15 minutes and try again.");
  }
  const user = await prisma.user.findUnique({ where: { id: context.userId }, select: { passwordHash: true } });
  if (!user?.passwordHash) {
    refundRateLimit(key); // not a guess
    return deny(
      context,
      403,
      "password_not_set",
      "You signed in with Google, so this account has no password to confirm with. Ask your study lead to create or download the site kit for this site."
    );
  }
  if (typeof context.password !== "string" || context.password.length === 0 || context.password.length > 1024) {
    refundRateLimit(key); // no password was tested
    return deny(context, 403, "step_up_required", "Enter your account password to continue.");
  }
  let valid = false;
  try {
    valid = await argon2.verify(user.passwordHash, context.password);
  } catch {
    valid = false;
  }
  if (!valid) return deny(context, 403, "step_up_failed", "The password is not correct.");
  refundRateLimit(key);
  return { ok: true };
}
