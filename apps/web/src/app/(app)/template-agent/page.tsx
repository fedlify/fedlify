"use client";

import { CodeOutlined, GithubOutlined, RobotOutlined } from "@ant-design/icons";
import { Bubble, Prompts, Sender, ThoughtChain } from "@ant-design/x";
import { Alert, Button, Form, Input, InputNumber, Select, Space, Typography, message } from "antd";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { AppPage, AppPageHeader, SectionHeader } from "@/components/AppPage";
import { CLINICAL_USE_CASE_OPTIONS, DATA_MODALITY_OPTIONS } from "@/lib/governance-options";

const BubbleList = Bubble.List as any;
const SenderBox = Sender as any;
const PromptList = Prompts as any;
const ThoughtSteps = ThoughtChain as any;

type AgentMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  missing?: string[];
};

type GeneratedFile = {
  path: string;
  content: string;
};

type EntityRecord = Record<string, any>;

function latestAssistantMissing(messages: AgentMessage[]) {
  return [...messages].reverse().find((item) => item.role === "assistant")?.missing ?? [];
}

export default function TemplateAgentPage() {
  const searchParams = useSearchParams();
  const [form] = Form.useForm();
  const [session, setSession] = useState<EntityRecord | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [generatedFiles, setGeneratedFiles] = useState<GeneratedFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mode = Form.useWatch("mode", form);
  const missing = latestAssistantMissing(messages);
  const selectedFile = useMemo(
    () => generatedFiles.find((file) => file.path === selectedPath) ?? generatedFiles[0],
    [generatedFiles, selectedPath]
  );

  const initialValues = useMemo(
    () => ({
      mode: (searchParams.get("mode") as string) || "FROM_SCRATCH",
      studyId: searchParams.get("studyId") ?? undefined,
      templateId: searchParams.get("templateId") ?? undefined,
      intake: {
        purpose: "training",
        nvflareWorkflow: "scatter_and_gather",
        minClients: 1,
        numRounds: 1,
        aggregation: "weighted FedAvg",
        privacyConstraints: "Raw clinical data remains site-local. No patient-level files, identifiers, CSV, or parquet data in Git.",
        dependencyPolicy: "Use NVFLARE and lightweight Python dependencies only; no network calls from site training code.",
        artifactOutputs: "server.npy, metrics summary, log.txt, manifest.json",
        reviewExpectations: "Template manifest, README, tests, Python syntax, NVFLARE job folder, and no-raw-data path checks must pass."
      }
    }),
    [searchParams]
  );

  function normalizeMessages(value: unknown): AgentMessage[] {
    return Array.isArray(value)
      ? value
          .filter((item): item is AgentMessage => typeof item === "object" && item != null && "content" in item)
          .map((item) => ({ role: item.role === "user" ? "user" : "assistant", content: String(item.content), missing: item.missing as string[] }))
      : [];
  }

  async function startSession(values: EntityRecord) {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/template-agent-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values)
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "Template agent session could not start.");
      setSession(body.session);
      setMessages(normalizeMessages(body.session?.messages));
      setGeneratedFiles([]);
      message.success("Template agent session started.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Template agent session could not start.");
    } finally {
      setStarting(false);
    }
  }

  async function sendMessage(messageText: string) {
    if (!session || !messageText.trim()) return;
    setSending(true);
    setError(null);
    try {
      const values = form.getFieldsValue(true);
      const response = await fetch(`/api/v1/template-agent-sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: messageText, intakePatch: values.intake })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "Template agent message failed.");
      setSession(body.session);
      setMessages(normalizeMessages(body.session?.messages));
      setDraft("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Template agent message failed.");
    } finally {
      setSending(false);
    }
  }

  async function applyDraft() {
    if (!session) return;
    setApplying(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/template-agent-sessions/${session.id}/apply`, { method: "POST" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "Draft PR was not created.");
      setSession(body.session);
      setGeneratedFiles(body.session?.generatedFiles ?? []);
      setSelectedPath(body.session?.generatedFiles?.[0]?.path ?? null);
      message.success("Draft PR created.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Draft PR was not created.");
    } finally {
      setApplying(false);
    }
  }

  const thoughtItems = [
    { title: "Intake", status: missing.length > 0 ? "process" : "finish", description: missing.length > 0 ? `${missing.length} missing field(s)` : "Complete" },
    { title: "Plan", status: session ? "finish" : "wait", description: "Federated learning guardrails loaded" },
    { title: "Generate", status: session?.status === "APPLIED" ? "finish" : session && missing.length === 0 ? "process" : "wait", description: "NVFLARE code branch" },
    { title: "Validate", status: session?.status === "APPLIED" ? "finish" : "wait", description: session?.resultSummary ?? "Pending" },
    { title: "Draft PR", status: session?.giteaPullRequestUrl ? "finish" : "wait", description: session?.giteaPullRequestUrl ? "Created" : "Not created" }
  ];

  return (
    <AppPage className="fedlify-template-agent-page">
      <AppPageHeader
        title="AI template assistant"
        subtitle="Use chat and structured intake to create or edit NVFLARE template sources in draft Gitea pull requests."
        actions={
          <Space wrap>
            {session?.giteaPullRequestUrl ? (
              <Button icon={<GithubOutlined />} href={session.giteaPullRequestUrl} target="_blank">
                Open draft PR
              </Button>
            ) : null}
            <Button type="primary" className="fedlify-dark-action" icon={<CodeOutlined />} onClick={applyDraft} loading={applying} disabled={!session || missing.length > 0}>
              Create draft PR
            </Button>
          </Space>
        }
      />

      {error ? <Alert type="error" showIcon message={error} /> : null}

      <div className="fedlify-template-agent-layout">
        <div className="fedlify-template-agent-left">
          <SectionHeader title="Structured intake" description="The agent will not write code until required clinical, runtime, privacy, and validation details are present." />
          <Form form={form} layout="vertical" initialValues={initialValues} onFinish={(values) => void startSession(values)}>
            <Form.Item name="mode" label="Agent mode" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: "FROM_SCRATCH", label: "Create from scratch" },
                  { value: "FROM_PUBLIC_TEMPLATE", label: "Create from public template" },
                  { value: "FROM_STUDY_TEMPLATE", label: "Create from study template" }
                ]}
              />
            </Form.Item>
            <div className="fedlify-template-agent-grid">
              <Form.Item name={["intake", "templateName"]} label="Template name" rules={[{ required: true, min: 3 }]}>
                <Input placeholder="Cross-silo risk prediction FedAvg" />
              </Form.Item>
              <Form.Item name={["intake", "clinicalUseCase"]} label="Clinical AI use case" rules={[{ required: true }]}>
                <Select options={CLINICAL_USE_CASE_OPTIONS} />
              </Form.Item>
              <Form.Item name={["intake", "dataModalities"]} label="Data modalities" rules={[{ required: true }]}>
                <Select mode="multiple" options={DATA_MODALITY_OPTIONS} />
              </Form.Item>
              <Form.Item name={["intake", "purpose"]} label="Template purpose" rules={[{ required: true }]}>
                <Select options={["training", "evaluation", "preprocessing", "metrics", "model export"].map((value) => ({ value, label: value }))} />
              </Form.Item>
              <Form.Item name={["intake", "minClients"]} label="Minimum clients" rules={[{ required: true }]}>
                <InputNumber min={1} precision={0} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item name={["intake", "numRounds"]} label="Rounds" rules={[{ required: true }]}>
                <InputNumber min={1} precision={0} style={{ width: "100%" }} />
              </Form.Item>
            </div>
            {mode !== "FROM_SCRATCH" ? (
              <Form.Item name="templateId" label="Source template id" rules={[{ required: true }]}>
                <Input placeholder="Template id from public sources or study sources" />
              </Form.Item>
            ) : null}
            {mode !== "FROM_PUBLIC_TEMPLATE" ? (
              <Form.Item name="studyId" label="Study id">
                <Input placeholder="Optional for public proposals; required for study-private templates" />
              </Form.Item>
            ) : (
              <Form.Item name="studyId" label="Study id" rules={[{ required: true }]}>
                <Input placeholder="Private study id" />
              </Form.Item>
            )}
            <Form.Item name={["intake", "agentRequest"]} label="Agent request" rules={[{ required: true, min: 20 }]}>
              <Input.TextArea rows={3} placeholder="Describe the template or change the agent should generate." />
            </Form.Item>
            <Form.Item name={["intake", "siteLocalInputs"]} label="Site-local input contract" rules={[{ required: true }]}>
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item name={["intake", "syntheticFixtures"]} label="Synthetic fixtures" rules={[{ required: true }]}>
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item name={["intake", "aggregation"]} label="Aggregation" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name={["intake", "privacyConstraints"]} label="Privacy constraints" rules={[{ required: true }]}>
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item name={["intake", "dependencyPolicy"]} label="Dependency policy" rules={[{ required: true }]}>
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item name={["intake", "artifactOutputs"]} label="Output artifacts" rules={[{ required: true }]}>
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item name={["intake", "reviewExpectations"]} label="Validation expectations" rules={[{ required: true }]}>
              <Input.TextArea rows={2} />
            </Form.Item>
            <Button type="primary" className="fedlify-dark-action" htmlType="submit" loading={starting} icon={<RobotOutlined />}>
              Start assistant session
            </Button>
          </Form>
        </div>

        <div className="fedlify-template-agent-middle">
          <SectionHeader title="Agent chat" description="Ask questions, refine requirements, then create a draft Gitea PR." />
          <PromptList
            items={[
              { key: "fedavg", label: "FedAvg template", description: "Create a configurable cross-silo FedAvg training template." },
              { key: "privacy", label: "Privacy review", description: "Check this template for raw-data leakage risks." },
              { key: "runtime", label: "Runtime knobs", description: "Make clients, rounds, and aggregation configurable." }
            ]}
            onItemClick={(info: any) => setDraft(info?.data?.description ?? info?.description ?? "")}
          />
          <div className="fedlify-template-agent-chat">
            {messages.length ? (
              <BubbleList
                items={messages.map((item, index) => ({
                  key: `${index}`,
                  role: item.role,
                  content: item.content
                }))}
              />
            ) : (
              <div className="fedlify-template-agent-empty">
                <RobotOutlined />
                <Typography.Text>Start a session to let the Fedlify AI assistant inspect intake and ask missing questions.</Typography.Text>
              </div>
            )}
          </div>
          <SenderBox value={draft} onChange={setDraft} onSubmit={(value: string) => void sendMessage(value)} loading={sending} placeholder="Ask the Fedlify AI assistant..." />
          <ThoughtSteps items={thoughtItems} />
        </div>

        <div className="fedlify-template-agent-right">
          <SectionHeader title="Generated files" description="Files written to the draft PR after validation passes." />
          {generatedFiles.length ? (
            <div className="fedlify-template-agent-files">
              <div className="fedlify-template-agent-file-list">
                {generatedFiles.map((file) => (
                  <button key={file.path} type="button" className={file.path === selectedFile?.path ? "is-active" : ""} onClick={() => setSelectedPath(file.path)}>
                    {file.path}
                  </button>
                ))}
              </div>
              <div className="fedlify-template-agent-preview">
                <Typography.Text strong>{selectedFile?.path}</Typography.Text>
                <pre>{selectedFile?.content}</pre>
              </div>
            </div>
          ) : (
            <Alert
              type="info"
              showIcon
              message="No files generated yet"
              description="Complete intake, use the chat to refine the template, then create a draft PR. Fedlify will show the generated source here."
            />
          )}
        </div>
      </div>
    </AppPage>
  );
}
