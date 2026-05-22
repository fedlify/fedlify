"use client";

import {
  CheckCircleOutlined,
  CodeOutlined,
  DiffOutlined,
  DownOutlined,
  FileTextOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  GithubOutlined,
  InfoCircleOutlined,
  LayoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ReloadOutlined,
  RightOutlined,
  RobotOutlined
} from "@ant-design/icons";
import { Bubble, Prompts, Sender, ThoughtChain } from "@ant-design/x";
import { Alert, Button, Segmented, Select, Space, Tag, Tooltip, Typography, message } from "antd";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import type { Monaco } from "@monaco-editor/react";
import { FieldGrid, FieldRow } from "@/components/EntityDetail";
import { InlineLoadError } from "@/components/LoadStates";
import { StatusTag } from "@/components/StatusTag";

const FEDLIFY_EDITOR_THEME = "fedlify-vs-dark";
const NVFLARE_CONFIG_LANGUAGE = "nvflare-conf";
const REVIEW_LAYOUT_STORAGE_KEY = "fedlify.codeReview.layout";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => <div className="fedlify-editor-loading">Loading editor...</div>
});

const MonacoDiffEditor = dynamic(() => import("@monaco-editor/react").then((mod) => mod.DiffEditor), {
  ssr: false,
  loading: () => <div className="fedlify-editor-loading">Loading diff...</div>
});

const BubbleList = Bubble.List as any;
const PromptList = Prompts as any;
const SenderBox = Sender as any;
const ThoughtSteps = ThoughtChain as any;

export type SourceFile = {
  path: string;
  content: string;
  language: string;
};

type SourcePayload = {
  ref?: string;
  gitRef?: string | null;
  commit?: string | null;
  branchName?: string | null;
  repoUrl?: string | null;
  branchUrl?: string | null;
  pullRequestUrl?: string | null;
  source?: string;
  files?: SourceFile[];
};

type ReviewMessage = {
  role: "user" | "assistant";
  content: string;
};

type ReviewChangedFile = {
  path: string;
  originalContent: string;
  proposedContent: string;
  reason: string;
};

type ReviewValidation = {
  status: "PASSED" | "FAILED" | string;
  summary: string;
  errors?: string[];
};

type SourceTreeNode = {
  type: "folder" | "file";
  name: string;
  path: string;
  children?: SourceTreeNode[];
  file?: SourceFile;
};

type EditorMode = "source" | "diff" | "proposed";
type ExplorerView = "files" | "changes";

type CodeReviewPanelProps = {
  sourceUrl: string;
  reviewTemplateId?: string;
  sourceRef?: string;
  title?: string;
  description?: string;
  reloadKey?: string | number;
  emptyMessage?: string;
  requestChangeLabel?: string;
  requestChangeDescription?: string;
  savingDraft?: boolean;
  onRequestChange?: (file: SourceFile, context?: { instruction?: string; mode?: "assistant_request" }) => void;
  onSaveDraft?: (file: SourceFile, content: string) => void;
  onReviewApplied?: (proposalId: string) => void;
};

function shortCommit(value?: string | null) {
  return value ? value.slice(0, 12) : "Not set";
}

