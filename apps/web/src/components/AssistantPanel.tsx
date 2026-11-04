"use client";

import { ClearOutlined, MenuFoldOutlined, MenuUnfoldOutlined, ReloadOutlined, RobotOutlined, ArrowUpOutlined, StopOutlined } from "@ant-design/icons";
import { Alert, Button, Input, Popconfirm, Segmented, Tag, Tooltip, Typography } from "antd";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  appliedPaths,
  createProposal,
  effectiveStatus,
  listProposals,
  type ProposalFailure,
  type ProposalStatus,
  type ProposalSummary
} from "@/lib/agent-proposal-client";
import type { FailureSummary } from "@/lib/diagnostics";
import { MAX_MESSAGE_CHARS, MAX_SELECTION_CHARS, buildHistory, createSseParser, splitFences } from "@/lib/assistant-stream";

export type AskRequest = { id: number; path: string; selection?: string };

type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "done" | "error" | "stopped";
  error?: string;
  notice?: string;
  /** Problems found by the server-side proposal checks, shown as a list under the error. */
  details?: string[];
  /** A proposal card rendered under this message. */
  proposalId?: string;
};

/** Page-owned actions: only a click on Accept commits anything, and the page reloads the source afterwards. */
export type ProposalActionResult = { ok: true; commitSha: string } | ProposalFailure;
export type ProposalSync = { id: string; status: ProposalStatus; commit: string | null; /** Files committed by an accept; null when not accepted or all files. */ paths?: string[] | null; nonce: number };

type ContextInfo = { hash: string; commit: string | null; truncated: string[]; answered: number; total: number };

type AssistantPanelProps = {
  studyId: string;
  projectId: string;
  /** Saved commit the assistant reads (it never sees unsaved editor content). */
  commit: string | null;
  /** The file currently open in the editor. */
  focusFile: string | null;
  unsavedPaths: string[];
  open: boolean;
  onToggle: () => void;
  askRequest: AskRequest | null;
  onReviewProposal: (id: string) => void;
  onAcceptProposal: (id: string, paths?: string[]) => Promise<ProposalActionResult>;
  onRejectProposal: (id: string) => Promise<{ ok: true } | ProposalFailure>;
  /** Set by the page when a proposal is decided from the diff view, so the card here follows. */
  proposalSync: ProposalSync | null;
  /** Keys of the failed publish and run the page sees (null when the latest one did not fail). A new key posts a notice. */
  failures?: { publish: string | null; run: string | null };
  /** Codes of sites that should be connected to the live aggregator but are not. */
  unconnectedSites?: string[];
};

const FAILURE_PROMPTS = {
  publish: {
    explain: "Why did the latest publish fail? Use the publish diagnostics in the context and quote the step and log lines you rely on.",
    fix: "Propose a fix for the failed publish. Use the publish diagnostics in the context; change only repository files."
  },
  run: {
    explain: "Why did the latest run fail? Use the run diagnostics in the context, and say what is not visible to the server.",
    fix: "Propose a fix for the failed run. Use the run diagnostics in the context; change only repository files."
  }
} as const;

const PROPOSE_PROMPTS = [
  "Add a unit test for the main training function",
  "Add input validation for the features listed in fedlify-pipeline.json",
  "Document how this pipeline works in README.md"
];

const STATUS_LABEL: Record<ProposalStatus, string> = { PROPOSED: "Proposed", ACCEPTED: "Accepted", REJECTED: "Rejected", STALE: "Stale" };
const STATUS_COLOR: Record<ProposalStatus, string> = { PROPOSED: "purple", ACCEPTED: "green", REJECTED: "default", STALE: "orange" };

