"use client";

import {
  ApiOutlined,
  CheckCircleOutlined,
  CloudDownloadOutlined,
  CopyOutlined,
  FileTextOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  TeamOutlined
} from "@ant-design/icons";
import { Alert, Button, Checkbox, Form, Input, Select, Space, Tabs, Typography, message } from "antd";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppPage, AppPageHeader } from "@/components/AppPage";
import { CardGrid, EntityCard } from "@/components/DataCards";
import { FormError } from "@/components/FormFeedback";
import { CardGridSkeleton, EmptyState, InlineLoadError } from "@/components/LoadStates";
import { StatusTag } from "@/components/StatusTag";
import { GateChecklist, WorkflowRail, type GateItem, type WorkflowStep } from "@/components/WorkflowRail";
import {
  DATA_MODALITY_OPTIONS,
  normalizeMultiSelectValue,
  splitMultiSelectValue
} from "@/lib/governance-options";

type EntityRecord = Record<string, any>;

type SiteDashboard = {
  onboardingSteps: string[];
  studySite: EntityRecord;
  activeDeployment?: EntityRecord | null;
  approvedReleases: EntityRecord[];
  pipelineVersions: EntityRecord[];
  auditEvents: EntityRecord[];
};

function text(value: unknown, fallback = "Not set") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function displayEnum(value: unknown, fallback = "Not set") {
  if (!value || typeof value !== "string") return fallback;
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace("Nvflare", "NVFLARE");
}

