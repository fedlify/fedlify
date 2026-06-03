"use client";

import {
  BulbOutlined,
  CheckCircleOutlined,
  CloseOutlined,
  CloudUploadOutlined,
  CodeOutlined,
  DatabaseOutlined,
  DiffOutlined,
  FileAddOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  GithubOutlined,
  HistoryOutlined,
  LayoutOutlined,
  LoadingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PaperClipOutlined,
  QuestionCircleOutlined,
  RobotOutlined,
  SafetyOutlined,
  SendOutlined
} from "@ant-design/icons";
import { Attachments, Bubble, Conversations, Prompts, Sender, Think, ThoughtChain, Welcome } from "@ant-design/x";
import { Alert, Badge, Button, Form, Input, InputNumber, Popover, Segmented, Select, Space, Splitter, Tag, Tooltip, Typography, message } from "antd";
import dynamic from "next/dynamic";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppPage, AppPageHeader } from "@/components/AppPage";
import { CLINICAL_USE_CASE_OPTIONS, DATA_MODALITY_OPTIONS } from "@/lib/governance-options";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false, loading: () => <div className="fedlify-editor-loading">Loading editor…</div> });
const MonacoDiffEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.DiffEditor), { ssr: false, loading: () => <div className="fedlify-editor-loading">Loading diff…</div> });

// ─── ant-design/x casts ──────────────────────────────────────────────────────
const BubbleList = Bubble.List as any;
const SenderBox = Sender as any;
const PromptList = Prompts as any;
const ThoughtSteps = ThoughtChain as any;
const ThinkBox = Think as any;
const ConversationList = Conversations as any;
const WelcomeBox = Welcome as any;
const AttachmentBox = Attachments as any;

// ─── Types ────────────────────────────────────────────────────────────────────

type ChatMessage = {
  role: "user" | "assistant" | "thinking";
  content: string;
  createdAt?: string;
  missing?: string[];
  streaming?: boolean;
};

type GeneratedFile = { path: string; content: string; proposedContent?: string };
type Session = Record<string, any>;
type EditorMode = "source" | "diff";

type TreeNode = {
  type: "folder" | "file";
  name: string;
  path: string;
  children?: TreeNode[];
  file?: GeneratedFile;
};

// ─── File tree helpers ────────────────────────────────────────────────────────

function buildFileTree(files: GeneratedFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split("/");
    let nodes = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLeaf = i === parts.length - 1;
      let node = nodes.find((n) => n.name === name);
      if (!node) {
        node = isLeaf
          ? { type: "file", name, path: file.path, file }
          : { type: "folder", name, path: parts.slice(0, i + 1).join("/"), children: [] };
        nodes.push(node);
      }
      if (!isLeaf) nodes = node.children!;
    }
  }
  return root;
}

function languageForPath(p: string): string {
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".md")) return "markdown";
  if (p.endsWith(".conf") || p.endsWith(".toml")) return "ini";
  if (p.endsWith(".yml") || p.endsWith(".yaml")) return "yaml";
  if (p.endsWith(".sh")) return "shell";
  return "plaintext";
}

// ─── File tree node ──────────────────────────────────────────────────────────

function FileTreeNode({ node, selectedPath, onSelect, depth = 0 }: { node: TreeNode; selectedPath: string | null; onSelect: (path: string) => void; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);
  if (node.type === "folder") {
    return (
      <div>
        <button type="button" className="fedlify-pa-tree-folder" style={{ paddingLeft: depth * 10 + 8 }} onClick={() => setOpen((v) => !v)}>
          {open ? <FolderOpenOutlined /> : <FolderOutlined />}
          <span>{node.name}</span>
        </button>
        {open ? (node.children ?? []).map((child) => <FileTreeNode key={child.path} node={child} selectedPath={selectedPath} onSelect={onSelect} depth={depth + 1} />) : null}
      </div>
    );
  }
  const isSelected = node.path === selectedPath;
  const hasChange = !!node.file?.proposedContent;
  return (
    <button type="button" className={["fedlify-pa-tree-file", isSelected ? "is-selected" : ""].filter(Boolean).join(" ")} style={{ paddingLeft: depth * 10 + 8 }} onClick={() => onSelect(node.path)}>
      <FileTextOutlined />
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.name}</span>
      {hasChange ? <Badge dot color="blue" /> : null}
    </button>
  );
}

// ─── Minimal markdown renderer (no external deps) ────────────────────────────
// Handles: code fences, inline code, bold, italic, headings, lists, hr, links

