"use client";

import { Alert, Button, Checkbox, Popconfirm, Tag, Typography } from "antd";
import { useState } from "react";
import { ApprovalLine, SecondCheckBanner } from "@/components/AssistantControlParts";
import type { PlanDto } from "@/lib/agent-thread-types";
import { isEnforced, reasonRequired } from "@/lib/assistant-control-client";
import { PLAN_STATUS_LABEL, assumptionsNeedingAck, canApprovePlan, effectivePlanStatus, initialApprovedSteps, toggleStep } from "@/lib/agent-thread-client";

const STATUS_COLOR: Record<string, string> = { DRAFT: "purple", APPROVED: "blue", EXECUTED: "green", STALE: "orange", REJECTED: "default", SUPERSEDED: "default" };

/** A plan inline in the chat: toggle steps, acknowledge assumptions, approve. Approval is recorded intent; the diff is still reviewed and accepted separately. */
export function PlanStepsCard({
  plan,
  head,
  canDecide,
  autoCode,
  busy,
  error,
  onApprove,
  onReject,
  onRevise,
  onWriteCode,
  onReplan,
  controlMode,
  verifying = false,
  onRetryCheck
}: {
  plan: PlanDto;
  head: string | null;
  canDecide: boolean;
  /** Agent mode: approving also starts writing the code. Plan mode: approval only, code is a separate click. */
  autoCode: boolean;
  busy: boolean;
  error?: string;
  onApprove: (approvedStepIds: string[], ackAssumptions: string[]) => void;
  onReject: () => void;
  onRevise: () => void;
  onWriteCode: () => void;
  onReplan: () => void;
  /** "enforce" when the study enforces the control plane. Without it (and without control fields on the plan) nothing extra shows. */
  controlMode?: "enforce";
  /** The client is waiting for the AI second check. */
  verifying?: boolean;
  onRetryCheck?: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(() => initialApprovedSteps(plan));
  const [acked, setAcked] = useState<string[]>([]);
  const status = effectivePlanStatus(plan, head);
  const editable = status === "DRAFT" && canDecide;
  const chosen = status === "DRAFT" ? selected : plan.approvedStepIds ?? selected;
  const missing = assumptionsNeedingAck(plan.assumptions, acked);
  const enforced = isEnforced(plan, controlMode);
  // When the second check did not pass the person is asked for a reason, so a plain button opens that dialog instead of a confirm bubble.
  const needsReason = reasonRequired(enforced, plan.verificationStatus);
  const showCheck = enforced && (status === "DRAFT" || status === "APPROVED");
  return (
    <div className="fedlify-ws-card" role="group" aria-label={`Plan version ${plan.version}`} data-testid="plan-card">
      <div className="fedlify-ws-card-head">
        <strong>{`Plan v${plan.version}`}</strong>
        <Tag color={STATUS_COLOR[status]}>{PLAN_STATUS_LABEL[status]}</Tag>
      </div>
      <p className="fedlify-ws-msg-text">{plan.summary}</p>
      <ul className="fedlify-ws-plan-steps">
        {plan.steps.map((step, i) => (
          <li key={step.id}>
            <Checkbox checked={chosen.includes(step.id)} disabled={!editable || busy} onChange={() => setSelected((s) => toggleStep(s, step.id))}>
              <strong>{`${i + 1}. ${step.title}`}</strong>
              {step.optional ? <em className="fedlify-muted"> (optional)</em> : null}
              {step.risk !== "low" ? <Tag color={step.risk === "high" ? "red" : "gold"}>{`${step.risk} risk`}</Tag> : null}
            </Checkbox>
            <div className="fedlify-ws-plan-paths">
              <em>{step.action}</em> {step.paths.map((path) => <code key={path} title={path}>{path}</code>)}
            </div>
            {step.rationale ? <Typography.Text className="fedlify-muted">{step.rationale}</Typography.Text> : null}
          </li>
        ))}
      </ul>
      {plan.assumptions.length > 0 ? (
        <div className="fedlify-ws-plan-assumptions">
          <Typography.Text strong>Assumptions</Typography.Text>
          {plan.assumptions.map((item) =>
            item.needsAck && status === "DRAFT" ? (
              <Checkbox key={item.id} checked={acked.includes(item.id)} disabled={!editable || busy} onChange={() => setAcked((a) => toggleStep(a, item.id))}>
                {item.text} <em className="fedlify-muted">(confirm)</em>
              </Checkbox>
            ) : (
              <div key={item.id} className="fedlify-muted">{item.text}</div>
            )
          )}
        </div>
      ) : null}
      {showCheck ? <SecondCheckBanner status={plan.verificationStatus} findings={plan.findings ?? []} working={verifying} onRetry={() => onRetryCheck?.()} /> : null}
      {enforced && plan.approval && (status === "APPROVED" || status === "EXECUTED") ? <ApprovalLine approval={plan.approval} /> : null}
      {status === "STALE" ? <Alert type="warning" showIcon message="The saved code or the requirements changed after this plan was written." description="Re-plan from the latest commit before approving." /> : null}
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <div className="fedlify-ws-card-actions">
        {editable ? (
          <>
            <Button size="small" onClick={onRevise} disabled={busy}>Revise</Button>
            <Button size="small" danger onClick={onReject} disabled={busy}>Reject</Button>
            {needsReason ? (
              <Button size="small" type="primary" loading={busy} disabled={!canApprovePlan(plan, selected, acked)} title={missing.length ? "Confirm the assumptions first" : undefined} onClick={() => onApprove(selected, acked)}>
                {autoCode ? "Approve and write code" : "Approve plan"}
              </Button>
            ) : (
              <Popconfirm
                title={autoCode ? "Approve this plan and write the code?" : "Approve this plan?"}
                description="This records your approval of the plan only. You still review the diff and accept it before anything is saved."
                okText="Approve"
                disabled={!canApprovePlan(plan, selected, acked)}
                onConfirm={() => onApprove(selected, acked)}
              >
                <Button size="small" type="primary" loading={busy} disabled={!canApprovePlan(plan, selected, acked)} title={missing.length ? "Confirm the assumptions first" : undefined}>
                  {autoCode ? "Approve and write code" : "Approve plan"}
                </Button>
              </Popconfirm>
            )}
          </>
        ) : null}
        {status === "APPROVED" && canDecide ? (
          <Button size="small" type="primary" loading={busy} onClick={onWriteCode}>Write code</Button>
        ) : null}
        {status === "STALE" && canDecide ? (
          <Button size="small" type="primary" disabled={busy} onClick={onReplan}>Continue from head</Button>
        ) : null}
      </div>
    </div>
  );
}
