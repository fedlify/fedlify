import { ZodError } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { mutationHeaders } from "@/lib/control-plane";
import { problem } from "@/lib/json";
import { assertStudyAccess, isForbiddenError, type StudyAction } from "@/lib/rbac";

type ControlRequestResult =
  | { response: Response }
  | {
      userId: string;
      mutation: { studyId: string; actorUserId: string; idempotencyKey: string; expectedVersion: number };
    };

export async function controlRequestContext(
  request: NextRequest,
  studyId: string,
  action: StudyAction
): Promise<ControlRequestResult> {
  const authResult = await requireUser();
  if ("response" in authResult) return { response: authResult.response! };
  await assertStudyAccess(authResult.userId, studyId, action);
  const headers = mutationHeaders(request.headers);
  return {
    userId: authResult.userId,
    mutation: {
      studyId,
      actorUserId: authResult.userId,
      idempotencyKey: headers.idempotencyKey,
      expectedVersion: headers.expectedVersion
    }
  };
}

export function controlError(error: unknown): Response {
  if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
  if (error instanceof ZodError) return problem(400, error.issues[0]?.message ?? "Invalid request.", "validation_error");
  if (error instanceof Error && error.message.includes("version conflict")) return problem(409, error.message, "version_conflict");
  if (error instanceof Error && error.message.includes("Idempotency key")) return problem(409, error.message, "idempotency_conflict");
  if (error instanceof Error && error.message.includes("not found")) return problem(404, error.message, "not_found");
  return problem(422, error instanceof Error ? error.message : "Control-plane request failed.", "control_plane_rejected");
}
