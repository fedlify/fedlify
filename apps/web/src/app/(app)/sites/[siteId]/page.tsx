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
import { Alert, Button, Checkbox, Form, Input, Modal, Select, Space, Tabs, Tag, Typography, message } from "antd";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppPage, AppPageHeader } from "@/components/AppPage";
import { CardGrid, EntityCard } from "@/components/DataCards";
import { FormError } from "@/components/FormFeedback";
import { CardGridSkeleton, EmptyState, InlineLoadError } from "@/components/LoadStates";
import { StatusTag } from "@/components/StatusTag";
import { toneIcon } from "@/components/PipelineRail";
import type { SiteRuntime } from "@/lib/site-runtime";
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
  runtime: SiteRuntime;
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

function shortImage(value: string | null) {
  const sha = value?.match(/sha256:([0-9a-f]{12})/)?.[1];
  return sha ? `sha256:${sha}` : "Not reported";
}

function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <div className="fedlify-governance-grid">
      {items.map(([label, value]) => (
        <div key={label} className="fedlify-governance-field">
          <span className="fedlify-governance-label">{label}</span>
          <span className="fedlify-governance-value">{value}</span>
        </div>
      ))}
    </div>
  );
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
  // The kit passphrase exists only here, in memory, until the creator dismisses it. Fedlify keeps no copy.
  const [kitPassphrase, setKitPassphrase] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<{ mode: "create" } | { mode: "download"; packageId: string } | null>(null);
  const [stepUpPassword, setStepUpPassword] = useState("");
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("runner");
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

  function askPassword(next: { mode: "create" } | { mode: "download"; packageId: string }) {
    setStepUpPassword("");
    setStepUpError(null);
    setStepUp(next);
  }

  function closeStepUp() {
    setStepUp(null);
    setStepUpPassword("");
    setStepUpError(null);
  }

  async function confirmStepUp() {
    if (!stepUp) return;
    if (!stepUpPassword) {
      setStepUpError("Enter your account password.");
      return;
    }
    setSubmitting(true);
    setStepUpError(null);
    try {
      if (stepUp.mode === "create") {
        const response = await fetch(`/api/v1/sites/${siteId}/join-package`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: stepUpPassword })
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error?.message ?? "The startup kit could not be created.");
        closeStepUp();
        messageApi.success("Startup kit prepared.");
        setEnrollmentToken(body.enrollmentToken ?? null);
        setKitPassphrase(body.passphrase ?? null);
        setInlineManifest(body.manifest ?? null);
        await load();
        if (body.downloadUrl) window.location.assign(body.downloadUrl);
        if (body.message) messageApi.info(body.message);
      } else {
        const base = `/api/v1/sites/${siteId}/join-package/${stepUp.packageId}/download`;
        const grantResponse = await fetch(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: stepUpPassword })
        });
        const grantBody = await grantResponse.json().catch(() => null);
        if (!grantResponse.ok) throw new Error(grantBody?.error?.message ?? "Startup kit could not be downloaded.");
        closeStepUp();
        if (!grantBody.grant) {
          setInlineManifest(grantBody.manifest ?? null);
          messageApi.info(grantBody.message ?? "Startup kit manifest is available inline.");
          return;
        }
        const urlResponse = await fetch(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grant: grantBody.grant })
        });
        const urlBody = await urlResponse.json().catch(() => null);
        if (!urlResponse.ok || !urlBody?.downloadUrl) throw new Error(urlBody?.error?.message ?? "Startup kit could not be downloaded.");
        window.location.href = urlBody.downloadUrl;
      }
    } catch (error) {
      setStepUpError(error instanceof Error ? error.message : "The request could not be completed.");
    } finally {
      setSubmitting(false);
    }
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
  const runtime = dashboard?.runtime;
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
    "# Unzip the download, then (the passphrase is typed at the prompt):",
    "chmod +x unlock.sh && ./unlock.sh",
    "cd fedlify-site-kit",
    `FEDLIFY_SITE_TOKEN=${enrollmentToken ?? "<token-from-fedlify>"} ./fedlify-runner.sh start`
  ].join("\n");
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

  if (!dashboard || !site || !runtime) return <Alert type="error" message="Site onboarding dashboard could not be loaded." />;

  return (
    <>
      {contextHolder}
      <Modal
        open={stepUp !== null}
        title={stepUp?.mode === "create" ? "Confirm your password to create a kit" : "Confirm your password to download"}
        okText={stepUp?.mode === "create" ? "Create kit" : "Download"}
        confirmLoading={submitting}
        onOk={() => void confirmStepUp()}
        onCancel={closeStepUp}
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text>
            {stepUp?.mode === "create"
              ? "Creating a kit rotates this site's token, revokes the previous kit, and issues a new passphrase."
              : "Each confirmation allows one download. The kit file is useless without its passphrase."}
          </Typography.Text>
          <Input.Password
            autoFocus
            autoComplete="current-password"
            placeholder="Account password"
            value={stepUpPassword}
            onChange={(event) => setStepUpPassword(event.target.value)}
            onPressEnter={() => void confirmStepUp()}
          />
          {stepUpError ? <Alert type="error" showIcon message={stepUpError} /> : null}
        </Space>
      </Modal>
      <AppPage>
        <AppPageHeader
          title={text(site.name, "Participant site")}
          subtitle={`${text(site.institutionName, "Institution")} - ${text(site.study?.title, "Study")}`}
          backLabel="Participant sites"
          onBack={() => router.push(`/studies/${site.studyId}?section=sites`)}
          actions={<Button icon={<ReloadOutlined />} onClick={() => void load()} aria-label="Refresh site status" />}
        />

        <div className="fedlify-section-stack">
          <nav className="fedlify-ws-rail" aria-label="Site status">
            {runtime.stages.map((stage) => (
              <div key={stage.key} className={["fedlify-ws-stage", `is-${stage.tone}`].join(" ")}>
                <button type="button" className="fedlify-ws-stage-main" onClick={() => setActiveTab(stage.tab)}>
                  <span className="fedlify-ws-stage-icon" aria-hidden>{toneIcon[stage.tone]}</span>
                  <span className="fedlify-ws-stage-copy">
                    <strong>{stage.title}</strong>
                    <span title={stage.status}>{stage.status}</span>
                  </span>
                </button>
              </div>
            ))}
          </nav>
          {runtime.nextStep ? <Alert type="warning" showIcon message="Next step" description={runtime.nextStep} data-testid="site-next-step" /> : null}

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
                key: "runner",
                label: "Get runner",
                children: (
                  <div className="fedlify-tab-panel">
                    <section className="fedlify-site-panel">
                      <div className="fedlify-site-panel-head">
                        <strong>1. Startup kit</strong>
                        <Tag color={runtime.kitState === "RELEASED" ? "green" : "orange"}>{runtime.kitState === "RELEASED" ? "Released" : runtime.kitState === "OUTDATED" ? "New kit needed" : "Not released"}</Tag>
                      </div>
                      <Typography.Text type="secondary">
                        {activeJoinPackage ? `Created ${formatDate(activeJoinPackage.createdAt)}, expires ${formatDate(activeJoinPackage.expiresAt)}. A kit carries this site's identity, so only release it to this site's operator.` : "Creates this site's identity and an encrypted download."}
                      </Typography.Text>
                      <Space wrap>
                        <Button type={activeJoinPackage ? "default" : "primary"} icon={<CloudDownloadOutlined />} loading={submitting} onClick={() => askPassword({ mode: "create" })}>
                          {activeJoinPackage ? "Create new kit" : "Create encrypted kit"}
                        </Button>
                        {activeJoinPackage ? (
                          <Button type="primary" icon={<CloudDownloadOutlined />} onClick={() => askPassword({ mode: "download", packageId: activeJoinPackage.id })}>
                            Download kit
                          </Button>
                        ) : null}
                        <Button icon={<ReloadOutlined />} loading={submitting} onClick={() => void rotateToken()}>
                          Rotate token
                        </Button>
                      </Space>
                    {kitPassphrase ? (
                      <Alert
                        type="warning"
                        showIcon
                        message="Kit passphrase: shown once"
                        description={
                          <Space direction="vertical" style={{ width: "100%" }}>
                            <Typography.Text code copyable={false} style={{ fontSize: 16, wordBreak: "break-all" }}>
                              {kitPassphrase}
                            </Typography.Text>
                            <Typography.Text>
                              Fedlify does not keep it. Send it to the site operator by a different channel than the kit file (phone, a messaging app,
                              in person). Never send it with the file, and never by email together with the file. If it is lost, create a new kit.
                            </Typography.Text>
                            <Space wrap>
                              <Button
                                icon={<CopyOutlined />}
                                onClick={() => {
                                  void navigator.clipboard.writeText(kitPassphrase);
                                  messageApi.success("Passphrase copied.");
                                }}
                              >
                                Copy passphrase
                              </Button>
                              <Button onClick={() => setKitPassphrase(null)}>I have saved it, hide it</Button>
                            </Space>
                          </Space>
                        }
                      />
                    ) : null}
                      <Typography.Text type="secondary" className="fedlify-site-note">
                        Creating a new kit or rotating the token revokes the old kit and token. The site&apos;s NVFLARE certificate cannot be re-issued yet, so a kit that was already unlocked keeps a valid certificate until the study is republished with new site identities.
                      </Typography.Text>
                    </section>

                    <section className="fedlify-site-panel">
                      <div className="fedlify-site-panel-head">
                        <strong>2. Install and start the runner</strong>
                        <Button size="small" icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(runnerCommand)}>Copy commands</Button>
                      </div>
                      <Typography.Text type="secondary">
                        Check the machine and install Docker first with the public <a href="/get-ready" target="_blank" rel="noreferrer">Get ready page</a>. Unlocking needs age or Docker. On Windows the runner runs inside WSL 2.
                      </Typography.Text>
                      <pre className="fedlify-command-panel">{runnerCommand}</pre>
                    </section>

                    {runtime.imageFix.length > 0 ? (
                      <section className="fedlify-site-panel">
                        <div className="fedlify-site-panel-head">
                          <strong>3. Bring this site up to date</strong>
                          <Tag color="orange">{runtime.imageState === "OUTDATED" ? "Outdated" : "Not reported"}</Tag>
                        </div>
                        <ol className="fedlify-site-steps">{runtime.imageFix.map((step) => <li key={step}>{step}</li>)}</ol>
                      </section>
                    ) : null}

                    <section className="fedlify-site-panel">
                      <div className="fedlify-site-panel-head"><strong>Connection</strong></div>
                      <Facts
                        items={[
                          ["Aggregator", runtime.live?.hostname ? `${runtime.live.hostname}:443` : "Nothing published"],
                          ["Serving", runtime.live?.version ? `${runtime.live.version}${runtime.live.gitCommit ? ` (${runtime.live.gitCommit.slice(0, 8)})` : ""}` : "Nothing published"],
                          ["NVFLARE client", runtime.clientName],
                          ["Runner's last report", runtime.lastHeartbeatLabel]
                        ]}
                      />
                    </section>
                    {inlineManifest ? (
                      <pre className="fedlify-detail-json">{JSON.stringify(inlineManifest, null, 2)}</pre>
                    ) : null}
                  </div>
                )
              },
              {
                key: "readiness",
                label: "Readiness",
                children: (
                  <div className="fedlify-tab-panel">
                    <section className="fedlify-site-panel">
                      <div className="fedlify-site-panel-head"><strong>Machine evidence</strong><Typography.Text type="secondary">Reported by the site&apos;s runner, {runtime.lastHeartbeatLabel.toLowerCase()}</Typography.Text></div>
                      <Facts
                        items={[
                          ["Runner", text(runtime.evidence.runner, "Not reported")],
                          ["Container", `${text(runtime.evidence.container, "Not reported")}${runtime.evidence.health ? `, ${runtime.evidence.health}` : ""}`],
                          ["Restarts", text(runtime.evidence.restarts, "Not reported")],
                          ["Data files found", text(runtime.evidence.dataFiles, "Not reported")],
                          ["Disk free", runtime.evidence.diskFreeGb === null ? "Not reported" : `${runtime.evidence.diskFreeGb} GB`],
                          ["GPUs", text(runtime.evidence.gpus, "Not reported")],
                          ["Study image", shortImage(runtime.evidence.reportedImage)]
                        ]}
                      />
                    </section>
                    <div className="fedlify-site-panel-head"><strong>Site attestation</strong><Typography.Text type="secondary">Confirmed by a person responsible for this site</Typography.Text></div>
                    <div className="fedlify-inline-create-card">
                      <Form
                        key={latestReadiness?.id ?? "readiness"}
                        layout="vertical"
                        className="fedlify-inline-create-form"
                        initialValues={{
                          dependenciesVerified: latestReadiness?.dependenciesVerified ?? false,
                          policyAccepted: latestReadiness?.policyAccepted ?? false,
                          notes: latestReadiness?.notes
                        }}
                        onFinish={async (values) => {
                          // Connectivity is checked live when a run starts, so the sign-off is only what staff confirm here.
                          await patch(`/api/v1/sites/${siteId}/governance`, { readiness: values }, "Site attestation saved.");
                        }}
                      >
                        <div className="fedlify-readiness-checks">
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
                            Save attestation
                          </Button>
                        </Space>
                      </Form>
                    </div>
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
                key: "pipeline",
                label: "Published code",
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
                            subtitle={version.id === runtime.live?.versionId ? "Serving now" : "Earlier version"}
                            status={version.id === runtime.live?.versionId ? <Tag color="green">Live</Tag> : <StatusTag value={version.approvalStatus} />}
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
