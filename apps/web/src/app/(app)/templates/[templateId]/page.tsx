"use client";

import {
  CheckCircleOutlined,
  CodeOutlined,
  PlayCircleOutlined,
  RobotOutlined
} from "@ant-design/icons";
import { Alert, Button, Form, Input, Space, Steps, Tabs, Typography, message } from "antd";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppPage, AppPageHeader, SectionHeader } from "@/components/AppPage";
import { CodeReviewPanel } from "@/components/CodeReviewPanel";
import { CardGrid, EntityCard } from "@/components/DataCards";
import { FieldGrid, FieldRow, TimelineList } from "@/components/EntityDetail";
import { FormError } from "@/components/FormFeedback";
import { CardGridSkeleton, EmptyState, InlineLoadError } from "@/components/LoadStates";
import { StatusTag } from "@/components/StatusTag";


type EntityRecord = Record<string, any>;

function text(value: unknown, fallback = "Not set") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function formatDate(value: unknown) {
  return typeof value === "string" && value ? new Date(value).toLocaleDateString() : "Not recorded";
}

function shortCommit(value: unknown) {
  return typeof value === "string" && value ? value.slice(0, 12) : "Not set";
}

export default function TemplateDetailPage() {
  const router = useRouter();
  const params = useParams<{ templateId: string }>();
  const searchParams = useSearchParams();
  const templateId = params.templateId;

  // studyId is passed from the study pipeline page so we can offer fork-to-study
  const studyId = searchParams.get("studyId") ?? undefined;
  const initialTab = searchParams.get("tab") ?? "overview";

  const [template, setTemplate] = useState<EntityRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [changeFormOpen, setChangeFormOpen] = useState(false);
  const [changeFormError, setChangeFormError] = useState<string | null>(null);
  const [submittingChange, setSubmittingChange] = useState(false);
  const [forking, setForking] = useState(false);
  const [activeTab, setActiveTab] = useState(initialTab);
  const [sourceRef, setSourceRef] = useState("current");
  const [proposalForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/v1/pipeline-templates/${templateId}`, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "Template could not be loaded.");
      const t = body.template as EntityRecord;
      setTemplate(t);
      // If the current approved version is a legacy seed but there are proposals,
      // auto-switch sourceRef to the latest open/merged proposal so Code tab shows real code.
      const approvedCommit = String(t?.currentApprovedVersion?.gitCommit ?? "");
      const proposals: EntityRecord[] = t?.templateProposals ?? [];
      const latestProposal = proposals.find((p) => p.status === "OPEN" || p.status === "MERGED") ?? proposals[0];
      if (approvedCommit.startsWith("legacy-seed-") && latestProposal?.id) {
        setSourceRef((prev) => prev === "current" ? `proposal:${String(latestProposal.id)}` : prev);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Template could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [templateId]);

  useEffect(() => { void load(); }, [load]);

  const isLegacySeed = !template?.giteaRepoUrl && String(template?.currentApprovedVersion?.gitCommit ?? "").startsWith("legacy-seed-");
  const hasGiteaRepo = Boolean(template?.giteaRepoUrl);
  const isApproved = template?.currentApprovedVersion?.approvalStatus === "APPROVED";

  // Can fork: must be approved, non-legacy, and a studyId must be available
  const canFork = hasGiteaRepo && isApproved && Boolean(studyId);

  // Fork this template into the study's Gitea workspace, then open the pipeline agent
  async function forkToStudy() {
    if (!studyId || !template) return;
    setForking(true);
    try {
      const response = await fetch(`/api/v1/studies/${studyId}/templates/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateId: template.id })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "Could not fork template to study.");

      // Fork succeeded — open the pipeline agent in "adjust" mode with the new study template
      const forkedTemplateId = body.template?.id;
      message.success("Template forked to your study workspace. Opening code editor…");
      if (forkedTemplateId) {
        router.push(`/studies/${studyId}/pipeline-agent?mode=adjust&templateId=${forkedTemplateId}`);
      } else {
        router.push(`/studies/${studyId}?section=pipeline`);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Could not fork template.");
    } finally {
      setForking(false);
    }
  }

  async function createChangeProposal(values: EntityRecord) {
    if (!template) return;
    setSubmittingChange(true);
    setChangeFormError(null);
    try {
      // Auto-include all intake fields from the template spec — the user only provides the prompt
      const spec = (template.spec ?? {}) as EntityRecord;
      const runtimeDefaults = (spec.runtimeDefaults ?? {}) as EntityRecord;
      const autoIntakeAnswers = {
        purpose: spec.purpose ?? "training",
        clinicalUseCase: spec.clinicalUseCase ?? "Disease progression prediction",
        dataModalities: Array.isArray(spec.dataModalities) ? spec.dataModalities : ["Tabular / structured data"],
        siteLocalInputs: spec.siteLocalInputs ?? "Site-local tabular data stored at each hospital.",
        syntheticFixtures: spec.syntheticFixtures ?? "Use synthetic numpy arrays for smoke tests only.",
        nvflareWorkflow: spec.workflow ?? spec.nvflareWorkflow ?? "scatter_and_gather",
        minClients: runtimeDefaults.minClients ?? 1,
        numRounds: runtimeDefaults.numRounds ?? 1,
        aggregation: runtimeDefaults.aggregation ?? spec.aggregation ?? "weighted FedAvg",
        privacyConstraints: spec.privacyConstraints ?? "Raw clinical data remains site-local. No patient-level files in Git.",
        dependencyPolicy: spec.dependencyPolicy ?? "Use standard NVFLARE and lightweight Python dependencies only.",
        artifactOutputs: spec.artifactOutputs ?? "server.npy, metrics summary, logs, manifest",
        reviewExpectations: spec.reviewExpectations ?? "README, manifest, NVFLARE job shape, syntax checks, and no raw-data paths must pass."
      };

      const response = await fetch("/api/v1/pipeline-templates/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "CHANGE_TEMPLATE",
          templateId: template.id,
          sourceRef,
          name: template.name,
          description: template.description,
          prompt: values.prompt,
          intakeAnswers: autoIntakeAnswers
        })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "Change proposal was not created.");
      message.success("Draft PR created.");
      setChangeFormOpen(false);
      setActiveTab("drafts");
      await load();
    } catch (error) {
      setChangeFormError(error instanceof Error ? error.message : "Change proposal was not created.");
    } finally {
      setSubmittingChange(false);
    }
  }

  async function approveProposal(proposalId: string) {
    setApprovingId(proposalId);
    try {
      const response = await fetch(`/api/v1/template-proposals/${proposalId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "Proposal was not approved.");
      message.success("Template version published.");
      setSourceRef("current");
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Proposal was not approved.");
    } finally {
      setApprovingId(null);
    }
  }

  if (loading && !template) return <AppPage><CardGridSkeleton count={4} /></AppPage>;
  if (loadError && !template) return <AppPage><InlineLoadError message={loadError} onRetry={() => void load()} /></AppPage>;
  if (!template) return <AppPage><EmptyState icon={<CodeOutlined />} title="Template not found" description="Return to the catalog and select an available template." /></AppPage>;

  const backLabel = studyId ? "Back to study pipeline" : "Template catalog";
  const backPath = studyId ? `/studies/${studyId}?section=pipeline&tab=templates` : "/templates";

  return (
    <AppPage>
      <AppPageHeader
        title={text(template.name)}
        subtitle={text(template.description, "Reusable Fedlify NVFLARE template")}
        onBack={() => router.push(backPath)}
        backLabel={backLabel}
        badges={<StatusTag value={template.status ?? "DRAFT"} />}
        actions={
          <Space wrap>
            {/* Primary action: use this template in the current study */}
            {studyId ? (
              <Button
                type="primary"
                className="fedlify-dark-action"
                icon={<PlayCircleOutlined />}
                loading={forking}
                disabled={!canFork}
                title={!canFork ? (isLegacySeed ? "This template has no editable source yet — initialize it first" : "Template must be approved before forking") : undefined}
                onClick={() => void forkToStudy()}
              >
                Use in my study
              </Button>
            ) : null}

            {/* Edit with AI — only available in study context */}
            {hasGiteaRepo && studyId ? (
              <Button
                icon={<RobotOutlined />}
                onClick={() => router.push(`/studies/${studyId}/pipeline-agent?mode=from-template&templateId=${template.id}`)}
              >
                Edit with AI
              </Button>
            ) : null}

            {/* Gitea is backend infrastructure — not exposed to researchers */}

            {/* Legacy seed: initialize */}
            {isLegacySeed ? (
              <Button icon={<CodeOutlined />} onClick={() => { setChangeFormOpen(true); setActiveTab("drafts"); }}>
                Initialize source code
              </Button>
            ) : null}
          </Space>
        }
      />

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: "overview",
            label: "Overview",
            children: (
              <div className="fedlify-section-stack">
                {/* How to use guide — only when coming from a study */}
                {studyId ? (
                  <div className="fedlify-template-use-guide">
                    <Typography.Text strong style={{ display: "block", marginBottom: 12 }}>
                      How to use this template in your study
                    </Typography.Text>
                    <Steps
                      size="small"
                      direction="horizontal"
                      items={[
                        {
                          title: "Fork to your study",
                          description: "Creates a private Gitea branch in your study workspace",
                          status: "process",
                          icon: <PlayCircleOutlined />
                        },
                        {
                          title: "Edit the code",
                          description: isLegacySeed ? "Initialize source first" : "Edit in Gitea or with AI assistance",
                          status: canFork ? "wait" : "error",
                          icon: <CodeOutlined />
                        },
                        {
                          title: "Approve for deployment",
                          description: "Reviewer marks the commit as approved",
                          status: "wait",
                          icon: <CheckCircleOutlined />
                        }
                      ]}
                    />
                    {isLegacySeed ? (
                      <Alert
                        type="warning"
                        showIcon
                        style={{ marginTop: 12 }}
                        message="No editable source code yet"
                        description={
                          <>
                            This template was seeded without a Gitea repository. Click{" "}
                            <Typography.Text strong>Initialize source code</Typography.Text> to generate the NVFlare code and create a draft PR, then it can be forked into your study.
                          </>
                        }
                      />
                    ) : (
                      <div style={{ marginTop: 16 }}>
                        <Button
                          type="primary"
                          className="fedlify-dark-action"
                          icon={<PlayCircleOutlined />}
                          loading={forking}
                          onClick={() => void forkToStudy()}
                        >
                          Fork to my study & open editor
                        </Button>
                        <Typography.Text type="secondary" style={{ marginLeft: 10, fontSize: 12 }}>
                          Creates a branch in your study's Gitea workspace and opens the AI-assisted code editor.
                        </Typography.Text>
                      </div>
                    )}
                  </div>
                ) : null}

                <FieldGrid>
                  <FieldRow label="Template key" value={text(template.templateKey)} />
                  <FieldRow label="Framework" value={text(template.framework)} />
                  <FieldRow label="Approved version" value={text(template.currentApprovedVersion?.version)} />
                  <FieldRow label="Approved commit" value={shortCommit(template.currentApprovedVersion?.gitCommit)} />
                  <FieldRow label="Default branch" value={text(template.giteaDefaultBranch)} />
                </FieldGrid>

                {/* Template spec fields */}
                {template.spec ? (
                  <>
                    <SectionHeader title="Template specification" />
                    <FieldGrid>
                      {(template.spec as EntityRecord).clinicalUseCase ? (
                        <FieldRow label="Clinical use case" value={text((template.spec as EntityRecord).clinicalUseCase)} />
                      ) : null}
                      {(template.spec as EntityRecord).purpose ? (
                        <FieldRow label="Purpose" value={text((template.spec as EntityRecord).purpose)} />
                      ) : null}
                      {Array.isArray((template.spec as EntityRecord).dataModalities) ? (
                        <FieldRow label="Data modalities" value={((template.spec as EntityRecord).dataModalities as string[]).join(", ")} />
                      ) : null}
                      {(template.spec as EntityRecord).privacyConstraints ? (
                        <FieldRow label="Privacy constraints" value={text((template.spec as EntityRecord).privacyConstraints)} />
                      ) : null}
                    </FieldGrid>
                  </>
                ) : null}

                {/* Published versions — collapsible */}
                {(template.templateVersions ?? []).length > 0 ? (
                  <details className="fedlify-form-advanced">
                    <summary>Published versions ({(template.templateVersions as EntityRecord[]).length})</summary>
                    <div className="fedlify-template-versions-list">
                      {(template.templateVersions as EntityRecord[]).map((version) => (
                        <div key={String(version.id)} className="fedlify-template-version-row">
                          <StatusTag value={version.approvalStatus} />
                          <span><strong>{text(version.version)}</strong> · Commit: <code>{shortCommit(version.gitCommit)}</code></span>
                          <span className="fedlify-template-version-date">Approved {formatDate(version.approvedAt)}</span>
                          {!String(version.gitCommit ?? "").startsWith("legacy-seed-") ? (
                            <Button size="small" icon={<CodeOutlined />} onClick={() => { setSourceRef(`version:${String(version.id)}`); setActiveTab("code"); }}>
                              View code
                            </Button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            )
          },
          {
            key: "code",
            label: "Code",
            children: isLegacySeed ? (
              <Alert
                type="info"
                showIcon
                message="No source code yet"
                description="Initialize a draft PR with AI to generate the NVFlare code for this template."
                action={
                  <Button icon={<CodeOutlined />} onClick={() => { setChangeFormOpen(true); setActiveTab("drafts"); }}>
                    Initialize source code
                  </Button>
                }
              />
            ) : (
              <CodeReviewPanel
                sourceUrl={`/api/v1/pipeline-templates/${templateId}/source?ref=${encodeURIComponent(sourceRef)}`}
                reviewTemplateId={templateId}
                sourceRef={sourceRef}
                reloadKey={sourceRef}
                hideHeader={true}
                onReviewApplied={(proposalId) => {
                  setSourceRef(`proposal:${proposalId}`);
                  setActiveTab("code");
                  void load();
                }}
              />
            )
          },
          {
            key: "drafts",
            label: "Changes",
            children: (
              <>
                {changeFormOpen ? (
                  <div className="fedlify-inline-create-card">
                    <SectionHeader
                      title={isLegacySeed ? "Initialize source code" : "Propose a change"}
                      description={
                        isLegacySeed
                          ? "Describe what the AI should generate. Template settings are taken from the existing template spec automatically."
                          : "Describe what to change. The AI will generate a draft Gitea PR — human approval is required to publish."
                      }
                      actions={<Button onClick={() => setChangeFormOpen(false)}>Cancel</Button>}
                    />
                    <Form
                      form={proposalForm}
                      layout="vertical"
                      className="fedlify-inline-create-form"
                      initialValues={{ prompt: "" }}
                      onFinish={(values) => void createChangeProposal(values)}
                    >
                      <FormError title="Draft PR was not created" message={changeFormError} />
                      <Form.Item
                        name="prompt"
                        label={isLegacySeed ? "What should the AI generate?" : "What should the AI change?"}
                        rules={[{ required: true, min: 20, message: "Please describe what to generate or change (min 20 characters)." }]}
                      >
                        <Input.TextArea
                          rows={5}
                          placeholder={
                            isLegacySeed
                              ? "e.g. Generate a complete NVFlare FedAvg executor for cross-silo tabular data classification. Include a local training loop, model weight sharing, and a synthetic numpy fixture for smoke testing."
                              : "e.g. Add differential privacy noise to the weight updates before returning them to the aggregator."
                          }
                          autoFocus
                        />
                      </Form.Item>
                      <Space className="fedlify-form-actions">
                        <Button onClick={() => setChangeFormOpen(false)}>Cancel</Button>
                        <Button type="primary" htmlType="submit" className="fedlify-dark-action" loading={submittingChange} icon={<RobotOutlined />}>
                          {isLegacySeed ? "Generate source PR" : "Create draft PR"}
                        </Button>
                      </Space>
                    </Form>
                  </div>
                ) : (
                  <div style={{ marginBottom: 16 }}>
                    <Button icon={<CodeOutlined />} onClick={() => setChangeFormOpen(true)}>
                      {isLegacySeed ? "Initialize source code" : "Propose a change"}
                    </Button>
                  </div>
                )}

                <CardGrid>
                  {(template.templateProposals ?? []).length === 0 && !changeFormOpen ? (
                    <EmptyState compact icon={<CodeOutlined />} title="No draft PRs" description="Draft pull requests appear here after AI-assisted or manual changes." />
                  ) : (
                    (template.templateProposals ?? []).map((proposal: EntityRecord) => (
                      <EntityCard
                        key={proposal.id}
                        title={text(proposal.prompt, "Draft change")}
                        subtitle={`Branch: ${text(proposal.branchName)}`}
                        status={<StatusTag value={proposal.status} />}
                        meta={[
                          `Validation: ${text(proposal.validationStatus)}`,
                          `Commit: ${shortCommit(proposal.giteaHeadCommit)}`,
                          `Created: ${formatDate(proposal.createdAt)}`
                        ]}
                        actions={
                          <Space wrap>
                            <Button
                              size="small"
                              icon={<CodeOutlined />}
                              disabled={!proposal.giteaHeadCommit && !proposal.branchName}
                              onClick={() => { setSourceRef(`proposal:${proposal.id}`); setActiveTab("code"); }}
                            >
                              Review code
                            </Button>
                            {/* Gitea PR link not exposed to researchers — code review is in-app via Code tab */}
                            <Button
                              size="small"
                              type="primary"
                              className="fedlify-dark-action"
                              icon={<CheckCircleOutlined />}
                              loading={approvingId === proposal.id}
                              disabled={proposal.validationStatus !== "PASSED" || proposal.status === "MERGED"}
                              onClick={() => void approveProposal(proposal.id)}
                            >
                              Publish version
                            </Button>
                          </Space>
                        }
                      />
                    ))
                  )}
                </CardGrid>
              </>
            )
          },
        ]}
      />
    </AppPage>
  );
}
