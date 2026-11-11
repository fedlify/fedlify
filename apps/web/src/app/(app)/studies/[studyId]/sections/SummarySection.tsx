"use client";

import { CheckCircleFilled } from "@ant-design/icons";
import { Button, message, Skeleton } from "antd";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { InlineLoadError } from "@/components/LoadStates";
import { PendingInvitationsCard } from "@/components/PendingInvitationsCard";
import { PreflightChecklist } from "@/components/PreflightChecklist";
import { toneIcon } from "@/components/PipelineRail";
import { visibleBlockers, type Step, type StartInfo, type StepsResult } from "@/lib/next-step";

function Blockers({ step }: { step: Step }) {
  const failing = visibleBlockers(step);
  if (failing.length === 0) return null;
  return <PreflightChecklist title="What is missing" result={{ ok: false, items: failing }} compact />;
}

/** Start the study: the one button, or the plain list of what is missing before it can be pressed. */
function StartCard({ start, starting, onStart }: { start: StartInfo; starting: boolean; onStart: () => void }) {
  if (start.started) return null;
  if (!start.ready) {
    return (
      <article className="fedlify-next-step-card" aria-label="Start the study">
        <h2 className="fedlify-next-step-title">Before you can start the study</h2>
        <ul className="fedlify-next-step-attention">
          {start.missing.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </article>
    );
  }
  return (
    <article className="fedlify-next-step-card is-complete" aria-label="Start the study">
      <h2 className="fedlify-next-step-title">Ready to start</h2>
      <p className="fedlify-next-step-text">
        {start.canStart ? "Everything the study needs is in place. Start the study when you are ready." : "Ask a study lead to start the study."}
      </p>
      {start.canStart ? (
        <div className="fedlify-next-step-actions">
          <Button type="primary" size="large" loading={starting} onClick={onStart}>
            Start the study
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/** The Summary page: the pending invitations, the one next step, and the six phases of the study. */
export function SummarySection({ studyId }: { studyId: string }) {
  const router = useRouter();
  const [result, setResult] = useState<StepsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

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
      setResult({ current: body.current ?? null, steps: body.steps, start: body.start });
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

  async function startStudy() {
    setStarting(true);
    try {
      const response = await fetch(`/api/v1/studies/${studyId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "activate" })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        messageApi.error(body?.error?.message ?? "The study could not be started.");
        return;
      }
      messageApi.success("The study has started.");
      await load(true);
    } catch {
      messageApi.error("The study could not be started. Check the connection and try again.");
    } finally {
      setStarting(false);
    }
  }

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
      {contextHolder}
      <PendingInvitationsCard />
      {loading && !result ? (
        <article className="fedlify-next-step-card" aria-busy="true" aria-label="Loading the next step">
          <Skeleton active paragraph={{ rows: 3 }} title={{ width: "40%" }} />
        </article>
      ) : error && !result ? (
        <InlineLoadError title="The next step could not be loaded" message={error} onRetry={() => void load()} />
      ) : result ? (
        <>
          {result.start ? <StartCard start={result.start} starting={starting} onStart={() => void startStudy()} /> : null}
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
          <nav className="fl-grid" style={{ "--grid-min": "260px" } as CSSProperties} aria-label="Study steps">
            {result.steps.map((step, position) => (
              <Link
                key={step.key}
                href={step.href}
                aria-label={`Open ${step.title}`}
                className={["fl-card", "is-link", "fl-step-tile", `is-${step.tone}`, position === index ? "is-current" : ""].filter(Boolean).join(" ")}
              >
                <span className="fl-step-tile-icon" aria-hidden>{toneIcon[step.tone]}</span>
                <span className="fl-step-tile-copy">
                  <strong>{position + 1}. {step.title}</strong>
                  <span>{step.status}</span>
                </span>
              </Link>
            ))}
          </nav>
        </>
      ) : null}
    </div>
  );
}
