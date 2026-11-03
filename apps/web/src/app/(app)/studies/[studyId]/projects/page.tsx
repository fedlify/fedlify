"use client";

import { CloudUploadOutlined, LinkOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, StopOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Empty, Input, InputNumber, Modal, Select, Space, Steps, Table, Tag, Tooltip, Typography, message } from "antd";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppPage, AppPageHeader, SectionHeader } from "@/components/AppPage";
import { CodeReviewPanel, type SourceFile } from "@/components/CodeReviewPanel";

type Version = {
  id: string;
  version: string;
  gitCommit: string | null;
  imageDigest: string | null;
  validationStatus: string;
  publishedAt: string | null;
  publish: { status: string; summary: string | null; workflowId: string | null } | null;
};
type Project = { id: string; name: string; giteaRepoUrl: string | null; defaultBranch: string; versions: Version[] };
type Site = {
  studySiteId: string;
  code: string;
  name: string;
  nvflareClientName: string;
  provisioned: boolean;
  kitReleased: boolean;
  kitImageDigest: string | null;
  connected: boolean | null;
};
type Aggregator = {
  id: string;
  hostname: string | null;
  status: string;
  imageDigest: string | null;
  pipelineVersionId: string | null;
  lastError: string | null;
  reachable: boolean | null;
  error: string | null;
};
type Job = {
  id: string;
  status: string;
  nvflareJobId: string | null;
  createdAt: string;
  commandSummary: string | null;
  pipelineVersion: { id: string; version: string } | null;
  result: { id: string } | null;
};
type Overview = { aggregator: Aggregator | null; sites: Site[]; projects: Project[]; jobs: Job[] };
type RoundRow = { round: number; sites: Array<{ site: string; numSamples: number; metrics: Record<string, number> }>; weighted: Record<string, number> };

const ACTIVE_JOB = new Set(["SUBMITTED", "SCHEDULED", "RUNNING"]);
const statusColor: Record<string, string> = {
  PASSED: "green",
  ACTIVE: "green",
  COMPLETED: "green",
  RUNNING: "blue",
  QUEUED: "blue",
  SUBMITTED: "blue",
  FAILED: "red",
  ABORTED: "orange",
  DRAFT: "default"
};

