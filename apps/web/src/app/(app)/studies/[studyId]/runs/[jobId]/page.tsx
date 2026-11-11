"use client";

import { Alert, Button, Descriptions, Popconfirm, Space, Spin, Tabs, Typography, message } from "antd";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppPage, AppPageHeader } from "@/components/AppPage";
import { type CodeView, RunCodeView } from "@/components/RunCodeView";
import { RecordTable } from "@/components/RecordTable";
import { AuditPartialNotice } from "@/components/AuditPartialNotice";
import { Details } from "@/components/Details";
import { RoundMetricsChart, type MetricsPayload } from "@/components/RoundMetricsChart";
import { StatusTag } from "@/components/StatusTag";
import type { AuditEventDto } from "@/lib/audit-query";
import { formatDateTime } from "@/lib/format";
import { auditActionLabel, statusLabel } from "@/lib/terms";
import { ApiError, apiCall } from "@/lib/web-api";

type Detail = {
  scope: "full" | "site";
  can: { logs: boolean; audit: boolean; saveModel: boolean; release: boolean; modelCard: boolean };
  run: {
    id: string;
    status: string;
    nvflareJobId: string | null;
    createdAt: string;
    submittedAt: string | null;
    completedAt: string | null;
    submittedBy: string | null;
    endReason?: string | null;
    sites: Array<{ code?: string; clientName: string | null }>;
    siteCount: number;
    parameters: { minClients?: number; numRounds?: number } | null;
    pipeline: { version: string; project: string; approvalStatus: string; validationStatus: string };
    snapshot: { gitCommit: string | null; imageDigest: string | null; siteDigests: Array<{ site: string; imageDigest: string | null; reportedAt: string | null }> | null; recorded: boolean };
  };
  siteLost?: { since: string; timeoutMs: number; sites: Array<{ code: string; clientName: string; state: string; reason: string; since: string; abortAt: string | null }> } | null;
  metrics: MetricsPayload;
  model: {
    saved: boolean;
    release: { id: string; version: string; status: string; approvedAt: string | null; approvedBy: string | null } | null;
    artifacts: Array<{ id: string; kind: string; filename: string }>;
  };
  events: Array<{ id: string; createdAt: string; type: string; message: string | null; metadata: unknown }>;
};

const NOT_RECORDED = <Typography.Text type="secondary">Not recorded</Typography.Text>;
const when = (v: string | null) => (v ? formatDateTime(v) : NOT_RECORDED);