function ProposalCard({
  proposal,
  head,
  busy,
  error,
  onReview,
  onAccept,
  onReject,
  onRegenerate
}: {
  proposal: ProposalSummary;
  head: string | null;
  busy: boolean;
  error?: string;
  onReview: () => void;
  onAccept: () => void;
  onReject: () => void;
  onRegenerate: () => void;
}) {
  const status = effectiveStatus(proposal, head);
  const added = proposal.files.reduce((sum, file) => sum + file.added, 0);
  const removed = proposal.files.reduce((sum, file) => sum + file.removed, 0);
  const applied = appliedPaths({ ...proposal, status });
  const partial = status === "ACCEPTED" && applied.size < proposal.files.length;
  const appliedFiles = proposal.files.filter((file) => applied.has(file.path));
  const appliedAdded = appliedFiles.reduce((sum, file) => sum + file.added, 0);
  const appliedRemoved = appliedFiles.reduce((sum, file) => sum + file.removed, 0);
  return (
    <div className="fedlify-ws-proposal" role="group" aria-label={`Proposal: ${proposal.title}`}>
      <div className="fedlify-ws-proposal-head">
        <strong>{proposal.title}</strong>
        <Tag color={STATUS_COLOR[status]}>
          {STATUS_LABEL[status]}
          {partial ? ` (${applied.size} of ${proposal.files.length} files)` : ""}
          {status === "ACCEPTED" && proposal.acceptedCommit ? ` - commit ${proposal.acceptedCommit.slice(0, 8)}` : ""}
        </Tag>
      </div>
      <p className="fedlify-ws-msg-text">{proposal.rationale}</p>
      <ul className="fedlify-ws-proposal-files">
        {proposal.files.map((file) => (
          <li key={file.path}>
            <code title={file.path} style={partial && !applied.has(file.path) ? { textDecoration: "line-through", opacity: 0.6 } : undefined}>{file.path}</code>
            {partial && !applied.has(file.path) ? <em className="fedlify-muted"> not applied</em> : null}
            <span className="fedlify-proposal-counts">
              <span className="is-add">+{file.added}</span> <span className="is-del">-{file.removed}</span>
              {file.action !== "update" ? <em> {file.action}</em> : null}
            </span>
          </li>
        ))}
      </ul>
      <Typography.Text className="fedlify-muted">{status === "ACCEPTED"
          ? `${appliedFiles.length} of ${proposal.files.length} file(s) committed, +${appliedAdded} -${appliedRemoved}.`
          : `${proposal.files.length} file(s), +${added} -${removed}. Nothing is saved until you accept.`}</Typography.Text>
      {status === "STALE" ? (
        <Alert type="warning" showIcon message="The saved code changed after this was written." description="Regenerate it against the latest commit." />
      ) : null}
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <div className="fedlify-ws-proposal-actions">
        {status === "PROPOSED" ? (
          <>
            <Button size="small" onClick={onReview} disabled={busy}>Review diff</Button>
            <Popconfirm
              title={`Commit ${proposal.files.length} file(s) to the saved code?`}
              description="This creates one commit under your name. It does not publish or run anything."
              okText="Accept all"
              onConfirm={onAccept}
            >
              <Button size="small" type="primary" loading={busy}>Accept all</Button>
            </Popconfirm>
            <Button size="small" danger onClick={onReject} disabled={busy}>Reject</Button>
          </>
        ) : null}
        {status === "STALE" ? (
          <>
            <Button size="small" type="primary" onClick={onRegenerate} disabled={busy}>Regenerate</Button>
            <Button size="small" danger onClick={onReject} disabled={busy}>Dismiss</Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

const QUICK_PROMPTS = [
  "Explain this repository",
  "Plan from my requirements",
  "Check this pipeline for data-leakage or privacy risks",
  "What should I review in this code before publishing?",
  "How will each site's data profile work with this code?"
];

function errorFromResponse(status: number, body: { error?: { message?: string; code?: string } } | null): string {
  if (body?.error?.code === "ai_not_configured") return "The assistant is not configured on this server yet (no model key). Ask an administrator to enable it.";
  if (status === 429) return "Too many assistant requests. Wait a minute and try again.";
  if (status === 403) return "You do not have permission to use the assistant on this study.";
  return body?.error?.message ?? `The assistant request failed (${status}).`;
}

// Small Markdown subset for model replies. Builds React elements only, so model output can never inject HTML.
function inlineMarkdown(text: string) {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={index}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

function ChatMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push(<p key={blocks.length}>{inlineMarkdown(paragraph.join(" "))}</p>);
    paragraph = [];
    if (list) {
      const items = list.items.map((item, index) => <li key={index}>{inlineMarkdown(item)}</li>);
      blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    }
    list = null;
  };
  for (const line of text.split("\n")) {
    const heading = /^#{1,6}\s+(.*)/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)/.exec(line);
    if (!line.trim()) flush();
    else if (heading) {
      flush();
      blocks.push(<h5 key={blocks.length}>{inlineMarkdown(heading[1])}</h5>);
    } else if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (paragraph.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else {
      if (list) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return <>{blocks}</>;
}

function MessageBody({ message }: { message: ChatMessage }) {
  if (message.role === "user") return <p className="fedlify-ws-msg-text">{message.content}</p>;
  return (
    <>
      {splitFences(message.content).map((part, index) =>
        part.type === "code" ? (
          <pre key={index} className="fedlify-ws-msg-code"><code>{part.value}</code></pre>
        ) : (
          <div key={index} className="fedlify-ws-msg-text"><ChatMarkdown text={part.value} /></div>
        )
      )}
      {message.status === "streaming" && !message.content ? <span className="fedlify-ws-typing" role="status" aria-label="Thinking"><i /><i /><i /></span> : null}
    </>
  );
}

export function AssistantPanel({
  studyId,
  projectId,
  commit,
  focusFile,
  unsavedPaths,
  open,
  onToggle,
  askRequest,
  onReviewProposal,
  onAcceptProposal,
  onRejectProposal,
  proposalSync,
  failures,
  unconnectedSites = []
}: AssistantPanelProps) {
  const [mode, setMode] = useState<"ask" | "propose">("ask");
  const [proposals, setProposals] = useState<Record<string, ProposalSummary>>({});
  const [busyProposal, setBusyProposal] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [context, setContext] = useState<ContextInfo | null>(null);
  const [includeFile, setIncludeFile] = useState(true);
  const [selection, setSelection] = useState<{ path: string; text: string } | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const nextId = useRef(1);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<{ focus: () => void } | null>(null);
  const [notices, setNotices] = useState<FailureSummary[]>([]);
  const dismissedRef = useRef<Set<string>>(new Set(typeof window === "undefined" ? [] : (() => { try { return JSON.parse(window.sessionStorage.getItem(`fedlify-dismissed-notices:${projectId}`) ?? "[]") as string[]; } catch { return []; } })()));
  const streaming = messages.some((message) => message.status === "streaming");

  const update = useCallback((updater: (current: ChatMessage[]) => ChatMessage[]) => {
    setMessages((current) => {
      const next = updater(current);
      messagesRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Proposals survive a page reload: they are stored server-side, only the chat is local.
  useEffect(() => {
    let cancelled = false;
    void listProposals(studyId, projectId).then((result) => {
      if (cancelled || !result.ok) return;
      setProposals((current) => ({ ...Object.fromEntries(result.proposals.map((item) => [item.id, item])), ...current }));
    });
    return () => {
      cancelled = true;
    };
  }, [studyId, projectId]);

  // A failed publish or run posts a system message with the first error lines (redacted and bounded server-side).
  const publishKey = failures?.publish ?? null;
  const runKey = failures?.run ?? null;
  useEffect(() => {
    if (!publishKey && !runKey) {
      setNotices([]);
      return;
    }
    let cancelled = false;
    void fetch(`/api/v1/studies/${studyId}/pipeline-projects/${projectId}/agent/diagnostics`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { failures?: FailureSummary[] } | null) => {
        if (cancelled || !body?.failures) return;
        // Only the failure the page reports (same publish or run), so the notice and the page agree.
        const kinds = new Set([publishKey ? "publish" : null, runKey ? "run" : null]);
        setNotices(body.failures.filter((item) => kinds.has(item.kind) && !dismissedRef.current.has(item.key)));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [studyId, projectId, publishKey, runKey]);

  useEffect(() => {
    if (!proposalSync) return;
    setProposals((current) => {
      const item = current[proposalSync.id];
      return item ? { ...current, [proposalSync.id]: { ...item, status: proposalSync.status, acceptedCommit: proposalSync.commit ?? item.acceptedCommit, acceptedPaths: proposalSync.status === "ACCEPTED" ? (proposalSync.paths ?? null) : item.acceptedPaths } } : current;
    });
  }, [proposalSync]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages]);

  // "Ask assistant" from the editor: attach the file (and selection) and prefill a prompt for the user to review.
  useEffect(() => {
    if (!askRequest) return;
    setIncludeFile(true);
    setSelection(askRequest.selection ? { path: askRequest.path, text: askRequest.selection } : null);
    setInput((current) => current.trim() || (askRequest.selection ? "Explain this selection." : `Explain ${askRequest.path}.`));
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [askRequest]);

  const attachedPath = includeFile ? (selection?.path ?? focusFile) : null;
  const attachedSelection = selection && selection.path === attachedPath ? selection.text : undefined;

  const send = useCallback(
    async (rawText: string, options?: { diagnostics?: boolean }) => {
      const text = rawText.trim().slice(0, MAX_MESSAGE_CHARS);
      if (!text || messagesRef.current.some((message) => message.status === "streaming")) return;
      const history = buildHistory(messagesRef.current);
      const userId = nextId.current++;
      const assistantId = nextId.current++;
      update((current) => [
        ...current,
        { id: userId, role: "user", content: text, status: "done" },
        { id: assistantId, role: "assistant", content: "", status: "streaming" }
      ]);
      setInput("");
      const patch = (changes: Partial<ChatMessage>) => update((current) => current.map((message) => (message.id === assistantId ? { ...message, ...changes } : message)));
      const append = (delta: string) => update((current) => current.map((message) => (message.id === assistantId ? { ...message, content: message.content + delta } : message)));

      const controller = new AbortController();
      abortRef.current = controller;
      let finished = false;
      try {
        const response = await fetch(`/api/v1/studies/${studyId}/pipeline-projects/${projectId}/agent/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({
            message: text,
            history,
            filePath: attachedPath ?? undefined,
            selection: attachedSelection ? attachedSelection.slice(0, MAX_SELECTION_CHARS) : undefined,
            diagnostics: options?.diagnostics || undefined
          }),
          signal: controller.signal
        });
        if (!response.ok || !response.body) {
          const body = await response.json().catch(() => null);
          patch({ status: "error", error: errorFromResponse(response.status, body) });
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = createSseParser();
        const handle = (events: ReturnType<typeof parser.push>) => {
          for (const event of events) {
            if (event.kind === "context") setContext({ hash: event.hash, commit: event.commit, truncated: event.truncated, answered: event.answered, total: event.total });
            else if (event.kind === "delta") append(event.text);
            else if (event.kind === "notice") patch({ notice: event.message });
            else if (event.kind === "error") {
              finished = true;
              patch({ status: "error", error: event.message });
            } else if (event.kind === "done") {
              finished = true;
              patch({ status: "done" });
            }
          }
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          handle(parser.push(decoder.decode(value, { stream: true })));
        }
        handle(parser.push(decoder.decode()));
        handle(parser.flush());
        if (!finished) patch({ status: "error", error: "The reply ended unexpectedly. What arrived is shown above." });
      } catch (sendError) {
        if (controller.signal.aborted) patch({ status: "stopped" });
        else patch({ status: "error", error: sendError instanceof Error ? "The connection was interrupted." : "The assistant request failed." });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        // Never leave a bubble spinning.
        update((current) => current.map((message) => (message.id === assistantId && message.status === "streaming" ? { ...message, status: "error", error: "The reply did not finish." } : message)));
      }
    },
    [attachedPath, attachedSelection, projectId, studyId, update]
  );

  /** File and selection each proposal was written with, so Regenerate asks the same question. Lost on reload. */
  const proposalContextRef = useRef<Record<string, { filePath?: string; selection?: string }>>({});

  const propose = useCallback(
    async (rawText: string, context?: { filePath?: string; selection?: string }, options?: { diagnostics?: boolean }) => {
      const text = rawText.trim().slice(0, MAX_MESSAGE_CHARS);
      if (!text || messagesRef.current.some((message) => message.status === "streaming")) return;
      const history = buildHistory(messagesRef.current);
      const userId = nextId.current++;
      const assistantId = nextId.current++;
      update((current) => [
        ...current,
        { id: userId, role: "user", content: `Propose a change: ${text}`, status: "done" },
        { id: assistantId, role: "assistant", content: "", status: "streaming" }
      ]);
      setInput("");
      const patch = (changes: Partial<ChatMessage>) => update((current) => current.map((message) => (message.id === assistantId ? { ...message, ...changes } : message)));
      const controller = new AbortController();
      abortRef.current = controller;
      const sent = context ?? { filePath: attachedPath ?? undefined, selection: attachedSelection ? attachedSelection.slice(0, MAX_SELECTION_CHARS) : undefined };
      const result = await createProposal(studyId, projectId, { message: text, history, filePath: sent.filePath, selection: sent.selection, diagnostics: options?.diagnostics || undefined }, controller.signal);
      if (abortRef.current === controller) abortRef.current = null;
      if (controller.signal.aborted) {
        patch({ status: "stopped" });
      } else if (result.ok) {
        proposalContextRef.current[result.proposal.id] = sent;
        setProposals((current) => ({ ...current, [result.proposal.id]: result.proposal }));
        patch({ status: "done", content: "I wrote a proposal. Review the diff below; nothing is saved until you accept it.", proposalId: result.proposal.id });
      } else if (result.code === "ai_not_configured") {
        patch({ status: "error", error: errorFromResponse(result.status, { error: { code: result.code, message: result.message } }) });
      } else if (result.code === "no_changes") {
        patch({ status: "done", content: result.details[0] ?? result.message });
      } else {
        patch({ status: "error", error: result.message, details: result.details });
      }
    },
    [attachedPath, attachedSelection, projectId, studyId, update]
  );

  async function acceptCard(id: string) {
    setBusyProposal(id);
    setCardErrors((current) => ({ ...current, [id]: "" }));
    const result = await onAcceptProposal(id);
    setBusyProposal(null);
    if (result.ok) {
      setProposals((current) => (current[id] ? { ...current, [id]: { ...current[id], status: "ACCEPTED", acceptedCommit: result.commitSha, acceptedPaths: null } } : current));
    } else if (result.stale) {
      setProposals((current) => (current[id] ? { ...current, [id]: { ...current[id], status: "STALE" } } : current));
    } else {
      setCardErrors((current) => ({ ...current, [id]: [result.message, ...result.details].join(" ") }));
    }
  }

  async function rejectCard(id: string): Promise<boolean> {
    setBusyProposal(id);
    const result = await onRejectProposal(id);
    setBusyProposal(null);
    if (result.ok) setProposals((current) => (current[id] ? { ...current, [id]: { ...current[id], status: "REJECTED" } } : current));
    else setCardErrors((current) => ({ ...current, [id]: result.message }));
    return result.ok;
  }

  function renderCard(id: string) {
    const proposal = proposals[id];
    if (!proposal) return null;
    return (
      <ProposalCard
        key={id}
        proposal={proposal}
        head={commit}
        busy={busyProposal === id}
        error={cardErrors[id]}
        onReview={() => onReviewProposal(id)}
        onAccept={() => void acceptCard(id)}
        onReject={() => void rejectCard(id)}
        onRegenerate={() => {
          setMode("propose");
          // Only start the new proposal once the old one is really closed; otherwise two open proposals would exist.
          void rejectCard(id).then((closed) => {
            if (closed) void propose(proposal.prompt, proposalContextRef.current[id] ?? {});
          });
        }}
      />
    );
  }

  function retry() {
    const current = messagesRef.current;
    const lastUser = [...current].reverse().find((message) => message.role === "user");
    if (!lastUser) return;
    update((items) => items.slice(0, items.length - 2));
    const proposeMarker = "Propose a change: ";
    if (lastUser.content.startsWith(proposeMarker)) void propose(lastUser.content.slice(proposeMarker.length));
    else void send(lastUser.content);
  }

  function dismissNotice(key: string) {
    dismissedRef.current.add(key);
    try { window.sessionStorage.setItem(`fedlify-dismissed-notices:${projectId}`, JSON.stringify([...dismissedRef.current].slice(-50))); } catch { /* storage unavailable */ }
    setNotices((current) => current.filter((item) => item.key !== key));
  }

  function explainFailure(kind: FailureSummary["kind"]) {
    setMode("ask");
    void send(FAILURE_PROMPTS[kind].explain, { diagnostics: true });
  }

  function proposeFix(kind: FailureSummary["kind"]) {
    setMode("propose");
    void propose(FAILURE_PROMPTS[kind].fix, undefined, { diagnostics: true });
  }

  function clearChat() {
    abortRef.current?.abort();
    update(() => []);
    setContext(null);
    setSelection(null);
  }

  const submit = (text: string) => (mode === "propose" ? propose(text) : send(text));
  const shownIds = new Set(messages.flatMap((message) => (message.proposalId ? [message.proposalId] : [])));
  const earlier = Object.values(proposals)
    .filter((item) => !shownIds.has(item.id) && ["PROPOSED", "STALE"].includes(effectiveStatus(item, commit)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);

  if (!open) {
    return (
      <aside className="fedlify-ws-assistant is-collapsed" aria-label="Assistant (collapsed)">
        <Tooltip title="Open assistant" placement="left">
          <Button type="text" icon={<MenuFoldOutlined />} onClick={onToggle} aria-label="Open assistant" />
        </Tooltip>
        <RobotOutlined className="fedlify-ws-assistant-glyph" />
        <span className="fedlify-ws-assistant-vertical">Assistant</span>
      </aside>
    );
  }

  const lastMessage = messages[messages.length - 1];
  const unsavedNote = unsavedPaths.length > 0;

  return (
    <aside className="fedlify-ws-assistant" aria-label="Project assistant">
      <div className="fedlify-ws-assistant-head">
        <div>
          <strong><RobotOutlined /> Assistant</strong>
          <Tooltip title="The assistant never saves, publishes, runs or releases. A change is committed only when you accept it.">
            <Tag className="fedlify-ws-readonly">Proposes only</Tag>
          </Tooltip>
        </div>
        <span>
          <Tooltip title="Clear conversation">
            <Button size="small" type="text" icon={<ClearOutlined />} onClick={clearChat} disabled={messages.length === 0} aria-label="Clear conversation" />
          </Tooltip>
          <Tooltip title="Collapse assistant">
            <Button size="small" type="text" icon={<MenuUnfoldOutlined />} onClick={onToggle} aria-label="Collapse assistant" />
          </Tooltip>
        </span>
      </div>

      <div className="fedlify-ws-log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation">
        {notices.map((notice) => (
          <div key={notice.key} className="fedlify-ws-msg is-system" role="alert" data-testid={`failure-notice-${notice.kind}`}>
            <span className="fedlify-ws-msg-role">System</span>
            <strong>{notice.title}</strong>
            {notice.lines.length > 0 ? <pre className="fedlify-ws-msg-code"><code>{notice.lines.join("\n")}</code></pre> : <Typography.Text className="fedlify-muted">No error text was recorded.</Typography.Text>}
            <div className="fedlify-ws-proposal-actions">
              <Button size="small" disabled={streaming} onClick={() => explainFailure(notice.kind)}>Explain</Button>
              <Button size="small" type="primary" disabled={streaming} onClick={() => proposeFix(notice.kind)}>Propose fix</Button>
              <Button size="small" type="text" onClick={() => dismissNotice(notice.key)}>Dismiss</Button>
            </div>
          </div>
        ))}
        {messages.length === 0 ? (
          <div className="fedlify-ws-quick">
            <Typography.Text className="fedlify-muted">
              {mode === "propose"
                ? "Describe a change. The assistant writes a proposal you can review as a diff. It cannot save, publish, run, or release anything."
                : "Ask about this project. It can read your study context and the saved code, but it cannot save, publish, run, or release anything."}
            </Typography.Text>
            <div className="fedlify-ws-quick-list">
              {(mode === "propose" ? PROPOSE_PROMPTS : QUICK_PROMPTS).map((prompt) => (
                <Button key={prompt} size="small" onClick={() => void submit(prompt)}>{prompt}</Button>
              ))}
              {mode === "ask" && publishKey && !notices.some((n) => n.kind === "publish") ? <Button size="small" onClick={() => void send("Why did publish fail?", { diagnostics: true })}>Why did publish fail?</Button> : null}
              {mode === "ask" && runKey && !notices.some((n) => n.kind === "run") ? <Button size="small" onClick={() => void send("Why did the run fail?", { diagnostics: true })}>Why did the run fail?</Button> : null}
              {mode === "ask" && unconnectedSites.length > 0 ? (
                <Button size="small" onClick={() => void send(`Why is site ${unconnectedSites[0]} not connected?`, { diagnostics: true })}>{`Why is site ${unconnectedSites[0]} not connected?`}</Button>
              ) : null}
              {mode === "ask" && focusFile ? <Button size="small" onClick={() => void send(`Explain ${focusFile}`)}>{`Explain ${focusFile}`}</Button> : null}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`fedlify-ws-msg is-${message.role}`}>
              <span className="fedlify-ws-msg-role">{message.role === "user" ? "You" : "Assistant"}</span>
              <MessageBody message={message} />
              {message.notice ? <Typography.Text type="warning">{message.notice}</Typography.Text> : null}
              {message.status === "stopped" ? <Typography.Text className="fedlify-muted">Stopped.</Typography.Text> : null}
              {message.status === "error" ? (
                <Alert
                  type="error"
                  showIcon
                  message={message.error ?? "The assistant failed."}
                  description={message.details && message.details.length > 0 ? <ul className="fedlify-ws-problems">{message.details.map((item) => <li key={item}>{item}</li>)}</ul> : undefined}
                />
              ) : null}
              {message.proposalId ? renderCard(message.proposalId) : null}
            </div>
          ))
        )}
        {earlier.length > 0 ? (
          <details className="fedlify-ws-earlier">
            <summary>{`Open proposals (${earlier.length})`}</summary>
            {earlier.map((item) => renderCard(item.id))}
          </details>
        ) : null}
      </div>

      <div className="fedlify-ws-composer">
        <div className="fedlify-ws-chips" aria-label="Context sent with your next message">
          <Tooltip title="Protocol fields, your requirement answers, sites and data profiles, fedlify-pipeline.json, AGENTS.md and the file list.">
            <Tag color={context && context.answered < context.total ? "orange" : "purple"}>
              {context ? `Study context ${context.answered}/${context.total}` : "Study context"}
            </Tag>
          </Tooltip>
          <Tag>{commit ? `commit ${commit.slice(0, 8)}` : "no commit"}</Tag>
          {attachedPath ? (
            <Tag closable onClose={(event) => { event.preventDefault(); setIncludeFile(false); setSelection(null); }} title={attachedPath}>
              {attachedPath}
            </Tag>
          ) : focusFile ? (
            <Tag className="fedlify-ws-chip-off" onClick={() => setIncludeFile(true)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") setIncludeFile(true); }}>
              + {focusFile}
            </Tag>
          ) : null}
          {attachedSelection ? (
            <Tag closable color="blue" onClose={(event) => { event.preventDefault(); setSelection(null); }}>
              selection ({attachedSelection.length} chars)
            </Tag>
          ) : null}
          {context && context.truncated.length > 0 ? (
            <Tooltip title={`Cut to fit: ${context.truncated.join("; ")}`}>
              <Tag color="gold">context trimmed</Tag>
            </Tooltip>
          ) : null}
          {unsavedNote ? (
            <Tooltip title="The assistant reads the saved commit. Save first if you want it to see your edits.">
              <Tag color="gold">unsaved edits not included</Tag>
            </Tooltip>
          ) : null}
        </div>
        <Input.TextArea
          ref={inputRef as never}
          value={input}
          maxLength={MAX_MESSAGE_CHARS}
          variant="borderless"
          autoSize={{ minRows: 1, maxRows: 8 }}
          placeholder={mode === "propose" ? "Describe the change you want proposed..." : focusFile ? `Ask about ${focusFile} or the project...` : "Ask about the project..."}
          aria-label="Message to the assistant"
          onChange={(event) => setInput(event.target.value)}
          onPressEnter={(event) => {
            if (event.shiftKey) return;
            event.preventDefault();
            void submit(input);
          }}
        />
        <div className="fedlify-ws-composer-actions">
          <Segmented
            size="small"
            value={mode}
            onChange={(value) => setMode(value as "ask" | "propose")}
            options={[{ label: "Ask", value: "ask" }, { label: "Propose change", value: "propose" }]}
            aria-label="Assistant mode"
          />
          <span className="fedlify-ws-composer-right">
          {lastMessage?.status === "error" ? (
            <Button size="small" icon={<ReloadOutlined />} onClick={retry}>Retry</Button>
          ) : null}
            {streaming ? (
              <Button shape="circle" danger icon={<StopOutlined />} aria-label="Stop" title="Stop" onClick={() => abortRef.current?.abort()} />
            ) : (
              <Button shape="circle" type="primary" icon={<ArrowUpOutlined />} aria-label={mode === "propose" ? "Propose" : "Send"} title={mode === "propose" ? "Propose" : "Send"} disabled={!input.trim()} onClick={() => void submit(input)} />
            )}
          </span>
        </div>
      </div>
    </aside>
  );
}
