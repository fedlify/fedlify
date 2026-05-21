"use client";

import { ArrowLeftOutlined, CheckCircleOutlined, CodeOutlined, CopyOutlined, GithubOutlined, RobotOutlined } from "@ant-design/icons";
import { Alert, Button, Form, Input, InputNumber, Select, Space, Tabs, Typography, message } from "antd";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppPage, AppPageHeader, SectionHeader } from "@/components/AppPage";
import { CodeReviewPanel } from "@/components/CodeReviewPanel";
import { CardGrid, EntityCard } from "@/components/DataCards";
import { FieldGrid, FieldRow, TimelineList } from "@/components/EntityDetail";
import { FormError } from "@/components/FormFeedback";
import { CardGridSkeleton, EmptyState, InlineLoadError } from "@/components/LoadStates";
import { StatusTag } from "@/components/StatusTag";
import { CLINICAL_USE_CASE_OPTIONS, DATA_MODALITY_OPTIONS } from "@/lib/governance-options";
import { WORKFLOW_TERMS } from "@/lib/workflow-copy";

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
  const templateId = params.templateId;
  const [template, setTemplate] = useState<EntityRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [changeFormOpen, setChangeFormOpen] = useState(false);
  const [changeFormError, setChangeFormError] = useState<string | null>(null);
  const [submittingChange, setSubmittingChange] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const [sourceRef, setSourceRef] = useState("current");
  const [proposalForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/v1/pipeline-templates/${templateId}`, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "Template detail could not be loaded.");
      setTemplate(body.template);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Template detail could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [templateId]);

  useEffect(() => {
    void load();
  }, [load]);

  const vsCodeCommand = useMemo(() => {
    if (!template?.giteaRepoUrl) return "";
    return [`git clone ${template.giteaRepoUrl}`, `cd ${template.giteaRepo ?? "template-repo"}`, "code ."].join("\n");
  }, [template]);
  const isLegacySeed = !template?.giteaRepoUrl && String(template?.currentApprovedVersion?.gitCommit ?? "").startsWith("legacy-seed-");
  const proposalCtaLabel = isLegacySeed ? "Initialize source repo with AI" : WORKFLOW_TERMS.proposeReusableTemplateUpdate;

  const changeInitialValues = useMemo(() => {
    const spec = (template?.spec ?? {}) as EntityRecord;
    const runtimeDefaults = (spec.runtimeDefaults ?? {}) as EntityRecord;
    return {
      name: template?.name,
      description: template?.description,
      intakeAnswers: {
        purpose: spec.purpose ?? "training",
        clinicalUseCase: spec.clinicalUseCase,
        dataModalities: Array.isArray(spec.dataModalities) ? spec.dataModalities : [],
        siteLocalInputs: spec.siteLocalInputs,
        syntheticFixtures: spec.syntheticFixtures,
        nvflareWorkflow: spec.workflow ?? spec.nvflareWorkflow ?? "scatter_and_gather",
        minClients: runtimeDefaults.minClients ?? 1,
        numRounds: runtimeDefaults.numRounds ?? 1,
        aggregation: runtimeDefaults.aggregation ?? spec.aggregation ?? "weighted FedAvg",
        privacyConstraints:
          spec.privacyConstraints ?? "Keep raw clinical data site-local; use TLS startup kits and no patient-level artifacts.",
        dependencyPolicy: spec.dependencyPolicy ?? "Use standard NVFLARE and lightweight Python dependencies only.",
        artifactOutputs: spec.artifactOutputs ?? "server.npy, metrics summary, logs, manifest",
        reviewExpectations:
          spec.reviewExpectations ?? "README, manifest, NVFLARE job shape, syntax checks, and no raw-data paths must pass."
      },
      prompt: ""
    };
  }, [template]);

  async function createChangeProposal(values: EntityRecord) {
    if (!template) return;
    setSubmittingChange(true);
    setChangeFormError(null);
    try {
      const response = await fetch("/api/v1/pipeline-templates/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...values,
          kind: "CHANGE_TEMPLATE",
          templateId: template.id,
          sourceRef,
          name: values.name ?? template.name
        })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "Template change proposal was not created.");
      message.success("Template change proposal created.");
      setChangeFormOpen(false);
      setActiveTab("proposals");
      await load();
    } catch (error) {
      setChangeFormError(error instanceof Error ? error.message : "Template change proposal was not created.");
    } finally {
      setSubmittingChange(false);
    }
  }

  function openChangeProposalForm() {
    setChangeFormOpen(true);
    setActiveTab("proposals");
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
      if (!response.ok) throw new Error(body?.error?.message ?? "Template proposal was not approved.");
      message.success("Template version published.");
      setSourceRef("current");
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Template proposal was not approved.");
    } finally {
      setApprovingId(null);
    }
  }

  if (loading && !template) {
    return (
      <AppPage>
        <CardGridSkeleton count={4} />
      </AppPage>
    );
  }

  if (loadError && !template) {
    return (
      <AppPage>
        <InlineLoadError message={loadError} onRetry={() => void load()} />
      </AppPage>
    );
  }

  if (!template) {
    return (
      <AppPage>
        <EmptyState icon={<CodeOutlined />} title="Template not found" description="Return to the catalog and select an available template." />
      </AppPage>
    );
  }

  return (
    <AppPage>
      <AppPageHeader
        title={text(template.name)}
        subtitle={text(template.description, "Reusable Fedlify NVFLARE template")}
        onBack={() => router.push("/templates")}
        backLabel="Back to templates"
        badges={<StatusTag value={template.status ?? "DRAFT"} />}
        actions={
          <Space wrap>
            {template.giteaRepoUrl ? (
              <Button icon={<CodeOutlined />} onClick={() => setActiveTab("code")}>
                Review code
              </Button>
            ) : null}
            {template.giteaRepoUrl ? (
              <Button icon={<GithubOutlined />} href={template.giteaRepoUrl} target="_blank">
                Open Gitea
              </Button>
            ) : null}
            <Button icon={<CodeOutlined />} onClick={openChangeProposalForm}>
              {proposalCtaLabel}
            </Button>
            <Button
              icon={<RobotOutlined />}
              onClick={() => router.push(`/template-agent?mode=FROM_PUBLIC_TEMPLATE&templateId=${template.id}`)}
            >
              {WORKFLOW_TERMS.createOrEditWithAi}
            </Button>
            {vsCodeCommand ? (
              <Button icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(vsCodeCommand).then(() => message.success("VS Code command copied."))}>
                Copy VS Code command
              </Button>
            ) : null}
          </Space>
        }
      />

      {loadError ? <Alert type="warning" showIcon message={loadError} /> : null}
      {isLegacySeed ? (
        <Alert
          type="info"
          showIcon
          message="This template is a legacy seed and has no reviewable source repository yet."
          description="Initialize a source repo with AI to create a draft Gitea PR, review the generated NVFLARE template code, and publish a public reusable version."
          action={
            <Button icon={<CodeOutlined />} onClick={openChangeProposalForm}>
              Initialize source repo with AI
            </Button>
          }
        />
      ) : null}

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: "overview",
            label: "Overview",
            children: (
              <>
                <Alert
                  type="info"
                  showIcon
                  message="Published template versions are sources, not runnable study pipelines"
                  description="Templates are reusable source. To run one, open a study, go to Pipeline, and create a pipeline version from the approved template commit. Fedlify copies that commit into the study source workspace and creates a separate pipeline version for approval."
                />
                <FieldGrid>
                  <FieldRow label="Template key" value={text(template.templateKey)} />
                  <FieldRow label="Framework" value={text(template.framework)} />
                  <FieldRow label="Approved version" value={text(template.currentApprovedVersion?.version)} />
                  <FieldRow label="Approved commit" value={shortCommit(template.currentApprovedVersion?.gitCommit)} />
                  <FieldRow label="Gitea repository" value={template.giteaRepoUrl ? <a href={template.giteaRepoUrl} target="_blank" rel="noreferrer">{template.giteaOwner}/{template.giteaRepo}</a> : "Not linked"} />
                  <FieldRow label="Default branch" value={text(template.giteaDefaultBranch)} />
                </FieldGrid>
                {vsCodeCommand ? (
                  <>
                    <SectionHeader title="Open locally" description="This command only clones and opens the template repository; it does not run jobs." />
                    <pre className="fedlify-command-panel">{vsCodeCommand}</pre>
                  </>
                ) : null}
              </>
            )
          },
          {
            key: "code",
            label: "Code",
            children: isLegacySeed ? (
              <Alert
                type="info"
                showIcon
                message="No source repository yet"
                description="This seeded template can be converted into a Gitea-backed reusable template by initializing a draft PR with AI assistance."
                action={
                  <Button icon={<CodeOutlined />} onClick={openChangeProposalForm}>
                    Initialize source repo with AI
                  </Button>
                }
              />
            ) : (
              <CodeReviewPanel
                sourceUrl={`/api/v1/pipeline-templates/${templateId}/source?ref=${encodeURIComponent(sourceRef)}`}
                reviewTemplateId={templateId}
                sourceRef={sourceRef}
                title="Template source review"
                description="Review the reusable NVFLARE template source before publishing or using it in study pipelines."
                reloadKey={sourceRef}
                requestChangeDescription="Codex changes are routed through a draft Gitea pull request. Publishing still requires validation and human approval."
                onReviewApplied={(proposalId) => {
                  setSourceRef(`proposal:${proposalId}`);
                  setActiveTab("code");
                  void load();
                }}
              />
            )
          },
          {
            key: "versions",
            label: "Versions",
            children: (
              <CardGrid>
                {(template.templateVersions ?? []).map((version: EntityRecord) => (
                  <EntityCard
                    key={version.id}
                    title={text(version.version)}
                    subtitle={`Commit ${shortCommit(version.gitCommit)}`}
                    status={<StatusTag value={version.approvalStatus} />}
                    meta={[`Validation: ${text(version.validationStatus)}`, `Approved: ${formatDate(version.approvedAt)}`]}
                    actions={
                      <Button
                        size="small"
                        icon={<CodeOutlined />}
                        disabled={String(version.gitCommit ?? "").startsWith("legacy-seed-")}
                        onClick={() => {
                          setSourceRef(`version:${version.id}`);
                          setActiveTab("code");
                        }}
                      >
                        Review code
                      </Button>
                    }
                  />
                ))}
              </CardGrid>
            )
          },
          {
            key: "proposals",
            label: "Proposals",
            children: (
              <>
                {changeFormOpen ? (
                  <div className="fedlify-inline-create-card">
                    <SectionHeader
                      title={isLegacySeed ? "Initialize source repo with AI" : "Reusable template update"}
                      description="AI assistance creates a draft Gitea PR only. Human approval is required before this becomes a selectable public template version, and the assistant never approves or runs experiments."
                    />
                    <Form
                      form={proposalForm}
                      layout="vertical"
                      className="fedlify-inline-create-form"
                      initialValues={changeInitialValues}
                      onFinish={(values) => void createChangeProposal(values)}
                    >
                      <FormError title="Template change proposal was not created" message={changeFormError} />
                      <div className="fedlify-intake-field-grid">
                        <Form.Item name="name" label="Template name" rules={[{ required: true, min: 3 }]}>
                          <Input />
                        </Form.Item>
                        <Form.Item name={["intakeAnswers", "clinicalUseCase"]} label="Clinical AI use case" rules={[{ required: true }]}>
                          <Select options={CLINICAL_USE_CASE_OPTIONS} placeholder="Select use case" />
                        </Form.Item>
                        <Form.Item name={["intakeAnswers", "dataModalities"]} label="Data modalities" rules={[{ required: true }]}>
                          <Select mode="multiple" options={DATA_MODALITY_OPTIONS} placeholder="Select modalities" />
                        </Form.Item>
                        <Form.Item name={["intakeAnswers", "purpose"]} label="Template purpose" rules={[{ required: true }]}>
                          <Select
                            options={["training", "evaluation", "preprocessing", "metrics", "model export"].map((value) => ({ value, label: value }))}
                          />
                        </Form.Item>
                        <Form.Item name={["intakeAnswers", "minClients"]} label="Default minimum sites" rules={[{ required: true }]}>
                          <InputNumber min={1} precision={0} style={{ width: "100%" }} />
                        </Form.Item>
                        <Form.Item name={["intakeAnswers", "numRounds"]} label="Default rounds" rules={[{ required: true }]}>
                          <InputNumber min={1} precision={0} style={{ width: "100%" }} />
                        </Form.Item>
                        <Form.Item name="description" label="Description" className="fedlify-intake-full">
                          <Input.TextArea rows={2} />
                        </Form.Item>
                        <Form.Item
                          name={["intakeAnswers", "siteLocalInputs"]}
                          label="Expected site-local inputs"
                          rules={[{ required: true }]}
                          className="fedlify-intake-full"
                        >
                          <Input.TextArea rows={2} />
                        </Form.Item>
                        <Form.Item
                          name={["intakeAnswers", "syntheticFixtures"]}
                          label="Allowed synthetic fixtures"
                          rules={[{ required: true }]}
                          className="fedlify-intake-full"
                        >
                          <Input.TextArea rows={2} />
                        </Form.Item>
                        <Form.Item name={["intakeAnswers", "aggregation"]} label="Aggregation behavior" rules={[{ required: true }]}>
                          <Input />
                        </Form.Item>
                        <Form.Item name={["intakeAnswers", "nvflareWorkflow"]} label="NVFLARE workflow" rules={[{ required: true }]}>
                          <Input />
                        </Form.Item>
                        <Form.Item
                          name={["intakeAnswers", "privacyConstraints"]}
                          label="Privacy and security constraints"
                          rules={[{ required: true }]}
                          className="fedlify-intake-full"
                        >
                          <Input.TextArea rows={2} />
                        </Form.Item>
                        <Form.Item
                          name={["intakeAnswers", "dependencyPolicy"]}
                          label="Dependency policy"
                          rules={[{ required: true }]}
                          className="fedlify-intake-full"
                        >
                          <Input.TextArea rows={2} />
                        </Form.Item>
                        <Form.Item name={["intakeAnswers", "artifactOutputs"]} label="Expected artifacts" rules={[{ required: true }]} className="fedlify-intake-full">
                          <Input.TextArea rows={2} />
                        </Form.Item>
                        <Form.Item
                          name={["intakeAnswers", "reviewExpectations"]}
                          label="Review expectations"
                          rules={[{ required: true }]}
                          className="fedlify-intake-full"
                        >
                          <Input.TextArea rows={2} />
                        </Form.Item>
                        <Form.Item name="prompt" label="AI change request" rules={[{ required: true, min: 20 }]} className="fedlify-intake-full">
                          <Input.TextArea rows={4} placeholder="Describe the reusable template source the AI assistant should create or change in the draft PR." />
                        </Form.Item>
                      </div>
                      <Space className="fedlify-form-actions">
                        <Button onClick={() => setChangeFormOpen(false)}>Cancel</Button>
                        <Button type="primary" htmlType="submit" className="fedlify-dark-action" loading={submittingChange}>
                          {isLegacySeed ? "Initialize source PR" : "Create reusable template PR"}
                        </Button>
                      </Space>
                    </Form>
                  </div>
                ) : null}
                <CardGrid>
                  {(template.templateProposals ?? []).length === 0 ? (
                    <EmptyState compact icon={<CodeOutlined />} title="No template proposals" description="Draft PRs appear here after AI-assisted or manual changes are created." />
                  ) : (
                    (template.templateProposals ?? []).map((proposal: EntityRecord) => (
                      <EntityCard
                        key={proposal.id}
                        title={`${text(proposal.kind)} proposal`}
                        subtitle={text(proposal.prompt)}
                        status={<StatusTag value={proposal.status} />}
                        meta={[
                          `Validation: ${text(proposal.validationStatus)}`,
                          `Commit: ${shortCommit(proposal.giteaHeadCommit)}`,
                          `Created: ${formatDate(proposal.createdAt)}`
                        ]}
                        actions={
                          <Space wrap>
                            <Button
                              icon={<CodeOutlined />}
                              disabled={!proposal.giteaHeadCommit && !proposal.branchName}
                              onClick={() => {
                                setSourceRef(`proposal:${proposal.id}`);
                                setActiveTab("code");
                              }}
                            >
                              Review code
                            </Button>
                            {proposal.giteaPullRequestUrl ? (
                              <Button icon={<GithubOutlined />} href={proposal.giteaPullRequestUrl} target="_blank">
                                Open PR
                              </Button>
                            ) : null}
                            <Button
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
          {
            key: "activity",
            label: "Activity",
            children: (
              <TimelineList
                events={(template.templateProposals ?? []).map((proposal: EntityRecord) => ({
                  id: proposal.id,
                  status: proposal.status,
                  message: proposal.resultSummary ?? proposal.prompt,
                  createdAt: proposal.createdAt
                }))}
              />
            )
          }
        ]}
      />
      <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => router.push("/templates")}>
        Back to catalog
      </Button>
    </AppPage>
  );
}