function errText(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

function SummaryTab({ d }: { d: Detail }) {
  const { run } = d;
  return (
    <div>
      {!run.snapshot.recorded ? (
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Some details were not recorded for this run" description="It was started before the code, code version and settings were recorded on runs. They are shown as not recorded and are not reconstructed." />
      ) : null}
      <Descriptions bordered size="small" column={1}>
        <Descriptions.Item label="Status"><StatusTag value={run.status} /></Descriptions.Item>
        <Descriptions.Item label="Pipeline version">{run.pipeline.version} ({run.pipeline.project})</Descriptions.Item>
        <Descriptions.Item label="Settings">{run.parameters ? `${run.parameters.numRounds ?? "?"} rounds, at least ${run.parameters.minClients ?? "?"} site(s)` : NOT_RECORDED}</Descriptions.Item>
        <Descriptions.Item label="Sites">{run.sites.map((s) => s.code).join(", ") || NOT_RECORDED}{d.scope === "site" ? ` (your sites only, ${run.siteCount} in total)` : ""}</Descriptions.Item>
        <Descriptions.Item label="Started by">{run.submittedBy ?? NOT_RECORDED}</Descriptions.Item>
        <Descriptions.Item label="Started">{when(run.submittedAt)}</Descriptions.Item>
        <Descriptions.Item label="Completed">{when(run.completedAt)}</Descriptions.Item>
      </Descriptions>
      <Details
        items={[
          { label: "Run ID", value: <code>{run.id}</code>, copyText: run.id },
          { label: "Job ID", value: run.nvflareJobId ? <code>{run.nvflareJobId}</code> : NOT_RECORDED, copyText: run.nvflareJobId ?? undefined },
          { label: "Commit", value: run.snapshot.gitCommit ? <code>{run.snapshot.gitCommit}</code> : NOT_RECORDED, copyText: run.snapshot.gitCommit ?? undefined },
          { label: "Image digest", value: run.snapshot.imageDigest ? <code>{run.snapshot.imageDigest}</code> : NOT_RECORDED, copyText: run.snapshot.imageDigest ?? undefined },
          ...(run.snapshot.siteDigests ?? []).map((r) => ({
            label: `Image digest reported by site ${r.site} before the run`,
            value: r.imageDigest ? <code>{r.imageDigest}</code> : <Typography.Text type="secondary">Not reported</Typography.Text>
          }))
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
        Fedlify records which code version each site was running before the run. It cannot prove the code was not altered, so treat this as a record, not a guarantee.
      </Typography.Paragraph>
    </div>
  );
}

function CodeTab({ studyId, jobId }: { studyId: string; jobId: string }) {
  const [view, setView] = useState<CodeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(true);
  const load = useCallback(
    async (path?: string) => {
      try {
        setView(await apiCall<CodeView>(`/api/v1/studies/${studyId}/runs/${jobId}/code${path ? `?path=${encodeURIComponent(path)}` : ""}`));
        setError(null);
      } catch (e) {
        setError(errText(e));
      }
    },
    [studyId, jobId]
  );
  useEffect(() => {
    void load();
  }, [load]);
  if (error) return <Alert type="warning" showIcon message="Code could not be shown" description={error} />;
  if (!view) return <Typography.Text type="secondary">Loading code...</Typography.Text>;
  return <RunCodeView view={view} onSelect={(p) => void load(p)} />;
}

function ModelTab({ studyId, d, reload }: { studyId: string; d: Detail; reload: () => void }) {
  const [card, setCard] = useState<{ card: Record<string, unknown> | null; kind: string | null; reason?: string } | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const jobId = d.run.id;
  useEffect(() => {
    if (!d.model.saved) return;
    apiCall<{ card: Record<string, unknown> | null; kind: string | null; reason?: string }>(`/api/v1/studies/${studyId}/runs/${jobId}/model-card`).then(setCard).catch((e) => setCardError(errText(e)));
  }, [studyId, jobId, d.model.saved, d.model.release?.id]);
  async function act(url: string, body: unknown, ok: string) {
    try {
      await apiCall(url, { method: "POST", body: JSON.stringify(body) });
      message.success(ok);
      reload();
    } catch (e) {
      message.error(errText(e));
    }
  }
  async function download(artifactId: string) {
    try {
      const body = await apiCall<{ downloadUrl?: string | null; message?: string }>(`/api/v1/model-releases/${d.model.release!.id}/download?artifactId=${artifactId}`);
      if (body.downloadUrl) window.location.assign(body.downloadUrl);
      else message.info(body.message ?? "No download URL is available.");
    } catch (e) {
      message.error(errText(e));
    }
  }
  const release = d.model.release;
  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        {release ? <StatusTag value={release.status} label={`${release.version} ${statusLabel(release.status).toLowerCase()}`} /> : d.model.saved ? <StatusTag value="NOT_RELEASED" label="Saved, not released" /> : <StatusTag value="NOT_CREATED" label="Not saved" />}
        {d.run.status === "COMPLETED" && !d.model.saved && d.can.saveModel ? <Button onClick={() => void act(`/api/v1/nvflare/jobs/${jobId}/results/sync`, {}, "Model saved.")}>Save model</Button> : null}
        {d.model.saved && !release && d.can.release ? (
          <Popconfirm title="Release this model?" description="This creates an approved model release under your name that cannot be changed. It is never done automatically." onConfirm={() => void act(`/api/v1/nvflare/jobs/${jobId}/model-release`, { status: "APPROVED" }, "Model released.")}>
            <Button type="primary">Release model</Button>
          </Popconfirm>
        ) : null}
        {release?.status === "APPROVED" ? d.model.artifacts.map((a) => <Button key={a.id} size="small" onClick={() => void download(a.id)}>Download {a.filename}</Button>) : null}
      </Space>
      {cardError ? <Alert type="warning" showIcon message="Model card unavailable" description={cardError} /> : null}
      {card?.card ? (
        <div data-testid="model-card">
          <Alert type={card.kind === "released" ? "success" : "warning"} showIcon style={{ marginBottom: 8 }} message={card.kind === "released" ? "Model card stored with the model release" : "Preview, not part of a model release"} description={card.reason} />
          {(card.card.notices as string[] | undefined)?.map((n) => <Typography.Paragraph key={n} type="secondary">{n}</Typography.Paragraph>)}
          <pre style={{ overflow: "auto", maxHeight: 520 }}>{JSON.stringify(card.card, null, 2)}</pre>
        </div>
      ) : card ? <Typography.Text type="secondary">{card.reason}</Typography.Text> : null}
      {!d.model.saved ? <Typography.Paragraph type="secondary">No model has been saved from this run, so there is no model card.</Typography.Paragraph> : null}
    </div>
  );
}

function AuditTab({ studyId, d }: { studyId: string; d: Detail }) {
  const [events, setEvents] = useState<AuditEventDto[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiCall<{ events: AuditEventDto[]; total?: number }>(`/api/v1/studies/${studyId}/audit?run=${d.run.id}&pageSize=100`).then((b) => { setEvents(b.events); setTotal(b.total ?? b.events.length); }).catch((e) => setError(errText(e)));
  }, [studyId, d.run.id]);
  const rows = useMemo(() => {
    const a = (events ?? []).map((e) => ({ key: `a-${e.id}`, time: e.createdAt, source: "Activity", actor: e.actorName ?? e.actorEmail ?? "System", what: auditActionLabel(e.action), raw: e.action, detail: e.metadata }));
    const r = d.events.map((e) => ({ key: `r-${e.id}`, time: e.createdAt, source: "Run update", actor: "System", what: statusLabel(e.type), raw: e.type, detail: e.message ?? e.metadata }));
    return [...a, ...r].sort((x, y) => new Date(y.time).getTime() - new Date(x.time).getTime());
  }, [events, d.events]);
  const q = `run=${d.run.id}`;
  return (
    <div>
      {error ? <Alert type="warning" showIcon message="Activity could not be loaded" description={error} /> : null}
      <AuditPartialNotice shown={events?.length ?? null} total={total} />
      <Space style={{ marginBottom: 8 }}>
        <Button href={`/api/v1/studies/${studyId}/audit?${q}&format=csv`}>Export CSV</Button>
        <Button href={`/api/v1/studies/${studyId}/audit?${q}&format=json`}>Export JSON</Button>
      </Space>
      <RecordTable rowKey="key" dataSource={rows} loading={events === null && !error} emptyText="No activity for this run yet." pagination={{ pageSize: 25, hideOnSinglePage: true }}
        columns={[
          { title: "Time", dataIndex: "time", render: (v: string) => formatDateTime(v) },
          { title: "Source", dataIndex: "source" },
          { title: "Actor", dataIndex: "actor" },
          { title: "What happened", dataIndex: "what" },
          {
            title: "Details",
            render: (_, r) => (
              <div style={{ maxWidth: 420 }}>
                {typeof r.detail === "string" ? <div>{r.detail}</div> : null}
                <Details
                  items={[
                    { label: "Event key", value: <code>{r.raw}</code> },
                    ...(typeof r.detail === "string" ? [] : [{ label: "Data", value: <code style={{ display: "block", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{JSON.stringify(r.detail ?? {})}</code> }])
                  ]}
                />
              </div>
            )
          }
        ]} />
    </div>
  );
}

function LogsTab({ studyId, jobId }: { studyId: string; jobId: string }) {
  const [data, setData] = useState<{ available: boolean; reason?: string; text: string | null; truncated?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiCall<{ available: boolean; reason?: string; text: string | null; truncated?: boolean }>(`/api/v1/studies/${studyId}/runs/${jobId}/logs`).then(setData).catch((e) => setError(errText(e)));
  }, [studyId, jobId]);
  if (error) return <Alert type="warning" showIcon message="Logs could not be loaded" description={error} />;
  if (!data) return <Typography.Text type="secondary">Loading logs...</Typography.Text>;
  if (!data.available) return <Alert type="info" showIcon message="No stored log" description={data.reason} />;
  return <pre style={{ overflow: "auto", maxHeight: 560 }}>{data.truncated ? "[earlier output cut]\n" : ""}{data.text}</pre>;
}

export default function RunDetailPage() {
  const { studyId, jobId } = useParams<{ studyId: string; jobId: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  const load = useCallback(async () => {
    try {
      setDetail(await apiCall<Detail>(`/api/v1/studies/${studyId}/runs/${jobId}`));
      setError(null);
    } catch (e) {
      setError({ message: errText(e), status: e instanceof ApiError ? e.status : undefined });
    }
  }, [studyId, jobId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!detail || !["SUBMITTED", "SCHEDULED", "RUNNING"].includes(detail.run.status)) return;
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [detail, load]);

  const items = detail
    ? [
        { key: "summary", label: "Summary", children: <SummaryTab d={detail} /> },
        { key: "performance", label: "Performance", children: <RoundMetricsChart metrics={detail.metrics} /> },
        { key: "code", label: "Code", children: <CodeTab studyId={studyId} jobId={jobId} /> },
        ...(detail.can.modelCard ? [{ key: "model", label: "Model", children: <ModelTab studyId={studyId} d={detail} reload={() => void load()} /> }] : []),
        ...(detail.can.audit ? [{ key: "audit", label: "Activity", children: <AuditTab studyId={studyId} d={detail} /> }] : []),
        ...(detail.can.logs ? [{ key: "logs", label: "Logs", children: <LogsTab studyId={studyId} jobId={jobId} /> }] : [])
      ]
    : [];
  const active = items.some((i) => i.key === search.get("tab")) ? (search.get("tab") as string) : "summary";
  return (
    <AppPage>
      <AppPageHeader title={detail ? `Run from ${formatDateTime(detail.run.createdAt)}` : "Run"} subtitle={detail ? `Pipeline version ${detail.run.pipeline.version} - ${statusLabel(detail.run.status)}` : undefined} onBack={() => router.push(`/studies/${studyId}/runs`)} backLabel="Results" />
      {error && !detail ? <Alert type={error.status === 403 || error.status === 404 ? "warning" : "error"} showIcon message="Run could not be loaded" description={error.message} /> : null}
      {error && detail ? <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Could not refresh this run" description={`${error.message} The values below are from the last successful load.`} /> : null}
      {!detail && !error ? <Spin tip="Loading run..."><div style={{ minHeight: 120 }} /></Spin> : null}
      {detail?.siteLost ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="A site is not responding"
          description={
            <div>
              {detail.siteLost.sites.map((site) => (
                <div key={site.code}>
                  <strong>Site {site.code}</strong>: {site.reason} (since {formatDateTime(site.since)}).
                  {site.abortAt ? ` If it stays down, Fedlify ends this run as failed at about ${formatDateTime(site.abortAt)}.` : " This alone does not end the run."}
                </div>
              ))}
              <div>Restart the runner on that site with ./fedlify-runner.sh start, or stop the run from the Results page.</div>
            </div>
          }
        />
      ) : null}
      {detail?.run.endReason ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={`Run ${statusLabel(detail.run.status).toLowerCase()}`} description={detail.run.endReason} /> : null}
      {detail ? <Tabs activeKey={active} items={items} onChange={(key) => router.replace(`/studies/${studyId}/runs/${jobId}?tab=${key}`)} /> : null}
    </AppPage>
  );
}
