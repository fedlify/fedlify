"use client";

import { Alert, Button, Input, Modal, Spin, Typography } from "antd";
import { useEffect, useState } from "react";
import { Details } from "@/components/Details";
import {
  FINDING_KIND_LABEL,
  MAX_REASON_CHARS,
  MIN_REASON_CHARS,
  approvalLabel,
  cleanReason,
  secondCheckView,
  validReason,
  type Approval,
  type Finding,
  type VerificationStatus
} from "@/lib/assistant-control-client";
import { SECOND_CHECK_TEXT, type StopPayload } from "@/lib/terms";

/** "Paused: needs your decision" card shown when the safety check stopped the assistant. */
export function StopNoticeCard({ stop }: { stop: StopPayload }) {
  const codes = stop.codes && stop.codes.length > 0 ? stop.codes : [stop.code];
  // A check that simply could not run needs no decision from anyone: the person only has to try again.
  const header = stop.code === "CHECK_UNAVAILABLE" ? "Paused: please try again" : "Paused: needs your decision";
  return (
    <div className="fedlify-ws-card" role="group" aria-label={header} data-testid="stop-card">
      <Alert
        type="warning"
        showIcon
        message={header}
        description={
          <div>
            <p><strong>{stop.title}</strong></p>
            <p>{stop.why}</p>
            <p><strong>Who decides:</strong> {stop.whoDecides}</p>
            <p><strong>What to do next:</strong> {stop.nextAction}</p>
          </div>
        }
      />
      <Details items={[{ label: "Reason codes", value: codes.join(", "), copyText: codes.join(", ") }]} />
    </div>
  );
}

/** The AI second check on a plan or a change: checking, passed, things to look at, or could not check (with Retry). */
export function SecondCheckBanner({
  status,
  findings,
  working,
  onRetry
}: {
  status: VerificationStatus | null | undefined;
  findings: Finding[];
  /** The client is waiting for the check right now. */
  working: boolean;
  onRetry: () => void;
}) {
  const view = secondCheckView(status, findings, working);
  return (
    <div className="fedlify-ws-secondcheck" data-testid="second-check" data-status={status ?? "none"}>
      <Alert
        type={view.tone}
        showIcon
        icon={view.checking ? <Spin size="small" /> : undefined}
        message={view.label}
        description={
          view.findings.length > 0 || view.showAdvice ? (
            <div>
              {view.findings.length > 0 ? (
                <ul>
                  {view.findings.map((finding, index) => (
                    <li key={`${finding.kind}-${index}`}>
                      <strong>{FINDING_KIND_LABEL[finding.kind]}:</strong> {finding.text}
                    </li>
                  ))}
                </ul>
              ) : null}
              {view.showAdvice ? <Typography.Text className="fedlify-muted">{SECOND_CHECK_TEXT.advice}</Typography.Text> : null}
            </div>
          ) : undefined
        }
        action={view.canRetry ? <Button size="small" onClick={onRetry}>Retry</Button> : undefined}
      />
    </div>
  );
}

/** "Approved by <name>" with "(self-approved)" when it applies. */
export function ApprovalLine({ approval }: { approval: Approval | null | undefined }) {
  const text = approvalLabel(approval);
  if (!text) return null;
  return <Typography.Text className="fedlify-muted" data-testid="approval-line">{text}</Typography.Text>;
}

/** Asks "Why are you going ahead?" when the second check did not pass. The reason is kept with the decision. */
/** What each button does, shown in the reason dialog in place of the short confirm text. */
export const PLAN_APPROVE_EXPLAIN = "Approving records your approval of the plan only. You still review the changes and accept them before anything is saved.";
export const ACCEPT_EXPLAIN = "Accepting saves the changes to the pipeline code. Nothing is published or run.";

export function ProceedReasonModal({
  open,
  title,
  explain,
  note,
  okText,
  busy,
  onCancel,
  onConfirm
}: {
  open: boolean;
  title: string;
  /** What the button does. */
  explain?: string;
  /** What the second check said, in plain words. */
  note?: string;
  okText: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (open) setText("");
  }, [open]);
  return (
    <Modal open={open} title={title} okText={okText} cancelText="Cancel" okButtonProps={{ disabled: !validReason(text), loading: busy }} onCancel={onCancel} onOk={() => onConfirm(cleanReason(text))} destroyOnHidden>
      {explain ? <p>{explain}</p> : null}
      {note ? <p>{note}</p> : null}
      <Typography.Text strong>{SECOND_CHECK_TEXT.reasonPrompt}</Typography.Text>
      <Input.TextArea
        value={text}
        maxLength={MAX_REASON_CHARS}
        autoSize={{ minRows: 3, maxRows: 8 }}
        onChange={(event) => setText(event.target.value)}
        aria-label={SECOND_CHECK_TEXT.reasonPrompt}
        placeholder="Write a short reason. It is kept with your decision."
      />
      <Typography.Text className="fedlify-muted">{`At least ${MIN_REASON_CHARS} characters. Do not paste secrets or patient data.`}</Typography.Text>
    </Modal>
  );
}
