/**
 * GET /api/v1/studies/[studyId]/runs/[jobId]/logs
 *
 * Stored run log (log.txt from the synced result). Study managers only ("manage"): site operators and other roles get
 * 403 before anything is looked up. Text is size-capped and secret-looking strings are masked.
 */
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { sha256 } from "@/lib/crypto";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { redactLogText } from "@/lib/run-evidence";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { readObject } from "@/lib/storage";

type Params = { params: Promise<{ studyId: string; jobId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, jobId } = await params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "manage");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const job = await prisma.nvflareJob.findFirst({
    where: { id: jobId, studyId },
    select: { id: true, status: true, result: { select: { artifacts: { where: { kind: "LOG" }, select: { storageKey: true, checksum: true, filename: true, sizeBytes: true } } } } }
  });
  if (!job) return problem(404, "Run not found.", "not_found");

  const artifact = job.result?.artifacts[0];
  if (!artifact) {
    return json({ available: false, reason: job.result ? "No log file was stored with this run's result." : "This run has no saved result, so no log was stored.", text: null });
  }
  try {
    const body = await readObject(artifact.storageKey);
    if (sha256(body) !== artifact.checksum) return json({ available: false, reason: "The stored log does not match its recorded checksum, so it is not shown.", text: null });
    const { text, truncated } = redactLogText(body.toString("utf8"));
    return json({ available: true, filename: artifact.filename, sizeBytes: artifact.sizeBytes, truncated, text }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return json({ available: false, reason: "The stored log could not be read from object storage.", text: null });
  }
}
