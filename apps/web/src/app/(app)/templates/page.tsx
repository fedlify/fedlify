"use client";

import { CodeOutlined, GithubOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Form, Input, Modal, Space, Tabs, Typography, message } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppPage, AppPageHeader, SectionHeader } from "@/components/AppPage";
import { CardGrid, EntityCard } from "@/components/DataCards";
import { CardGridSkeleton, EmptyState, InlineLoadError } from "@/components/LoadStates";
import { StatusTag } from "@/components/StatusTag";
import { templateCatalogEmptyCopy } from "@/lib/workflow-copy";

type EntityRecord = Record<string, any>;

function text(value: unknown, fallback = "Not set") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function shortCommit(value: unknown) {
  return typeof value === "string" && value ? value.slice(0, 12) : "Not set";
}

const DEFAULT_INTAKE = {
  purpose: "training",
  nvflareWorkflow: "scatter_and_gather",
  minClients: 1,
  numRounds: 1,
  aggregation: "weighted FedAvg",
  clinicalUseCase: "Disease progression prediction",
  dataModalities: ["Tabular / structured data"],
  siteLocalInputs: "Site-local tabular data stored at each hospital.",
  syntheticFixtures: "Small synthetic numpy arrays for smoke tests only.",
  privacyConstraints: "Keep raw clinical data site-local; use TLS startup kits and no patient-level artifacts.",
  dependencyPolicy: "Use standard NVFLARE and lightweight Python dependencies only.",
  artifactOutputs: "server.npy, metrics summary, logs, manifest",
  reviewExpectations: "README, manifest, NVFLARE job shape, syntax checks, and no raw-data paths must pass."
};

export default function TemplateCatalogPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<EntityRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();

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

  useEffect(() => { void load(); }, [load]);

  async function createTemplate(values: { name: string; prompt: string }) {
    setCreating(true);
    try {
      const response = await fetch("/api/v1/pipeline-templates/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "NEW_TEMPLATE",
          name: values.name,
          prompt: values.prompt,
          intakeAnswers: DEFAULT_INTAKE
        })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "Template could not be created.");
      message.success("Template draft created.");
      setModalOpen(false);
      form.resetFields();
      router.push(`/templates/${body.template.id}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Template could not be created.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <AppPage>
      <AppPageHeader
        title="Template sources"
        subtitle="Browse reusable NVFLARE templates. Approved templates can be used as the starting point for study pipelines."
        actions={
          <Button icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
            Build new template
          </Button>
        }
      />

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
                    description="These approved commits appear in Study Pipeline as selectable starting points for study-specific pipelines."
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

      {/* 2-field "Build new template" modal */}
      <Modal
        title="Build new template"
        open={modalOpen}
        onCancel={() => { setModalOpen(false); form.resetFields(); }}
        footer={null}
        width={520}
      >
        <Typography.Text type="secondary" style={{ display: "block", marginBottom: 16 }}>
          Describe what the template should do. The AI will generate NVFlare code and open a draft Gitea PR for review.
        </Typography.Text>
        <Form form={form} layout="vertical" onFinish={(values) => void createTemplate(values as { name: string; prompt: string })}>
          <Form.Item name="name" label="Template name" rules={[{ required: true, min: 3 }]}>
            <Input placeholder="Cross-silo survival analysis FedAvg" autoFocus />
          </Form.Item>
          <Form.Item name="prompt" label="What should this template do?" rules={[{ required: true, min: 20 }]}>
            <Input.TextArea
              rows={4}
              placeholder="e.g. Generate a cross-silo FedAvg training template for survival analysis on clinical tabular data. Include a local training loop, federated aggregation, and synthetic smoke tests."
            />
          </Form.Item>
          <Space style={{ justifyContent: "flex-end", width: "100%" }}>
            <Button onClick={() => { setModalOpen(false); form.resetFields(); }}>Cancel</Button>
            <Button type="primary" htmlType="submit" className="fedlify-dark-action" loading={creating}>
              Generate draft PR
            </Button>
          </Space>
        </Form>
      </Modal>
    </AppPage>
  );
}
