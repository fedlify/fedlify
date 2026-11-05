/**
 * POST /api/webhooks/run-sweep
 *
 * Called every minute by the run-sweeper CronJob (deploy/k8s/run-sweeper.yaml). Same HMAC as the Argo callback and the
 * registry sweep: header x-fedlify-signature = "sha256=" + HMAC-SHA256(ARGO_WEBHOOK_SECRET, body). Unsigned calls are
 * refused even if the secret is unset. It reconciles every active published run (status, evidence capture, lost sites),
 * so a dead site is noticed and aborted after the timeout with nobody watching the page. Idempotent; returns counts only.
 */
import type { NextRequest } from "next/server";
import { verifyHmacSignature } from "@/lib/crypto";
import { json, problem } from "@/lib/json";
import { sweepRuns } from "@/lib/run-reconcile";

export async function POST(request: NextRequest) {
  const body = await request.text();
  const secret = process.env.ARGO_WEBHOOK_SECRET ?? "";
  if (!secret) return problem(503, "ARGO_WEBHOOK_SECRET is not configured.", "webhook_not_configured");
  if (!verifyHmacSignature(secret, body, request.headers.get("x-fedlify-signature"))) {
    return problem(401, "Invalid webhook signature.", "unauthorized");
  }
  return json({ ok: true, result: await sweepRuns() });
}
