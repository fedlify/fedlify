"use client";

import { Alert, Tooltip, Typography } from "antd";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppPage, AppPageHeader } from "@/components/AppPage";
import { RecordTable } from "@/components/RecordTable";
import { StatusTag } from "@/components/StatusTag";
import { formatDateTime } from "@/lib/format";
import { statusLabel } from "@/lib/terms";
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
  trainedRounds: number | null;
  imageMismatchSites: string[];
};

const ENDED_EARLY = new Set(["FAILED", "ABORTED", "REJECTED"]);

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
      <AppPageHeader title="Results" subtitle="One row per run. Open a run to see how it performed, its code, its model and its activity history." onBack={() => router.push(`/studies/${studyId}`)} backLabel="Study" />
      {error ? (
        <Alert type={error.status === 403 ? "warning" : "error"} showIcon message={error.status === 403 ? "You do not have access to this study's runs" : "Runs could not be loaded"} description={error.message} />
      ) : (
        <div className="fedlify-section-stack">
          <Typography.Paragraph type="secondary">
            Best AUROC is the highest round average of the shared model, scored on each site&apos;s own validation data. It is not an independent test and not evidence of clinical validity. AUROC is a score from 0.5 to 1 for how well the model tells cases from non-cases; 0.5 is no better than chance.
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
                  <Link href={`/studies/${studyId}/runs/${run.id}`} title={`Run ID ${run.nvflareJobId ?? run.id}`}>
                    Run from {formatDateTime(run.createdAt)}
                  </Link>
                )
              },
              { title: "Status", dataIndex: "status", render: (value: string) => <StatusTag value={value} /> },
              {
                title: "Pipeline version",
                render: (_, run) => (
                  <span>
                    {run.pipelineVersion}
                    {run.imageMismatchSites.length ? (
                      <Tooltip title={`When this run started, ${run.imageMismatchSites.join(", ")} reported a different code version from this pipeline version, so the code that trained may not be ${run.pipelineVersion}.`}>
                        {" "}
                        <StatusTag tone="warning" label="Code version differs" />
                      </Tooltip>
                    ) : null}
                  </span>
                )
              },
              {
                title: "Code",
                render: (_, run) =>
                  run.gitCommit ? (
                    <span title={`Commit ${run.gitCommit.slice(0, 10)}. ${run.gitCommitRecordedOnRun ? "Recorded when the run was started" : "Taken from the pipeline version; not recorded on this older run"}`}>
                      {run.gitCommitRecordedOnRun ? "Recorded with the run" : <Typography.Text type="secondary">From the pipeline version</Typography.Text>}
                    </span>
                  ) : (
                    missing
                  )
              },
              {
                title: "Best AUROC",
                render: (_, run) =>
                  run.bestAuroc && run.trainedRounds === 0 ? (
                    <Tooltip title={`Only round 0 was scored. That is the starting model before any site trained it (AUROC ${run.bestAuroc.value.toFixed(4)}).`}>
                      <Typography.Text type="secondary">No trained rounds</Typography.Text>
                    </Tooltip>
                  ) : run.bestAuroc && ENDED_EARLY.has(run.status) ? (
                    <Tooltip title="The run did not finish. This is the best round reached before it stopped, not a final result.">
                      <Typography.Text type="secondary">
                        {run.bestAuroc.value.toFixed(4)} (round {run.bestAuroc.round}, partial)
                      </Typography.Text>
                    </Tooltip>
                  ) : run.bestAuroc ? (
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
                render: (_, run) => (run.modelRelease ? <StatusTag value={run.modelRelease.status} label={`${run.modelRelease.version} ${statusLabel(run.modelRelease.status).toLowerCase()}`} /> : run.modelSaved ? <StatusTag value="NOT_RELEASED" label="Saved, not released" /> : <StatusTag value="NOT_CREATED" label="Not saved" />)
              }
            ]}
          />
        </div>
      )}
    </AppPage>
  );
}
