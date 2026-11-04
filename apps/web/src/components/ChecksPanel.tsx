"use client";

import { CheckCircleFilled, CloseCircleFilled, MinusCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Typography } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RepoCheckReport } from "@/lib/repo-checks";

type ChecksResponse = RepoCheckReport & { commit: string | null; fileCount: number };

type ChecksPanelProps = {
  studyId: string;
  projectId: string;
  /** Re-run automatically when the saved commit changes. */
  commit: string | null;
  onFailureCount?: (count: number) => void;
};

export function ChecksPanel({ studyId, projectId, commit, onFailureCount }: ChecksPanelProps) {
  const [report, setReport] = useState<ChecksResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const run = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/studies/${studyId}/pipeline-projects/${projectId}/agent/checks`, { method: "POST", cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? `Checks failed (${response.status}).`);
      if (id !== requestId.current) return;
      setReport(body as ChecksResponse);
      onFailureCount?.((body as ChecksResponse).checks.filter((check) => check.status === "fail").length);
    } catch (runError) {
      if (id === requestId.current) setError(runError instanceof Error ? runError.message : "Checks could not run.");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyId, projectId]);

  useEffect(() => {
    setReport(null);
    void run();
  }, [run, commit]);

  const stale = Boolean(report && commit && report.commit && report.commit !== commit);

  return (
    <div className="fedlify-ws-checks">
      <div className="fedlify-ws-section-title">
        <strong>Checks</strong>
        <Button size="small" type="text" icon={<ReloadOutlined />} loading={loading} onClick={() => void run()} aria-label="Run checks" title="Run checks on the saved commit" />
      </div>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {report ? (
        <ul className="fedlify-ws-check-list">
          {report.checks.map((check) => (
            <li key={check.id} className={`is-${check.status}`}>
              <span className="fedlify-ws-check-icon" aria-hidden>
                {check.status === "pass" ? <CheckCircleFilled /> : check.status === "fail" ? <CloseCircleFilled /> : <MinusCircleOutlined />}
              </span>
              <div>
                <span>{check.label}</span>
                <span className="fedlify-ws-visually-hidden">{check.status === "pass" ? " passed" : check.status === "fail" ? " failed" : " not run here"}</span>
                {check.status === "not_run" ? <small>{check.note ?? "Runs at publish."}</small> : null}
                {check.errors.slice(0, 4).map((message, index) => (
                  <small key={index} className="is-error">{message}</small>
                ))}
                {check.errors.length > 4 ? <small>+{check.errors.length - 4} more</small> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : loading ? (
        <Typography.Text className="fedlify-muted">Running checks...</Typography.Text>
      ) : null}
      {report ? <Typography.Text className="fedlify-muted fedlify-ws-check-notice">{report.notice}{stale ? " Results are for an older commit." : ""}</Typography.Text> : null}
    </div>
  );
}
