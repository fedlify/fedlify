/**
 * POST /api/webhooks/registry-sweep
 *
 * Called every 15 minutes by the registry-sweeper CronJob (deploy/k8s/registry-sweeper.yaml). Same HMAC as the Argo
 * callback: header x-fedlify-signature = "sha256=" + HMAC-SHA256(ARGO_WEBHOOK_SECRET, body). Unsigned calls are refused
 * even if the secret is unset. Idempotent; returns counts only, never robot names or secrets.
 */
import type { NextRequest } from "next/server";
import { verifyHmacSignature } from "@/lib/crypto";
import { json, problem } from "@/lib/json";
import { HarborError } from "@/lib/harbor-registry";
import { sweepRegistry } from "@/lib/registry-access";

export async function POST(request: NextRequest) {
  const body = await request.text();
  const secret = process.env.ARGO_WEBHOOK_SECRET ?? "";
  if (!secret) return problem(503, "ARGO_WEBHOOK_SECRET is not configured.", "webhook_not_configured");
  if (!verifyHmacSignature(secret, body, request.headers.get("x-fedlify-signature"))) {
    return problem(401, "Invalid webhook signature.", "unauthorized");
  }
  try {
    return json({ ok: true, result: await sweepRegistry() });
  } catch (error) {
    if (error instanceof HarborError) return problem(502, error.message, "registry_unavailable");
    throw error;
  }
}
