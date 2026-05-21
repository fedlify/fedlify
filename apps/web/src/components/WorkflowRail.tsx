"use client";

import { CheckCircleOutlined, ClockCircleOutlined, ExclamationCircleOutlined, StopOutlined } from "@ant-design/icons";
import { Typography } from "antd";
import type { ReactNode } from "react";

export type WorkflowStepState = "done" | "current" | "waiting" | "blocked";

export type WorkflowStep = {
  label: ReactNode;
  detail?: ReactNode;
  state: WorkflowStepState;
  meta?: ReactNode;
};

export type GateItem = {
  label: ReactNode;
  detail?: ReactNode;
  passed: boolean;
};

const stateIcon: Record<WorkflowStepState, ReactNode> = {
  done: <CheckCircleOutlined />,
  current: <ClockCircleOutlined />,
  waiting: <ClockCircleOutlined />,
  blocked: <StopOutlined />
};

export function WorkflowRail({ steps }: { steps: WorkflowStep[] }) {
  return (
    <div className="fedlify-workflow-rail" aria-label="Workflow progress">
      {steps.map((step, index) => (
        <article key={`${index}-${String(step.label)}`} className={`fedlify-workflow-step is-${step.state}`}>
          <span className="fedlify-workflow-step-icon">{stateIcon[step.state]}</span>
          <span className="fedlify-workflow-step-copy">
            <Typography.Text strong>{step.label}</Typography.Text>
            {step.detail ? <Typography.Text className="fedlify-muted">{step.detail}</Typography.Text> : null}
            {step.meta ? <span className="fedlify-workflow-step-meta">{step.meta}</span> : null}
          </span>
        </article>
      ))}
    </div>
  );
}

export function GateChecklist({ items }: { items: GateItem[] }) {
  return (
    <div className="fedlify-gate-list" aria-label="Gate checklist">
      {items.map((item, index) => (
        <article key={`${index}-${String(item.label)}`} className={`fedlify-gate-item${item.passed ? " is-passed" : ""}`}>
          <span className="fedlify-gate-icon">{item.passed ? <CheckCircleOutlined /> : <ExclamationCircleOutlined />}</span>
          <span className="fedlify-gate-copy">
            <Typography.Text strong>{item.label}</Typography.Text>
            {item.detail ? <Typography.Text className="fedlify-muted">{item.detail}</Typography.Text> : null}
          </span>
        </article>
      ))}
    </div>
  );
}
