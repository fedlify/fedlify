"use client";

import { CodeOutlined, GithubOutlined, PlusOutlined, RobotOutlined } from "@ant-design/icons";
import { Alert, Button, Form, Input, InputNumber, Select, Space, Tabs, Typography, message } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppPage, AppPageHeader, SectionHeader } from "@/components/AppPage";
import { CardGrid, EntityCard } from "@/components/DataCards";
import { FormError } from "@/components/FormFeedback";
import { CardGridSkeleton, EmptyState, InlineLoadError } from "@/components/LoadStates";
import { StatusTag } from "@/components/StatusTag";
import { CLINICAL_USE_CASE_OPTIONS, DATA_MODALITY_OPTIONS } from "@/lib/governance-options";
import { WORKFLOW_TERMS, templateCatalogEmptyCopy } from "@/lib/workflow-copy";

type EntityRecord = Record<string, any>;

function text(value: unknown, fallback = "Not set") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function shortCommit(value: unknown) {
  return typeof value === "string" && value ? value.slice(0, 12) : "Not set";
}

export default function TemplateCatalogPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<EntityRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/v1/pipeline-templates", { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "Template sources could not be loaded.");
      setTemplates(body?.templates ?? []);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Template sources could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createProposal(values: EntityRecord) {
    setCreating(true);
    setFormError(null);
    try {
      const response = await fetch("/api/v1/pipeline-templates/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...values, kind: "NEW_TEMPLATE" })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "Template proposal was not created.");
      message.success("Template proposal created.");
      setFormOpen(false);
      await load();
      router.push(`/templates/${body.template.id}`);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Template proposal was not created.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <AppPage>
      <AppPageHeader
        title="Template sources"
        subtitle="Review reusable NVFLARE template source, propose updates, and publish approved commits that studies can select."
        actions={
          <Space wrap>
            <Button icon={<RobotOutlined />} onClick={() => router.push("/template-agent?mode=FROM_SCRATCH")}>
              Template Agent
            </Button>
            <Button type="primary" className="fedlify-dark-action" icon={<PlusOutlined />} onClick={() => setFormOpen((current) => !current)}>
              New reusable template proposal
            </Button>
          </Space>
        }
      />

      {formOpen ? (
        <div className="fedlify-inline-create-card">
          <Form
            layout="vertical"
            className="fedlify-inline-create-form"
            initialValues={{
              intakeAnswers: {
                purpose: "training",
                nvflareWorkflow: "scatter_and_gather",
                minClients: 1,
                numRounds: 1,
                aggregation: "weighted FedAvg",
                privacyConstraints: "Keep raw clinical data site-local; use TLS startup kits and no patient-level artifacts.",
                dependencyPolicy: "Use standard NVFLARE and lightweight Python dependencies only.",
                artifactOutputs: "server.npy, metrics summary, logs, manifest",
                reviewExpectations: "README, manifest, NVFLARE job shape, syntax checks, and no raw-data paths must pass."
              }
            }}
            onFinish={(values) => void createProposal(values)}
          >
            <FormError title="Template proposal was not created" message={formError} />
            <div className="fedlify-intake-field-grid">
              <Form.Item name="name" label="Template name" rules={[{ required: true, min: 3 }]}>
                <Input placeholder="Cross-silo risk prediction FedAvg" />
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
              <Form.Item name={["intakeAnswers", "siteLocalInputs"]} label="Expected site-local inputs" rules={[{ required: true }]} className="fedlify-intake-full">
                <Input.TextArea rows={2} placeholder="Local EHR feature table, labels, and site-owned preprocessing config." />
              </Form.Item>
              <Form.Item name={["intakeAnswers", "syntheticFixtures"]} label="Allowed synthetic fixtures" rules={[{ required: true }]} className="fedlify-intake-full">
                <Input.TextArea rows={2} placeholder="Small synthetic numpy arrays for smoke tests only." />
              </Form.Item>
              <Form.Item name={["intakeAnswers", "aggregation"]} label="Aggregation behavior" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name={["intakeAnswers", "nvflareWorkflow"]} label="NVFLARE workflow" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name={["intakeAnswers", "privacyConstraints"]} label="Privacy and security constraints" rules={[{ required: true }]} className="fedlify-intake-full">
                <Input.TextArea rows={2} />
              </Form.Item>
              <Form.Item name={["intakeAnswers", "dependencyPolicy"]} label="Dependency policy" rules={[{ required: true }]} className="fedlify-intake-full">
                <Input.TextArea rows={2} />
              </Form.Item>
              <Form.Item name={["intakeAnswers", "artifactOutputs"]} label="Expected artifacts" rules={[{ required: true }]} className="fedlify-intake-full">
                <Input.TextArea rows={2} />
              </Form.Item>
              <Form.Item name={["intakeAnswers", "reviewExpectations"]} label="Review expectations" rules={[{ required: true }]} className="fedlify-intake-full">
                <Input.TextArea rows={2} />
              </Form.Item>
              <Form.Item name="prompt" label="Codex request" rules={[{ required: true, min: 20 }]} className="fedlify-intake-full">
                <Input.TextArea rows={4} placeholder="Describe what the Codex agent should create or change in the template." />
              </Form.Item>
            </div>
            <Space className="fedlify-form-actions">
              <Button onClick={() => setFormOpen(false)}>Cancel</Button>
              <Button type="primary" htmlType="submit" className="fedlify-dark-action" loading={creating}>
                Create draft PR
              </Button>
            </Space>
          </Form>
        </div>
      ) : null}

      {loading ? (
        <CardGridSkeleton count={6} />
      ) : loadError ? (
        <InlineLoadError message={loadError} onRetry={() => void load()} />
      ) : templates.length === 0 ? (
        <EmptyState icon={<CodeOutlined />} title={templateCatalogEmptyCopy("public").title} description={templateCatalogEmptyCopy("public").description} />
      ) : (
        <Tabs
          items={[
            {
              key: "approved",
              label: "Approved public templates",
              children: (
                <>
                  <SectionHeader
                    title="Approved public template sources"
                    description="These approved commits appear in Study Pipeline as selectable sources for study-specific pipeline versions."
                  />
                  <CardGrid>
                    {templates.map((template) => {
                      const version = template.currentApprovedVersion;
                      return (
                        <EntityCard
                          key={template.id}
                          title={text(template.name)}
                          subtitle={text(template.description, "Reusable Fedlify NVFLARE template")}
                          status={<StatusTag value={template.status ?? "DRAFT"} />}
                          meta={[
                            `Version: ${text(version?.version)}`,
                            `Commit: ${shortCommit(version?.gitCommit)}`,
                            `Repo: ${text(template.giteaRepoUrl, "Not linked")}`
                          ]}
                          onClick={() => router.push(`/templates/${template.id}`)}
                          actions={
                            <Space wrap>
                              {template.giteaRepoUrl ? (
                                <Button icon={<GithubOutlined />} href={template.giteaRepoUrl} target="_blank">
                                  Open Gitea
                                </Button>
                              ) : null}
                              <Button onClick={() => router.push(`/templates/${template.id}`)}>Open</Button>
                            </Space>
                          }
                        />
                      );
                    })}
                  </CardGrid>
                </>
              )
            }
          ]}
        />
      )}
      <Typography.Text className="fedlify-muted">
        AI-assisted template work always lands in draft Gitea pull requests. Fedlify approval publishes immutable template commits.
      </Typography.Text>
    </AppPage>
  );
}