function formatDate(value: unknown) {
  if (!value || typeof value !== "string") return "Not recorded";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function stepState(passed: boolean, blocked = false): WorkflowStep["state"] {
  if (passed) return "done";
  return blocked ? "blocked" : "current";
}

function buildSiteWorkflow(input: {
  site: EntityRecord;
  activeDeployment?: EntityRecord | null;
  activeJoinPackage?: EntityRecord | null;
  latestReadiness?: EntityRecord | null;
  latestStatus?: EntityRecord | null;
}): WorkflowStep[] {
  const policyAccepted = Boolean(input.latestReadiness?.policyAccepted);
  const kitDownloaded = Boolean(input.activeJoinPackage);
  const kitInstalled = Boolean(input.latestReadiness?.kitInstalled);
  const dependenciesVerified = Boolean(input.latestReadiness?.dependenciesVerified);
  const connected = input.latestStatus?.status === "CONNECTED";
  return [
    {
      label: "Accept participation",
      detail: displayEnum(input.site.participationStatus, "Invited"),
      state: stepState(["KIT_RELEASED", "CONNECTED", "DEGRADED"].includes(String(input.site.participationStatus)))
    },
    {
      label: "Review governance",
      detail: displayEnum(input.site.study?.governanceStatus, "Incomplete"),
      state: stepState(policyAccepted, !input.site.study?.governanceStatus)
    },
    {
      label: "Download startup kit",
      detail: kitDownloaded ? `Generated ${formatDate(input.activeJoinPackage?.createdAt)}` : "Generate a site-specific package",
      state: stepState(kitDownloaded, input.activeDeployment?.status !== "ACTIVE")
    },
    {
      label: "Install local runner",
      detail: kitInstalled ? "Site marked the runner installed" : "Run Docker Compose at the site",
      state: stepState(kitInstalled, !kitDownloaded)
    },
    {
      label: "Pass readiness",
      detail: input.latestReadiness?.status ? displayEnum(input.latestReadiness.status) : "Checklist incomplete",
      state: stepState(input.latestReadiness?.status === "PASSED", !dependenciesVerified || !policyAccepted)
    },
    {
      label: "Join federation",
      detail: connected ? "Heartbeat received" : "Waiting for Fedlify heartbeat",
      state: stepState(connected, input.latestReadiness?.status !== "PASSED")
    }
  ];
}

function buildSiteGateItems(input: {
  site: EntityRecord;
  activeDeployment?: EntityRecord | null;
  activeJoinPackage?: EntityRecord | null;
  latestReadiness?: EntityRecord | null;
  latestStatus?: EntityRecord | null;
}): GateItem[] {
  return [
    {
      label: "Aggregator address available",
      detail: text(input.activeDeployment?.serverAddress, "No active deployment"),
      passed: input.activeDeployment?.status === "ACTIVE" && Boolean(input.activeDeployment?.serverAddress)
    },
    {
      label: "Site startup kit generated",
      detail: input.activeJoinPackage ? `Expires ${formatDate(input.activeJoinPackage.expiresAt)}` : "No active startup kit",
      passed: Boolean(input.activeJoinPackage)
    },
    {
      label: "Local policy accepted",
      detail: input.latestReadiness?.policyAcceptedAt ? formatDate(input.latestReadiness.policyAcceptedAt) : "Policy not accepted",
      passed: Boolean(input.latestReadiness?.policyAccepted)
    },
    {
      label: "Heartbeat connected",
      detail: input.latestStatus?.observedAt ? formatDate(input.latestStatus.observedAt) : formatDate(input.latestStatus?.createdAt),
      passed: input.latestStatus?.status === "CONNECTED"
    }
  ];
}

export default function SiteOnboardingPage() {
  const params = useParams<{ siteId: string }>();
  const router = useRouter();
  const siteId = params.siteId;
  const [dashboard, setDashboard] = useState<SiteDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [enrollmentToken, setEnrollmentToken] = useState<string | null>(null);
  const [inlineManifest, setInlineManifest] = useState<unknown>(null);
  const [activeTab, setActiveTab] = useState("governance");
  const [messageApi, contextHolder] = message.useMessage();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/v1/sites/${siteId}`, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "Site onboarding dashboard could not be loaded.");
      setDashboard(body);
    } catch (error) {
      setDashboard(null);
      setLoadError(error instanceof Error ? error.message : "Site onboarding dashboard could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(path: string, values: unknown, success: string) {
    setSubmitting(true);
    setFormError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values ?? {})
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "The request could not be completed.");
      messageApi.success(success);
      await load();
      return body ?? {};
    } catch (error) {
      const nextError = error instanceof Error ? error.message : "The request could not be completed.";
      setFormError(nextError);
      messageApi.error(nextError);
      return null;
    } finally {
      setSubmitting(false);
    }
  }

  async function patch(path: string, values: unknown, success: string) {
    setSubmitting(true);
    setFormError(null);
    try {
      const response = await fetch(path, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values)
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "The request could not be completed.");
      messageApi.success(success);
      await load();
      return body ?? {};
    } catch (error) {
      const nextError = error instanceof Error ? error.message : "The request could not be completed.";
      setFormError(nextError);
      messageApi.error(nextError);
      return null;
    } finally {
      setSubmitting(false);
    }
  }

  async function createJoinPackage() {
    const result = await post(`/api/v1/sites/${siteId}/join-package`, {}, "Startup kit prepared.");
    if (!result) return;
    setEnrollmentToken(result.enrollmentToken ?? null);
    setInlineManifest(result.manifest ?? null);
    if (result.downloadUrl) window.location.assign(result.downloadUrl);
    if (result.message) messageApi.info(result.message);
  }

  async function downloadJoinPackage(packageId: string) {
    const response = await fetch(`/api/v1/sites/${siteId}/join-package/${packageId}/download`);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      messageApi.error(body?.error?.message ?? "Startup kit could not be downloaded.");
      return;
    }
    if (body.downloadUrl) {
      window.location.href = body.downloadUrl;
      return;
    }
    setInlineManifest(body.manifest ?? null);
    messageApi.info(body.message ?? "Startup kit manifest is available inline.");
  }

  async function rotateToken() {
    const result = await post(`/api/v1/sites/${siteId}/token/rotate`, {}, "Site token rotated.");
    if (!result) return;
    setEnrollmentToken(result.enrollmentToken ?? null);
    if (result.message) messageApi.info(result.message);
  }

  async function downloadReleaseArtifact(releaseId: string, artifactId: string) {
    const response = await fetch(`/api/v1/releases/${releaseId}/download?artifactId=${artifactId}`);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      messageApi.error(body?.error?.message ?? "Pipeline bundle could not be downloaded.");
      return;
    }
    if (body.downloadUrl) window.location.assign(body.downloadUrl);
    else messageApi.info(body.message ?? "Artifact is registered, but no download URL is available.");
  }

  async function downloadPipelineVersion(versionId: string) {
    const response = await fetch(`/api/v1/pipeline-versions/${versionId}/download`);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      messageApi.error(body?.error?.message ?? "Pipeline bundle could not be downloaded.");
      return;
    }
    if (body.downloadUrl) window.location.assign(body.downloadUrl);
    else messageApi.info(body.message ?? "Pipeline bundle metadata is registered, but no download URL is available.");
  }

  const site = dashboard?.studySite;
  const activeDeployment = dashboard?.activeDeployment;
  const latestReadiness = site?.readinessChecks?.[0];
  const latestStatus = site?.nvflareStatuses?.[0] ?? site?.site?.heartbeats?.[0];
  const activeJoinPackage = useMemo(
    () =>
      site?.joinPackages?.find(
        (item: EntityRecord) => item.status === "ACTIVE" && (!item.expiresAt || new Date(item.expiresAt) > new Date())
      ),
    [site?.joinPackages]
  );
  const sourceArtifacts = useMemo(
    () =>
      (dashboard?.approvedReleases ?? []).flatMap((release) =>
        (release.artifacts ?? [])
          .filter((artifact: EntityRecord) => ["SOURCE_BUNDLE", "CHECKSUM_MANIFEST", "SIGNATURE"].includes(artifact.kind))
          .map((artifact: EntityRecord) => ({ release, artifact }))
      ),
    [dashboard?.approvedReleases]
  );
  const runnerCommand = [
    "chmod +x fedlify-runner.sh",
    `FEDLIFY_SITE_TOKEN=${enrollmentToken ?? "<token-from-fedlify>"} ./fedlify-runner.sh start --safe`
  ].join("\n");
  const onboardingWorkflow = useMemo(
    () =>
      site
        ? buildSiteWorkflow({
            site,
            activeDeployment,
            activeJoinPackage,
            latestReadiness,
            latestStatus
          })
        : [],
    [activeDeployment, activeJoinPackage, latestReadiness, latestStatus, site]
  );
  const gateItems = useMemo(
    () =>
      site
        ? buildSiteGateItems({
            site,
            activeDeployment,
            activeJoinPackage,
            latestReadiness,
            latestStatus
          })
        : [],
    [activeDeployment, activeJoinPackage, latestReadiness, latestStatus, site]
  );

  if (loading && !dashboard) {
    return (
      <AppPage>
        <CardGridSkeleton count={6} />
      </AppPage>
    );
  }

  if (loadError && !dashboard) {
    return (
      <AppPage>
        <InlineLoadError message={loadError} onRetry={() => void load()} />
      </AppPage>
    );
  }

  if (!dashboard || !site) return <Alert type="error" message="Site onboarding dashboard could not be loaded." />;

  return (
    <>
      {contextHolder}
      <AppPage>
        <AppPageHeader
          title={text(site.name, "Participant site")}
          subtitle={`${text(site.institutionName, "Institution")} - ${text(site.study?.title, "Study")}`}
          backLabel="Participant sites"
          onBack={() => router.push(`/studies/${site.studyId}?section=sites`)}
          badges={
            <Space wrap>
              <StatusTag value={site.participationStatus} />
              <StatusTag value={latestReadiness?.status ?? "PENDING"} />
            </Space>
          }
        />

        <div className="fedlify-section-stack">
          <WorkflowRail steps={onboardingWorkflow} />
          <GateChecklist items={gateItems} />

          <FormError title="Site onboarding request failed" message={formError} />

          {enrollmentToken ? (
            <Alert
              type="success"
              showIcon
              message="One-time enrollment token"
              description={
                <Space direction="vertical" size={8}>
                  <Typography.Text copyable={{ text: enrollmentToken }}>{enrollmentToken}</Typography.Text>
                  <Typography.Text className="fedlify-muted">
                    Use this once with the Fedlify runner command. The runner writes it to the local `.env`; Fedlify stores only the hash.
                  </Typography.Text>
                </Space>
              }
              action={
                <Button icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(enrollmentToken)}>
                  Copy
                </Button>
              }
            />
          ) : null}

          <Tabs
            className="fedlify-card-tabs fedlify-workspace-tabs"
            activeKey={activeTab}
            onChange={(key) => {
              setFormError(null);
              setActiveTab(key);
            }}
            items={[
              {
                key: "governance",
                label: "Governance",
                children: (
                  <div className="fedlify-tab-panel">
                    <div className="fedlify-governance-grid">
                      <div className="fedlify-governance-field">
                        <span className="fedlify-governance-label">Study status</span>
                        <span className="fedlify-governance-value">{displayEnum(site.study?.status)}</span>
                      </div>
                      <div className="fedlify-governance-field">
                        <span className="fedlify-governance-label">Governance status</span>
                        <span className="fedlify-governance-value">{displayEnum(site.study?.governanceStatus)}</span>
                      </div>
                      <div className="fedlify-governance-field">
                        <span className="fedlify-governance-label">Risk level</span>
                        <span className="fedlify-governance-value">{displayEnum(site.study?.riskLevel)}</span>
                      </div>
                      <div className="fedlify-governance-field">
                        <span className="fedlify-governance-label">Intended use</span>
                        <span className="fedlify-governance-value">{text(site.study?.intendedUse)}</span>
                      </div>
                      <div className="fedlify-governance-field fedlify-governance-full">
                        <span className="fedlify-governance-label">Research question</span>
                        <span className="fedlify-governance-value">{text(site.study?.researchQuestion)}</span>
                      </div>
                    </div>
                  </div>
                )
              },
              {
                key: "startup",
                label: "Startup kit",
                children: (
                  <div className="fedlify-tab-panel">
                    <div className="fedlify-tab-toolbar">
                      <div />
                      <div className="fedlify-tab-toolbar-actions">
                        <Button icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(runnerCommand)}>
                          Copy runner command
                        </Button>
                      </div>
                    </div>
                    <CardGrid>
                      <EntityCard
                        title="Aggregator deployment"
                        subtitle={text(activeDeployment?.name, "No active deployment")}
                        status={<StatusTag value={activeDeployment?.status ?? "NOT_STARTED"} />}
                        meta={[
                          `Server: ${text(activeDeployment?.serverAddress)}`,
                          `Admin: ${text(activeDeployment?.adminAddress)}`,
                          `Runtime: ${text(activeDeployment?.runtimeMode, "local-docker")}`
                        ]}
                      />
                      <EntityCard
                        title="Site startup package"
                        subtitle="Fedlify runner, NVFLARE client identity, site agent configuration, and install manifest."
                        status={<StatusTag value={activeJoinPackage?.status ?? "NOT_CREATED"} />}
                        meta={[
                          `Client: ${text(site.site?.nvflareClientName)}`,
                          `Latest package: ${activeJoinPackage ? formatDate(activeJoinPackage.createdAt) : "Not generated"}`,
                          `Expires: ${activeJoinPackage ? formatDate(activeJoinPackage.expiresAt) : "Not set"}`
                        ]}
                        actions={
                          <Space wrap>
                            <Button icon={<CloudDownloadOutlined />} loading={submitting} onClick={() => void createJoinPackage()}>
                              Download runner kit
                            </Button>
                            {activeJoinPackage ? (
                              <Button icon={<CloudDownloadOutlined />} onClick={() => void downloadJoinPackage(activeJoinPackage.id)}>
                                Download latest
                              </Button>
                            ) : null}
                            <Button icon={<ReloadOutlined />} loading={submitting} onClick={() => void rotateToken()}>
                              Rotate token
                            </Button>
                          </Space>
                        }
                      />
                      <EntityCard
                        title="Connection status"
                        subtitle={`Last signal ${latestStatus?.observedAt ? formatDate(latestStatus.observedAt) : formatDate(latestStatus?.createdAt)}`}
                        status={<StatusTag value={latestStatus?.status ?? "OFFLINE"} />}
                        meta={[
                          `Heartbeat endpoint: /api/v1/sites/${text(site.site?.id, "site-id")}/heartbeat`,
                          `NVFLARE job: ${text(latestStatus?.currentJobId)}`
                        ]}
                      />
                    </CardGrid>
                    <pre className="fedlify-command-panel">{runnerCommand}</pre>
                    <Alert
                      type="info"
                      showIcon
                      message="The runner owns the Docker complexity"
                      description="Run the command from the extracted kit folder. If Docker is missing, the runner explains the safe next step. Sites that permit managed dependency installation can rerun with `--install-deps --yes`."
                    />
                    {inlineManifest ? (
                      <pre className="fedlify-detail-json">{JSON.stringify(inlineManifest, null, 2)}</pre>
                    ) : null}
                  </div>
                )
              },
              {
                key: "data",
                label: "Data profile",
                children: (
                  <div className="fedlify-tab-panel">
                    <div className="fedlify-inline-create-card">
                      <Form
                        key={site.dataProfile?.id ?? "data-profile"}
                        layout="vertical"
                        className="fedlify-inline-create-form"
                        initialValues={{
                          modality: splitMultiSelectValue(site.dataProfile?.modality),
                          cohortSizeRange: site.dataProfile?.cohortSizeRange,
                          datasetDescription: site.dataProfile?.datasetDescription,
                          inclusionCriteria: site.dataProfile?.inclusionCriteria,
                          exclusionCriteria: site.dataProfile?.exclusionCriteria,
                          dataResidency: site.dataProfile?.dataResidency,
                          deidentificationSummary: site.dataProfile?.deidentificationSummary
                        }}
                        onFinish={async (values) => {
                          await patch(
                            `/api/v1/sites/${siteId}/governance`,
                            {
                              dataProfile: {
                                ...values,
                                modality: normalizeMultiSelectValue(values.modality)
                              }
                            },
                            "Local data profile saved."
                          );
                        }}
                      >
                        <div className="fedlify-intake-field-grid">
                          <Form.Item name="modality" label="Data modalities">
                            <Select mode="tags" options={DATA_MODALITY_OPTIONS} optionFilterProp="label" placeholder="Select modalities" />
                          </Form.Item>
                          <Form.Item name="cohortSizeRange" label="Cohort size range">
                            <Input placeholder="e.g. 1k-5k records" />
                          </Form.Item>
                          <Form.Item name="datasetDescription" label="Dataset summary" className="fedlify-intake-full">
                            <Input.TextArea rows={3} placeholder="Cohort-level description only. Do not enter patient-level data." />
                          </Form.Item>
                          <Form.Item name="inclusionCriteria" label="Inclusion summary">
                            <Input.TextArea rows={2} />
                          </Form.Item>
                          <Form.Item name="exclusionCriteria" label="Exclusion summary">
                            <Input.TextArea rows={2} />
                          </Form.Item>
                          <Form.Item name="dataResidency" label="Data residency">
                            <Input placeholder="site-local" />
                          </Form.Item>
                          <Form.Item name="deidentificationSummary" label="De-identification summary">
                            <Input />
                          </Form.Item>
                        </div>
                        <Space className="fedlify-form-actions">
                          <Button type="primary" htmlType="submit" className="fedlify-dark-action" loading={submitting}>
                            Save data profile
                          </Button>
                        </Space>
                      </Form>
                    </div>
                  </div>
                )
              },
              {
                key: "readiness",
                label: "Readiness",
                children: (
                  <div className="fedlify-tab-panel">
                    <div className="fedlify-inline-create-card">
                      <Form
                        key={latestReadiness?.id ?? "readiness"}
                        layout="vertical"
                        className="fedlify-inline-create-form"
                        initialValues={{
                          connectivityVerified: latestReadiness?.connectivityVerified ?? false,
                          kitInstalled: latestReadiness?.kitInstalled ?? false,
                          dependenciesVerified: latestReadiness?.dependenciesVerified ?? false,
                          policyAccepted: latestReadiness?.policyAccepted ?? false,
                          notes: latestReadiness?.notes
                        }}
                        onFinish={async (values) => {
                          await patch(`/api/v1/sites/${siteId}/governance`, { readiness: values }, "Site readiness updated.");
                        }}
                      >
                        <div className="fedlify-readiness-checks">
                          <Form.Item name="connectivityVerified" valuePropName="checked">
                            <Checkbox>Fedlify heartbeat or NVFLARE client connection verified</Checkbox>
                          </Form.Item>
                          <Form.Item name="kitInstalled" valuePropName="checked">
                            <Checkbox>Startup kit installed in the local site environment</Checkbox>
                          </Form.Item>
                          <Form.Item name="dependenciesVerified" valuePropName="checked">
                            <Checkbox>Runtime dependencies verified</Checkbox>
                          </Form.Item>
                          <Form.Item name="policyAccepted" valuePropName="checked">
                            <Checkbox>Local policy accepted by authorized site staff</Checkbox>
                          </Form.Item>
                        </div>
                        <Form.Item name="notes" label="Readiness notes">
                          <Input.TextArea rows={3} />
                        </Form.Item>
                        <Space className="fedlify-form-actions">
                          <Button
                            icon={<SafetyCertificateOutlined />}
                            onClick={() => void post(`/api/v1/sites/${siteId}/policy-acceptance`, {}, "Local policy accepted.")}
                            loading={submitting}
                          >
                            Accept policy
                          </Button>
                          <Button type="primary" htmlType="submit" icon={<CheckCircleOutlined />} className="fedlify-dark-action" loading={submitting}>
                            Run readiness check
                          </Button>
                        </Space>
                      </Form>
                    </div>
                  </div>
                )
              },
              {
                key: "pipeline",
                label: "Pipeline review",
                children: (
                  <div className="fedlify-tab-panel">
                    {dashboard.pipelineVersions.length === 0 && sourceArtifacts.length === 0 ? (
                      <EmptyState
                        icon={<FileTextOutlined />}
                        title="No validated pipeline bundles"
                        description="Validated or approved pipeline versions will appear here for site review."
                      />
                    ) : (
                      <CardGrid>
                        {dashboard.pipelineVersions.map((version) => (
                          <EntityCard
                            key={version.id}
                            title={`${text(version.project?.name, "Pipeline")} ${text(version.version, "")}`}
                            subtitle={text(version.project?.template?.name, "NVFLARE template")}
                            status={<StatusTag value={version.approvalStatus} />}
                            meta={[
                              `Validation: ${displayEnum(version.validationStatus)}`,
                              `Commit: ${text(version.gitCommit)}`,
                              `Branch: ${text(version.gitBranch)}`,
                              `Repo: ${text(version.project?.giteaRepoUrl)}`
                            ]}
                            actions={
                              <Button icon={<CloudDownloadOutlined />} onClick={() => void downloadPipelineVersion(version.id)}>
                                Download approved pipeline bundle
                              </Button>
                            }
                          />
                        ))}
                        {sourceArtifacts.map(({ release, artifact }) => (
                          <EntityCard
                            key={artifact.id}
                            title={displayEnum(artifact.kind)}
                            subtitle={`Release ${text(release.version)}`}
                            status={<StatusTag value={release.status} />}
                            meta={[`Checksum: ${text(artifact.checksum).slice(0, 16)}...`, `Downloads: ${artifact.downloadCount ?? 0}`]}
                            actions={
                              <Button icon={<CloudDownloadOutlined />} onClick={() => void downloadReleaseArtifact(release.id, artifact.id)}>
                                Download approved pipeline bundle
                              </Button>
                            }
                          />
                        ))}
                      </CardGrid>
                    )}
                  </div>
                )
              },
              {
                key: "activity",
                label: "Staff, logs & audit",
                children: (
                  <div className="fedlify-tab-panel">
                    <CardGrid>
                      <EntityCard
                        title="Assigned staff"
                        subtitle={`${site.members?.length ?? 0} site-scoped assignments`}
                        status={<TeamOutlined />}
                        meta={(site.members ?? []).map((member: EntityRecord) => `${text(member.user?.email, member.user?.name)}: ${displayEnum(member.role)}`)}
                      />
                      <EntityCard
                        title="Operational logs"
                        subtitle={`${site.logArtifacts?.length ?? 0} retained artifacts`}
                        status={<ApiOutlined />}
                        meta={(site.logArtifacts ?? []).slice(0, 4).map((artifact: EntityRecord) => `${text(artifact.kind)}: ${text(artifact.filename)}`)}
                      />
                    </CardGrid>

                    {dashboard.auditEvents.length === 0 ? (
                      <EmptyState icon={<SafetyCertificateOutlined />} title="No site audit events" description="Site onboarding actions will be recorded here." />
                    ) : (
                      <CardGrid>
                        {dashboard.auditEvents.slice(0, 6).map((event) => (
                          <EntityCard
                            key={event.id}
                            title={displayEnum(event.action)}
                            subtitle={formatDate(event.createdAt)}
                            meta={[`Target: ${text(event.targetType)}`, `Actor: ${text(event.actorUserId)}`]}
                          />
                        ))}
                      </CardGrid>
                    )}
                  </div>
                )
              }
            ]}
          />
        </div>
      </AppPage>
    </>
  );
}
