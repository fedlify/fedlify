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
  PlusOutlined,
  QuestionCircleOutlined,
  RobotOutlined,
  SafetyOutlined,
  SendOutlined
} from "@ant-design/icons";
import { Bubble, Conversations, Prompts, Sender, Think, ThoughtChain, Welcome } from "@ant-design/x";
import { Alert, Badge, Button, Dropdown, Input, InputNumber, Popover, Segmented, Select, Space, Tag, Tooltip, Typography, message } from "antd";
import dynamic from "next/dynamic";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppPage, AppPageHeader } from "@/components/AppPage";
import { closePipelineAgentTab, derivePipelineAgentLayoutMode, GUIDED_QUESTIONS, nextGuidedMissingField, type GuidedAnswerOption, type GuidedIconKey, type GuidedQuestionConfig, type PipelineAgentLayoutMode } from "@/lib/pipeline-agent-guided";

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

function normalizeGeneratedFiles(raw: unknown): GeneratedFile[] {
  return Array.isArray(raw)
    ? raw
        .filter((file): file is Record<string, unknown> => typeof file === "object" && file !== null)
        .filter((file) => typeof file.path === "string" && file.content !== undefined)
        .map((file) => ({
          path: String(file.path),
          content: String(file.content ?? ""),
          ...(typeof file.proposedContent === "string" ? { proposedContent: file.proposedContent } : {})
        }))
    : [];
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

function looksLikeGeneratedCode(content: string): boolean {
  if (content.includes("```")) return true;
  const lines = content.split("\n");
  const codeSignals = lines.filter((line) => {
    const trimmed = line.trim();
    return (
      /^import\s+\w+/.test(trimmed)
      || /^from\s+\S+\s+import\s+/.test(trimmed)
      || /^class\s+\w+/.test(trimmed)
      || /^def\s+\w+\(/.test(trimmed)
      || /return\s+\w+/.test(trimmed)
      || /self\.\w+/.test(trimmed)
      || /DXO|Shareable|Executor|AppConstants|np\./.test(trimmed)
    );
  }).length;
  return lines.length >= 18 && codeSignals >= 6;
}

function conciseAssistantDisplay(content: string): string {
  if (!looksLikeGeneratedCode(content)) return content;
  const withoutCodeBlocks = content.replace(/```[\s\S]*?```/g, "").trim();
  const summaryLines = withoutCodeBlocks
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  const summary = summaryLines.join(" ");
  return [
    "Code generated.",
    "",
    summary ? `Summary: ${summary}` : "Summary: Pipeline source files are ready for review.",
    "Open the Files panel to inspect the generated code."
  ].join("\n");
}

// ─── Guided intake UI ────────────────────────────────────────────────────────

function guidedIcon(icon: GuidedIconKey): React.ReactNode {
  switch (icon) {
    case "artifacts":
      return <FileTextOutlined />;
    case "automation":
      return <RobotOutlined />;
    case "check":
      return <CheckCircleOutlined />;
    case "code":
      return <CodeOutlined />;
    case "data":
      return <DatabaseOutlined />;
    case "files":
      return <FolderOpenOutlined />;
    case "governance":
      return <SafetyOutlined />;
    case "privacy":
      return <SafetyOutlined />;
    case "runtime":
      return <CloudUploadOutlined />;
    case "workflow":
      return <LayoutOutlined />;
    case "name":
    default:
      return <FileTextOutlined />;
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

function initialDraftValue(config: GuidedQuestionConfig, intake: Record<string, unknown>): string | number | string[] | null {
  const intakeValue = intake[config.key];
  if (Array.isArray(intakeValue)) return intakeValue.map(String);
  if (typeof intakeValue === "number") return intakeValue;
  if (typeof intakeValue === "string" && intakeValue.trim()) return intakeValue;
  if (config.defaultValue !== undefined) return config.defaultValue;
  return config.input === "multiselect" ? [] : null;
}

function renderCustomAnswerInput(config: GuidedQuestionConfig, draftAnswer: string | number | string[] | null, setDraftAnswer: (value: string | number | string[]) => void) {
  if (config.input === "textarea") {
    return <Input.TextArea rows={3} value={typeof draftAnswer === "string" ? draftAnswer : ""} placeholder={config.placeholder} onChange={(event) => setDraftAnswer(event.target.value)} />;
  }
  if (config.input === "number") {
    return <InputNumber min={config.min ?? 1} precision={0} style={{ width: "100%" }} value={typeof draftAnswer === "number" ? draftAnswer : Number(draftAnswer ?? config.defaultValue ?? config.min ?? 1)} onChange={(value) => setDraftAnswer(Number(value ?? config.min ?? 1))} />;
  }
  if (config.input === "select") {
    return <Select style={{ width: "100%" }} value={typeof draftAnswer === "string" ? draftAnswer : undefined} options={config.options} placeholder={config.placeholder} onChange={(value) => setDraftAnswer(value)} />;
  }
  if (config.input === "multiselect") {
    return <Select style={{ width: "100%" }} mode="multiple" value={Array.isArray(draftAnswer) ? draftAnswer : []} options={config.options} placeholder={config.placeholder ?? "Select all that apply"} onChange={(value) => setDraftAnswer(value)} />;
  }
  return <Input value={typeof draftAnswer === "string" ? draftAnswer : ""} placeholder={config.placeholder} onChange={(event) => setDraftAnswer(event.target.value)} />;
}

function GuidedIntakeWizard({
  missing,
  intake,
  sending,
  currentField,
  completedFieldOrder,
  answerMode,
  draftAnswer,
  onAnswerModeChange,
  onDraftAnswerChange,
  onConfirm,
  onMinimize,
  onDismiss
}: {
  missing: string[];
  intake: Record<string, unknown>;
  sending: boolean;
  currentField: string | null;
  completedFieldOrder: string[];
  answerMode: "curated" | "custom";
  draftAnswer: string | number | string[] | null;
  onAnswerModeChange: (value: "curated" | "custom") => void;
  onDraftAnswerChange: (value: string | number | string[]) => void;
  onConfirm: () => void;
  onMinimize: () => void;
  onDismiss: () => void;
}) {
  if (!currentField) return null;
  const config = GUIDED_QUESTIONS[currentField];
  if (!config) return null;
  const total = completedFieldOrder.length + missing.length;
  const currentIndex = Math.min(completedFieldOrder.length + 1, Math.max(total, 1));
  const selectedCuratedOption = config.curatedOptions.find((option) => valuesEqual(option.value, draftAnswer));
  const canConfirm = Array.isArray(draftAnswer) ? draftAnswer.length > 0 : draftAnswer !== null && String(draftAnswer).trim().length > 0;
  return (
    <section className="fedlify-pa-guided-intake" data-testid="guided-intake">
      <div className="fedlify-pa-guided-intake-header">
        <div className="fedlify-pa-guided-intake-step">
          <span>{completedFieldOrder.length + 1}</span>
          <div>
            <Typography.Text strong>Understand requirements</Typography.Text>
            <Typography.Text type="secondary">{Math.max(currentIndex, 1)} of {Math.max(total, 1)} questions</Typography.Text>
          </div>
        </div>
        <div className="fedlify-pa-guided-intake-header-actions">
          <Tag bordered={false} color="purple">{missing.length} remaining</Tag>
          <div className="fedlify-pa-guided-window-actions">
            <Tooltip title="Minimize requirements">
              <button type="button" className="fedlify-pa-guided-window-btn" onClick={onMinimize} aria-label="Minimize requirements">
                <MenuFoldOutlined />
              </button>
            </Tooltip>
            <Tooltip title="Hide requirements for now">
              <button type="button" className="fedlify-pa-guided-window-btn" onClick={onDismiss} aria-label="Hide requirements">
                <CloseOutlined />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
      <div className="fedlify-pa-guided-intake-body">
        <div className="fedlify-pa-guided-intake-title-row">
          <div className="fedlify-pa-guided-intake-icon">{guidedIcon(config.icon)}</div>
          <div>
            <Typography.Title level={5}>{config.title}</Typography.Title>
            <Typography.Paragraph>{config.helper}</Typography.Paragraph>
          </div>
        </div>
        <div className="fedlify-pa-guided-intake-scroll">
          <div className="fedlify-pa-guided-options">
            {config.curatedOptions.map((option: GuidedAnswerOption) => {
              const isSelected = answerMode === "curated" && selectedCuratedOption?.id === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className={["fedlify-pa-guided-option", isSelected ? "is-selected" : ""].filter(Boolean).join(" ")}
                  onClick={() => {
                    onAnswerModeChange("curated");
                    onDraftAnswerChange(option.value);
                  }}
                >
                  <span className="fedlify-pa-guided-option-icon">{guidedIcon(option.icon)}</span>
                  <span className="fedlify-pa-guided-option-copy">
                    <strong>{option.label}</strong>
                    <span>{option.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {config.allowCustom ? (
            <div className="fedlify-pa-guided-custom">
              <button type="button" className={["fedlify-pa-guided-custom-toggle", answerMode === "custom" ? "is-active" : ""].filter(Boolean).join(" ")} onClick={() => {
                onAnswerModeChange("custom");
                onDraftAnswerChange(initialDraftValue(config, intake) ?? "");
              }}>
                Use a custom answer
              </button>
              {answerMode === "custom" ? (
                <div className="fedlify-pa-guided-custom-input">
                  {renderCustomAnswerInput(config, draftAnswer, onDraftAnswerChange)}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="fedlify-pa-guided-actions">
          {answerMode === "custom" ? (
            <Button onClick={() => {
              onAnswerModeChange("curated");
              onDraftAnswerChange(initialDraftValue(config, intake) ?? "");
            }}>
              Back
            </Button>
          ) : <span />}
          <Button type="primary" className="fedlify-dark-action" icon={<SendOutlined />} loading={sending} disabled={!canConfirm || sending} onClick={onConfirm}>
            Confirm answer
          </Button>
        </div>
      </div>
    </section>
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
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [layoutMode, setLayoutMode] = useState<PipelineAgentLayoutMode>("chat-focus");
  const [thoughtExpanded, setThoughtExpanded] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [attachments, setAttachments] = useState<Array<{ uid: string; name: string; status?: string; url?: string; originFileObj?: File }>>([]);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [sessionsPopover, setSessionsPopover] = useState(false);
  const [sessionList, setSessionList] = useState<Array<{ id: string; label: string; mode: string; status: string; createdAt: string }>>([]);

  // ── Session / chat state ──────────────────────────────────────────────────
  const [session, setSession] = useState<Session | null>(null);
  const [sessionMissing, setSessionMissing] = useState<string[]>([]);
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
  const [currentMissingField, setCurrentMissingField] = useState<string | null>(null);
  const [answerMode, setAnswerMode] = useState<"curated" | "custom">("curated");
  const [draftAnswer, setDraftAnswer] = useState<string | number | string[] | null>(null);
  const [completedFieldOrder, setCompletedFieldOrder] = useState<string[]>([]);
  const [savingIntake, setSavingIntake] = useState(false);
  const [intakePopupDismissed, setIntakePopupDismissed] = useState(false);
  const [intakePopupMinimized, setIntakePopupMinimized] = useState(false);
  const streamingContentRef = useRef("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);

  // ── Derived ───────────────────────────────────────────────────────────────
  const missing = sessionMissing;
  const selectedFile = useMemo(() => files.find((f) => f.path === selectedPath) ?? null, [files, selectedPath]);
  const tree = useMemo(() => buildFileTree(files), [files]);
  const intakeComplete = session?.status === "CODING" || session?.status === "DRAFT_READY";
  const canCreatePR = session && session.status !== "APPLIED" && (intakeComplete || validation?.status === "PASSED" || files.length > 0);
  const unresolvedMissing = useMemo(() => missing.filter((label) => label in GUIDED_QUESTIONS), [missing]);

  // ── Helpers ───────────────────────────────────────────────────────────────

  function normalizeMessages(raw: unknown): ChatMessage[] {
    return Array.isArray(raw)
      ? raw.filter((m): m is Record<string, unknown> => typeof m === "object" && m != null && "content" in m)
           .map((m) => {
             const role = m.role === "user" ? "user" : ("assistant" as const);
             const rawContent = String(m.content ?? "");
             return {
               role,
               content: role === "assistant" ? conciseAssistantDisplay(rawContent) : rawContent,
               createdAt: typeof m.createdAt === "string" ? m.createdAt : undefined,
               missing: Array.isArray(m.missing) ? (m.missing as string[]) : undefined
             };
           })
      : [];
  }

  function normalizeMissing(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string");
    return [];
  }

  function addAssistantMessage(content: string, extra?: Partial<ChatMessage>) {
    setMessages((prev) => [...prev, { role: "assistant", content, ...extra }]);
  }

  const showFiles = useCallback((nextFiles: GeneratedFile[]) => {
    setFiles(nextFiles);
    setOpenTabs((prev) => {
      const nextOpenTabs = prev.filter((path) => nextFiles.some((file) => file.path === path));
      return nextOpenTabs;
    });
    setSelectedPath((prev) => (prev && nextFiles.find((file) => file.path === prev) ? prev : null));
  }, []);

  const syncFilesFromSession = useCallback((sess: Session) => {
    const sessionFiles = normalizeGeneratedFiles(sess.generatedFiles);
    if (sessionFiles.length > 0) {
      showFiles(sessionFiles);
    }
  }, [showFiles]);

  const loadSourceFilesForSession = useCallback(async (sess: Session): Promise<boolean> => {
    if (normalizeGeneratedFiles(sess.generatedFiles).length > 0) return true;
    if (modeParam !== "adjust" && modeParam !== "from-template" && sess.mode !== "FROM_STUDY_TEMPLATE") return false;

    let sourceFiles: GeneratedFile[] = [];
    const sourceTemplateId = typeof sess.templateId === "string" ? sess.templateId : templateId;
    if (sourceTemplateId) {
      const response = await fetch(`/api/v1/pipeline-templates/${encodeURIComponent(sourceTemplateId)}/source?ref=current`, { cache: "no-store" }).catch(() => null);
      if (response?.ok) {
        const body = await response.json().catch(() => null);
        sourceFiles = normalizeGeneratedFiles(body?.files);
      }
    }

    if (sourceFiles.length === 0 && studyId) {
      const response = await fetch(`/api/v1/studies/${studyId}/pipeline-version-source`, { cache: "no-store" }).catch(() => null);
      if (response?.ok) {
        const body = await response.json().catch(() => null);
        sourceFiles = normalizeGeneratedFiles(body?.files);
      }
    }

    if (sourceFiles.length === 0) return false;
    showFiles(sourceFiles);
    return true;
  }, [modeParam, showFiles, studyId, templateId]);

  function openFileTab(path: string) {
    setWorkspaceOpen(true);
    setExplorerOpen(true);
    setSelectedPath(path);
    setOpenTabs((prev) => prev.includes(path) ? prev : [...prev, path].slice(0, 8));
  }

  function toggleWorkspace(open?: boolean) {
    const nextOpen = open ?? !workspaceOpen;
    setWorkspaceOpen(nextOpen);
    setExplorerOpen(nextOpen ? true : false);
  }

  function closeTab(path: string, e: React.MouseEvent) {
    e.stopPropagation();
    const nextState = closePipelineAgentTab({ openTabs, selectedPath, path });
    setOpenTabs(nextState.openTabs);
    setSelectedPath(nextState.selectedPath);
    setExplorerOpen(nextState.explorerOpen);
    setWorkspaceOpen(nextState.workspaceOpen);
    setLayoutMode(nextState.layoutMode);
  }

  // Auto-scroll chat
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, streaming]);

  useEffect(() => {
    setLayoutMode(derivePipelineAgentLayoutMode({ explorerOpen, openTabs }));
  }, [explorerOpen, openTabs]);

  useEffect(() => {
    const nextField = nextGuidedMissingField(unresolvedMissing, completedFieldOrder);
    setCurrentMissingField(nextField);
    if (!nextField) {
      setAnswerMode("curated");
      setDraftAnswer(null);
      return;
    }
    const config = GUIDED_QUESTIONS[nextField];
    const initialValue = initialDraftValue(config, (session?.intake ?? {}) as Record<string, unknown>);
    const matchingCuratedOption = config.curatedOptions.find((option) => valuesEqual(option.value, initialValue));
    setAnswerMode(matchingCuratedOption ? "curated" : "custom");
    setDraftAnswer(initialValue);
  }, [completedFieldOrder, session?.intake, unresolvedMissing]);

  useEffect(() => {
    setCompletedFieldOrder([]);
    setCurrentMissingField(null);
    setAnswerMode("curated");
    setDraftAnswer(null);
    setSavingIntake(false);
    setIntakePopupDismissed(false);
    setIntakePopupMinimized(false);
  }, [session?.id]);

  useEffect(() => {
    if (planMode && unresolvedMissing.length > 0) {
      setIntakePopupDismissed(false);
      setIntakePopupMinimized(false);
    }
  }, [planMode, unresolvedMissing.length]);

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
          setSessionMissing(normalizeMissing(d?.missing ?? [...normalizeMessages(d.session?.messages)].reverse().find((m) => m.role === "assistant")?.missing));
          setMessages(normalizeMessages(d.session?.messages));
          syncFilesFromSession(d.session);
          await loadSourceFilesForSession(d.session);
          return;
        }
      }
      const body: Record<string, unknown> = { mode: sessionMode, studyId };
      if (templateId) body.templateId = templateId;
      const response = await fetch("/api/v1/template-agent-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error?.message ?? "Could not start session.");
      setSession(data.session);
      setSessionMissing(normalizeMissing(data?.missing));
      setMessages(normalizeMessages(data.session?.messages));
      syncFilesFromSession(data.session);
      if (data.session?.id) {
        const url = new URL(window.location.href);
        url.searchParams.set("sessionId", data.session.id);
        window.history.replaceState({}, "", url.toString());
      }
      await loadSourceFilesForSession(data.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start session.");
    } finally {
      setStarting(false);
    }
  }, [loadSourceFilesForSession, resumeSessionId, session, sessionMode, starting, studyId, syncFilesFromSession, templateId]);

  useEffect(() => { void startSession(); }, [startSession]);

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
    setSessionMissing(normalizeMissing(d?.missing ?? [...normalizeMessages(d.session?.messages)].reverse().find((m) => m.role === "assistant")?.missing));
    setMessages(normalizeMessages(d.session?.messages));
    setFiles([]);
    setOpenTabs([]);
    setSelectedPath(null);
    setWorkspaceOpen(false);
    setExplorerOpen(false);
    syncFilesFromSession(d.session);
    const url = new URL(window.location.href);
    url.searchParams.set("sessionId", sessionId);
    window.history.replaceState({}, "", url.toString());
  }

  async function saveGuidedIntakeAnswer() {
    if (!session || !currentMissingField || draftAnswer == null || savingIntake) return;
    const question = GUIDED_QUESTIONS[currentMissingField];
    if (!question) return;

    const completedField = currentMissingField;
    const patch = { [question.key]: draftAnswer };
    setSavingIntake(true);
    setError(null);
    setCompletedFieldOrder((previous) => (previous.includes(completedField) ? previous : [...previous, completedField]));

    try {
      const response = await fetch(`/api/v1/template-agent-sessions/${session.id}/intake`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intakePatch: patch })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error?.message ?? "Could not save requirement.");
      setSession(data.session);
      const nextMissing = normalizeMissing(data?.missing);
      setSessionMissing(nextMissing);
      if (nextMissing.length === 0) {
        addAssistantMessage(
          [
            "Requirements captured.",
            "",
            "I can prepare a short plan next, then generate the pipeline files when you confirm.",
            "When code is generated, it will appear in the Files panel instead of being pasted into chat."
          ].join("\n")
        );
        setIntakePopupDismissed(false);
        setIntakePopupMinimized(false);
      }
    } catch (err) {
      setCompletedFieldOrder((previous) => previous.filter((label) => label !== completedField));
      setError(err instanceof Error ? err.message : "Could not save requirement.");
    } finally {
      setSavingIntake(false);
    }
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
      const displayContent = conciseAssistantDisplay(fullContent);
      setMessages((prev) => {
        const updated = [...prev];
        const thinkIdx = updated.map((m) => m.role === "thinking").lastIndexOf(true);
        if (thinkIdx >= 0) updated[thinkIdx] = { role: "thinking", content: displayContent, streaming: false };
        return [...updated, { role: "assistant", content: displayContent, missing: newMissing }];
      });
      if (newMissing !== undefined) setSessionMissing(newMissing);
      setSession((prev) => {
        if (!prev) return prev;
        const nextIntake = intakePatch ? { ...(prev.intake ?? {}), ...intakePatch } : prev.intake;
        return {
          ...prev,
          intake: nextIntake,
          status: newMissing !== undefined ? (newMissing.length > 0 ? "INTAKE" : "CODING") : prev.status
        };
      });
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
        setSessionMissing(normalizeMissing(data?.missing));
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
      const generatedFiles = normalizeGeneratedFiles(data.session?.generatedFiles);
      const preferredFile = generatedFiles.find((file) => file.path.endsWith("executor.py")) ?? generatedFiles[0] ?? null;
      setWorkspaceOpen(generatedFiles.length > 0);
      setExplorerOpen(generatedFiles.length > 0);
      if (preferredFile) {
        setSelectedPath(preferredFile.path);
        setOpenTabs([preferredFile.path]);
      }
      addAssistantMessage(
        [
          "Code generated successfully.",
          "",
          `Summary: ${data.session?.resultSummary ?? `${generatedFiles.length} files are ready.`}`,
          "Open the Files panel to inspect the generated pipeline code."
        ].join("\n")
      );
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

  const modeTitle = modeParam === "adjust" ? "Customize Pipeline" : modeParam === "from-template" ? "Pipeline from Template" : "Develop Pipeline";
  const contextPrompts = promptsForFile(selectedPath);
  const steps = thoughtItems(session, missing, files, validation, streaming);
  const intakePopupVisible = planMode && unresolvedMissing.length > 0 && !intakePopupDismissed && !intakePopupMinimized;
  const showContinueRequirements = planMode && unresolvedMissing.length > 0 && !intakePopupVisible;

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
          <Space size="small">
            <RobotOutlined />
            <span>{modeTitle}</span>
            {starting ? <LoadingOutlined style={{ fontSize: 14 }} /> : null}
          </Space>
        }
        backLabel={studyId ? "Back to study" : "Back to templates"}
        onBack={() => studyId ? router.push(`/studies/${studyId}?section=pipeline`) : router.push("/templates")}
        actions={
          <Space size="small">
            <button
              type="button"
              className="fedlify-pa-header-progress"
              onClick={() => setThoughtExpanded((v) => !v)}
              title="Show agent progress"
            >
              <div className="fedlify-pa-progress-dots">
                {steps.map((step) => (
                  <span
                    key={step.key}
                    className={[
                      "fedlify-pa-dot",
                      step.status === "finish" ? "is-done" : step.status === "process" ? "is-active" : ""
                    ].filter(Boolean).join(" ")}
                  />
                ))}
              </div>
              <span>{steps.find((s) => s.status === "process")?.title ?? steps.filter((s) => s.status === "finish").at(-1)?.title ?? "Waiting"}</span>
            </button>
            <div className="fedlify-pa-header-chip">
              {streaming ? <LoadingOutlined /> : <RobotOutlined />}
              <span>AI assistant</span>
              <Typography.Text type="secondary">{streaming ? "Thinking…" : session ? "Ready" : "Starting…"}</Typography.Text>
            </div>
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
            <Tooltip title={workspaceOpen ? "Hide files and editor" : "Open files and editor"}>
              <Button
                size="small"
                icon={explorerOpen ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
                onClick={() => toggleWorkspace()}
              >
                Files
              </Button>
            </Tooltip>
          </Space>
        }
      />

      {error ? <Alert type="error" showIcon closable message={error} onClose={() => setError(null)} style={{ marginBottom: 8 }} /> : null}

      <div className={["fedlify-pa-layout", `is-${layoutMode}`, workspaceOpen ? "workspace-open" : "workspace-hidden", explorerOpen ? "explorer-open" : ""].filter(Boolean).join(" ")}>
        {workspaceOpen && explorerOpen ? (
          <aside className="fedlify-pa-explorer" data-testid="pipeline-files">
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
        ) : null}

        {workspaceOpen ? (
        <main className="fedlify-pa-editor-area fedlify-pa-code-panel" data-testid="pipeline-code-panel">
          <div className="fedlify-pa-tabs">
            {openTabs.length === 0 ? (
              <div className="fedlify-pa-tabs-empty">
                <CodeOutlined style={{ opacity: 0.3 }} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Files stay closed until you open one.
                </Typography.Text>
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
                    <CloseOutlined className="fedlify-pa-tab-close" onClick={(event) => closeTab(path, event)} />
                  </button>
                );
              })
            )}
          </div>

          <div className="fedlify-pa-editor">
            {selectedFile ? (
              editorMode === "diff" && selectedFile.proposedContent ? (
                <MonacoDiffEditor height="100%" language={languageForPath(selectedFile.path)} original={selectedFile.content} modified={selectedFile.proposedContent} theme="vs-dark" options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12 }} />
              ) : (
                <MonacoEditor height="100%" language={languageForPath(selectedFile.path)} value={selectedFile.content} theme="vs-dark" options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12, wordWrap: "on" }} />
              )
            ) : (
              <div className="fedlify-pa-editor-empty">
                <div className="fedlify-pa-editor-empty-shell">
                  <div className="fedlify-pa-editor-empty-icon">
                    <FolderOpenOutlined />
                  </div>
                  <div className="fedlify-pa-editor-empty-copy">
                    <Typography.Text strong>Open files when you need source context</Typography.Text>
                    <Typography.Text type="secondary">
                      {files.length > 0
                        ? "Keep the chat in focus until you choose a file."
                        : intakeComplete
                        ? "Generated files will appear here. Open the explorer whenever you want to inspect them."
                        : planMode
                        ? "Plan mode will gather the missing requirements before code generation."
                        : "Chat first. Open files when you need source context or when generated code is ready."}
                    </Typography.Text>
                  </div>
                  <Button size="small" onClick={() => toggleWorkspace(true)}>Open files</Button>
                </div>
              </div>
            )}
          </div>

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
                  <Segmented size="small" value={editorMode} onChange={(value) => setEditorMode(value as EditorMode)} options={[{ value: "source", label: <><FileTextOutlined /> Source</> }, { value: "diff", label: <><DiffOutlined /> Diff</> }]} />
                ) : null}
                {files.length > 0 ? (
                  <Button size="small" icon={<CheckCircleOutlined />} loading={validating} onClick={() => void validateFiles()}>Validate</Button>
                ) : null}
                {validation ? (
                  <Tag color={validation.status === "PASSED" ? "success" : "warning"}>{validation.status === "PASSED" ? "Validation passed" : "Validation issues"}</Tag>
                ) : null}
                <Tooltip title={session?.status === "INTAKE" ? (planMode ? "Continue requirements in plan mode before generating" : "Keep chatting or enable plan mode to gather requirements") : intakeComplete && files.length === 0 ? "Build NVFlare files and push to Gitea" : "Push generated files to Gitea"}>
                  <Button type="primary" className="fedlify-dark-action" size="small" icon={applying ? <LoadingOutlined /> : <GithubOutlined />} loading={applying} disabled={!session || !canCreatePR || streaming} onClick={() => void createPR()}>
                    {intakeComplete && files.length === 0 ? "Generate & push to Gitea" : "Create PR"}
                  </Button>
                </Tooltip>
              </Space>
            )}
          </div>
        </main>
        ) : null}

        <aside className="fedlify-pa-chat-sidebar fedlify-pa-chat-panel" data-testid="pipeline-chat-panel">
          {/* Full ThoughtChain — only when expanded */}
          {thoughtExpanded ? (
            <div className="fedlify-pa-thought-chain-full">
              <ThoughtSteps items={steps} />
            </div>
          ) : null}

          {/* Messages */}
          <div className="fedlify-pa-messages-area fedlify-pa-messages">
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
                          background: "#f6f7f9",
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

          {intakePopupVisible ? (
            <div className="fedlify-pa-intake-popup" data-testid="guided-intake-modal">
              <GuidedIntakeWizard
                missing={unresolvedMissing}
                intake={(session?.intake ?? {}) as Record<string, unknown>}
                sending={savingIntake}
                currentField={currentMissingField}
                completedFieldOrder={completedFieldOrder}
                answerMode={answerMode}
                draftAnswer={draftAnswer}
                onAnswerModeChange={setAnswerMode}
                onDraftAnswerChange={setDraftAnswer}
                onConfirm={() => void saveGuidedIntakeAnswer()}
                onMinimize={() => setIntakePopupMinimized(true)}
                onDismiss={() => setIntakePopupDismissed(true)}
              />
            </div>
          ) : null}

          {showContinueRequirements ? (
            <div className="fedlify-pa-intake-resume-row">
              <button
                type="button"
                className="fedlify-pa-intake-resume"
                onClick={() => {
                  setIntakePopupDismissed(false);
                  setIntakePopupMinimized(false);
                }}
              >
                <BulbOutlined />
                <span>Continue requirements</span>
                <Tag bordered={false} color="purple">{unresolvedMissing.length} remaining</Tag>
              </button>
            </div>
          ) : null}

          {/* Chat input */}
          <div className="fedlify-pa-chat-input">
            <div className="fedlify-pa-composer-shell">
              <input
                ref={attachmentInputRef}
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
              {attachments.length > 0 ? (
                <div className="fedlify-pa-composer-attachments">
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
              ) : null}
              <Dropdown
                trigger={["click"]}
                placement="topLeft"
                menu={{
                  items: [
                    { key: "attach", icon: <PaperClipOutlined />, label: "Attach files" },
                    {
                      key: "intake-or-plan",
                      icon: <BulbOutlined />,
                      label: unresolvedMissing.length > 0
                        ? (planMode ? "Continue intake" : "Open intake")
                        : (planMode ? "Turn plan mode off" : "Turn plan mode on")
                    },
                    { key: "files", icon: <FolderOpenOutlined />, label: workspaceOpen ? "Hide files" : "Show files" },
                    ...(selectedFile
                      ? [{ key: "insert-file", icon: <FileAddOutlined />, label: `Insert ${selectedFile.path.split("/").pop()}` }]
                      : [])
                  ],
                  onClick: ({ key }) => {
                    if (key === "attach") attachmentInputRef.current?.click();
                    if (key === "intake-or-plan") {
                      if (unresolvedMissing.length > 0) {
                        setPlanMode(true);
                        setIntakePopupDismissed(false);
                        setIntakePopupMinimized(false);
                      } else {
                        setPlanMode((current) => !current);
                      }
                    }
                    if (key === "files") toggleWorkspace();
                    if (key === "insert-file" && selectedFile) {
                      const snippet = `\n\`\`\`${languageForPath(selectedFile.path)}\n${selectedFile.content.slice(0, 2000)}${selectedFile.content.length > 2000 ? "\n…(truncated)" : ""}\n\`\`\``;
                      setDraft((prev) => prev + snippet);
                    }
                  }
                }}
              >
                <button
                  type="button"
                  className={["fedlify-pa-composer-prefix", planMode ? "is-active" : ""].filter(Boolean).join(" ")}
                  aria-label="Composer tools"
                >
                  <PlusOutlined />
                </button>
              </Dropdown>
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
      </div>
    </AppPage>
  );
}
