/**
 * GET /api/v1/studies/[studyId]/runs/[jobId]/model-card
 *
 * The released model card (stored MODEL_CARD artifact of the release, checksum verified), or a clearly labelled
 * preview built from stored values when the run is saved but not released. Not available to site-scope viewers
 * because the card contains every site's metrics.
 */
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { sha256 } from "@/lib/crypto";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { buildCardForJob, resolveRunViewer } from "@/lib/run-evidence";
import { readObject } from "@/lib/storage";

type Params = { params: Promise<{ studyId: string; jobId: string }> };

async function readVerified(artifact: { storageKey: string; checksum: string } | undefined) {
  if (!artifact) return null;
  try {
    const body = await readObject(artifact.storageKey);
    return sha256(body) === artifact.checksum ? body : null;
  } catch {
    return null;
  }
}

export async function GET(_request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, jobId } = await params;

  const viewer = await resolveRunViewer(authResult.userId, studyId);
  if (!viewer) return problem(403, "You do not have permission to perform this action for this study.", "forbidden");
  if (viewer.scope !== "full") return problem(403, "The model card is not available to site operators.", "forbidden");

  const job = await prisma.nvflareJob.findFirst({
    where: { id: jobId, studyId },
    select: { id: true, result: { select: { artifacts: true, modelRelease: { select: { version: true, status: true, artifacts: true } } } } }
  });
  if (!job) return problem(404, "Run not found.", "not_found");
  if (!job.result) return json({ card: null, kind: null, reason: "This run has no saved model, so there is no model card." });

  const release = job.result.modelRelease;
  const storedCard = await readVerified(release?.artifacts.find((a) => a.kind === "MODEL_CARD"));
  if (storedCard) {
    try {
      return json({ card: JSON.parse(storedCard.toString("utf8")), kind: "released" }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      // fall through to a preview
    }
  }
  const metrics = await readVerified(job.result.artifacts.find((a) => a.kind === "ROUND_METRICS"));
  const modelArtifact = job.result.artifacts.find((a) => a.kind === "AGGREGATED_MODEL");
  const card = await buildCardForJob(job.id, {
    modelVersion: release?.version ?? null,
    releaseStatus: release?.status ?? null,
    metricsBody: metrics,
    metricsChecksum: metrics ? sha256(metrics) : null,
    modelChecksum: modelArtifact?.checksum ?? null,
    approvers: []
  });
  return json(
    { card, kind: "preview", reason: release ? "This release has no stored model card (it predates model cards). The card below is rebuilt now from stored values and is not part of the release." : "Preview only. A model card is written into the release when the model is released." },
    { headers: { "Cache-Control": "no-store" } }
  );
}
