"use client";

import {
  CheckCircleOutlined,
  CloudDownloadOutlined,
  CopyOutlined,
  MailOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  UserAddOutlined
} from "@ant-design/icons";
import type { SiteRole } from "@prisma/client";
import { Alert, Button, Checkbox, Collapse, Form, Input, Modal, Popconfirm, Select, Space, Tabs, Tag, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppPage, AppPageHeader } from "@/components/AppPage";
import { Details } from "@/components/Details";
import { FormError } from "@/components/FormFeedback";
import { CardGridSkeleton, EmptyState, InlineLoadError } from "@/components/LoadStates";
import { toneIcon } from "@/components/PipelineRail";
import { isSiteContact } from "@/lib/plain-roles";
import { studySoftwareLabel, type SiteRuntime } from "@/lib/site-runtime";
import { auditActionLabel, kitStateLabel, roleLabel, statusLabel, TERMS } from "@/lib/terms";
import { useSitePermissions, useStudyPermissions } from "@/lib/use-permissions";
import {
  DATA_MODALITY_OPTIONS,
  normalizeMultiSelectValue,
  splitMultiSelectValue
} from "@/lib/governance-options";

type EntityRecord = Record<string, any>;

type SiteDashboard = {
  pendingInvitations?: EntityRecord[];
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
  return statusLabel(value);
}

