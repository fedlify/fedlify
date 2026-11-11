"use client";

import {
  BranchesOutlined,
  CodeOutlined,
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
import { Alert, Button, Modal, Space, Tag, Tooltip, Typography, message } from "antd";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { Monaco } from "@monaco-editor/react";
import { FieldGrid, FieldRow } from "@/components/EntityDetail";
import { InlineLoadError } from "@/components/LoadStates";
import { ProposalReviewView } from "@/components/ProposalReviewView";
import { StatusTag } from "@/components/StatusTag";
import { type ProposalFileSummary, type ProposalStatus } from "@/lib/agent-proposal-client";

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

type SourceTreeNode = {
  type: "folder" | "file";
  name: string;
  path: string;
  children?: SourceTreeNode[];
  file?: SourceFile;
};

/** An assistant proposal open for review: the diff is against the files this panel loaded. Nothing commits until a person clicks Accept. */
export type ProposalReviewState = {
  id: string;
  title: string;
  status: ProposalStatus;
  baseCommit: string | null;
  acceptedCommit?: string | null;
  baseUnavailable?: boolean;
  files: ProposalFileSummary[];
  accepted: Record<string, boolean>;
  busy: boolean;
};

type CodeReviewPanelProps = {
  proposalReview?: ProposalReviewState | null;
  /** Short explanation shown at the end of the compact branch and commit row. */
  contextNote?: string;
  /** The page shows the files, code and assistant without the app chrome. */
  fullScreen?: boolean;
  onFullScreenChange?: (fullScreen: boolean) => void;
  proposalForceFullWidth?: boolean;
  onProposalExitFullWidth?: () => void;
  onProposalToggle?: (path: string, accepted: boolean) => void;
  onProposalAccept?: () => void;
  onProposalReject?: () => void;
  onProposalClose?: () => void;
  sourceUrl: string;
  title?: string;
  description?: string;
  reloadKey?: string | number;
  emptyMessage?: string;
  requestChangeLabel?: string;
  requestChangeDescription?: string;
  savingDraft?: boolean;
  hideHeader?: boolean;
  onRequestChange?: (file: SourceFile, context?: { instruction?: string; mode?: "assistant_request" }) => void;
  onSaveDraft?: (file: SourceFile, content: string) => void;
  /** Workspace mode: the page owns the file tree, so the built-in explorer and layout toggles are hidden. */
  hideExplorer?: boolean;
  /** Controlled selection: when set and present in the repo, this file is shown. */
  selectedPath?: string | null;
  onSelectedPathChange?: (path: string | null) => void;
  onFilesLoaded?: (files: SourceFile[], commit: string | null) => void;
  /** Called when the source could not be loaded, so the host can show an error instead of a spinner. */
  onLoadError?: (message: string) => void;
  /** Reports the path with unsaved edits (edit mode and content differs), or null. */
  onDirtyChange?: (path: string | null) => void;
  /** "Ask assistant" with the current file and (if any) the editor selection. */
  onAskAssistant?: (context: { path: string; selection?: string }) => void;
  editLabel?: string;
  saveLabel?: string;
  /** Lets the host trigger Save for the file being edited. */
  controlRef?: MutableRefObject<{ save: () => void; hasEdits: () => boolean } | null>;
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

export function CodeReviewPanel({
  sourceUrl,
  title = "Code review",
  description,
  reloadKey,
  emptyMessage,
  requestChangeLabel = "Review with Codex",
  requestChangeDescription,
  savingDraft,
  hideHeader = false,
  onRequestChange,
  onSaveDraft,
  hideExplorer = false,
  selectedPath: controlledPath,
  onSelectedPathChange,
  onFilesLoaded,
  onLoadError,
  onDirtyChange,
  onAskAssistant,
  editLabel = "Edit in review",
  saveLabel = "Preview change",
  controlRef,
  proposalReview,
  contextNote,
  fullScreen = false,
  onFullScreenChange,
  proposalForceFullWidth,
  onProposalExitFullWidth,
  onProposalToggle,
  onProposalAccept,
  onProposalReject,
  onProposalClose
}: CodeReviewPanelProps) {
  const [proposalPath, setProposalPath] = useState<string | null>(null);
  const [payload, setPayload] = useState<SourcePayload | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [editMode, setEditMode] = useState(false);
  const [draftContent, setDraftContent] = useState("");
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [expandedEditor, setExpandedEditor] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [layoutLoaded, setLayoutLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Only the newest load may write state: a slow response for a previous project must not overwrite the current one.
  const loadSeq = useRef(0);
  const selectedPathRef = useRef<string | null>(null);
  selectedPathRef.current = selectedPath;

  async function load() {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(sourceUrl, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (seq !== loadSeq.current) return;
      if (!response.ok) throw new Error(apiErrorMessage(body, "Source code could not be loaded."));
      const files = body?.files ?? [];
      setPayload({ ...body, files });
      const previous = selectedPathRef.current;
      const nextPath = previous && files.some((file: SourceFile) => file.path === previous) ? previous : preferredInitialFile(files)?.path ?? null;
      setSelectedPath(nextPath);
      // Report the path after every load: the host may have reset its own copy while this one kept the same file.
      onSelectedPathChange?.(nextPath);
      onFilesLoaded?.(files, body?.commit ?? body?.gitRef ?? null);
      setCollapsedFolders(new Set());
    } catch (loadError) {
      if (seq !== loadSeq.current) return;
      setPayload(null);
      setSelectedPath(null);
      const failure = loadError instanceof Error ? loadError.message : "Source code could not be loaded.";
      setError(failure);
      onLoadError?.(failure);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
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
  const proposalFile = proposalReview ? (proposalReview.files.find((file) => file.path === proposalPath) ?? proposalReview.files[0]) : undefined;
  const loadedCommit = payload?.commit ?? payload?.gitRef ?? null;
  // The diff is "current files -> proposed files", so it is only trustworthy once the loaded files ARE the proposal's
  // base commit. While the files are unknown (first load, failed load) nothing can be accepted.
  const proposalFilesUnknown = Boolean(proposalReview && proposalReview.status === "PROPOSED" && !loadedCommit);
  const proposalStale = Boolean(
    proposalReview &&
      (proposalReview.status !== "PROPOSED" || !proposalReview.baseCommit || proposalFilesUnknown || (loadedCommit && loadedCommit !== proposalReview.baseCommit))
  );
  const proposalAcceptedPaths = proposalReview ? proposalReview.files.filter((file) => proposalReview.accepted[file.path]).map((file) => file.path) : [];
  const reviewRef = payload?.ref ?? "current";
  const reviewCommit = payload?.commit ?? payload?.gitRef;
  const shellClassName = [
    "fedlify-code-review-shell",
    explorerOpen && !expandedEditor && !hideExplorer ? "has-explorer" : "is-explorer-hidden",
    "is-assistant-hidden",
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
          expandedEditor: boolean;
          contextOpen: boolean;
        }>;
        if (typeof layout.explorerOpen === "boolean") setExplorerOpen(layout.explorerOpen);
        if (typeof layout.expandedEditor === "boolean") setExpandedEditor(layout.expandedEditor);
        if (typeof layout.contextOpen === "boolean") setContextOpen(layout.contextOpen);
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
        JSON.stringify({ explorerOpen, expandedEditor, contextOpen })
      );
    } catch {
      // Ignore unavailable storage.
    }
  }, [contextOpen, expandedEditor, explorerOpen, layoutLoaded]);

  useEffect(() => {
    setEditMode(false);
    setDraftContent(selectedFile?.content ?? "");
  }, [selectedFile?.path, selectedFile?.content]);

  // Controlled selection from the host's file tree.
  useEffect(() => {
    if (controlledPath && controlledPath !== selectedPath && files.some((file) => file.path === controlledPath)) {
      setSelectedPath(controlledPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlledPath, files]);

  useEffect(() => {
    onSelectedPathChange?.(selectedFile?.path ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile?.path]);

  const dirtyPath = editMode && isModified && selectedFile ? selectedFile.path : null;
  useEffect(() => {
    onDirtyChange?.(dirtyPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtyPath]);

  const editorRef = useRef<{ getSelectedText: () => string } | null>(null);
  const askRef = useRef<() => void>(() => undefined);
  const saveRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    askRef.current = () => {
      if (!selectedFile || !onAskAssistant) return;
      const selection = editorRef.current?.getSelectedText().trim();
      onAskAssistant({ path: selectedFile.path, selection: selection ? selection.slice(0, 20000) : undefined });
    };
    saveRef.current = () => {
      if (editMode && isModified) saveManualEditForReview();
    };
  });
  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = { save: () => saveRef.current(), hasEdits: () => Boolean(dirtyPath) };
    return () => {
      controlRef.current = null;
    };
  }, [controlRef, dirtyPath]);

  function toggleFolder(path: string) {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleExplorer() {
    setExpandedEditor(false);
    setExplorerOpen((current) => !current);
  }

  function expandEditorOnly() {
    setExpandedEditor(true);
    setExplorerOpen(false);
  }

  function resetLayout() {
    setExpandedEditor(false);
    setExplorerOpen(true);
    setContextOpen(false);
  }

  function saveManualEditForReview() {
    if (!selectedFile) return;
    onSaveDraft?.(selectedFile, draftContent);
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

  // In the workspace the branch and commit sit in a status bar under the editor, as in VS Code.
  const statusBar = Boolean(hideHeader && contextNote);
  const compactRef = (
    <div className={["fedlify-code-compact-ref", statusBar ? "is-statusbar" : ""].join(" ")}>
      {payload?.branchName ? (
        <Typography.Text type="secondary" title={`Branch: ${payload.branchName}`}>
          {statusBar ? <BranchesOutlined /> : "Branch:"} <code>{payload.branchName.length > 50 ? `…${payload.branchName.slice(-44)}` : payload.branchName}</code>
        </Typography.Text>
      ) : null}
      {reviewCommit ? (
        <Typography.Text type="secondary" title={`Commit: ${reviewCommit}`}>
          {statusBar ? null : "Commit: "}<code>{shortCommit(reviewCommit)}</code>
        </Typography.Text>
      ) : null}
      <Button size="small" type="text" icon={<InfoCircleOutlined />} onClick={() => setContextOpen((current) => !current)}>
        {statusBar ? "Details" : contextOpen ? "Hide context" : "Review context"}
      </Button>
      {contextNote ? <Typography.Text type="secondary" className="fedlify-code-compact-note" ellipsis={{ tooltip: contextNote }}>{contextNote}</Typography.Text> : null}
    </div>
  );
  const contextPanel = contextOpen ? (
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
  ) : null;

  return (
    <div className="fedlify-code-review">
      {!hideHeader ? (
        <>
          <div className="fedlify-code-review-header">
            <div>
              <Typography.Title level={3}>{title}</Typography.Title>
              {description ? <Typography.Text className="fedlify-muted">{description}</Typography.Text> : null}
            </div>
            <Space wrap>
              {onRequestChange && selectedFile ? (
                <Button
                  type="primary"
                  className="fedlify-dark-action"
                  icon={<RobotOutlined />}
                  onClick={() => onRequestChange(selectedFile)}
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
          {onRequestChange && requestChangeDescription ? (
            <Alert type="info" showIcon message={requestChangeDescription} />
          ) : null}
          <div className="fedlify-code-context-bar">
            <Space className="fedlify-code-context-chips" wrap size={[6, 6]}>
              <Tag title={reviewRef}>{compactLabel(reviewRef)}</Tag>
              <Tag title={reviewCommit ?? undefined}>{shortCommit(reviewCommit)}</Tag>
              {payload?.branchName ? <Tag title={payload.branchName}>{compactLabel(payload.branchName)}</Tag> : null}
              {manifest?.packageType ? <Tag title={String(manifest.packageType)}>{compactLabel(String(manifest.packageType))}</Tag> : null}
            </Space>
            <Button size="small" icon={<InfoCircleOutlined />} onClick={() => setContextOpen((current) => !current)}>
              {contextOpen ? "Hide context" : "Review context"}
            </Button>
          </div>
        </>
      ) : statusBar ? null : (
        compactRef
      )}
      {statusBar ? null : contextPanel}

      <div className={shellClassName}>
        {explorerOpen && !expandedEditor && !hideExplorer ? (
          <aside className="fedlify-code-file-list" aria-label="Source files">
            <div className="fedlify-code-explorer-header">
              <strong>Explorer</strong>
              <span>{files.length} files</span>
            </div>
            <div className="fedlify-code-tree">{renderSourceTree(sourceTree)}</div>
          </aside>
        ) : null}
        <section className="fedlify-code-file-preview">
          <div className="fedlify-code-file-title">
            <div className="fedlify-code-file-title-main">
              <strong>{proposalFile ? proposalFile.path : (selectedFile?.path ?? "No file selected")}</strong>
              <span>{proposalFile ? `proposed ${proposalFile.action}` : (selectedFile?.language ?? "text")}</span>
            </div>
            <Space className="fedlify-code-editor-actions" wrap>
              {statusBar ? (
                <Tooltip title={fullScreen ? "Exit full screen" : "Full screen"}>
                  <Button size="small" type="text" icon={fullScreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />} onClick={() => onFullScreenChange?.(!fullScreen)} aria-label={fullScreen ? "Exit full screen" : "Full screen"} aria-pressed={fullScreen} data-testid="editor-fullscreen" />
                </Tooltip>
              ) : null}
              {hideExplorer ? null : (
              <Space.Compact className="fedlify-code-layout-actions">
                <Tooltip title={explorerOpen && !expandedEditor ? "Hide explorer" : "Show explorer"}>
                  <Button size="small" icon={explorerOpen && !expandedEditor ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />} onClick={toggleExplorer} />
                </Tooltip>
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
              )}
              {onSaveDraft && selectedFile ? (
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
                      {saveLabel}
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
                    {editLabel}
                  </Button>
                )
              ) : null}
              {onAskAssistant && selectedFile ? (
                <Tooltip title="Send this file (and any selected lines) to the assistant. Shortcut: Cmd/Ctrl+K in the editor.">
                  <Button size="small" icon={<RobotOutlined />} onClick={() => askRef.current()}>
                    Ask assistant
                  </Button>
                </Tooltip>
              ) : null}
              {onRequestChange && selectedFile ? (
                <Button
                  size="small"
                  type="primary"
                  className="fedlify-dark-action"
                  icon={<RobotOutlined />}
                  onClick={() => onRequestChange(selectedFile)}
                >
                  Review with Codex
                </Button>
              ) : null}
            </Space>
          </div>
          {proposalReview && proposalFile ? (
            <ProposalReviewView
              proposal={proposalReview}
              currentPath={proposalFile.path}
              stale={Boolean(proposalStale)}
              filesUnknown={proposalFilesUnknown}
              filesLoading={loading}
              onSelect={setProposalPath}
              onToggle={onProposalToggle}
              onAccept={onProposalAccept}
              onReject={onProposalReject}
              onClose={onProposalClose}
              forceExpanded={proposalForceFullWidth}
              onExitFullWidth={onProposalExitFullWidth}
              renderDiff={(file, view) => (
                <MonacoDiffEditor
                  key={`proposal-${proposalReview.id}-${file.path}-${view.sideBySide}-${view.changesOnly}`}
                  beforeMount={configureMonaco}
                  height="100%"
                  language={monacoLanguage(files.find((candidate) => candidate.path === file.path)?.language ?? file.path.split(".").pop() ?? "text")}
                  original={file.originalContent ?? files.find((candidate) => candidate.path === file.path)?.content ?? ""}
                  modified={file.content ?? ""}
                  theme={FEDLIFY_EDITOR_THEME}
                  options={{
                    automaticLayout: true,
                    fontSize: 14,
                    hideUnchangedRegions: { enabled: view.changesOnly },
                    minimap: { enabled: false },
                    readOnly: true,
                    renderSideBySide: view.sideBySide,
                    useInlineViewWhenSpaceIsLimited: false,
                    scrollBeyondLastLine: false,
                    wordWrap: "on"
                  }}
                />
              )}
            />
          ) : null}
          <div className="fedlify-monaco-frame" hidden={Boolean(proposalReview && proposalFile)}>
              <MonacoEditor
                beforeMount={configureMonaco}
                onMount={(editor, monaco) => {
                  editorRef.current = { getSelectedText: () => editor.getModel()?.getValueInRange(editor.getSelection() ?? { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }) ?? "" };
                  editor.addAction({
                    id: "fedlify.askAssistant",
                    label: "Ask Fedlify assistant",
                    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
                    contextMenuGroupId: "navigation",
                    contextMenuOrder: 0,
                    run: () => askRef.current()
                  });
                }}
                height="100%"
                language={monacoLanguage(selectedFile?.language)}
                path={selectedFile?.path ?? "source"}
                theme={FEDLIFY_EDITOR_THEME}
                value={editMode ? draftContent : selectedFile?.content ?? ""}
                onChange={(value) => setDraftContent(value ?? "")}
                options={{
                  automaticLayout: true,
                  contextmenu: true,
                  fontSize: 14,
                  lineNumbers: "on",
                  minimap: { enabled: false },
                  readOnly: !editMode,
                  renderWhitespace: "selection",
                  scrollBeyondLastLine: false,
                  tabSize: 2,
                  wordWrap: "on"
                }}
              />
          </div>
        </section>
      </div>
      {statusBar ? (
        <Modal open={contextOpen} title="Review context" footer={null} width={560} onCancel={() => setContextOpen(false)}>
          {contextPanel}
        </Modal>
      ) : null}
      {statusBar ? compactRef : null}
    </div>
  );
}