function compactLabel(value?: string | null, maxLength = 26) {
  if (!value) return "Not set";
  if (value.length <= maxLength) return value;
  const separator = value.indexOf(":");
  if (separator > 0 && separator < 14) {
    const prefix = value.slice(0, separator + 1);
    const rest = value.slice(separator + 1);
    return `${prefix}${rest.slice(0, Math.max(6, maxLength - prefix.length - 3))}...`;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

function apiErrorMessage(body: any, fallback: string) {
  const message = body?.error?.message ?? body?.message ?? (typeof body?.error === "string" ? body.error : null) ?? fallback;
  const code = body?.error?.code ?? body?.code;
  if (code && typeof message === "string" && !message.includes(String(code))) return `${message} (${code})`;
  return String(message);
}

function preferredInitialFile(files: SourceFile[]) {
  return (
    files.find((file) => file.path.toLowerCase() === "readme.md") ??
    files.find((file) => file.path === ".fedlify/template.json") ??
    files.find((file) => file.path.toLowerCase() === "agents.md") ??
    files[0]
  );
}

function parseManifest(files: SourceFile[]) {
  const manifest = files.find((file) => file.path === ".fedlify/template.json" || file.path === "fedlify-pipeline.json");
  if (!manifest) return null;
  try {
    return JSON.parse(manifest.content) as Record<string, any>;
  } catch {
    return null;
  }
}

function configureMonaco(monaco: Monaco) {
  monaco.editor.defineTheme(FEDLIFY_EDITOR_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment.nvflare", foreground: "6A9955" },
      { token: "constant.nvflare", foreground: "4FC1FF" },
      { token: "delimiter.nvflare", foreground: "D4D4D4" },
      { token: "identifier.nvflare", foreground: "DCDCAA" },
      { token: "key.nvflare", foreground: "9CDCFE" },
      { token: "keyword.nvflare", foreground: "C586C0" },
      { token: "number.nvflare", foreground: "B5CEA8" },
      { token: "operator.nvflare", foreground: "D4D4D4" },
      { token: "string.nvflare", foreground: "CE9178" },
      { token: "tag.nvflare", foreground: "4EC9B0" },
      { token: "type.identifier.nvflare", foreground: "4EC9B0" }
    ],
    colors: {
      "editor.background": "#101828",
      "editorGutter.background": "#101828",
      "editorLineNumber.foreground": "#64748b",
      "editorLineNumber.activeForeground": "#cbd5e1"
    }
  });

  if (monaco.languages.getLanguages().some((language: { id: string }) => language.id === NVFLARE_CONFIG_LANGUAGE)) return;

  monaco.languages.register({
    id: NVFLARE_CONFIG_LANGUAGE,
    aliases: ["NVFLARE config", "nvflare-conf"],
    extensions: [".conf"]
  });
  monaco.languages.setLanguageConfiguration(NVFLARE_CONFIG_LANGUAGE, {
    comments: { lineComment: "#" },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"]
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"" }
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"" }
    ]
  });
  monaco.languages.setMonarchTokensProvider(NVFLARE_CONFIG_LANGUAGE, {
    defaultToken: "",
    tokenPostfix: ".nvflare",
    keywords: [
      "args",
      "components",
      "deploy_map",
      "executors",
      "filters",
      "id",
      "mandatory_clients",
      "min_clients",
      "name",
      "path",
      "resource_spec",
      "tasks",
      "workflows"
    ],
    constants: ["ALL", "DXO", "METRICS", "MODEL", "None", "WEIGHTS", "false", "null", "true"],
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/"/, "string", "@string"],
        [/[{}[\](),]/, "delimiter"],
        [/[A-Za-z_][\w-]*(?=\s*=)/, "key"],
        [/@[A-Z_]+/, "tag"],
        [/[A-Za-z_][\w.]*\.[\w.]+/, "type.identifier"],
        [/\b\d+(\.\d+)?\b/, "number"],
        [/=/, "operator"],
        [
          /[A-Za-z_][\w-]*/,
          {
            cases: {
              "@constants": "constant",
              "@keywords": "keyword",
              "@default": "identifier"
            }
          }
        ],
        [/\s+/, "white"]
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, "string", "@pop"]
      ]
    }
  });
}

function sortTree(nodes: SourceTreeNode[]) {
  nodes.sort((first, second) => {
    if (first.type !== second.type) return first.type === "folder" ? -1 : 1;
    return first.name.localeCompare(second.name);
  });
  nodes.forEach((node) => {
    if (node.children) sortTree(node.children);
  });
}

function buildSourceTree(files: SourceFile[]) {
  const root: SourceTreeNode = { type: "folder", name: "", path: "", children: [] };

  files.forEach((file) => {
    const parts = file.path.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";

    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1;
      if (isFile) {
        current.children?.push({ type: "file", name: part, path: file.path, file });
        return;
      }

      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let folder = current.children?.find((node) => node.type === "folder" && node.path === currentPath);
      if (!folder) {
        folder = { type: "folder", name: part, path: currentPath, children: [] };
        current.children?.push(folder);
      }
      current = folder;
    });
  });

  const nodes = root.children ?? [];
  sortTree(nodes);
  return nodes;
}

function monacoLanguage(language?: string) {
  switch ((language ?? "").toLowerCase()) {
    case "dockerfile":
      return "dockerfile";
    case "javascript":
    case "js":
      return "javascript";
    case "json":
      return "json";
    case "config":
    case "conf":
      return NVFLARE_CONFIG_LANGUAGE;
    case "markdown":
    case "md":
      return "markdown";
    case "python":
    case "py":
      return "python";
    case "shell":
    case "bash":
    case "sh":
      return "shell";
    case "typescript":
    case "ts":
      return "typescript";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return "plaintext";
  }
}

function normalizeReviewMessages(value: unknown): ReviewMessage[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item != null && typeof item.content === "string")
        .map((item) => ({
          role: item.role === "user" ? "user" : "assistant",
          content: String(item.content)
        }))
    : [];
}

function changedFileLanguage(change: ReviewChangedFile, files: SourceFile[]) {
  return files.find((file) => file.path === change.path)?.language ?? change.path.split(".").pop() ?? "text";
}

