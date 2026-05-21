"use client";

import { CheckOutlined } from "@ant-design/icons";
import { Fragment } from "react";

type IntakeStep = {
  title: string;
  description: string;
  state?: "complete" | "current" | "upcoming";
};

export function IntakeSteps({ steps }: { steps: IntakeStep[] }) {
  return (
    <div className="fedlify-intake-steps" aria-label="Study intake steps">
      {steps.map((step, index) => (
        <Fragment key={step.title}>
          {index > 0 ? <div className="fedlify-intake-line" /> : null}
          <div
            className={[
              "fedlify-intake-step",
              step.state === "complete" ? "is-complete" : null,
              step.state === "current" ? "is-current" : null
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <span>{step.state === "complete" ? <CheckOutlined /> : index + 1}</span>
            <div>
              <strong>{step.title}</strong>
              <p>{step.description}</p>
            </div>
          </div>
        </Fragment>
      ))}
    </div>
  );
}
