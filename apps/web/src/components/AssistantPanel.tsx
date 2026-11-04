"use client";

import { ClearOutlined, MenuFoldOutlined, MenuUnfoldOutlined, ReloadOutlined, RobotOutlined, SendOutlined, StopOutlined } from "@ant-design/icons";
import { Alert, Button, Input, Tag, Tooltip, Typography } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_MESSAGE_CHARS, MAX_SELECTION_CHARS, buildHistory, createSseParser, splitFences } from "@/lib/assistant-stream";

export type AskRequest = { id: number; path: string; selection?: string };

type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "done" | "error" | "stopped";
  error?: string;
  notice?: string;
};

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
};

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

function MessageBody({ message }: { message: ChatMessage }) {
  if (message.role === "user") return <p className="fedlify-ws-msg-text">{message.content}</p>;
  return (
    <>
      {splitFences(message.content).map((part, index) =>
        part.type === "code" ? (
          <pre key={index} className="fedlify-ws-msg-code"><code>{part.value}</code></pre>
        ) : (
          <p key={index} className="fedlify-ws-msg-text">{part.value}</p>
        )
      )}
      {message.status === "streaming" && !message.content ? <span className="fedlify-muted">Thinking...</span> : null}
    </>
  );
}

export function AssistantPanel({ studyId, projectId, commit, focusFile, unsavedPaths, open, onToggle, askRequest }: AssistantPanelProps) {
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
  const streaming = messages.some((message) => message.status === "streaming");

  const update = useCallback((updater: (current: ChatMessage[]) => ChatMessage[]) => {
    setMessages((current) => {
      const next = updater(current);
      messagesRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

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
    async (rawText: string) => {
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
            selection: attachedSelection ? attachedSelection.slice(0, MAX_SELECTION_CHARS) : undefined
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

  function retry() {
    const current = messagesRef.current;
    const lastUser = [...current].reverse().find((message) => message.role === "user");
    if (!lastUser) return;
    update((items) => items.slice(0, items.length - 2));
    void send(lastUser.content);
  }

  function clearChat() {
    abortRef.current?.abort();
    update(() => []);
    setContext(null);
    setSelection(null);
  }

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
          <Tag className="fedlify-ws-readonly">Read-only</Tag>
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

      <div className="fedlify-ws-log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation">
        {messages.length === 0 ? (
          <div className="fedlify-ws-quick">
            <Typography.Text className="fedlify-muted">
              Ask about this project. It can read your study context and the saved code, but it cannot save, publish, run, or release anything.
            </Typography.Text>
            <div className="fedlify-ws-quick-list">
              {QUICK_PROMPTS.map((prompt) => (
                <Button key={prompt} size="small" onClick={() => void send(prompt)}>{prompt}</Button>
              ))}
              {focusFile ? <Button size="small" onClick={() => void send(`Explain ${focusFile}`)}>{`Explain ${focusFile}`}</Button> : null}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`fedlify-ws-msg is-${message.role}`}>
              <span className="fedlify-ws-msg-role">{message.role === "user" ? "You" : "Assistant"}</span>
              <MessageBody message={message} />
              {message.notice ? <Typography.Text type="warning">{message.notice}</Typography.Text> : null}
              {message.status === "stopped" ? <Typography.Text className="fedlify-muted">Stopped.</Typography.Text> : null}
              {message.status === "error" ? <Alert type="error" showIcon message={message.error ?? "The assistant failed."} /> : null}
            </div>
          ))
        )}
      </div>

      <div className="fedlify-ws-composer">
        <Input.TextArea
          ref={inputRef as never}
          value={input}
          maxLength={MAX_MESSAGE_CHARS}
          autoSize={{ minRows: 2, maxRows: 6 }}
          placeholder={focusFile ? `Ask about ${focusFile} or the project...` : "Ask about the project..."}
          aria-label="Message to the assistant"
          onChange={(event) => setInput(event.target.value)}
          onPressEnter={(event) => {
            if (event.shiftKey) return;
            event.preventDefault();
            void send(input);
          }}
        />
        <div className="fedlify-ws-composer-actions">
          {lastMessage?.status === "error" ? (
            <Button size="small" icon={<ReloadOutlined />} onClick={retry}>Retry</Button>
          ) : <span />}
          {streaming ? (
            <Button danger icon={<StopOutlined />} onClick={() => abortRef.current?.abort()}>Stop</Button>
          ) : (
            <Button type="primary" icon={<SendOutlined />} disabled={!input.trim()} onClick={() => void send(input)}>Send</Button>
          )}
        </div>
      </div>
    </aside>
  );
}
