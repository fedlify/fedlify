"use client";

import { CheckCircleFilled, ClockCircleOutlined, CloseCircleFilled, ExclamationCircleFilled, LoadingOutlined, RightOutlined } from "@ant-design/icons";
import { Button, Tooltip } from "antd";
import type { ReactNode } from "react";
import type { StageKey, StageSummary, StageTone } from "@/lib/pipeline-stage";

type PipelineRailProps = {
  stages: StageSummary[];
  /** The stage whose panel is open. */
  activeStage: StageKey;
  /** The stage the project is actually waiting on; its action is the primary button. */
  currentStage: StageKey;
  onSelect: (stage: StageKey) => void;
  onAction: (stage: StageSummary) => void;
};

const toneIcon: Record<StageTone, ReactNode> = {
  idle: <ClockCircleOutlined />,
  active: <LoadingOutlined spin />,
  ok: <CheckCircleFilled />,
  warn: <ExclamationCircleFilled />,
  error: <CloseCircleFilled />
};

export function PipelineRail({ stages, activeStage, currentStage, onSelect, onAction }: PipelineRailProps) {
  return (
    <nav className="fedlify-ws-rail" aria-label="Pipeline stages">
      {stages.map((stage, index) => {
        const action = stage.action;
        const button = action ? (
          <Button
            size="small"
            type={stage.key === currentStage ? "primary" : "default"}
            loading={action.loading}
            disabled={Boolean(action.disabledReason)}
            onClick={() => onAction(stage)}
          >
            {action.label}
          </Button>
        ) : null;
        return (
          <div
            key={stage.key}
            className={["fedlify-ws-stage", `is-${stage.tone}`, stage.key === activeStage ? "is-open" : "", stage.key === currentStage ? "is-current" : ""].filter(Boolean).join(" ")}
          >
            <button type="button" className="fedlify-ws-stage-main" onClick={() => onSelect(stage.key)} aria-current={stage.key === activeStage ? "step" : undefined}>
              <span className="fedlify-ws-stage-icon" aria-hidden>{toneIcon[stage.tone]}</span>
              <span className="fedlify-ws-stage-copy">
                <strong>{index + 1}. {stage.title}</strong>
                <span>{stage.status}</span>
                {stage.detail || action?.disabledReason ? <span className="fedlify-ws-stage-detail">{action?.disabledReason ?? stage.detail}</span> : null}
              </span>
            </button>
            {button ? (
              <div className="fedlify-ws-stage-action">
                {action?.disabledReason ? <Tooltip title={action.disabledReason}><span>{button}</span></Tooltip> : button}
              </div>
            ) : null}
            {index < stages.length - 1 ? <RightOutlined className="fedlify-ws-stage-arrow" aria-hidden /> : null}
          </div>
        );
      })}
    </nav>
  );
}