function renderMarkdown(text: string): React.ReactNode {
  const blocks = text.split(/\n\n+/);
  return (
    <div className="fedlify-pa-md">
      {blocks.map((block, bi) => {
        // Code fence
        if (block.startsWith("```")) {
          const firstNl = block.indexOf("\n");
          const lang = block.slice(3, firstNl).trim() || "text";
          const code = block.slice(firstNl + 1).replace(/```\s*$/, "").trimEnd();
          return <pre key={bi}><code className={`language-${lang}`}>{code}</code></pre>;
        }
        // Ordered / unordered list
        const listLines = block.split("\n");
        const isUL = listLines.every((l) => /^\s*[-*+] /.test(l) || l.trim() === "");
        const isOL = listLines.every((l) => /^\s*\d+\. /.test(l) || l.trim() === "");
        if (isUL && listLines.some((l) => /^\s*[-*+] /.test(l))) {
          return <ul key={bi}>{listLines.filter((l) => l.trim()).map((l, i) => <li key={i}>{inlineMarkdown(l.replace(/^\s*[-*+] /, ""))}</li>)}</ul>;
        }
        if (isOL && listLines.some((l) => /^\s*\d+\. /.test(l))) {
          return <ol key={bi}>{listLines.filter((l) => l.trim()).map((l, i) => <li key={i}>{inlineMarkdown(l.replace(/^\s*\d+\. /, ""))}</li>)}</ol>;
        }
        // Headings
        const h = block.match(/^(#{1,3})\s+(.+)/);
        if (h) {
          const level = h[1].length;
          const content = inlineMarkdown(h[2]);
          return level === 1 ? <h1 key={bi}>{content}</h1> : level === 2 ? <h2 key={bi}>{content}</h2> : <h3 key={bi}>{content}</h3>;
        }
        // Horizontal rule
        if (/^---+$/.test(block.trim())) return <hr key={bi} />;
        // Blockquote
        if (block.startsWith("> ")) {
          return <blockquote key={bi}>{inlineMarkdown(block.replace(/^> /gm, ""))}</blockquote>;
        }
        // Regular paragraph (preserve single newlines as <br>)
        if (!block.trim()) return null;
        const lines = block.split("\n").map((l, li) => (
          <span key={li}>{inlineMarkdown(l)}{li < block.split("\n").length - 1 ? <br /> : null}</span>
        ));
        return <p key={bi}>{lines}</p>;
      })}
    </div>
  );
}

function inlineMarkdown(text: string): React.ReactNode {
  // Split on inline code first to protect it from other processing
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }
    // Bold+italic, bold, italic
    const processed = part
      .replace(/\*\*\*(.+?)\*\*\*/g, "§§§BOLDITALIC:$1§§§")
      .replace(/\*\*(.+?)\*\*/g, "§§§BOLD:$1§§§")
      .replace(/\*(.+?)\*/g, "§§§ITALIC:$1§§§")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "§§§LINK:$1:$2§§§");
    const tokens = processed.split(/(§§§[^§]+§§§)/g);
    return tokens.map((token, j) => {
      if (token.startsWith("§§§BOLDITALIC:")) return <strong key={j}><em>{token.slice(14, -3)}</em></strong>;
      if (token.startsWith("§§§BOLD:")) return <strong key={j}>{token.slice(8, -3)}</strong>;
      if (token.startsWith("§§§ITALIC:")) return <em key={j}>{token.slice(10, -3)}</em>;
      if (token.startsWith("§§§LINK:")) { const [label, url] = token.slice(8, -3).split(":"); return <a key={j} href={url} target="_blank" rel="noreferrer">{label}</a>; }
      return token;
    });
  });
}

// ─── Intake field config ──────────────────────────────────────────────────────

type FieldConfig = { key: string; label: string; input: "text" | "textarea" | "number" | "select" | "multiselect"; placeholder?: string; options?: { value: string; label: string }[]; defaultValue?: unknown; min?: number; span?: "full" };

const INTAKE_FIELDS: Record<string, FieldConfig> = {
  "template name": { key: "templateName", label: "Template name", input: "text", placeholder: "e.g. fedavg-ehr-sepsis-prediction" },
  "what the template should do": { key: "agentRequest", label: "What should this pipeline do?", input: "textarea", placeholder: "Describe the pipeline goal.", span: "full" },
  "template purpose": { key: "purpose", label: "Purpose", input: "select", options: ["training","evaluation","preprocessing","metrics","model export"].map((v) => ({ value: v, label: v })), defaultValue: "training" },
  "clinical AI use case": { key: "clinicalUseCase", label: "Clinical AI use case", input: "select", options: CLINICAL_USE_CASE_OPTIONS as unknown as { value: string; label: string }[] },
  "data modalities": { key: "dataModalities", label: "Data modalities", input: "multiselect", options: DATA_MODALITY_OPTIONS as unknown as { value: string; label: string }[] },
  "site-local input contract": { key: "siteLocalInputs", label: "Site-local input format", input: "textarea", placeholder: "e.g. CSV with age, vitals, labs, label columns.", span: "full" },
  "allowed synthetic fixtures": { key: "syntheticFixtures", label: "Synthetic test data", input: "text", placeholder: "Synthetic numpy arrays for smoke tests only.", defaultValue: "Synthetic numpy arrays for smoke tests only." },
  "NVFLARE workflow type": { key: "nvflareWorkflow", label: "NVFLARE workflow", input: "select", options: [{ value: "scatter_and_gather", label: "Scatter and Gather (FedAvg)" }, { value: "cyclic", label: "Cyclic" }], defaultValue: "scatter_and_gather" },
  "minimum clients": { key: "minClients", label: "Min sites per round", input: "number", min: 1, defaultValue: 2 },
  "federated rounds": { key: "numRounds", label: "Federated rounds", input: "number", min: 1, defaultValue: 5 },
  "aggregation behavior": { key: "aggregation", label: "Aggregation", input: "text", placeholder: "weighted FedAvg", defaultValue: "weighted FedAvg" },
  "output artifacts": { key: "artifactOutputs", label: "Output artifacts", input: "text", defaultValue: "server.npy, metrics summary, logs, manifest" },
  "dependency policy": { key: "dependencyPolicy", label: "Dependencies", input: "select", options: [{ value: "Use standard NVFLARE and scikit-learn only.", label: "scikit-learn" }, { value: "Use standard NVFLARE and PyTorch only.", label: "PyTorch" }, { value: "Use standard NVFLARE and NumPy only.", label: "NumPy only" }], defaultValue: "Use standard NVFLARE and scikit-learn only." },
  "privacy constraints": { key: "privacyConstraints", label: "Privacy constraints", input: "text", defaultValue: "Raw clinical data remains site-local. No patient files in Git." },
  "validation expectations": { key: "reviewExpectations", label: "Validation checks", input: "text", defaultValue: "README, manifest, NVFLARE job shape, and no raw-data paths must pass." }
};

function IntakeFormCard({ missing, intake, onSubmit, sending }: { missing: string[]; intake: Record<string, unknown>; onSubmit: (patch: Record<string, unknown>) => void; sending: boolean }) {
  const [form] = Form.useForm();
  const missingFields = missing.map((label) => INTAKE_FIELDS[label]).filter((f): f is FieldConfig => Boolean(f));
  if (missingFields.length === 0) return null;
  const initialValues: Record<string, unknown> = {};
  for (const field of missingFields) initialValues[field.key] = intake[field.key] ?? field.defaultValue;
  return (
    <div className="fedlify-intake-card">
      <div className="fedlify-intake-card-header"><RobotOutlined style={{ color: "var(--fedlify-primary)" }} /><div><Typography.Text strong style={{ display: "block" }}>Complete pipeline details</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 12 }}>{missingFields.length} fields needed</Typography.Text></div></div>
      <Form form={form} layout="vertical" initialValues={initialValues} onFinish={(values) => { const patch: Record<string, unknown> = {}; for (const f of missingFields) if (values[f.key] !== undefined && values[f.key] !== null && values[f.key] !== "") patch[f.key] = values[f.key]; onSubmit(patch); }} className="fedlify-intake-card-form">
        <div className="fedlify-intake-card-grid">
          {missingFields.map((field) => (
            <Form.Item key={field.key} name={field.key} label={field.label} className={field.span === "full" ? "fedlify-intake-card-full" : ""} rules={[{ required: true }]}>
              {field.input === "textarea" ? <Input.TextArea rows={2} placeholder={field.placeholder} /> : field.input === "number" ? <InputNumber min={field.min ?? 1} precision={0} style={{ width: "100%" }} /> : field.input === "select" ? <Select options={field.options} placeholder={field.placeholder} /> : field.input === "multiselect" ? <Select mode="multiple" options={field.options} placeholder={field.placeholder ?? "Select all that apply"} /> : <Input placeholder={field.placeholder} />}
            </Form.Item>
          ))}
        </div>
        <Button type="primary" htmlType="submit" className="fedlify-dark-action" icon={<SendOutlined />} loading={sending} block>Generate pipeline code</Button>
      </Form>
    </div>
  );
}

// ─── Context-aware prompts ────────────────────────────────────────────────────

function promptsForFile(path: string | null): Array<{ key: string; label: string; description: string }> {
  if (!path) return [
    { key: "usecase", label: "Describe use case", description: "What is the clinical AI problem this pipeline should solve?" },
    { key: "executor", label: "Show executor code", description: "Show me the SiteLocalExecutor training code." },
    { key: "privacy", label: "Privacy constraints", description: "What privacy requirements apply (HIPAA, differential privacy)?" }
  ];
  if (path.includes("executor.py")) return [
    { key: "explain", label: "Explain executor", description: "Explain what this SiteLocalExecutor does step by step." },
    { key: "pytorch", label: "Switch to PyTorch", description: "Rewrite the executor using PyTorch instead of scikit-learn." },
    { key: "dp", label: "Add DP noise", description: "Add differential privacy Gaussian noise before returning weights." }
  ];
  if (path.includes("config_fed_server") || path.includes("config_fed_client")) return [
    { key: "explain", label: "Explain config", description: "Explain the NVFlare server/client configuration." },
    { key: "rounds", label: "Increase rounds", description: "Increase num_rounds from 5 to 10 in the server config." },
    { key: "agg", label: "Change aggregation", description: "Switch from FedAvg to FedProx aggregation." }
  ];
  if (path.endsWith(".md")) return [
    { key: "explain", label: "Summarize", description: "Summarize what this README describes." },
    { key: "update", label: "Update README", description: "Update the README to reflect the current pipeline configuration." }
  ];
  return [
    { key: "explain", label: "Explain file", description: `Explain the purpose of ${path.split("/").pop()}.` },
    { key: "improve", label: "Suggest improvements", description: "What improvements would you recommend for this file?" }
  ];
}

// ─── ThoughtChain items ───────────────────────────────────────────────────────

function thoughtItems(session: Session | null, missing: string[], files: GeneratedFile[], validation: { status: string } | null, streaming: boolean) {
  const s = (cond: boolean, active = false): "finish" | "process" | "wait" | "error" =>
    cond ? "finish" : active ? "process" : "wait";
  const hasFiles = files.length > 0;
  const applied = session?.status === "APPLIED";
  const intakeDone = !missing.length && session !== null;
  const validated = validation?.status === "PASSED";
  return [
    {
      key: "ctx",
      icon: <DatabaseOutlined />,
      title: "Load context",
      status: s(!!session),
      description: session ? "Session ready" : "Starting…"
    },
    {
      key: "req",
      icon: <QuestionCircleOutlined />,
      title: "Understand requirements",
      status: s(intakeDone, !intakeDone && !!session && !streaming),
      description: intakeDone ? "Ready to generate" : missing.length > 0 ? `${missing.length} fields needed` : "Awaiting input"
    },
    {
      key: "gen",
      icon: <CodeOutlined />,
      title: "Generate code",
      status: s(hasFiles, streaming && intakeDone),
      description: hasFiles ? `${files.length} files generated` : streaming ? "Generating…" : "Pending"
    },
    {
      key: "val",
      icon: <SafetyOutlined />,
      title: "Validate",
      status: s(validated, false),
      description: validated ? "All checks passed" : "Pending"
    },
    {
      key: "push",
      icon: <CloudUploadOutlined />,
      title: "Push to workspace",
      status: s(applied, false),
      description: applied ? "Code pushed to Gitea" : "Pending"
    }
  ];
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function PipelineAgentPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const studyId = typeof params.studyId === "string" ? params.studyId : "";
  const modeParam = searchParams.get("mode") ?? "develop";
  const templateId = searchParams.get("templateId") ?? undefined;
  const resumeSessionId = searchParams.get("sessionId") ?? undefined;
  const sessionMode = modeParam === "adjust" || modeParam === "from-template" ? "FROM_STUDY_TEMPLATE" : "FROM_SCRATCH";

  // ── Layout state ──────────────────────────────────────────────────────────
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);
  const [thoughtExpanded, setThoughtExpanded] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [attachments, setAttachments] = useState<Array<{ uid: string; name: string; status?: string; url?: string; originFileObj?: File }>>([]);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [sessionsPopover, setSessionsPopover] = useState(false);
  const [sessionList, setSessionList] = useState<Array<{ id: string; label: string; mode: string; status: string; createdAt: string }>>([]);

  // ── Session / chat state ──────────────────────────────────────────────────
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<GeneratedFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>("source");
  const [starting, setStarting] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ status: string; summary: string; errors?: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const streamingContentRef = useRef("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  // ── Derived ───────────────────────────────────────────────────────────────
  const missing = useMemo(() => ([...messages].reverse().find((m) => m.role === "assistant")?.missing ?? []), [messages]);
  const selectedFile = useMemo(() => files.find((f) => f.path === selectedPath) ?? files[0] ?? null, [files, selectedPath]);
  const tree = useMemo(() => buildFileTree(files), [files]);
  const intakeComplete = session?.status === "CODING" || session?.status === "DRAFT_READY";
  const canCreatePR = session && session.status !== "APPLIED" && (intakeComplete || validation?.status === "PASSED" || files.length > 0);
  const ideClass = ["fedlify-pa-ide", !explorerOpen ? "explorer-hidden" : "", !chatOpen ? "chat-hidden" : ""].filter(Boolean).join(" ");

  // ── Helpers ───────────────────────────────────────────────────────────────

  function normalizeMessages(raw: unknown): ChatMessage[] {
    return Array.isArray(raw)
      ? raw.filter((m): m is Record<string, unknown> => typeof m === "object" && m != null && "content" in m)
           .map((m) => ({ role: m.role === "user" ? "user" : ("assistant" as const), content: String(m.content ?? ""), createdAt: typeof m.createdAt === "string" ? m.createdAt : undefined, missing: Array.isArray(m.missing) ? (m.missing as string[]) : undefined }))
      : [];
  }

  function syncFilesFromSession(sess: Session) {
    const raw = sess.generatedFiles;
    if (Array.isArray(raw) && raw.length > 0) {
      setFiles(raw as GeneratedFile[]);
      setSelectedPath((prev) => {
        const newFiles = raw as GeneratedFile[];
        if (prev && newFiles.find((f) => f.path === prev)) return prev;
        return newFiles.find((f) => f.path.includes("executor.py"))?.path ?? newFiles[0]?.path ?? null;
      });
      const paths = (raw as GeneratedFile[]).map((f) => f.path);
      setOpenTabs((prev) => {
        const combined = [...new Set([...prev, ...paths])];
        return combined.slice(0, 8);
      });
    }
  }

  function openFileTab(path: string) {
    setSelectedPath(path);
    setOpenTabs((prev) => prev.includes(path) ? prev : [...prev, path].slice(0, 8));
  }

  function closeTab(path: string, e: React.MouseEvent) {
    e.stopPropagation();
    setOpenTabs((prev) => {
      const next = prev.filter((p) => p !== path);
      if (selectedPath === path) setSelectedPath(next[next.length - 1] ?? null);
      return next;
    });
  }

  // Persist layout to localStorage
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("fedlify.pipelineAgent.layout") ?? "{}");
      if (typeof saved.explorerOpen === "boolean") setExplorerOpen(saved.explorerOpen);
      if (typeof saved.chatOpen === "boolean") setChatOpen(saved.chatOpen);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    try { localStorage.setItem("fedlify.pipelineAgent.layout", JSON.stringify({ explorerOpen, chatOpen })); } catch { /* ignore */ }
  }, [explorerOpen, chatOpen]);

  // Auto-scroll chat
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, streaming]);

  // ── Session start ─────────────────────────────────────────────────────────

  const startSession = useCallback(async () => {
    if (starting || session) return;
    setStarting(true);
    setError(null);
    try {
      if (resumeSessionId) {
        const r = await fetch(`/api/v1/template-agent-sessions/${resumeSessionId}`);
        const d = await r.json().catch(() => null);
        if (r.ok && d?.session) {
          setSession(d.session);
          setMessages(normalizeMessages(d.session?.messages));
          syncFilesFromSession(d.session);
          return;
        }
      }
      const body: Record<string, unknown> = { mode: sessionMode, studyId };
      if (templateId) body.templateId = templateId;
      const response = await fetch("/api/v1/template-agent-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error?.message ?? "Could not start session.");
      setSession(data.session);
      setMessages(normalizeMessages(data.session?.messages));
      syncFilesFromSession(data.session);
      if (data.session?.id) {
        const url = new URL(window.location.href);
        url.searchParams.set("sessionId", data.session.id);
        window.history.replaceState({}, "", url.toString());
      }
      if ((modeParam === "adjust" || modeParam === "from-template") && data.session?.generatedFiles == null) {
        let sourceFiles: GeneratedFile[] = [];
        if (templateId) {
          const r = await fetch(`/api/v1/pipeline-templates/${templateId}/source?ref=current`, { cache: "no-store" }).catch(() => null);
          if (r?.ok) { const sd = await r.json().catch(() => null); sourceFiles = (sd?.files ?? []).filter((f: any) => f.path && f.content !== undefined).map((f: any) => ({ path: f.path, content: f.content })); }
        }
        if (sourceFiles.length === 0 && studyId) {
          const r = await fetch(`/api/v1/studies/${studyId}/pipeline-version-source`, { cache: "no-store" }).catch(() => null);
          if (r?.ok) { const sd = await r.json().catch(() => null); sourceFiles = (sd?.files ?? []).filter((f: any) => f.path && f.content !== undefined).map((f: any) => ({ path: f.path, content: f.content })); }
        }
        if (sourceFiles.length > 0) {
          setFiles(sourceFiles);
          const executorFile = sourceFiles.find((f) => f.path.includes("executor.py")) ?? sourceFiles[0];
          if (executorFile) { setSelectedPath(executorFile.path); setOpenTabs([executorFile.path]); }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start session.");
    } finally {
      setStarting(false);
    }
  }, [starting, session, sessionMode, studyId, templateId, resumeSessionId, modeParam]);

  useEffect(() => { void startSession(); }, []);

  // ── Load session list ─────────────────────────────────────────────────────

  const loadSessionList = useCallback(async () => {
    if (!studyId) return;
    const r = await fetch(`/api/v1/studies/${studyId}/pipeline-sessions`, { cache: "no-store" }).catch(() => null);
    if (r?.ok) { const d = await r.json().catch(() => null); setSessionList(d?.sessions ?? []); }
  }, [studyId]);

  useEffect(() => { if (sessionsPopover) void loadSessionList(); }, [sessionsPopover, loadSessionList]);

  // ── Load a past session ──────────────────────────────────────────────────

  async function loadSession(sessionId: string) {
    setSessionsPopover(false);
    const r = await fetch(`/api/v1/template-agent-sessions/${sessionId}`);
    const d = await r.json().catch(() => null);
    if (!r.ok || !d?.session) { message.error("Could not load session."); return; }
    setSession(d.session);
    setMessages(normalizeMessages(d.session?.messages));
    setFiles([]);
    setOpenTabs([]);
    syncFilesFromSession(d.session);
    const url = new URL(window.location.href);
    url.searchParams.set("sessionId", sessionId);
    window.history.replaceState({}, "", url.toString());
  }

  // ── Send message ──────────────────────────────────────────────────────────

  async function sendMessage(text: string, intakePatch?: Record<string, unknown>) {
    if (!session || !text.trim() || streaming) return;
    setDraft("");
    // Prefix plan-mode instruction
    if (planMode && !text.startsWith("PLAN:")) {
      text = `PLAN: Before generating any code, show a numbered step-by-step plan of the changes you'll make and wait for my confirmation before proceeding.\n\n${text}`;
    }
    // Append attachment names if any
    if (attachments.length > 0) {
      text += `\n\nAttached files: ${attachments.map((a) => a.name).join(", ")}`;
      setAttachments([]);
    }
    setError(null);
    const userMsg: ChatMessage = { role: "user", content: text };
    // Add user + thinking placeholder
    setMessages((prev) => [...prev, userMsg, { role: "thinking", content: "", streaming: true }]);
    setStreaming(true);
    streamingContentRef.current = "";
    try {
      const streamResponse = await fetch(`/api/v1/template-agent-sessions/${session.id}/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, ...(intakePatch ? { intakePatch } : {}) })
      });
      if (!streamResponse.ok || !streamResponse.body) throw new Error("stream_unavailable");
      const reader = streamResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let newMissing: string[] | undefined;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          try {
            const parsed = JSON.parse(data) as { type?: string; delta?: unknown; missing?: string[]; sessionId?: string };
            if (parsed.type === "response.output_text.delta") {
              const chunk = typeof parsed.delta === "string" ? parsed.delta : (parsed.delta as any)?.text ?? "";
              streamingContentRef.current += chunk;
              setMessages((prev) => {
                const updated = [...prev];
                const thinkIdx = updated.map((m) => m.role === "thinking" && m.streaming).lastIndexOf(true);
                if (thinkIdx >= 0) updated[thinkIdx] = { ...updated[thinkIdx], content: streamingContentRef.current };
                return updated;
              });
            }
            if (parsed.type === "fedlify.done") newMissing = parsed.missing;
          } catch { /* non-JSON line */ }
        }
      }
      // Replace thinking placeholder with final assistant message
      const fullContent = streamingContentRef.current.trim() || "(no response)";
      setMessages((prev) => {
        const updated = [...prev];
        const thinkIdx = updated.map((m) => m.role === "thinking").lastIndexOf(true);
        if (thinkIdx >= 0) updated[thinkIdx] = { role: "thinking", content: fullContent, streaming: false };
        return [...updated, { role: "assistant", content: fullContent, missing: newMissing }];
      });
      if (newMissing !== undefined) setSession((prev) => prev ? { ...prev, status: newMissing!.length > 0 ? "INTAKE" : "CODING" } : prev);
    } catch {
      setMessages((prev) => prev.filter((m) => !(m.role === "thinking" && m.streaming)));
      try {
        const fallback = await fetch(`/api/v1/template-agent-sessions/${session.id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: text, ...(intakePatch ? { intakePatch } : {}) })
        });
        const data = await fallback.json().catch(() => null);
        if (!fallback.ok) throw new Error(data?.error?.message ?? "Message failed.");
        setSession(data.session);
        setMessages(normalizeMessages(data.session?.messages));
        syncFilesFromSession(data.session);
      } catch (fallbackErr) {
        setError(fallbackErr instanceof Error ? fallbackErr.message : "Message failed.");
      }
    } finally {
      setStreaming(false);
    }
  }

  // ── Validate / Create PR / Deploy ─────────────────────────────────────────

  async function validateFiles() {
    if (!session) return;
    setValidating(true); setError(null);
    try {
      const changedFiles = files.map((f) => ({ path: f.path, proposedContent: f.proposedContent ?? f.content, originalContent: f.content, reason: "pipeline agent review" }));
      const response = await fetch(`/api/v1/template-agent-sessions/${session.id}/validate-review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ changedFiles }) });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error?.message ?? "Validation failed.");
      setValidation(data.validation);
      setSession(data.session);
      if (data.validation?.status === "PASSED") message.success("Validation passed.");
      else message.warning("Validation found issues.");
    } catch (err) { setError(err instanceof Error ? err.message : "Validation failed."); }
    finally { setValidating(false); }
  }

  async function createPR() {
    if (!session) return;
    setApplying(true); setError(null);
    try {
      const response = await fetch(`/api/v1/template-agent-sessions/${session.id}/apply`, { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error?.message ?? "Pipeline code could not be generated.");
      setSession(data.session);
      syncFilesFromSession(data.session);
      if (data.session?.id) { const url = new URL(window.location.href); url.searchParams.set("sessionId", data.session.id); window.history.replaceState({}, "", url.toString()); }
    } catch (err) { setError(err instanceof Error ? err.message : "PR could not be created."); }
    finally { setApplying(false); }
  }

  async function deployPipeline() {
    if (!session || !studyId) return;
    setDeploying(true); setError(null);
    try {
      const response = await fetch(`/api/v1/studies/${studyId}/pipeline/quick-deploy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: session.id }) });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error?.message ?? "Approval failed.");
      message.success("Pipeline approved for deployment.");
      router.push(`/studies/${studyId}?section=pipeline`);
    } catch (err) { setError(err instanceof Error ? err.message : "Approval failed."); setDeploying(false); }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const modeTitle = modeParam === "adjust" ? "Adjust Pipeline" : modeParam === "from-template" ? "Pipeline from Template" : "Develop Pipeline";
  const contextPrompts = promptsForFile(selectedPath);
  const steps = thoughtItems(session, missing, files, validation, streaming);

  // Bubble items: render assistant messages as markdown
  const bubbleItems = messages
    .filter((m) => m.role !== "thinking")
    .map((m, i) => ({
      key: i.toString(),
      role: m.role,
      content: m.role === "assistant" ? renderMarkdown(m.content) : m.content,
      placement: m.role === "user" ? ("end" as const) : ("start" as const)
    }));

  // Find the active thinking message for Think component
  const activeThinking = [...messages].reverse().find((m) => m.role === "thinking") ?? null;

  return (
    <AppPage className="fedlify-pa-page">
      <AppPageHeader
        title={
          <Space>
            <RobotOutlined />
            <span>{modeTitle}</span>
            {starting ? <LoadingOutlined style={{ fontSize: 14 }} /> : null}
          </Space>
        }
        subtitle="Agentic pipeline development — write, review, and approve NVFlare code with AI."
        backLabel={studyId ? "Back to study" : "Back to templates"}
        onBack={() => studyId ? router.push(`/studies/${studyId}?section=pipeline`) : router.push("/templates")}
        actions={
          <Space size="small">
            <Tooltip title={explorerOpen ? "Hide explorer" : "Show explorer"}>
              <Button size="small" icon={explorerOpen ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />} onClick={() => setExplorerOpen((v) => !v)} />
            </Tooltip>
            <Tooltip title={chatOpen ? "Hide chat" : "Show chat"}>
              <Button size="small" icon={<LayoutOutlined />} onClick={() => setChatOpen((v) => !v)} />
            </Tooltip>
          </Space>
        }
      />

      {error ? <Alert type="error" showIcon closable message={error} onClose={() => setError(null)} style={{ marginBottom: 8 }} /> : null}

      <Splitter className="fedlify-pa-splitter" layout="horizontal">
        {/* ── Explorer panel ── */}
        {explorerOpen ? (
        <Splitter.Panel defaultSize={180} min={120} max={360} collapsible>
        <aside className="fedlify-pa-explorer">
          <div className="fedlify-pa-explorer-header">
            <Typography.Text style={{ fontSize: 11, textTransform: "uppercase", fontWeight: 700, color: "var(--fedlify-muted)", letterSpacing: 0.5 }}>Explorer</Typography.Text>
            <Typography.Text style={{ fontSize: 11, color: "var(--fedlify-muted)" }}>{files.length} files</Typography.Text>
          </div>
          <div className="fedlify-pa-explorer-body">
            {tree.length === 0 ? (
              <div className="fedlify-pa-tree-empty">
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {starting ? "Loading…" : modeParam === "adjust" ? "Loading files…" : "Files appear after generation"}
                </Typography.Text>
              </div>
            ) : (
              tree.map((node) => <FileTreeNode key={node.path} node={node} selectedPath={selectedPath} onSelect={openFileTab} />)
            )}
          </div>
        </aside>
        </Splitter.Panel>
        ) : null}

        {/* ── Editor panel ── */}
        <Splitter.Panel min={300}>
        <main className="fedlify-pa-editor-area">
          {/* Tab bar */}
          <div className="fedlify-pa-tabs">
            {openTabs.length === 0 ? (
              <div className="fedlify-pa-tabs-empty">
                <CodeOutlined style={{ opacity: 0.3 }} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Select a file from the explorer</Typography.Text>
              </div>
            ) : (
              openTabs.map((path) => {
                const name = path.split("/").pop() ?? path;
                const isActive = path === selectedPath;
                const hasChange = !!files.find((f) => f.path === path)?.proposedContent;
                return (
                  <button key={path} type="button" className={["fedlify-pa-tab", isActive ? "is-active" : ""].filter(Boolean).join(" ")} onClick={() => setSelectedPath(path)}>
                    <FileTextOutlined />
                    <span>{name}</span>
                    {hasChange ? <Badge dot color="blue" style={{ marginRight: 2 }} /> : null}
                    <CloseOutlined className="fedlify-pa-tab-close" onClick={(e) => closeTab(path, e)} />
                  </button>
                );
              })
            )}
          </div>

          {/* Monaco */}
          <div className="fedlify-pa-editor">
            {selectedFile ? (
              editorMode === "diff" && selectedFile.proposedContent ? (
                <MonacoDiffEditor height="100%" language={languageForPath(selectedFile.path)} original={selectedFile.content} modified={selectedFile.proposedContent} theme="vs-dark" options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12 }} />
              ) : (
                <MonacoEditor height="100%" language={languageForPath(selectedFile.path)} value={selectedFile.content} theme="vs-dark" options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12, wordWrap: "on" }} />
              )
            ) : (
              <div className="fedlify-pa-editor-empty">
                <CodeOutlined style={{ fontSize: 40, opacity: 0.15 }} />
                <Typography.Text type="secondary">{intakeComplete ? "Generate code to see files here" : "Complete the pipeline details to get started"}</Typography.Text>
              </div>
            )}
          </div>

          {/* Toolbar */}
          <div className="fedlify-pa-editor-toolbar">
            {session?.status === "APPLIED" ? (
              <div className="fedlify-pa-success">
                <CheckCircleOutlined className="fedlify-pa-success-icon" />
                <div className="fedlify-pa-success-body">
                  <Typography.Text strong>Pipeline code generated</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12, display: "block" }}>Review the files, then approve for deployment.</Typography.Text>
                </div>
                <Space>
                  <Button type="primary" className="fedlify-dark-action" size="small" icon={deploying ? <LoadingOutlined /> : <CheckCircleOutlined />} loading={deploying} onClick={() => void deployPipeline()}>Approve for deployment</Button>
                  <Button size="small" onClick={() => router.push(`/studies/${studyId}?section=pipeline`)}>Back to study</Button>
                </Space>
              </div>
            ) : (
              <Space wrap>
                {selectedFile?.proposedContent ? (
                  <Segmented size="small" value={editorMode} onChange={(v) => setEditorMode(v as EditorMode)} options={[{ value: "source", label: <><FileTextOutlined /> Source</> }, { value: "diff", label: <><DiffOutlined /> Diff</> }]} />
                ) : null}
                {files.length > 0 ? (
                  <Button size="small" icon={<CheckCircleOutlined />} loading={validating} onClick={() => void validateFiles()}>Validate</Button>
                ) : null}
                {validation ? (
                  <Tag color={validation.status === "PASSED" ? "success" : "warning"}>{validation.status === "PASSED" ? "Validation passed" : "Validation issues"}</Tag>
                ) : null}
                <Tooltip title={session?.status === "INTAKE" ? "Complete the pipeline details first" : intakeComplete && files.length === 0 ? "Build NVFlare files and push to Gitea" : "Push generated files to Gitea"}>
                  <Button type="primary" className="fedlify-dark-action" size="small" icon={applying ? <LoadingOutlined /> : <GithubOutlined />} loading={applying} disabled={!session || !canCreatePR || streaming} onClick={() => void createPR()}>
                    {intakeComplete && files.length === 0 ? "Generate & push to Gitea" : "Create PR"}
                  </Button>
                </Tooltip>
              </Space>
            )}
          </div>
        </main>
        </Splitter.Panel>

        {/* ── Chat panel ── */}
        {chatOpen ? (
        <Splitter.Panel defaultSize={360} min={260} max={560} collapsible>
        <aside className="fedlify-pa-chat-sidebar">
          {/* Chat header */}
          <div className="fedlify-pa-chat-header">
            <Space align="center">
              <div className="fedlify-pa-agent-avatar">
                {streaming ? <LoadingOutlined /> : <RobotOutlined />}
              </div>
              <div>
                <Typography.Text strong style={{ fontSize: 13, display: "block", lineHeight: 1.3 }}>AI Agent</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {streaming ? "Thinking…" : session ? "Ready" : "Starting…"}
                </Typography.Text>
              </div>
            </Space>
            <Popover
              open={sessionsPopover}
              onOpenChange={setSessionsPopover}
              placement="bottomRight"
              trigger="click"
              content={
                <div style={{ width: 300 }}>
                  <Typography.Text strong style={{ fontSize: 12, display: "block", marginBottom: 10 }}>Session history</Typography.Text>
                  {sessionList.length === 0 ? (
                    <div style={{ textAlign: "center", padding: "16px 0" }}>
                      <HistoryOutlined style={{ fontSize: 24, opacity: 0.2 }} />
                      <Typography.Text type="secondary" style={{ display: "block", fontSize: 12, marginTop: 8 }}>No previous sessions</Typography.Text>
                    </div>
                  ) : (
                    <ConversationList
                      items={sessionList.map((s) => ({
                        key: s.id,
                        label: s.label,
                        icon: <RobotOutlined />,
                        description: `${s.mode.replace(/_/g, " ").toLowerCase()} · ${new Date(s.createdAt).toLocaleDateString()}`
                      }))}
                      onSelect={(key: string) => void loadSession(key)}
                      style={{ maxHeight: 320, overflow: "auto" }}
                    />
                  )}
                </div>
              }
            >
              <Button size="small" icon={<HistoryOutlined />} type="text" style={{ color: "var(--fedlify-muted)" }}>Sessions</Button>
            </Popover>
          </div>

          {/* Compact progress bar — expands to full ThoughtChain on click */}
          <button
            type="button"
            className={["fedlify-pa-progress-bar", thoughtExpanded ? "is-expanded" : ""].filter(Boolean).join(" ")}
            onClick={() => setThoughtExpanded((v) => !v)}
            title="Click to expand / collapse agent progress"
          >
            {/* Mini dots + active step label */}
            <div className="fedlify-pa-progress-dots">
              {steps.map((step) => (
                <span
                  key={step.key}
                  className={[
                    "fedlify-pa-dot",
                    step.status === "finish" ? "is-done" : step.status === "process" ? "is-active" : ""
                  ].filter(Boolean).join(" ")}
                  title={step.title as string}
                />
              ))}
            </div>
            <Typography.Text className="fedlify-pa-progress-label">
              {steps.find((s) => s.status === "process")?.title
                ?? steps.filter((s) => s.status === "finish").at(-1)?.title
                ?? "Waiting…"}
            </Typography.Text>
            <span className="fedlify-pa-progress-toggle">{thoughtExpanded ? "▲" : "▼"}</span>
          </button>

          {/* Full ThoughtChain — only when expanded */}
          {thoughtExpanded ? (
            <div className="fedlify-pa-thought-chain-full">
              <ThoughtSteps items={steps} />
            </div>
          ) : null}

          {/* Messages */}
          <div className="fedlify-pa-messages-area">
            {/* Welcome state — fresh session with no conversation yet */}
            {bubbleItems.length === 0 && !activeThinking && !starting ? (
              <WelcomeBox
                className="fedlify-pa-welcome"
                icon={<RobotOutlined />}
                title={modeParam === "adjust" ? "Ready to adjust" : "Let's build your pipeline"}
                description={
                  modeParam === "adjust"
                    ? "The existing pipeline code is loaded on the left. Describe what you'd like to change and I'll update the code."
                    : "Describe your federated learning goal — I'll generate NVFlare executor code, configs, and tests."
                }
                prompts={{
                  title: "Try asking:",
                  items: contextPrompts.slice(0, 3).map((p) => ({ key: p.key, label: p.label, description: p.description }))
                }}
                onPromptClick={(info: any) => { const text = info?.data?.description ?? info?.description ?? ""; void sendMessage(text); }}
              />
            ) : null}

            {/* Think — shows during streaming */}
            {activeThinking ? (
              <div className="fedlify-pa-think-wrapper">
                <ThinkBox
                  loading={activeThinking.streaming}
                  blink={activeThinking.streaming}
                  defaultExpanded={true}
                  title={activeThinking.streaming ? "Thinking…" : "Thought process"}
                >
                  <Typography.Text className="fedlify-pa-think-text">
                    {activeThinking.content.slice(0, 400)}{activeThinking.content.length > 400 ? "…" : ""}
                  </Typography.Text>
                </ThinkBox>
              </div>
            ) : null}

            {/* Message bubbles */}
            {bubbleItems.length > 0 ? (
              <div className="fedlify-pa-bubbles">
                <BubbleList
                  items={bubbleItems}
                  roles={{
                    user: {
                      placement: "end",
                      styles: {
                        content: {
                          background: "var(--fedlify-primary)",
                          color: "#fff",
                          borderRadius: "14px 14px 4px 14px",
                          fontSize: 13,
                          lineHeight: 1.5
                        }
                      }
                    },
                    assistant: {
                      placement: "start",
                      avatar: (
                        <div className="fedlify-pa-msg-avatar">
                          <RobotOutlined />
                        </div>
                      ),
                      styles: {
                        content: {
                          background: "#f0eefa",
                          color: "#1a1a2e",
                          borderRadius: "4px 14px 14px 14px",
                          fontSize: 13,
                          lineHeight: 1.55,
                          maxWidth: "100%"
                        }
                      }
                    }
                  }}
                />
              </div>
            ) : null}

            {/* Intake form — when fields are missing */}
            {session?.status === "INTAKE" && missing.length > 0 ? (
              <div style={{ padding: "8px 12px" }}>
                <IntakeFormCard
                  missing={missing}
                  intake={(session.intake ?? {}) as Record<string, unknown>}
                  sending={streaming}
                  onSubmit={(patch) => void sendMessage(`Here are the pipeline details: ${JSON.stringify(patch, null, 2)}\n\nPlease generate the complete NVFlare pipeline code now.`, patch)}
                />
              </div>
            ) : null}

            <div ref={chatEndRef} />
          </div>

          {/* File context chip — click to @mention current file */}
          {selectedPath ? (
            <button
              type="button"
              className="fedlify-pa-context-bar"
              onClick={() => setDraft((prev) => {
                const fname = selectedPath.split("/").pop() ?? "";
                return prev.includes(`@${fname}`) ? prev : `${prev}@${fname} `;
              })}
            >
              <FileTextOutlined />
              <Typography.Text style={{ fontSize: 11, fontWeight: 600 }}>@{selectedPath.split("/").pop()}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 10, marginLeft: "auto" }}>click to mention</Typography.Text>
            </button>
          ) : null}

          {/* Input toolbar — attach, plan mode, insert file */}
          <div className="fedlify-pa-input-toolbar">
            <Tooltip title="Attach files">
              <label className="fedlify-pa-toolbar-btn" style={{ cursor: "pointer" }}>
                <PaperClipOutlined />
                <input
                  type="file"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    setAttachments((prev) => [
                      ...prev,
                      ...files.map((f) => ({ uid: `${Date.now()}-${f.name}`, name: f.name, originFileObj: f }))
                    ]);
                    e.target.value = "";
                  }}
                />
              </label>
            </Tooltip>
            <Tooltip title={planMode ? "Plan mode on — agent shows plan before coding" : "Plan mode: agent shows a step-by-step plan first"}>
              <button
                type="button"
                className={["fedlify-pa-toolbar-btn", planMode ? "is-active" : ""].filter(Boolean).join(" ")}
                onClick={() => setPlanMode((v) => !v)}
              >
                <BulbOutlined />
                {planMode ? <span className="fedlify-pa-toolbar-label">Plan mode</span> : null}
              </button>
            </Tooltip>
            {selectedFile ? (
              <Tooltip title={`Insert ${selectedFile.path.split("/").pop()} content into message`}>
                <button
                  type="button"
                  className="fedlify-pa-toolbar-btn"
                  onClick={() => {
                    const snippet = `\n\`\`\`${languageForPath(selectedFile.path)}\n${selectedFile.content.slice(0, 2000)}${selectedFile.content.length > 2000 ? "\n…(truncated)" : ""}\n\`\`\``;
                    setDraft((prev) => prev + snippet);
                  }}
                >
                  <FileAddOutlined />
                </button>
              </Tooltip>
            ) : null}
            {/* Show attached file chips */}
            {attachments.map((a) => (
              <span key={a.uid} className="fedlify-pa-attachment-chip">
                <PaperClipOutlined />
                <span>{a.name}</span>
                <button type="button" onClick={() => setAttachments((prev) => prev.filter((x) => x.uid !== a.uid))}>
                  <CloseOutlined />
                </button>
              </span>
            ))}
          </div>

          {/* Chat input */}
          <div className="fedlify-pa-chat-input">
            <SenderBox
              value={draft}
              onChange={setDraft}
              onSubmit={(text: string) => void sendMessage(text)}
              loading={streaming}
              disabled={!session || applying}
              placeholder={
                planMode
                  ? "Describe what to build — agent will show a plan first…"
                  : streaming
                  ? "Agent is responding…"
                  : "Ask the agent or describe changes…"
              }
              submitType="enter"
              autoSize={{ minRows: 1, maxRows: 5 }}
            />
          </div>

          {/* Quick prompts — only when no active conversation yet */}
          {bubbleItems.length === 0 ? (
            <div className="fedlify-pa-quick-prompts">
              <PromptList
                items={contextPrompts}
                onItemClick={(info: any) => { const text = info?.data?.description ?? info?.description ?? ""; void sendMessage(text); }}
                wrap={false}
                styles={{ item: { fontSize: 11, padding: "5px 10px" } }}
              />
            </div>
          ) : null}
        </aside>
        </Splitter.Panel>
        ) : null}
      </Splitter>
    </AppPage>
  );
}