function formatDate(value: unknown) {
  if (!value || typeof value !== "string") return "Not recorded";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function shortImage(value: string | null) {
  const sha = value?.match(/sha256:([0-9a-f]{12})/)?.[1];
  return sha ? `sha256:${sha}` : "Not reported";
}

const IMAGE_STATE_LABEL: Record<string, string> = {
  CURRENT: "Up to date",
  OUTDATED: "Needs update",
  NOT_REPORTED: "Not reported",
  UNKNOWN: "Nothing published"
};

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
  const [activeTab, setActiveTab] = useState("kit");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteResult, setInviteResult] = useState<{ email: string; emailSent: boolean; inviteUrl: string | null } | null>(null);
  const { data: session } = useSession();
  const { can, backHref, loading: permissionsLoading, error: permissionsError } = useSitePermissions(siteId);
  const [siteCount, setSiteCount] = useState(0);
  const [messageApi, contextHolder] = message.useMessage();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/v1/sites/${siteId}`, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (response.status === 403 || response.status === 404) {
        throw new Error("You do not have access to this site. Open My site from the menu to see the sites you can use.");
      }
      if (!response.ok) throw new Error(body?.error?.message ?? "This site could not be loaded.");
      setDashboard(body);
    } catch (error) {
      setDashboard(null);
      setLoadError(error instanceof Error ? error.message : "This site could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A person with several sites gets a way back to the list.
  useEffect(() => {
    let active = true;
    fetch("/api/v1/me", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => active && setSiteCount(Array.isArray(body?.sites) ? body.sites.length : 0))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

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
        if (!response.ok) throw new Error(body?.error?.message ?? "The site kit could not be created.");
        closeStepUp();
        messageApi.success("Site kit created.");
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
        if (!grantResponse.ok) throw new Error(grantBody?.error?.message ?? "The site kit could not be downloaded.");
        closeStepUp();
        if (!grantBody.grant) {
          setInlineManifest(grantBody.manifest ?? null);
          messageApi.info(grantBody.message ?? "The site kit contents are shown below.");
          return;
        }
        const urlResponse = await fetch(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grant: grantBody.grant })
        });
        const urlBody = await urlResponse.json().catch(() => null);
        if (!urlResponse.ok || !urlBody?.downloadUrl) throw new Error(urlBody?.error?.message ?? "The site kit could not be downloaded.");
        window.location.href = urlBody.downloadUrl;
      }
    } catch (error) {
      setStepUpError(error instanceof Error ? error.message : "The request could not be completed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function rotateToken() {
    const result = await post(`/api/v1/sites/${siteId}/token/rotate`, {}, "Site access code reset.");
    if (!result) return;
    setEnrollmentToken(result.enrollmentToken ?? null);
    if (result.message) messageApi.info(result.message);
  }

  async function downloadReleaseArtifact(releaseId: string, artifactId: string) {
    const response = await fetch(`/api/v1/releases/${releaseId}/download?artifactId=${artifactId}`);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      messageApi.error(body?.error?.message ?? "Pipeline files could not be downloaded.");
      return;
    }
    if (body.downloadUrl) window.location.assign(body.downloadUrl);
    else messageApi.info(body.message ?? "Artifact is registered, but no download URL is available.");
  }

  async function downloadPipelineVersion(versionId: string) {
    const response = await fetch(`/api/v1/pipeline-versions/${versionId}/download`);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      messageApi.error(body?.error?.message ?? "Pipeline files could not be downloaded.");
      return;
    }
    if (body.downloadUrl) window.location.assign(body.downloadUrl);
    else messageApi.info(body.message ?? "The pipeline files are registered, but cannot be downloaded yet.");
  }

  async function removePerson(userId: string, label: string) {
    const response = await fetch(`/api/v1/sites/${siteId}/members`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId })
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      messageApi.error(body?.error?.message ?? "That person could not be removed.");
      return;
    }
    messageApi.success(`${label} no longer has access to this site.`);
    await load();
  }

  async function sendInvite() {
    const email = inviteEmail.trim();
    if (!email) {
      setInviteError("Enter the person's email address.");
      return;
    }
    if (!site) return;
    setSubmitting(true);
    setInviteError(null);
    try {
      const response = await fetch(`/api/v1/studies/${site.studyId}/invitations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, studySiteId: siteId })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "The invitation could not be sent.");
      setInviteResult({ email, emailSent: Boolean(body?.emailSent), inviteUrl: body?.inviteUrl ?? null });
      setInviteEmail("");
      await load();
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : "The invitation could not be sent.");
    } finally {
      setSubmitting(false);
    }
  }

  async function revokeInvitation(invitationId: string) {
    if (!site) return;
    const response = await fetch(`/api/v1/studies/${site.studyId}/invitations/${invitationId}`, { method: "DELETE" });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      messageApi.error(body?.error?.message ?? "The invitation could not be cancelled.");
      return;
    }
    messageApi.success("Invitation cancelled.");
    await load();
  }

  function closeInvite() {
    setInviteOpen(false);
    setInviteEmail("");
    setInviteError(null);
    setInviteResult(null);
  }

  const site = dashboard?.studySite;
  const studyCan = useStudyPermissions(site?.studyId).can;
  const activeDeployment = dashboard?.activeDeployment;
  const latestReadiness = site?.readinessChecks?.[0];
  const runtime = dashboard?.runtime;
  const activeJoinPackage = site?.joinPackages?.find(
    (item: EntityRecord) => item.status === "ACTIVE" && (!item.expiresAt || new Date(item.expiresAt) > new Date())
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
    `FEDLIFY_SITE_TOKEN=${enrollmentToken ?? "<site-access-code>"} ./fedlify-runner.sh start`
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

  if (!dashboard || !site || !runtime) return <Alert type="error" message="This site could not be loaded." />;

  const TAB_FOR_STAGE: Record<string, string> = { runner: "kit", readiness: "signoff" };
  const canSeeBack = Boolean(backHref) && (backHref !== "/my-site" || siteCount > 1);
  const live = runtime.live;
  const liveVersion = dashboard.pipelineVersions.find((version) => version.id === live?.versionId) ?? null;
  const bundleSource = liveVersion
    ? () => void downloadPipelineVersion(liveVersion.id)
    : sourceArtifacts[0]
      ? () => void downloadReleaseArtifact(sourceArtifacts[0].release.id, sourceArtifacts[0].artifact.id)
      : null;

  // People on this site, one row per person with their plain role.
  const people = (() => {
    const byUser = new Map<string, { userId: string; name: string; email: string; roles: string[] }>();
    for (const member of site.members ?? []) {
      const entry = byUser.get(member.userId) ?? {
        userId: member.userId,
        name: text(member.user?.name, text(member.user?.email, "Unnamed person")),
        email: text(member.user?.email, ""),
        roles: [] as string[]
      };
      entry.roles.push(member.role);
      byUser.set(member.userId, entry);
    }
    return Array.from(byUser.values());
  })();
  const nameById = new Map(people.map((person) => [person.userId, person.name]));
  const actorName = (id: unknown) => (typeof id === "string" && id ? (id === session?.user?.id ? "You" : nameById.get(id) ?? "Someone on the study team") : "Fedlify");
  const ownEmail = session?.user?.email?.toLowerCase();

  return (
    <>
      {contextHolder}
      <Modal
        open={stepUp !== null}
        title={stepUp?.mode === "create" ? "Confirm your password to create a site kit" : "Confirm your password to download"}
        okText={stepUp?.mode === "create" ? "Create site kit" : "Download"}
        confirmLoading={submitting}
        onOk={() => void confirmStepUp()}
        onCancel={closeStepUp}
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text>
            {stepUp?.mode === "create"
              ? activeJoinPackage
                ? "Creating a site kit replaces this site's access code, cancels the previous site kit, and issues a new passphrase."
                : "Creating a site kit gives this site an access code and a passphrase. Both are shown once."
              : "Each confirmation allows one download. The site kit file is useless without its passphrase."}
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
      <Modal
        open={inviteOpen}
        title="Invite a site contact"
        okText="Send invitation"
        cancelText={inviteResult ? "Close" : "Cancel"}
        okButtonProps={{ style: inviteResult ? { display: "none" } : undefined }}
        confirmLoading={submitting}
        onOk={() => void sendInvite()}
        onCancel={closeInvite}
        destroyOnHidden
      >
        {inviteResult ? (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Alert
              type="success"
              showIcon
              message={inviteResult.emailSent ? `We emailed ${inviteResult.email}.` : `The invitation for ${inviteResult.email} is ready, but the email could not be sent.`}
              description={inviteResult.emailSent ? "They can sign in or create an account with that address and accept the invitation." : "Send them this link yourself."}
            />
            {!inviteResult.emailSent && inviteResult.inviteUrl ? <Typography.Text copyable={{ text: inviteResult.inviteUrl }}>{inviteResult.inviteUrl}</Typography.Text> : null}
          </Space>
        ) : (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Typography.Text>
              A site contact installs the runner and gives the site sign-off for {text(site.name, "this site")} only. They cannot see the rest of the study.
            </Typography.Text>
            <Input
              autoFocus
              type="email"
              placeholder="Email address"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              onPressEnter={() => void sendInvite()}
            />
            {inviteError ? <Alert type="error" showIcon message={inviteError} /> : null}
          </Space>
        )}
      </Modal>
      <AppPage>
        <AppPageHeader
          title={text(site.name, "Site")}
          subtitle={`${text(site.institutionName, "Institution")} - ${text(site.study?.title, "Study")}`}
          backLabel={canSeeBack ? (backHref === "/my-site" ? "My sites" : "Sites") : undefined}
          onBack={canSeeBack ? () => router.push(backHref as string) : undefined}
          actions={<Button icon={<ReloadOutlined />} onClick={() => void load()} aria-label="Refresh site status" />}
        />

        <div className="fedlify-section-stack">
          <nav className="fedlify-ws-rail" aria-label="Site status">
            {runtime.stages.map((stage) => (
              <div key={stage.key} className={["fedlify-ws-stage", `is-${stage.tone}`].join(" ")}>
                <button type="button" className="fedlify-ws-stage-main" onClick={() => setActiveTab(TAB_FOR_STAGE[stage.tab] ?? "kit")}>
                  <span className="fedlify-ws-stage-icon" aria-hidden>{toneIcon[stage.tone]}</span>
                  <span className="fedlify-ws-stage-copy">
                    <strong>{stage.title}</strong>
                    <span title={stage.status}>{stage.status}</span>
                  </span>
                </button>
              </div>
            ))}
          </nav>
          {permissionsError ? <Alert type="warning" showIcon message="We could not check what you can do on this page. Some buttons may be missing. Reload the page to try again." /> : null}
          {runtime.nextStep ? <Alert type="warning" showIcon message="Next step" description={runtime.nextStep} data-testid="site-next-step" /> : null}

          <FormError title="That did not work" message={formError} />

          {enrollmentToken ? (
            <Alert
              type="success"
              showIcon
              message="Site access code (shown once)"
              description={
                <Space direction="vertical" size={8}>
                  <Typography.Text copyable={{ text: enrollmentToken }}>{enrollmentToken}</Typography.Text>
                  <Typography.Text className="fedlify-muted">
                    Use this once when you start the runner. The runner saves it on the site&apos;s computer; Fedlify keeps only a scrambled copy.
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
                key: "kit",
                label: "Get site kit",
                children: (
                  <div className="fedlify-tab-panel">
                    <section className="fedlify-site-panel">
                      <div className="fedlify-site-panel-head">
                        <strong>1. Download the site kit</strong>
                        <Tag color={runtime.kitState === "RELEASED" ? "green" : "orange"}>{kitStateLabel(runtime.kitState)}</Tag>
                      </div>
                      <Typography.Text type="secondary">
                        {activeJoinPackage
                          ? `Created ${formatDate(activeJoinPackage.createdAt)}, expires ${formatDate(activeJoinPackage.expiresAt)}. A site kit carries this site's identity, so only give it to the person who sets up this site's computer.`
                          : "The site kit is an encrypted download that sets up this site's computer."}
                      </Typography.Text>
                      <Space wrap>
                        {activeJoinPackage ? (
                          can.downloadJoinKit ? (
                            <Button type="primary" icon={<CloudDownloadOutlined />} onClick={() => askPassword({ mode: "download", packageId: activeJoinPackage.id })}>
                              Download site kit
                            </Button>
                          ) : (
                            <Button disabled title="Ask your study team">{permissionsLoading ? "Checking..." : "Download site kit (ask your study team)"}</Button>
                          )
                        ) : can.downloadJoinKit ? (
                          <Button type="primary" icon={<CloudDownloadOutlined />} loading={submitting} onClick={() => askPassword({ mode: "create" })}>
                            Create site kit
                          </Button>
                        ) : (
                          <Button disabled title="Ask your study team">{permissionsLoading ? "Checking..." : "Create site kit (ask your study team)"}</Button>
                        )}
                      </Space>
                      {kitPassphrase ? (
                        <Alert
                          type="warning"
                          showIcon
                          message="Site kit passphrase: shown once"
                          description={
                            <Space direction="vertical" style={{ width: "100%" }}>
                              <Typography.Text code copyable={false} style={{ fontSize: 16, wordBreak: "break-all" }}>
                                {kitPassphrase}
                              </Typography.Text>
                              <Typography.Text>
                                Fedlify does not keep it. Keep the passphrase somewhere other than where you saved the site kit file. If someone else installs the runner,
                                give it to them by a different channel than the file (phone, a messaging app, in person), never by email together with the file. If it is lost, create a new site kit.
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
                    </section>

                    <section className="fedlify-site-panel">
                      <div className="fedlify-site-panel-head">
                        <strong>2. Install and start the runner</strong>
                        <Button size="small" icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(runnerCommand)}>Copy commands</Button>
                      </div>
                      <Typography.Text>
                        Give this page, the site kit file and its passphrase to the person who looks after the site&apos;s computer (your IT team). If that is you, follow the checklist and the commands below.
                      </Typography.Text>
                      <ol className="fedlify-site-steps">
                        <li>Check the computer and install Docker with the <a href="/get-ready" target="_blank" rel="noreferrer">Get ready page</a>.</li>
                        <li>Unlock the site kit with its passphrase.</li>
                        <li>Start the runner with the site access code. The page then shows the runner as Connected.</li>
                      </ol>
                      <Collapse
                        ghost
                        items={[
                          {
                            key: "it",
                            label: "Commands for IT staff",
                            children: (
                              <>
                                <Typography.Text type="secondary">
                                  Unlocking needs age or Docker. On Windows the runner runs inside WSL 2. If the access code is no longer on this page, reset it under Having problems.
                                </Typography.Text>
                                <pre className="fedlify-command-panel" style={{ overflowX: "auto", maxWidth: "100%" }}>{runnerCommand}</pre>
                              </>
                            )
                          }
                        ]}
                      />
                    </section>

                    <section className="fedlify-site-panel">
                      <div className="fedlify-site-panel-head">
                        <strong>3. Update the code version when needed</strong>
                        <Tag color={runtime.imageFix.length > 0 ? "orange" : runtime.imageState === "CURRENT" ? "green" : undefined}>
                          {IMAGE_STATE_LABEL[runtime.imageState] ?? "Not reported"}
                        </Tag>
                      </div>
                      {runtime.imageFix.length > 0 ? (
                        <ol className="fedlify-site-steps">{runtime.imageFix.map((step) => <li key={step}>{step}</li>)}</ol>
                      ) : (
                        <Typography.Text type="secondary">Nothing to do right now. If the study team publishes a new code version, the steps to update will appear here.</Typography.Text>
                      )}
                      {live?.version ? (
                        <>
                          <Typography.Text>This site runs pipeline version {live.version}.</Typography.Text>
                          {bundleSource && can.downloadPipelineBundle ? (
                            <Details
                              title="Pipeline files"
                              items={[{ label: "Download", value: <Button size="small" icon={<CloudDownloadOutlined />} onClick={bundleSource}>Download pipeline files</Button> }]}
                            />
                          ) : null}
                        </>
                      ) : null}
                    </section>

                    <section className="fedlify-site-panel">
                      <div className="fedlify-site-panel-head"><strong>Connection</strong></div>
                      <Facts
                        items={[
                          [TERMS.studyServer, live?.hostname ? "Running" : "Not published yet"],
                          [TERMS.pipelineVersion, live?.version ?? "Nothing published"],
                          ["Runner's last report", runtime.lastHeartbeatLabel]
                        ]}
                      />
                      <Details
                        items={[
                          ...(live?.hostname ? [{ label: "Study server address", value: <code>{live.hostname}:443</code>, copyText: live.hostname }] : []),
                          { label: TERMS.siteId, value: <code>{runtime.clientName}</code>, copyText: runtime.clientName },
                          ...(live?.gitCommit ? [{ label: "Code reference", value: <code>{live.gitCommit}</code>, copyText: live.gitCommit }] : [])
                        ]}
                      />
                    </section>
                    {inlineManifest ? <pre className="fedlify-detail-json">{JSON.stringify(inlineManifest, null, 2)}</pre> : null}

                    {can.downloadJoinKit || can.rotateSiteToken ? (
                      <Collapse
                        className="fedlify-site-problems"
                        ghost
                        items={[
                          {
                            key: "problems",
                            label: "Having problems?",
                            children: (
                              <Space direction="vertical" size={14} style={{ width: "100%" }}>
                                {can.downloadJoinKit ? (
                                  <div className="fedlify-site-problem">
                                    <strong>Replace site kit</strong>
                                    <Typography.Text type="secondary">
                                      Makes a brand new site kit with a new passphrase. The current site kit and site access code stop working, so the computer must be set up again with the new one.
                                    </Typography.Text>
                                    <Popconfirm
                                      title="Replace the site kit?"
                                      description="The current site kit and access code will stop working."
                                      okText="Replace site kit"
                                      okButtonProps={{ danger: true }}
                                      onConfirm={() => askPassword({ mode: "create" })}
                                    >
                                      <Button danger loading={submitting}>Replace site kit</Button>
                                    </Popconfirm>
                                  </div>
                                ) : null}
                                {can.rotateSiteToken ? (
                                  <div className="fedlify-site-problem">
                                    <strong>Reset site access code</strong>
                                    <Typography.Text type="secondary">
                                      Gives you a new site access code. The old code stops working, so a runner started with it must be restarted with the new code.
                                    </Typography.Text>
                                    <Popconfirm
                                      title="Reset the site access code?"
                                      description="The old access code will stop working."
                                      okText="Reset access code"
                                      okButtonProps={{ danger: true }}
                                      onConfirm={() => void rotateToken()}
                                    >
                                      <Button danger loading={submitting}>Reset site access code</Button>
                                    </Popconfirm>
                                  </div>
                                ) : null}
                              </Space>
                            )
                          }
                        ]}
                      />
                    ) : null}
                  </div>
                )
              },
              {
                key: "data",
                label: "Your data",
                children: (
                  <div className="fedlify-tab-panel">
                    <Typography.Paragraph type="secondary">
                      The assistant uses this to write code that fits this site&apos;s data. Describe the data in general terms only; never enter patient-level details.
                    </Typography.Paragraph>
                    <section className="fedlify-site-panel">
                      <div className="fedlify-site-panel-head"><strong>Data files found on this computer</strong></div>
                      <Typography.Text>
                        {runtime.evidence.dataFiles === null
                          ? "Not reported yet. Once the runner is connected, the number of data files it finds appears here."
                          : runtime.evidence.dataFiles === 0
                            ? "The runner found no data files. Put the site's CSV file in the site kit's data folder."
                            : `${runtime.evidence.dataFiles} data file${runtime.evidence.dataFiles === 1 ? "" : "s"} found (${runtime.lastHeartbeatLabel.toLowerCase()}).`}
                      </Typography.Text>
                    </section>
                    <div className="fedlify-inline-create-card">
                      <Form
                        key={site.dataProfile?.id ?? "data-profile"}
                        layout="vertical"
                        className="fedlify-inline-create-form"
                        disabled={!can.manageProfile}
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
                            { dataProfile: { ...values, modality: normalizeMultiSelectValue(values.modality) } },
                            "Your data description was saved."
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
                          {can.manageProfile ? (
                            <Button type="primary" htmlType="submit" className="fedlify-dark-action" loading={submitting}>
                              Save
                            </Button>
                          ) : permissionsLoading ? null : (
                            <Typography.Text type="secondary">Only the site contact can change this. Ask your study team.</Typography.Text>
                          )}
                        </Space>
                      </Form>
                    </div>
                  </div>
                )
              },
              {
                key: "signoff",
                label: "Sign-off",
                children: (
                  <div className="fedlify-tab-panel">
                    <section className="fedlify-site-panel">
                      <div className="fedlify-site-panel-head"><strong>{TERMS.siteChecks} (automatic)</strong><Typography.Text type="secondary">Reported by the runner on this site&apos;s computer ({runtime.lastHeartbeatLabel.toLowerCase()})</Typography.Text></div>
                      <Facts
                        items={[
                          [TERMS.runner, text(runtime.evidence.runner, "Not reported")],
                          ["Study software", studySoftwareLabel(runtime.evidence.container, runtime.evidence.health)],
                          ["Restarts", text(runtime.evidence.restarts, "Not reported")],
                          ["Data files found", text(runtime.evidence.dataFiles, "Not reported")],
                          ["Disk free", runtime.evidence.diskFreeGb === null ? "Not reported" : `${runtime.evidence.diskFreeGb} GB`],
                          ["GPUs", text(runtime.evidence.gpus, "Not reported")],
                          [TERMS.codeVersion, IMAGE_STATE_LABEL[runtime.imageState] ?? "Not reported"]
                        ]}
                      />
                      <Details items={[{ label: "Study software (raw report)", value: <code>{`${text(runtime.evidence.container, "Not reported")}${runtime.evidence.health ? `, ${runtime.evidence.health}` : ""}`}</code> }, { label: "Reported code version ID", value: <code>{shortImage(runtime.evidence.reportedImage)}</code>, copyText: runtime.evidence.reportedImage ?? undefined }]} />
                    </section>
                    <div className="fedlify-site-panel-head"><strong>{TERMS.siteSignOff} (human)</strong><Typography.Text type="secondary">Confirmed by a person responsible for this site</Typography.Text></div>
                    <Typography.Paragraph type="secondary">
                      By confirming, you say the required software is installed and that your hospital&apos;s own rules allow this study to run on this site&apos;s data.
                      {latestReadiness ? ` Last confirmed ${formatDate(latestReadiness.createdAt)}${latestReadiness.policyAcceptedAt ? `; rules accepted ${formatDate(latestReadiness.policyAcceptedAt)}` : ""}.` : ""}
                    </Typography.Paragraph>
                    <div className="fedlify-inline-create-card">
                      <Form
                        key={latestReadiness?.id ?? "readiness"}
                        layout="vertical"
                        className="fedlify-inline-create-form"
                        disabled={!can.updateReadiness && !can.acceptSitePolicy}
                        initialValues={{
                          dependenciesVerified: latestReadiness?.dependenciesVerified ?? false,
                          policyAccepted: latestReadiness?.policyAccepted ?? false,
                          notes: latestReadiness?.notes
                        }}
                        onFinish={async (values) => {
                          // One button does everything this person is allowed to do. Connectivity is checked live when a run
                          // starts, so the sign-off is only what staff confirm here.
                          if (can.acceptSitePolicy && values.policyAccepted && !latestReadiness?.policyAccepted) {
                            const accepted = await post(`/api/v1/sites/${siteId}/policy-acceptance`, {}, "Local policy accepted.");
                            if (!accepted) return;
                          }
                          if (can.updateReadiness && can.manageProfile) {
                            await patch(`/api/v1/sites/${siteId}/governance`, { readiness: values }, "Site sign-off saved.");
                          }
                        }}
                      >
                        <div className="fedlify-readiness-checks">
                          <Form.Item name="dependenciesVerified" valuePropName="checked">
                            <Checkbox disabled={!can.updateReadiness}>Required software is installed and working</Checkbox>
                          </Form.Item>
                          <Form.Item name="policyAccepted" valuePropName="checked">
                            <Checkbox disabled={!can.acceptSitePolicy}>The data-use rules of this hospital allow this study to run on this site&apos;s data</Checkbox>
                          </Form.Item>
                        </div>
                        <Form.Item name="notes" label="Notes">
                          <Input.TextArea rows={3} disabled={!can.updateReadiness} />
                        </Form.Item>
                        <Space className="fedlify-form-actions" wrap>
                          {(can.updateReadiness && can.manageProfile) || can.acceptSitePolicy ? (
                            <Button type="primary" htmlType="submit" icon={<CheckCircleOutlined />} className="fedlify-dark-action" loading={submitting}>
                              Confirm sign-off
                            </Button>
                          ) : permissionsLoading ? null : (
                            <Typography.Text type="secondary">You cannot give the sign-off for this site. Ask your study team.</Typography.Text>
                          )}
                        </Space>
                      </Form>
                    </div>
                  </div>
                )
              },
              {
                key: "people",
                label: "People",
                children: (
                  <div className="fedlify-tab-panel">
                    <section className="fedlify-site-panel">
                      <div className="fedlify-site-panel-head">
                        <strong>People at this site</strong>
                        {studyCan.manageSites ? (
                          <Button size="small" type="primary" icon={<UserAddOutlined />} onClick={() => setInviteOpen(true)}>
                            Invite site contact
                          </Button>
                        ) : null}
                      </div>
                      {people.length === 0 ? (
                        <Typography.Text type="secondary">No one has been added to this site yet.</Typography.Text>
                      ) : (
                        <ul className="fedlify-site-people">
                          {people.map((person) => {
                            const isSelf = Boolean(ownEmail) && person.email.toLowerCase() === ownEmail;
                            return (
                              <li key={person.userId}>
                                <span>
                                  <strong>{person.name}</strong>
                                  {person.email && person.email !== person.name ? <Typography.Text type="secondary"> · {person.email}</Typography.Text> : null}
                                  <Tag style={{ marginLeft: 8 }}>{isSiteContact(person.roles as SiteRole[]) ? "Site contact" : person.roles.map((role) => roleLabel(role)).join(", ")}</Tag>
                                </span>
                                {can.assignMembers && !isSelf ? (
                                  <Popconfirm
                                    title={`Remove ${person.name}?`}
                                    description={`${people.length <= 1 ? "This is the last person on the site, so nobody will be left to install the runner or give the sign-off. " : ""}They will no longer be able to open this site. A site kit and access code they already have still work: reset the site access code (Get site kit tab, Having problems) to stop them.`}
                                    okText="Remove"
                                    okButtonProps={{ danger: true }}
                                    onConfirm={() => void removePerson(person.userId, person.name)}
                                  >
                                    <Button size="small" danger type="text">Remove</Button>
                                  </Popconfirm>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      {(dashboard.pendingInvitations ?? []).length > 0 ? (
                        <ul className="fedlify-site-people">
                          {(dashboard.pendingInvitations ?? []).map((invitation) => (
                            <li key={invitation.id}>
                              <span>
                                <MailOutlined /> {text(invitation.email)}
                                <Tag style={{ marginLeft: 8 }}>Invited, not accepted yet</Tag>
                                <Typography.Text type="secondary">expires {formatDate(invitation.expiresAt)}</Typography.Text>
                              </span>
                              {studyCan.manageSites ? (
                                <Popconfirm
                                  title="Cancel this invitation?"
                                  description="The link in the email will stop working. You can send a new invitation afterwards."
                                  okText="Cancel invitation"
                                  okButtonProps={{ danger: true }}
                                  onConfirm={() => void revokeInvitation(String(invitation.id))}
                                >
                                  <Button size="small" danger type="text">Cancel invitation</Button>
                                </Popconfirm>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </section>
                  </div>
                )
              },
              {
                key: "activity",
                label: "Activity",
                children: (
                  <div className="fedlify-tab-panel">
                    {dashboard.auditEvents.length === 0 ? (
                      <EmptyState icon={<SafetyCertificateOutlined />} title="No site activity yet" description="Actions taken for this site will be recorded here." />
                    ) : (
                      <section className="fedlify-site-panel">
                        <div className="fedlify-site-panel-head"><strong>Recent activity</strong></div>
                        <ul className="fedlify-site-people">
                          {dashboard.auditEvents.slice(0, 8).map((event) => (
                            <li key={event.id}>
                              <span>
                                <strong>{actorName(event.actorUserId)}</strong> {auditActionLabel(event.action).toLowerCase()}
                              </span>
                              <Typography.Text type="secondary">{formatDate(event.createdAt)}</Typography.Text>
                            </li>
                          ))}
                        </ul>
                      </section>
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