async function apiCall<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status}).`);
  return body as T;
}

function short(value?: string | null, length = 12) {
  return value ? value.slice(0, length) : "—";
}

function digestLabel(digest?: string | null) {
  return digest ? `…${digest.split("@sha256:")[1]?.slice(0, 12) ?? short(digest)}` : "—";
}

export default function StudyProjectsPage() {
  const { studyId } = useParams<{ studyId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(searchParams.get("project"));
  const [sourceCommit, setSourceCommit] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneName, setCloneName] = useState("");
  const [cloning, setCloning] = useState(false);
  const [rounds, setRounds] = useState(5);
  const [minClients, setMinClients] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [progress, setProgress] = useState<{ jobId: string; nvflareStatus: string | null; rounds: RoundRow[] } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await apiCall<Overview>(`/api/v1/studies/${studyId}/aggregator`);
      setOverview(body);
      setLoadError(null);
      setProjectId((current) => current ?? body.projects[0]?.id ?? null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load the study pipeline.");
    }
  }, [studyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const project = overview?.projects.find((item) => item.id === projectId) ?? null;
  const publishInFlight = project?.versions.some((version) => version.publish && ["QUEUED", "RUNNING"].includes(version.publish.status)) ?? false;
  const activeJob = overview?.jobs.find((job) => ACTIVE_JOB.has(job.status)) ?? null;
  const liveVersion = project?.versions.find((version) => version.id === overview?.aggregator?.pipelineVersionId) ?? null;
  const connectedCount = overview?.sites.filter((site) => site.connected).length ?? 0;

  // Keep the page live while something is moving (publish, run).
  useEffect(() => {
    if (!publishInFlight && !activeJob) return;
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [publishInFlight, activeJob, load]);

  const followJob = useCallback(
    (jobId: string) => {
      if (pollRef.current) clearInterval(pollRef.current);
      const tick = async () => {
        try {
          const body = await apiCall<{ job: Job; nvflareStatus: string | null; rounds: RoundRow[] }>(`/api/v1/nvflare/jobs/${jobId}/progress`);
          setProgress({ jobId, nvflareStatus: body.nvflareStatus, rounds: body.rounds });
          if (!ACTIVE_JOB.has(body.job.status) && pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
            void load();
          }
        } catch (error) {
          message.error(error instanceof Error ? error.message : "Could not read run progress.");
        }
      };
      void tick();
      pollRef.current = setInterval(tick, 5_000);
    },
    [load]
  );

  useEffect(() => {
    const latest = overview?.jobs[0];
    if (latest && (!progress || progress.jobId !== latest.id) && latest.nvflareJobId) followJob(latest.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview?.jobs[0]?.id]);

  useEffect(() => () => void (pollRef.current && clearInterval(pollRef.current)), []);

  const loadSourceCommit = useCallback(async () => {
    if (!projectId) return;
    try {
      const body = await apiCall<{ commit: string | null }>(`/api/v1/studies/${studyId}/pipeline-projects/${projectId}/source`);
      setSourceCommit(body.commit);
    } catch {
      setSourceCommit(null);
    }
  }, [projectId, studyId]);

  useEffect(() => {
    void loadSourceCommit();
  }, [loadSourceCommit, reloadKey]);

  async function save(file: SourceFile, content: string) {
    if (!projectId) return;
    setSaving(true);
    try {
      const body = await apiCall<{ commitSha: string; changed: number }>(`/api/v1/studies/${studyId}/pipeline-projects/${projectId}/save`, {
        method: "POST",
        body: JSON.stringify({ baseCommit: sourceCommit ?? undefined, message: `Edit ${file.path}`, files: [{ path: file.path, content }] })
      });
      message.success(body.changed ? `Saved ${file.path} (${short(body.commitSha, 8)})` : "No changes to save.");
      setReloadKey((key) => key + 1);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    if (!projectId) return;
    setPublishing(true);
    try {
      const body = await apiCall<{ pipelineVersion: { version: string }; deployment: { hostname: string; provision: boolean } }>(
        `/api/v1/studies/${studyId}/pipeline-projects/${projectId}/publish`,
        { method: "POST", body: JSON.stringify({ commit: sourceCommit ?? undefined }) }
      );
      message.success(
        `Publishing ${body.pipelineVersion.version} to ${body.deployment.hostname}${body.deployment.provision ? " (issuing site certificates)" : ""}.`
      );
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Publish failed.");
    } finally {
      setPublishing(false);
    }
  }

  async function cloneProject() {
    setCloning(true);
    try {
      const body = await apiCall<{ project: { id: string } }>(`/api/v1/studies/${studyId}/pipeline-projects/clone`, {
        method: "POST",
        body: JSON.stringify({ name: cloneName })
      });
      setCloneOpen(false);
      setCloneName("");
      setProjectId(body.project.id);
      await load();
      message.success("Project created from the Fedlify starter repository.");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Could not create the project.");
    } finally {
      setCloning(false);
    }
  }

  async function startRun() {
    if (!overview?.aggregator?.pipelineVersionId) return;
    setStarting(true);
    try {
      const body = await apiCall<{ job: Job }>(`/api/v1/studies/${studyId}/nvflare/jobs`, {
        method: "POST",
        body: JSON.stringify({
          pipelineVersionId: overview.aggregator.pipelineVersionId,
          studySiteIds: overview.sites.filter((site) => site.connected).map((site) => site.studySiteId),
          runtimeParameters: { numRounds: rounds, minClients: minClients ?? connectedCount },
          commandSummary: `Started from the project workspace: ${rounds} rounds.`
        })
      });
      message.success("Run started.");
      await load();
      followJob(body.job.id);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Could not start the run.");
    } finally {
      setStarting(false);
    }
  }

  async function abortRun(jobId: string) {
    try {
      await apiCall(`/api/v1/nvflare/jobs/${jobId}/abort`, { method: "POST", body: JSON.stringify({ reason: "Stopped from the project workspace." }) });
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Could not abort the run.");
    }
  }

  async function syncResult(jobId: string) {
    try {
      await apiCall(`/api/v1/nvflare/jobs/${jobId}/results/sync`, { method: "POST", body: "{}" });
      message.success("Aggregated model saved to Fedlify.");
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Could not sync the result.");
    }
  }

  const stage = useMemo(() => {
    if (!project) return 0;
    if (!overview?.aggregator || overview.aggregator.status !== "ACTIVE") return publishInFlight ? 1 : 0;
    if (connectedCount === 0) return 2;
    return 3;
  }, [project, overview, publishInFlight, connectedCount]);

  const metricKeys = useMemo(() => [...new Set((progress?.rounds ?? []).flatMap((row) => Object.keys(row.weighted)))], [progress]);

  return (
    <AppPage>
      <AppPageHeader
        title="Study pipeline"
        subtitle="Edit the study code, publish it to the study aggregator, connect the sites, and run the federated study."
        onBack={() => router.push(`/studies/${studyId}`)}
        backLabel="Study"
        actions={
          <Space wrap>
            <Select
              style={{ minWidth: 240 }}
              placeholder="Select a project"
              value={projectId ?? undefined}
              options={(overview?.projects ?? []).map((item) => ({ value: item.id, label: item.name }))}
              onChange={(value) => setProjectId(value)}
            />
            <Button icon={<PlusOutlined />} onClick={() => setCloneOpen(true)}>
              New project
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void load()} />
          </Space>
        }
      />

      {loadError ? <Alert type="error" showIcon message={loadError} style={{ marginBottom: 16 }} /> : null}

      <Steps
        current={stage}
        style={{ marginBottom: 24 }}
        items={[
          { title: "Code", description: "Edit and save to Gitea" },
          { title: "Publish", description: "Image + aggregator" },
          { title: "Sites", description: `${connectedCount}/${overview?.sites.length ?? 0} connected` },
          { title: "Run", description: activeJob ? activeJob.status : "Start a run" }
        ]}
      />

      {!project ? (
        <Card>
          <Empty description="No project yet. Start from the Fedlify starter repository (federated logistic regression on tabular site data).">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCloneOpen(true)}>
              New project
            </Button>
          </Empty>
        </Card>
      ) : (
        <Space direction="vertical" size={24} style={{ width: "100%" }}>
          <CodeReviewPanel
            sourceUrl={`/api/v1/studies/${studyId}/pipeline-projects/${project.id}/source`}
            title={project.name}
            description={`Every save is a commit to ${project.defaultBranch} in Gitea. Publishing builds exactly the saved commit.`}
            reloadKey={`${project.id}-${reloadKey}`}
            savingDraft={saving}
            onSaveDraft={(file, content) => void save(file, content)}
          />

          <Card>
            <SectionHeader
              title="Publish"
              description="Freeze the latest saved commit as a version, build the study image, and (re)start the study aggregator."
              actions={
                <Space wrap>
                  {project.giteaRepoUrl ? (
                    <Button icon={<LinkOutlined />} href={project.giteaRepoUrl} target="_blank">
                      Repository
                    </Button>
                  ) : null}
                  <Tooltip title={activeJob ? "A run is in progress; publishing restarts the aggregator." : undefined}>
                    <Button
                      type="primary"
                      icon={<CloudUploadOutlined />}
                      loading={publishing || publishInFlight}
                      disabled={Boolean(activeJob)}
                      onClick={() => void publish()}
                    >
                      Publish {short(sourceCommit, 8)}
                    </Button>
                  </Tooltip>
                </Space>
              }
            />
            <Table<Version>
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={project.versions}
              locale={{ emptyText: "Not published yet." }}
              columns={[
                {
                  title: "Version",
                  dataIndex: "version",
                  render: (value: string, row) => (
                    <Space>
                      {value}
                      {row.id === overview?.aggregator?.pipelineVersionId ? <Tag color="green">live</Tag> : null}
                    </Space>
                  )
                },
                { title: "Commit", dataIndex: "gitCommit", render: (value: string | null) => <code>{short(value, 8)}</code> },
                {
                  title: "Publish",
                  render: (_, row) => (
                    <Tooltip title={row.publish?.summary}>
                      <Tag color={statusColor[row.publish?.status ?? row.validationStatus] ?? "default"}>{row.publish?.status ?? row.validationStatus}</Tag>
                    </Tooltip>
                  )
                },
                { title: "Image", dataIndex: "imageDigest", render: (value: string | null) => <code>{digestLabel(value)}</code> },
                { title: "Published", dataIndex: "publishedAt", render: (value: string | null) => (value ? new Date(value).toLocaleString() : "—") }
              ]}
            />
          </Card>

          <Card>
            <SectionHeader
              title="Aggregator and sites"
              description={
                overview?.aggregator?.hostname
                  ? `Sites connect to ${overview.aggregator.hostname}:443 with the kit from their site page (outbound HTTPS only).`
                  : "The study aggregator is created on the first publish."
              }
              actions={
                overview?.aggregator ? (
                  <Space>
                    <Tag color={statusColor[overview.aggregator.status] ?? "default"}>{overview.aggregator.status}</Tag>
                    {liveVersion ? <Tag>serving {liveVersion.version}</Tag> : null}
                  </Space>
                ) : null
              }
            />
            {overview?.aggregator?.lastError ? <Alert type="warning" showIcon message={overview.aggregator.lastError} style={{ marginBottom: 12 }} /> : null}
            {overview?.aggregator?.error ? <Alert type="error" showIcon message={overview.aggregator.error} style={{ marginBottom: 12 }} /> : null}
            <Table<Site>
              size="small"
              rowKey="studySiteId"
              pagination={false}
              dataSource={overview?.sites ?? []}
              columns={[
                { title: "Site", render: (_, row) => `${row.name} (${row.code})` },
                { title: "NVFLARE client", dataIndex: "nvflareClientName", render: (value: string) => <code>{value}</code> },
                {
                  title: "Certificate",
                  render: (_, row) => (row.provisioned ? <Tag color="green">issued</Tag> : <Tag>{overview?.aggregator ? "republish to issue" : "on publish"}</Tag>)
                },
                {
                  title: "Kit",
                  render: (_, row) =>
                    row.kitReleased ? (
                      <Tag color={row.kitImageDigest && row.kitImageDigest !== overview?.aggregator?.imageDigest ? "orange" : "green"}>
                        {row.kitImageDigest && row.kitImageDigest !== overview?.aggregator?.imageDigest ? "update available" : "released"}
                      </Tag>
                    ) : (
                      <Button size="small" type="link" onClick={() => router.push(`/sites/${row.studySiteId}`)}>
                        Release kit
                      </Button>
                    )
                },
                {
                  title: "Connected",
                  render: (_, row) =>
                    row.connected == null ? <Tag>unknown</Tag> : row.connected ? <Tag color="green">connected</Tag> : <Tag color="default">waiting</Tag>
                }
              ]}
            />
          </Card>

          <Card>
            <SectionHeader
              title="Run"
              description="Runs the published version on the connected sites. Only model weights and aggregate metrics leave the sites."
              actions={
                <Space wrap>
                  <span>Rounds</span>
                  <InputNumber min={1} max={1000} value={rounds} onChange={(value) => setRounds(Number(value) || 1)} />
                  <span>Min sites</span>
                  <InputNumber min={1} max={Math.max(1, connectedCount)} value={minClients ?? connectedCount} onChange={(value) => setMinClients(Number(value) || 1)} />
                  <Button
                    type="primary"
                    icon={<PlayCircleOutlined />}
                    loading={starting}
                    disabled={overview?.aggregator?.status !== "ACTIVE" || connectedCount === 0 || Boolean(activeJob)}
                    onClick={() => void startRun()}
                  >
                    Start run
                  </Button>
                </Space>
              }
            />
            {progress ? (
              <>
                <Typography.Paragraph type="secondary">
                  NVFLARE status: <Tag>{progress.nvflareStatus ?? "pending"}</Tag> {progress.rounds.length} round(s) reported.
                </Typography.Paragraph>
                <Table<RoundRow>
                  size="small"
                  rowKey="round"
                  pagination={false}
                  dataSource={progress.rounds}
                  locale={{ emptyText: "Waiting for the first round." }}
                  columns={[
                    { title: "Round", dataIndex: "round" },
                    ...metricKeys.map((key) => ({
                      title: `${key} (weighted)`,
                      render: (_: unknown, row: RoundRow) => (row.weighted[key] != null ? row.weighted[key].toFixed(4) : "—")
                    })),
                    {
                      title: "Per site",
                      render: (_: unknown, row: RoundRow) => (
                        <Space wrap size={4}>
                          {row.sites.map((site) => (
                            <Tooltip key={site.site} title={`n=${site.numSamples}`}>
                              <Tag>
                                {site.site}: {Object.entries(site.metrics).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(" · ")}
                              </Tag>
                            </Tooltip>
                          ))}
                        </Space>
                      )
                    }
                  ]}
                />
              </>
            ) : null}
            <Table<Job>
              size="small"
              rowKey="id"
              pagination={false}
              style={{ marginTop: 16 }}
              dataSource={overview?.jobs ?? []}
              locale={{ emptyText: "No runs yet." }}
              columns={[
                { title: "Started", dataIndex: "createdAt", render: (value: string) => new Date(value).toLocaleString() },
                { title: "Version", render: (_, row) => row.pipelineVersion?.version ?? "—" },
                { title: "Status", dataIndex: "status", render: (value: string) => <Tag color={statusColor[value] ?? "default"}>{value}</Tag> },
                { title: "NVFLARE job", dataIndex: "nvflareJobId", render: (value: string | null) => <code>{short(value, 8)}</code> },
                {
                  title: "",
                  render: (_, row) => (
                    <Space>
                      <Button size="small" onClick={() => followJob(row.id)} disabled={!row.nvflareJobId}>
                        Metrics
                      </Button>
                      {ACTIVE_JOB.has(row.status) ? (
                        <Button size="small" danger icon={<StopOutlined />} onClick={() => void abortRun(row.id)}>
                          Abort
                        </Button>
                      ) : null}
                      {row.status === "COMPLETED" && !row.result ? (
                        <Button size="small" onClick={() => void syncResult(row.id)}>
                          Save model
                        </Button>
                      ) : null}
                      {row.result ? <Tag color="green">model saved</Tag> : null}
                    </Space>
                  )
                }
              ]}
            />
          </Card>
        </Space>
      )}

      <Modal
        title="New project"
        open={cloneOpen}
        onCancel={() => setCloneOpen(false)}
        onOk={() => void cloneProject()}
        okText="Create from starter"
        confirmLoading={cloning}
        okButtonProps={{ disabled: cloneName.trim().length < 3 }}
      >
        <Typography.Paragraph type="secondary">
          Creates a repository in this study&apos;s Gitea organization, cloned from the Fedlify starter (FedAvg logistic regression, NVFLARE
          Client API, eICU-style tabular data contract). You can then edit it here, with the agent, or with any Git client.
        </Typography.Paragraph>
        <Input placeholder="Project name, e.g. HF mortality FedAvg" value={cloneName} onChange={(event) => setCloneName(event.target.value)} />
      </Modal>
    </AppPage>
  );
}
