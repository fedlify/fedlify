"use client";

import { Alert, Typography } from "antd";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppPage, AppPageHeader } from "@/components/AppPage";
import { RecordTable } from "@/components/RecordTable";
import { StatusTag } from "@/components/StatusTag";
import { ApiError, apiCall } from "@/lib/web-api";

type RunRow = {
  id: string;
  status: string;
  nvflareJobId: string | null;
  createdAt: string;
  pipelineVersion: string;
  gitCommit: string | null;
  gitCommitRecordedOnRun: boolean;
  bestAuroc: { value: number; round: number } | null;
  metricsStored: boolean | null;
  modelSaved: boolean;
  modelRelease: { version: string; status: string } | null;
};

const missing = <Typography.Text type="secondary">Not recorded</Typography.Text>;

export default function StudyRunsPage() {
  const { studyId } = useParams<{ studyId: string }>();
  const router = useRouter();
  const [data, setData] = useState<{ runs: RunRow[]; scope: string } | null>(null);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiCall<{ runs: RunRow[]; scope: string }>(`/api/v1/studies/${studyId}/runs`)
      .then((body) => !cancelled && setData(body))
      .catch((err) => !cancelled && setError({ message: err instanceof Error ? err.message : "Runs could not be loaded.", status: err instanceof ApiError ? err.status : undefined }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [studyId]);

  return (
    <AppPage>
      <AppPageHeader title="Results" subtitle="One row per run. Open a run for its performance, code, model and audit trail." onBack={() => router.push(`/studies/${studyId}`)} backLabel="Study" />
      {error ? (
        <Alert type={error.status === 403 ? "warning" : "error"} showIcon message={error.status === 403 ? "You do not have access to this study's runs" : "Runs could not be loaded"} description={error.message} />
      ) : (
        <div className="fedlify-section-stack">
          <Typography.Paragraph type="secondary">
            Best AUROC is the highest round average of the global model scored on each site's local validation split. It is not a held-out test and not evidence of clinical validity.
          </Typography.Paragraph>
          <RecordTable<RunRow>
            rowKey="id"
            loading={loading}
            dataSource={data?.runs ?? []}
            emptyText="No runs yet. Start a run from Code & run."
            pagination={{ pageSize: 25, hideOnSinglePage: true }}
            columns={[
              {
                title: "Run",
                render: (_, run) => (
                  <Link href={`/studies/${studyId}/runs/${run.id}`}>
                    {new Date(run.createdAt).toLocaleString()} <code>{run.nvflareJobId?.slice(0, 8) ?? run.id.slice(0, 8)}</code>
                  </Link>
                )
              },
              { title: "Status", dataIndex: "status", render: (value: string) => <StatusTag value={value} /> },
              { title: "Pipeline version", dataIndex: "pipelineVersion" },
              {
                title: "Commit",
                render: (_, run) =>
                  run.gitCommit ? (
                    <span title={run.gitCommitRecordedOnRun ? "Snapshotted when the run was submitted" : "Taken from the pipeline version; not snapshotted on this older run"}>
                      <code>{run.gitCommit.slice(0, 10)}</code>
                      {run.gitCommitRecordedOnRun ? null : <Typography.Text type="secondary"> (from version)</Typography.Text>}
                    </span>
                  ) : (
                    missing
                  )
              },
              {
                title: "Best AUROC",
                render: (_, run) =>
                  run.bestAuroc ? (
                    <span>
                      {run.bestAuroc.value.toFixed(4)} <Typography.Text type="secondary">(round {run.bestAuroc.round})</Typography.Text>
                    </span>
                  ) : run.metricsStored === false ? (
                    <Typography.Text type="secondary">No metrics stored</Typography.Text>
                  ) : (
                    <Typography.Text type="secondary">{data?.scope === "site" ? "Hidden" : "Not reported"}</Typography.Text>
                  )
              },
              {
                title: "Model",
                render: (_, run) => (run.modelRelease ? <StatusTag value={run.modelRelease.status} label={`${run.modelRelease.version} ${run.modelRelease.status.toLowerCase()}`} /> : run.modelSaved ? <StatusTag value="NOT_RELEASED" label="Saved, not released" /> : <StatusTag value="NOT_CREATED" label="Not saved" />)
              }
            ]}
          />
        </div>
      )}
    </AppPage>
  );
}
