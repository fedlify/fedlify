"use client";

import { CheckCircleFilled } from "@ant-design/icons";
import { Button, Skeleton } from "antd";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { InlineLoadError } from "@/components/LoadStates";
import { PendingInvitationsCard } from "@/components/PendingInvitationsCard";
import { PreflightChecklist } from "@/components/PreflightChecklist";
import { toneIcon } from "@/components/PipelineRail";
import { visibleBlockers, type Step, type StepKey, type StepsResult } from "@/lib/next-step";

/** Where "Open" goes for a step when it has no action of its own (done steps, or a person without permission). */
function stepOpenHref(studyId: string, key: StepKey) {
  switch (key) {
    case "authorize":
    case "prepare":
      return `/studies/${studyId}?section=protocol`;
    case "deploy":
      return `/studies/${studyId}?section=sites`;
    case "validate":
      return `/studies/${studyId}/runs`;
    default:
      return `/studies/${studyId}/projects`;
  }
}

function Blockers({ step }: { step: Step }) {
  const failing = visibleBlockers(step);
  if (failing.length === 0) return null;
  return <PreflightChecklist title="What is missing" result={{ ok: false, items: failing }} compact />;
}

/** The Summary page: the pending invitations, the one next step, and the six phases of the study. */
export function SummarySection({ studyId }: { studyId: string }) {
  const router = useRouter();
  const [result, setResult] = useState<StepsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
    try {
      const response = await fetch(`/api/v1/studies/${studyId}/next-step`, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.steps) {
        setError(body?.error?.message ?? "The study steps could not be loaded.");
        return;
      }
      setResult({ current: body.current ?? null, steps: body.steps });
      setError(null);
    } catch {
      setError("The study steps could not be loaded. Check the connection and try again.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [studyId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the page current while something is moving (a publish, a run, sites joining): refresh quietly while it is visible.
  const watching = result?.steps.some((step) => step.tone === "active" || (step.key === "deploy" && step.tone !== "ok")) ?? false;
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 15_000);
    return () => clearInterval(timer);
  }, [watching, load]);

  const current = result?.steps.find((step) => step.key === result.current) ?? null;
  // A study with a released model can still have steps that need a look before the next run.
  const attention = result && !current ? result.steps.filter((step) => step.tone === "warn" || step.tone === "error") : [];
  const index = current && result ? result.steps.indexOf(current) : -1;

  return (
    <div className="fedlify-section-stack">
      <PendingInvitationsCard />
      {loading && !result ? (
        <article className="fedlify-next-step-card" aria-busy="true" aria-label="Loading the next step">
          <Skeleton active paragraph={{ rows: 3 }} title={{ width: "40%" }} />
        </article>
      ) : error && !result ? (
        <InlineLoadError title="The next step could not be loaded" message={error} onRetry={() => void load()} />
      ) : result ? (
        <>
          <article className={`fedlify-next-step-card${current || attention.length ? "" : " is-complete"}`}>
            {current ? (
              <>
                <span className="fedlify-next-step-eyebrow">Next step</span>
                <h2 className="fedlify-next-step-title">{current.title}</h2>
                {current.detail ? <p className="fedlify-next-step-text">{current.detail}</p> : null}
                <Blockers step={current} />
                <div className="fedlify-next-step-actions">
                  {current.action ? (
                    <Button type="primary" size="large" onClick={() => router.push(current.action!.href)}>
                      {current.action.label}
                    </Button>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <span className="fedlify-next-step-eyebrow">{attention.length ? "Released, with things to check" : "All steps done"}</span>
                <h2 className="fedlify-next-step-title">
                  <CheckCircleFilled className="fedlify-next-step-done-icon" aria-hidden /> This study has a released model
                </h2>
                {attention.length ? (
                  <>
                    <p className="fedlify-next-step-text">Before the next run, check {attention.length === 1 ? "this step" : "these steps"}:</p>
                    <ul className="fedlify-next-step-attention">
                      {attention.map((step) => (
                        <li key={step.key}>
                          <strong>{step.title}:</strong> {step.detail ?? step.status}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="fedlify-next-step-text">Every step is complete. You can review the results or start another run from Code & run.</p>
                )}
                <div className="fedlify-next-step-actions">
                  {attention[0]?.action ? (
                    <Button type="primary" onClick={() => router.push(attention[0].action!.href)}>
                      {attention[0].action.label}
                    </Button>
                  ) : null}
                  <Button onClick={() => router.push(`/studies/${studyId}/runs`)}>Open results</Button>
                </div>
              </>
            )}
          </article>
          {error ? <InlineLoadError title="The steps could not be refreshed" message={error} onRetry={() => void load()} /> : null}
          <nav className="fedlify-next-step-steps" aria-label="Study steps">
            {result.steps.map((step, position) => (
              <div
                key={step.key}
                className={["fedlify-ws-stage", `is-${step.tone}`, position === index ? "is-current" : ""].filter(Boolean).join(" ")}
              >
                <div className="fedlify-ws-stage-main fedlify-next-step-row">
                  <span className="fedlify-ws-stage-icon" aria-hidden>{toneIcon[step.tone]}</span>
                  <span className="fedlify-ws-stage-copy">
                    <strong>{position + 1}. {step.title}</strong>
                    <span>{step.status}</span>
                  </span>
                </div>
                <div className="fedlify-ws-stage-action">
                  <Link href={step.action?.href ?? stepOpenHref(studyId, step.key)} aria-label={`Open ${step.title}`}>Open</Link>
                </div>
              </div>
            ))}
          </nav>
        </>
      ) : null}
    </div>
  );
}