export function CodeReviewPanel({
  sourceUrl,
  reviewTemplateId,
  sourceRef,
  title = "Code review",
  description,
  reloadKey,
  emptyMessage,
  requestChangeLabel = "Review with Codex",
  requestChangeDescription,
  savingDraft,
  onRequestChange,
  onSaveDraft,
  onReviewApplied
}: CodeReviewPanelProps) {
  const [payload, setPayload] = useState<SourcePayload | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [editMode, setEditMode] = useState(false);
  const [draftContent, setDraftContent] = useState("");
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(null);
  const [reviewMessages, setReviewMessages] = useState<ReviewMessage[]>([]);
  const [assistantDraft, setAssistantDraft] = useState("");
  const [startingReview, setStartingReview] = useState(false);
  const [sendingReview, setSendingReview] = useState(false);
  const [validatingReview, setValidatingReview] = useState(false);
  const [applyingReview, setApplyingReview] = useState(false);
  const [changedFiles, setChangedFiles] = useState<ReviewChangedFile[]>([]);
  const [selectedChangePath, setSelectedChangePath] = useState<string | null>(null);
  const [validation, setValidation] = useState<ReviewValidation | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);
  const [draftPrUrl, setDraftPrUrl] = useState<string | null>(null);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [expandedEditor, setExpandedEditor] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>("source");
  const [explorerView, setExplorerView] = useState<ExplorerView>("files");
  const [layoutLoaded, setLayoutLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(sourceUrl, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, "Source code could not be loaded."));
      const files = body?.files ?? [];
      setPayload({ ...body, files });
      setSelectedPath(preferredInitialFile(files)?.path ?? null);
      setCollapsedFolders(new Set());
    } catch (loadError) {
      setPayload(null);
      setSelectedPath(null);
      setError(loadError instanceof Error ? loadError.message : "Source code could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUrl, reloadKey]);

  const files = useMemo(() => payload?.files ?? [], [payload]);
  const selectedFile = files.find((file) => file.path === selectedPath) ?? preferredInitialFile(files);
  const manifest = useMemo(() => parseManifest(files), [files]);
  const sourceTree = useMemo(() => buildSourceTree(files), [files]);
  const isModified = Boolean(selectedFile && draftContent !== selectedFile.content);
  const reviewEnabled = Boolean(reviewTemplateId);
  const selectedChange = changedFiles.find((file) => file.path === selectedChangePath) ?? changedFiles[0];
  const activeEditorMode: EditorMode = selectedChange ? editorMode : "source";
  const displayedPath = activeEditorMode === "source" ? selectedFile?.path : selectedChange?.path;
  const displayedLanguage = activeEditorMode === "source" ? selectedFile?.language : selectedChange ? changedFileLanguage(selectedChange, files) : selectedFile?.language;
  const reviewRef = payload?.ref ?? sourceRef ?? "current";
  const reviewCommit = payload?.commit ?? payload?.gitRef;
  const shellClassName = [
    "fedlify-code-review-shell",
    explorerOpen && !expandedEditor ? "has-explorer" : "is-explorer-hidden",
    assistantOpen && reviewEnabled && !expandedEditor ? "has-assistant" : "is-assistant-hidden",
    expandedEditor ? "is-expanded" : ""
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(REVIEW_LAYOUT_STORAGE_KEY);
      if (saved) {
        const layout = JSON.parse(saved) as Partial<{
          explorerOpen: boolean;
          assistantOpen: boolean;
          expandedEditor: boolean;
          contextOpen: boolean;
          editorMode: EditorMode;
          explorerView: ExplorerView;
        }>;
        if (typeof layout.explorerOpen === "boolean") setExplorerOpen(layout.explorerOpen);
        if (typeof layout.assistantOpen === "boolean") setAssistantOpen(layout.assistantOpen);
        if (typeof layout.expandedEditor === "boolean") setExpandedEditor(layout.expandedEditor);
        if (typeof layout.contextOpen === "boolean") setContextOpen(layout.contextOpen);
        if (layout.editorMode === "source" || layout.editorMode === "diff" || layout.editorMode === "proposed") setEditorMode(layout.editorMode);
        if (layout.explorerView === "files" || layout.explorerView === "changes") setExplorerView(layout.explorerView);
      }
    } catch {
      // Browser storage is optional; layout still works with defaults.
    } finally {
      setLayoutLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!layoutLoaded) return;
    try {
      localStorage.setItem(
        REVIEW_LAYOUT_STORAGE_KEY,
        JSON.stringify({ explorerOpen, assistantOpen, expandedEditor, contextOpen, editorMode, explorerView })
      );
    } catch {
      // Ignore unavailable storage.
    }
  }, [assistantOpen, contextOpen, editorMode, expandedEditor, explorerOpen, explorerView, layoutLoaded]);

  useEffect(() => {
    setEditMode(false);
    setDraftContent(selectedFile?.content ?? "");
  }, [selectedFile?.path, selectedFile?.content]);

  useEffect(() => {
    setReviewSessionId(null);
    setReviewMessages([]);
    setAssistantDraft("");
    setChangedFiles([]);
    setSelectedChangePath(null);
    setValidation(null);
    setReviewError(null);
    setAiConfigured(null);
    setDraftPrUrl(null);
    setEditorMode("source");
    setExplorerView("files");
  }, [sourceUrl, reloadKey]);

  function toggleFolder(path: string) {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function ensureReviewSession() {
    if (!reviewTemplateId) return null;
    if (reviewSessionId) return reviewSessionId;
    setStartingReview(true);
    setReviewError(null);
    try {
      const response = await fetch(`/api/v1/pipeline-templates/${reviewTemplateId}/review-sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceRef: reviewRef, selectedPath: selectedFile?.path })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, "Code review session could not be started."));
      setReviewSessionId(body.session?.id ?? null);
      setReviewMessages(normalizeReviewMessages(body.session?.messages));
      setAiConfigured(Boolean(body.aiConfigured));
      return body.session?.id ?? null;
    } catch (startError) {
      setReviewError(startError instanceof Error ? startError.message : "Code review session could not be started.");
      return null;
    } finally {
      setStartingReview(false);
    }
  }

  async function openAssistant() {
    setExpandedEditor(false);
    setAssistantOpen(true);
    await ensureReviewSession();
  }

  function toggleExplorer() {
    setExpandedEditor(false);
    setExplorerOpen((current) => !current);
  }

  function toggleAssistant() {
    setExpandedEditor(false);
    if (assistantOpen) {
      setAssistantOpen(false);
      return;
    }
    void openAssistant();
  }

  function expandEditorOnly() {
    setExpandedEditor(true);
    setExplorerOpen(false);
    setAssistantOpen(false);
  }

  function resetLayout() {
    setExpandedEditor(false);
    setExplorerOpen(true);
    setAssistantOpen(false);
    setContextOpen(false);
  }

  function discardReviewChanges() {
    setChangedFiles([]);
    setSelectedChangePath(null);
    setValidation(null);
    setDraftPrUrl(null);
    setEditorMode("source");
    setExplorerView("files");
  }

  function selectReviewChange(path: string, mode: EditorMode = "diff") {
    setSelectedChangePath(path);
    if (files.some((file) => file.path === path)) setSelectedPath(path);
    setEditorMode(mode);
  }

  async function sendReviewMessage(messageText: string) {
    const trimmed = messageText.trim();
    if (!trimmed || !reviewTemplateId) return;
    const sessionId = await ensureReviewSession();
    if (!sessionId) return;
    setSendingReview(true);
    setReviewError(null);
    try {
      const response = await fetch(`/api/v1/template-agent-sessions/${sessionId}/review-messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: trimmed, selectedPath: selectedFile?.path, sourceRef: reviewRef })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, "Codex review did not complete."));
      setReviewMessages(normalizeReviewMessages(body.session?.messages));
      const nextChanges = Array.isArray(body.result?.changedFiles) ? body.result.changedFiles : [];
      setChangedFiles(nextChanges);
      setSelectedChangePath(nextChanges[0]?.path ?? null);
      if (nextChanges[0]?.path && files.some((file) => file.path === nextChanges[0].path)) setSelectedPath(nextChanges[0].path);
      if (nextChanges.length > 0) {
        setEditorMode("diff");
        setExplorerView("changes");
      }
      setValidation(null);
      setDraftPrUrl(null);
      setAiConfigured(body.result?.aiConfigured ?? aiConfigured);
      setAssistantDraft("");
    } catch (sendError) {
      setReviewError(sendError instanceof Error ? sendError.message : "Codex review did not complete.");
    } finally {
      setSendingReview(false);
    }
  }

  function saveManualEditForReview() {
    if (!selectedFile) return;
    if (reviewEnabled) {
      const nextChange = {
        path: selectedFile.path,
        originalContent: selectedFile.content,
        proposedContent: draftContent,
        reason: "Manual edit prepared in Fedlify code review."
      };
      setChangedFiles([nextChange]);
      setSelectedChangePath(nextChange.path);
      setSelectedPath(nextChange.path);
      setEditorMode("diff");
      setExplorerView("changes");
      setValidation(null);
      setDraftPrUrl(null);
      setEditMode(false);
      message.info("Manual edit staged for review. Validate it before creating a draft PR.");
      return;
    }
    onSaveDraft?.(selectedFile, draftContent);
  }

  async function validateReviewChanges() {
    if (!reviewTemplateId || changedFiles.length === 0) return;
    const sessionId = await ensureReviewSession();
    if (!sessionId) return;
    setValidatingReview(true);
    setReviewError(null);
    try {
      const response = await fetch(`/api/v1/template-agent-sessions/${sessionId}/validate-review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ changedFiles })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, "Review validation failed."));
      setValidation(body.validation);
      if (Array.isArray(body.changedFiles)) {
        setChangedFiles(body.changedFiles);
        if (!body.changedFiles.some((file: ReviewChangedFile) => file.path === selectedChangePath)) {
          setSelectedChangePath(body.changedFiles[0]?.path ?? null);
          if (body.changedFiles[0]?.path && files.some((file) => file.path === body.changedFiles[0].path)) setSelectedPath(body.changedFiles[0].path);
        }
      }
      if (body.validation?.status === "PASSED") message.success("Review changes passed validation.");
      else message.warning(body.validation?.summary ?? "Review changes need attention.");
    } catch (validateError) {
      setReviewError(validateError instanceof Error ? validateError.message : "Review validation failed.");
    } finally {
      setValidatingReview(false);
    }
  }

  async function applyReviewChanges() {
    if (!reviewTemplateId || changedFiles.length === 0 || validation?.status !== "PASSED") return;
    const sessionId = await ensureReviewSession();
    if (!sessionId) return;
    setApplyingReview(true);
    setReviewError(null);
    try {
      const response = await fetch(`/api/v1/template-agent-sessions/${sessionId}/apply-review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ changedFiles })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, "Draft PR was not created."));
      setDraftPrUrl(body.draftPrUrl ?? body.proposal?.giteaPullRequestUrl ?? null);
      message.success("Draft PR created from reviewed changes.");
      if (body.proposal?.id) onReviewApplied?.(body.proposal.id);
    } catch (applyError) {
      setReviewError(applyError instanceof Error ? applyError.message : "Draft PR was not created.");
    } finally {
      setApplyingReview(false);
    }
  }

  function renderSourceTree(nodes: SourceTreeNode[], depth = 0) {
    return nodes.map((node) => {
      const paddingLeft = 10 + depth * 16;
      if (node.type === "folder") {
        const isCollapsed = collapsedFolders.has(node.path);
        return (
          <div key={node.path} className="fedlify-code-tree-group">
            <button className="fedlify-code-tree-row is-folder" onClick={() => toggleFolder(node.path)} style={{ paddingLeft }} type="button">
              {isCollapsed ? <RightOutlined /> : <DownOutlined />}
              {isCollapsed ? <FolderOutlined /> : <FolderOpenOutlined />}
              <span>{node.name}</span>
            </button>
            {isCollapsed ? null : renderSourceTree(node.children ?? [], depth + 1)}
          </div>
        );
      }

      return (
        <button
          key={node.path}
          className={["fedlify-code-tree-row", node.path === selectedFile?.path ? "is-selected" : ""].filter(Boolean).join(" ")}
          onClick={() => {
            setSelectedPath(node.path);
            setEditorMode("source");
          }}
          style={{ paddingLeft }}
          type="button"
        >
          <span />
          <FileTextOutlined />
          <span>{node.name}</span>
        </button>
      );
    });
  }

  function renderChangeList() {
    if (changedFiles.length === 0) {
      return (
        <div className="fedlify-code-change-empty">
          <DiffOutlined />
          <Typography.Text className="fedlify-muted">No reviewed changes yet.</Typography.Text>
        </div>
      );
    }

    return (
      <div className="fedlify-code-change-list">
        {changedFiles.map((file) => (
          <button
            key={file.path}
            type="button"
            className={file.path === selectedChange?.path ? "is-selected" : ""}
            onClick={() => selectReviewChange(file.path)}
          >
            <FileTextOutlined />
            <span>{file.path}</span>
            <small>{file.reason}</small>
          </button>
        ))}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="fedlify-code-review">
        <Typography.Text className="fedlify-muted">Loading source files...</Typography.Text>
      </div>
    );
  }

  if (error) {
    return <InlineLoadError message={error} onRetry={() => void load()} />;
  }

  if (files.length === 0) {
    return (
      <Alert
        type="info"
        showIcon
        message={emptyMessage ?? "No reviewable source files were returned."}
        action={
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            Retry
          </Button>
        }
      />
    );
  }

  return (
    <div className="fedlify-code-review">
      <div className="fedlify-code-review-header">
        <div>
          <Typography.Title level={3}>{title}</Typography.Title>
          {description ? <Typography.Text className="fedlify-muted">{description}</Typography.Text> : null}
        </div>
        <Space wrap>
          {(reviewEnabled || onRequestChange) && selectedFile ? (
            <Button
              type="primary"
              className="fedlify-dark-action"
              icon={<RobotOutlined />}
              onClick={() => {
                if (reviewEnabled) void openAssistant();
                else if (selectedFile) onRequestChange?.(selectedFile);
              }}
            >
              {requestChangeLabel}
            </Button>
          ) : null}
          {payload?.pullRequestUrl ? (
            <Button icon={<GithubOutlined />} href={payload.pullRequestUrl} target="_blank">
              Open PR
            </Button>
          ) : null}
          {payload?.branchUrl ? (
            <Button icon={<CodeOutlined />} href={payload.branchUrl} target="_blank">
              Open branch
            </Button>
          ) : null}
        </Space>
      </div>
      {(reviewEnabled || onRequestChange) && requestChangeDescription ? (
        <Alert type="info" showIcon message={requestChangeDescription} />
      ) : null}

      <div className="fedlify-code-context-bar">
        <Space className="fedlify-code-context-chips" wrap size={[6, 6]}>
          <Tag title={reviewRef}>{compactLabel(reviewRef)}</Tag>
          <Tag title={reviewCommit ?? undefined}>{shortCommit(reviewCommit)}</Tag>
          {payload?.branchName ? <Tag title={payload.branchName}>{compactLabel(payload.branchName)}</Tag> : null}
          {manifest?.packageType ? <Tag title={String(manifest.packageType)}>{compactLabel(String(manifest.packageType))}</Tag> : null}
          {validation?.status ? <StatusTag value={validation.status} /> : null}
        </Space>
        <Button size="small" icon={<InfoCircleOutlined />} onClick={() => setContextOpen((current) => !current)}>
          {contextOpen ? "Hide context" : "Review context"}
        </Button>
      </div>
      {contextOpen ? (
        <div className="fedlify-code-context-panel">
          <FieldGrid>
            <FieldRow label="Review ref" value={reviewRef} />
            <FieldRow label="Commit" value={shortCommit(reviewCommit)} />
            <FieldRow label="Branch" value={payload?.branchName ?? "Not set"} />
            <FieldRow
              label="Repository"
              value={
                payload?.repoUrl ? (
                  <a href={payload.repoUrl} target="_blank" rel="noreferrer">
                    {payload.repoUrl}
                  </a>
                ) : (
                  payload?.source ?? "Not set"
                )
              }
            />
            {manifest ? <FieldRow label="Package type" value={manifest.packageType ?? "Not set"} /> : null}
            {manifest?.workflow || manifest?.template?.name ? <FieldRow label="Workflow/template" value={manifest.workflow ?? manifest.template?.name} /> : null}
          </FieldGrid>
        </div>
      ) : null}

      <div className={shellClassName}>
        {explorerOpen && !expandedEditor ? (
          <aside className="fedlify-code-file-list" aria-label="Source files">
            <div className="fedlify-code-explorer-header">
              <strong>Explorer</strong>
              <span>{explorerView === "files" ? `${files.length} files` : `${changedFiles.length} changes`}</span>
            </div>
            {changedFiles.length > 0 ? (
              <Segmented
                block
                className="fedlify-code-explorer-switch"
                options={[
                  { label: "Files", value: "files" },
                  { label: "Changes", value: "changes" }
                ]}
                size="small"
                value={explorerView}
                onChange={(value) => setExplorerView(value as ExplorerView)}
              />
            ) : null}
            {explorerView === "changes" ? <>{renderChangeList()}</> : <div className="fedlify-code-tree">{renderSourceTree(sourceTree)}</div>}
          </aside>
        ) : null}
        <section className="fedlify-code-file-preview">
          <div className="fedlify-code-file-title">
            <div className="fedlify-code-file-title-main">
              <strong>{displayedPath ?? "No file selected"}</strong>
              <span>{displayedLanguage ?? "text"}</span>
              {changedFiles.length > 0 ? (
                <Segmented
                  className="fedlify-code-mode-switch"
                  options={[
                    { label: "Source", value: "source" },
                    { label: "Diff", value: "diff", disabled: !selectedChange },
                    { label: "Proposed", value: "proposed", disabled: !selectedChange }
                  ]}
                  size="small"
                  value={activeEditorMode}
                  onChange={(value) => setEditorMode(value as EditorMode)}
                />
              ) : null}
            </div>
            <Space className="fedlify-code-editor-actions" wrap>
              <Space.Compact className="fedlify-code-layout-actions">
                <Tooltip title={explorerOpen && !expandedEditor ? "Hide explorer" : "Show explorer"}>
                  <Button size="small" icon={explorerOpen && !expandedEditor ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />} onClick={toggleExplorer} />
                </Tooltip>
                {reviewEnabled ? (
                  <Tooltip title={assistantOpen && !expandedEditor ? "Hide Codex" : "Show Codex"}>
                    <Button size="small" icon={<RobotOutlined />} onClick={toggleAssistant} />
                  </Tooltip>
                ) : null}
                <Tooltip title={expandedEditor ? "Exit expanded editor" : "Expand editor"}>
                  <Button
                    size="small"
                    icon={expandedEditor ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                    onClick={expandedEditor ? resetLayout : expandEditorOnly}
                  />
                </Tooltip>
                <Tooltip title="Reset layout">
                  <Button size="small" icon={<LayoutOutlined />} onClick={resetLayout} />
                </Tooltip>
              </Space.Compact>
              {(reviewEnabled || onSaveDraft) && selectedFile && activeEditorMode === "source" ? (
                editMode ? (
                  <>
                    <Button
                      size="small"
                      type="primary"
                      className="fedlify-dark-action"
                      disabled={!isModified}
                      loading={savingDraft}
                      onClick={saveManualEditForReview}
                    >
                      Preview change
                    </Button>
                    <Button
                      size="small"
                      onClick={() => {
                        setDraftContent(selectedFile.content);
                        setEditMode(false);
                      }}
                    >
                      Discard
                    </Button>
                  </>
                ) : (
                  <Button size="small" onClick={() => setEditMode(true)}>
                    Edit in review
                  </Button>
                )
              ) : null}
              {(reviewEnabled || onRequestChange) && selectedFile ? (
                <Button
                  size="small"
                  type="primary"
                  className="fedlify-dark-action"
                  icon={<RobotOutlined />}
                  onClick={() => {
                    if (reviewEnabled) void openAssistant();
                    else onRequestChange?.(selectedFile);
                  }}
                >
                  Review with Codex
                </Button>
              ) : null}
            </Space>
          </div>
          {changedFiles.length > 0 ? (
            <div className="fedlify-code-change-toolbar">
              <Space className="fedlify-code-review-status" wrap size={[6, 6]}>
                <StatusTag value="PENDING_CHANGES" label={`${changedFiles.length} change${changedFiles.length === 1 ? "" : "s"} pending`} />
                {validation ? <StatusTag value={validation.status} /> : null}
                {draftPrUrl ? <StatusTag value="DRAFT_READY" label="Draft PR created" /> : null}
                <Select
                  className="fedlify-code-change-select"
                  size="small"
                  value={selectedChange?.path}
                  options={changedFiles.map((file) => ({ label: file.path, value: file.path }))}
                  onChange={(path) => selectReviewChange(path)}
                />
              </Space>
              <Space className="fedlify-code-review-actions" wrap>
                <Button size="small" onClick={discardReviewChanges}>
                  Discard
                </Button>
                <Button size="small" icon={<CheckCircleOutlined />} onClick={() => void validateReviewChanges()} loading={validatingReview}>
                  Validate
                </Button>
                <Button
                  size="small"
                  type="primary"
                  className="fedlify-dark-action"
                  icon={<GithubOutlined />}
                  disabled={validation?.status !== "PASSED" || Boolean(draftPrUrl)}
                  loading={applyingReview}
                  onClick={() => void applyReviewChanges()}
                >
                  Create draft PR
                </Button>
                {draftPrUrl ? (
                  <Button size="small" href={draftPrUrl} target="_blank" icon={<GithubOutlined />}>
                    Open PR
                  </Button>
                ) : null}
              </Space>
            </div>
          ) : null}
          {validation ? (
            <Alert className="fedlify-code-inline-alert" type={validation.status === "PASSED" ? "success" : "error"} showIcon message={validation.summary} />
          ) : null}
          <div className="fedlify-monaco-frame">
            {activeEditorMode === "diff" && selectedChange ? (
              <MonacoDiffEditor
                beforeMount={configureMonaco}
                height="100%"
                language={monacoLanguage(changedFileLanguage(selectedChange, files))}
                original={selectedChange.originalContent}
                modified={selectedChange.proposedContent}
                theme={FEDLIFY_EDITOR_THEME}
                options={{
                  automaticLayout: true,
                  fontSize: 14,
                  minimap: { enabled: false },
                  readOnly: true,
                  renderSideBySide: true,
                  scrollBeyondLastLine: false,
                  wordWrap: "on"
                }}
              />
            ) : (
              <MonacoEditor
                beforeMount={configureMonaco}
                height="100%"
                language={monacoLanguage(activeEditorMode === "proposed" && selectedChange ? changedFileLanguage(selectedChange, files) : selectedFile?.language)}
                path={activeEditorMode === "proposed" && selectedChange ? `${selectedChange.path}:proposed` : selectedFile?.path ?? "source"}
                theme={FEDLIFY_EDITOR_THEME}
                value={activeEditorMode === "proposed" && selectedChange ? selectedChange.proposedContent : editMode ? draftContent : selectedFile?.content ?? ""}
                onChange={(value) => setDraftContent(value ?? "")}
                options={{
                  automaticLayout: true,
                  contextmenu: true,
                  fontSize: 14,
                  lineNumbers: "on",
                  minimap: { enabled: false },
                  readOnly: activeEditorMode === "proposed" || !editMode,
                  renderWhitespace: "selection",
                  scrollBeyondLastLine: false,
                  tabSize: 2,
                  wordWrap: "on"
                }}
              />
            )}
          </div>
        </section>
        {assistantOpen && reviewEnabled && !expandedEditor ? (
          <aside className="fedlify-code-review-assistant" aria-label="Fedlify Codex review assistant">
            <div className="fedlify-code-assistant-heading">
              <div>
                <Typography.Title level={4}>Codex review</Typography.Title>
                <Typography.Text className="fedlify-muted">Ask about the selected file, request safe changes, then validate the diff before creating a draft PR.</Typography.Text>
              </div>
              <Space.Compact>
                <Tooltip title={contextOpen ? "Hide review context" : "Show review context"}>
                  <Button size="small" icon={<InfoCircleOutlined />} onClick={() => setContextOpen((current) => !current)} />
                </Tooltip>
                <Tooltip title="Close Codex">
                  <Button size="small" icon={<MenuFoldOutlined />} onClick={() => setAssistantOpen(false)} />
                </Tooltip>
              </Space.Compact>
            </div>
            <div className="fedlify-code-context-chips">
              <Tag title={selectedFile?.path}>{compactLabel(selectedFile?.path ?? "No file")}</Tag>
              <Tag title={reviewRef}>{compactLabel(reviewRef)}</Tag>
              <Tag title={reviewCommit ?? undefined}>{shortCommit(reviewCommit)}</Tag>
              {manifest?.packageType ? <Tag title={String(manifest.packageType)}>{compactLabel(String(manifest.packageType), 22)}</Tag> : null}
              {validation?.status ? <StatusTag value={validation.status} /> : null}
            </div>
            {reviewError ? (
              <Alert
                type="error"
                showIcon
                message={reviewError}
                action={
                  <Space wrap>
                    <Button size="small" onClick={() => void ensureReviewSession()} loading={startingReview}>
                      Retry
                    </Button>
                    <Button size="small" onClick={() => void load()}>
                      Reload source
                    </Button>
                  </Space>
                }
              />
            ) : null}
            {aiConfigured === false ? (
              <Alert
                type="warning"
                showIcon
                message="AI code review is not configured"
                description="Set OPENAI_API_KEY to enable natural-language Codex review. Manual edits can still be previewed, validated, and sent to a draft PR."
              />
            ) : null}
            <PromptList
              items={[
                { key: "explain", label: "Explain this file", description: "Explain the selected file and how it fits the NVFLARE workflow." },
                { key: "safety", label: "Check FL safety", description: "Check for raw-data leakage, hard-coded client assumptions, and runtime risks." },
                { key: "runtime", label: "Runtime knobs", description: "Make clients, rounds, aggregation, and artifacts configurable." },
                { key: "tests", label: "Update tests", description: "Add or update tests for the selected template behavior." },
                { key: "change", label: "Create draft change", description: "Propose a safe reviewed change for this template." }
              ]}
              onItemClick={(info: any) => setAssistantDraft(info?.data?.description ?? info?.description ?? "")}
            />
            <div className="fedlify-code-assistant-chat">
              {reviewMessages.length ? (
                <BubbleList
                  items={reviewMessages.map((item, index) => ({
                    key: `${index}`,
                    role: item.role,
                    content: item.content
                  }))}
                />
              ) : (
                <div className="fedlify-code-assistant-empty">
                  <RobotOutlined />
                  <Typography.Text>Open a review session to ask Codex about this template source.</Typography.Text>
                </div>
              )}
            </div>
            <SenderBox
              value={assistantDraft}
              onChange={setAssistantDraft}
              onSubmit={(value: string) => void sendReviewMessage(value)}
              loading={startingReview || sendingReview}
              disabled={aiConfigured === false}
              placeholder={`Ask about ${selectedFile?.path ?? "the selected file"}...`}
            />
            <ThoughtSteps
              items={[
                { title: "Ask", status: reviewSessionId ? "finish" : startingReview ? "process" : "wait", description: "Review context loaded" },
                { title: "Clarify", status: reviewMessages.length > 1 ? "finish" : "wait", description: "Questions handled in chat" },
                { title: "Propose", status: changedFiles.length > 0 ? "finish" : "wait", description: changedFiles.length ? `${changedFiles.length} file change(s)` : "No diff yet" },
                { title: "Validate", status: validation?.status === "PASSED" ? "finish" : validatingReview ? "process" : "wait", description: validation?.summary ?? "Pending" },
                { title: "Draft PR", status: draftPrUrl ? "finish" : applyingReview ? "process" : "wait", description: draftPrUrl ? "Created" : "Not created" }
              ]}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
