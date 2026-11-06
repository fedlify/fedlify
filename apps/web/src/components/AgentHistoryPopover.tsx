"use client";

import { HistoryOutlined, InboxOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Checkbox, Empty, Input, Popover, Tag, Tooltip, Typography } from "antd";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RETENTION_NOTICE, listThreads, relativeTime, threadRowSubtitle } from "@/lib/agent-thread-client";
import type { ThreadSummaryDto } from "@/lib/agent-thread-types";

/** Chat history: search, load more, show archived, archive/restore. Opening a row loads that thread. */
export function AgentHistoryPopover({
  studyId,
  projectId,
  activeId,
  refreshKey,
  disabled,
  onSelect,
  onNew,
  onSetArchived
}: {
  studyId: string;
  projectId: string;
  activeId: string | null;
  /** Changes whenever a thread was created, renamed or archived elsewhere. */
  refreshKey: number;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSetArchived: (id: string, archived: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [archived, setArchived] = useState(false);
  const [rows, setRows] = useState<ThreadSummaryDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (next: string | null) => {
      setLoading(true);
      const result = await listThreads(studyId, projectId, { cursor: next, q, status: archived ? "ARCHIVED" : "ACTIVE" });
      setLoading(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setError(null);
      setRows((current) => (next ? [...current, ...result.threads] : result.threads));
      setCursor(result.nextCursor);
    },
    [studyId, projectId, q, archived]
  );

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void load(null), q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [open, load, q, refreshKey]);

  const content: ReactNode = (
    <div className="fedlify-ws-history" data-testid="history-popover">
      <div className="fedlify-ws-history-head">
        <Input.Search size="small" allowClear placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search chats" />
        <Checkbox checked={archived} onChange={(e) => setArchived(e.target.checked)}>Archived</Checkbox>
      </div>
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      {rows.length === 0 && !loading && !error ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={archived ? "No archived chats" : "No chats yet"} /> : null}
      <ul className="fedlify-ws-history-list">
        {rows.map((row) => (
          <li key={row.id} className={row.id === activeId ? "is-active" : undefined}>
            <button type="button" className="fedlify-ws-history-row" onClick={() => { setOpen(false); onSelect(row.id); }}>
              <span className="fedlify-ws-history-title">{row.title || "Untitled chat"}</span>
              <span className="fedlify-muted">
                {[row.createdBy.name ?? "Unknown", relativeTime(row.lastTurnAt), threadRowSubtitle(row)].filter(Boolean).join(" - ")}
              </span>
              {row.foreign ? <Tag>read-only</Tag> : null}
            </button>
            <Tooltip title={row.status === "ARCHIVED" ? "Restore chat" : "Archive chat"}>
              <Button size="small" type="text" icon={<InboxOutlined />} aria-label={row.status === "ARCHIVED" ? "Restore chat" : "Archive chat"} onClick={() => onSetArchived(row.id, row.status !== "ARCHIVED")} />
            </Tooltip>
          </li>
        ))}
      </ul>
      {cursor ? <Button size="small" type="link" loading={loading} onClick={() => void load(cursor)}>Load more</Button> : null}
      <Typography.Text className="fedlify-muted fedlify-ws-history-note">{RETENTION_NOTICE}</Typography.Text>
    </div>
  );

  return (
    <span className="fedlify-ws-history-buttons">
      <Popover content={content} trigger="click" placement="bottomRight" open={open} onOpenChange={setOpen} title="History" arrowPointAtCenter>
        <Tooltip title="Chat history">
          <Button size="small" type="text" icon={<HistoryOutlined />} aria-label="Chat history" />
        </Tooltip>
      </Popover>
      <Tooltip title="New chat">
        <Button size="small" type="text" icon={<PlusOutlined />} onClick={onNew} disabled={disabled} aria-label="New chat" />
      </Tooltip>
    </span>
  );
}
