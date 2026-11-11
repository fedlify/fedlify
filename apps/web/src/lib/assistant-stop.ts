/**
 * What gets stored, and what comes back, when the control plane pauses an assistant turn (enforced studies only).
 *
 * The rule: the person's text is never kept once it was flagged. A flagged message is replaced by a short note in the
 * thread; a message that could not be checked is not stored at all. An assistant NOTICE turn carries the stop
 * (payload.stop) so the screen can show "Paused: needs your decision".
 */

import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { appendTurn, turnDto } from "@/lib/agent-thread-store";
import type { AssistantGate } from "@/lib/assistant-control";
import type { StopEventData, TurnDto } from "@/lib/agent-thread-types";
import type { StopPayload } from "@/lib/terms";

export const AGENT_STOPPED_ACTION = "pipeline_project.agent_stopped";

type BlockedGate = Extract<AssistantGate, { enforced: true; blocked: true }>;

export type StoredStop = {
  stop: StopPayload;
  userTurn: TurnDto | null;
  noticeTurn: TurnDto;
  event: StopEventData;
};

/**
 * Store the withheld note (when the message was flagged and a user turn applies) and the NOTICE turn, link both to the
 * work item, and audit the stop with ids and codes only. Throws if the notice cannot be stored; the caller then answers 503.
 */
export async function storeStop(input: {
  gate: BlockedGate;
  request: NextRequest;
  userId: string;
  orgId: string;
  studyId: string;
  projectId: string;
  threadId: string;
  /** The message turn to replace with the withheld note. Null when no user turn applies (answers, code from an approved plan). */
  userTurn: { clientTurnId: string | null } | null;
  planId?: string | null;
  contextHash?: string | null;
  baseCommit?: string | null;
}): Promise<StoredStop> {
  const { gate } = input;
  let userRow: Awaited<ReturnType<typeof appendTurn>>["turn"] | null = null;
  if (input.userTurn && gate.withheld) {
    // Only the note is stored: no text, no file path, no selection.
    userRow = (await appendTurn({ threadId: input.threadId, role: "USER", content: gate.withheld, actorUserId: input.userId, clientTurnId: input.userTurn.clientTurnId })).turn;
  }
  const notice = (
    await appendTurn({
      threadId: input.threadId,
      role: "ASSISTANT",
      kind: "NOTICE",
      content: `${gate.stop.title}. ${gate.stop.why}`,
      payload: { stop: gate.stop },
      status: "done",
      planId: input.planId ?? null,
      contextHash: input.contextHash ?? null,
      baseCommit: input.baseCommit ?? null
    })
  ).turn;
  await gate.link([userRow?.id, notice.id].filter((id): id is string => Boolean(id)));
  await audit({
    actorUserId: input.userId,
    orgId: input.orgId,
    studyId: input.studyId,
    action: AGENT_STOPPED_ACTION,
    targetType: "PipelineProject",
    targetId: input.projectId,
    metadata: { threadId: input.threadId, code: gate.stop.code, codes: gate.stop.codes ?? [], userTurnId: userRow?.id ?? null, noticeTurnId: notice.id, workItemId: gate.workItemId },
    request: input.request
  }).catch(() => undefined);
  const noticeTurn = turnDto(notice);
  return {
    stop: gate.stop,
    userTurn: userRow ? turnDto(userRow) : null,
    noticeTurn,
    event: { threadId: input.threadId, turnId: noticeTurn.id, seq: noticeTurn.seq, userTurnId: userRow?.id ?? null, stop: gate.stop }
  };
}

const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" };

/** The stop as an event stream that ends cleanly: [fedlify.turn,] fedlify.stop, fedlify.done. */
export function stopStream(stored: StoredStop): Response {
  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (stored.userTurn) {
        send(controller, { type: "fedlify.turn", threadId: stored.event.threadId, userTurnId: stored.userTurn.id, userSeq: stored.userTurn.seq, assistantTurnId: stored.noticeTurn.id, assistantSeq: stored.noticeTurn.seq });
      }
      send(controller, { type: "fedlify.stop", ...stored.event });
      send(controller, { type: "fedlify.done", turnId: stored.noticeTurn.id });
      controller.close();
    }
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
