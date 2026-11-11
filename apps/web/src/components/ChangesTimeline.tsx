"use client";

import { Button, Empty, Modal, Segmented, Spin, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import type { CommitDiff } from "@/lib/agent-timeline";
import { getCommitDiff, getTimeline, relativeTime } from "@/lib/agent-thread-client";
import { StatusTag, type StatusTone } from "@/components/StatusTag";
import { statusLabel } from "@/lib/terms";
import type { TimelineEntryDto, TimelineKind } from "@/lib/agent-thread-types";

type Filter = "all" | "agent" | "manual" | "published";
const KIND_LABEL: Record<TimelineKind, string> = { agent: "Assistant", manual: "Manual save", published: "Published", rejected: "Rejected", external: "External or unrecorded" };
const KIND_TONE: Record<TimelineKind, StatusTone> = { agent: "info", manual: "info", published: "success", rejected: "neutral", external: "warning" };

/** What changed in this project: agent proposals, manual saves, publishes. Diff opens the proposal review; Open thread jumps to the chat. */
export function ChangesTimeline({
  studyId,
  projectId,
  refreshKey,
  onReviewProposal,
  onOpenThread
}: {
  studyId: string;
  projectId: string;
  refreshKey: number;
  onReviewProposal: (proposalId: string) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [entries, setEntries] = useState<TimelineEntryDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ commit: string; loading: boolean; data: CommitDiff | null; error: string | null } | null>(null);

  const openCommitDiff = async (commit: string) => {
    setDiff({ commit, loading: true, data: null, error: null });
    const result = await getCommitDiff(studyId, projectId, commit);
    setDiff((current) => (current && current.commit === commit ? { commit, loading: false, data: result.ok ? result : null, error: result.ok ? null : result.message } : current));
  };

  const load = useCallback(
    async (next: string | null) => {
      setLoading(true);
      const result = await getTimeline(studyId, projectId, { cursor: next, kind: filter === "all" ? undefined : filter });
      setLoading(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setError(null);
      setEntries((current) => (next ? [...current, ...result.entries] : result.entries));
      setCursor(result.nextCursor);
    },
    [studyId, projectId, filter]
  );

  useEffect(() => {
    void load(null);
  }, [load, refreshKey]);

  return (
    <div className="fedlify-ws-changes" data-testid="changes-timeline">
      <Segmented size="small" value={filter} onChange={(value) => setFilter(value as Filter)} options={[{ label: "All", value: "all" }, { label: "Assistant", value: "agent" }, { label: "Manual", value: "manual" }, { label: "Published", value: "published" }]} aria-label="Filter changes" />
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      {entries.length === 0 && !loading && !error ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No changes yet" /> : null}
      <ul className="fedlify-ws-changes-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <div className="fedlify-ws-changes-head">
              <StatusTag tone={KIND_TONE[entry.kind]} label={KIND_LABEL[entry.kind]} />
              <span className="fedlify-muted">{relativeTime(entry.at)}</span>
              {entry.commit ? <code title="Commit">{entry.commit.slice(0, 7)}</code> : null}
            </div>
            <div>{entry.title}</div>
            <div className="fedlify-muted">
              {[entry.actor.name, entry.added !== null && entry.removed !== null ? `+${entry.added} -${entry.removed}` : null, entry.published ? `v${entry.published.version} published${entry.published.approvedByName ? `, approved by ${entry.published.approvedByName}` : ""}` : null, entry.proposalStatus && entry.kind !== "agent" ? statusLabel(entry.proposalStatus).toLowerCase() : null]
                .filter(Boolean)
                .join(" - ")}
            </div>
            <div className="fedlify-ws-card-actions">
              {entry.proposalId ? <Button size="small" onClick={() => onReviewProposal(entry.proposalId!)}>Diff</Button> : null}
              {!entry.proposalId && entry.commit ? <Button size="small" onClick={() => void openCommitDiff(entry.commit!)}>Diff</Button> : null}
              {entry.threadId ? <Button size="small" type="link" onClick={() => onOpenThread(entry.threadId!)}>Open thread</Button> : null}
            </div>
          </li>
        ))}
      </ul>
      <Modal open={diff !== null} onCancel={() => setDiff(null)} footer={null} width={900} title={diff ? "Saved change" : ""}>
        {diff ? <Typography.Text className="fedlify-muted" title={diff.commit}>Commit {diff.commit.slice(0, 7)}</Typography.Text> : null}
        {diff?.loading ? <Spin /> : null}
        {diff?.error ? <Typography.Text type="danger">{diff.error}</Typography.Text> : null}
        {diff?.data?.files.map((file) => (
          <details key={file.path} open={diff.data!.files.length === 1}>
            <summary><code>{file.path}</code> <span className="fedlify-muted">{file.status}</span></summary>
            {file.before === null && file.after === null ? (
              <Typography.Text className="fedlify-muted">Contents are not shown for this file.</Typography.Text>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <pre style={{ overflow: "auto", maxHeight: 320 }}>{file.before ?? "(none)"}</pre>
                <pre style={{ overflow: "auto", maxHeight: 320 }}>{file.after ?? "(none)"}</pre>
              </div>
            )}
            {file.truncated ? <Typography.Text className="fedlify-muted">Long file shortened.</Typography.Text> : null}
          </details>
        ))}
        {diff?.data && diff.data.omitted > 0 ? <Typography.Text className="fedlify-muted">{`${diff.data.omitted} more files not shown.`}</Typography.Text> : null}
      </Modal>
      {cursor ? <Button size="small" loading={loading} onClick={() => void load(cursor)}>Load more</Button> : null}
    </div>
  );
}
