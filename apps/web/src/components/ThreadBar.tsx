"use client";

import { InboxOutlined } from "@ant-design/icons";
import { Button, Tag, Tooltip, Typography } from "antd";
import { StatusTag } from "@/components/StatusTag";
import { PHASE_LABEL, PLAN_STATUS_LABEL, type ThreadView } from "@/lib/agent-thread-client";

/** Current chat: title (renamable by someone who may), phase, plan version and the commit the plan is based on. */
export function ThreadBar({
  view,
  head,
  onRename,
  onArchive
}: {
  view: ThreadView;
  head: string | null;
  onRename: (title: string) => void;
  onArchive: () => void;
}) {
  const plan = view.plans.reduce<ThreadView["plans"][number] | null>((best, item) => (!best || item.version > best.version ? item : best), null);
  const archived = view.thread.status === "ARCHIVED";
  return (
    <div className="fedlify-ws-threadbar" data-testid="thread-bar">
      <Typography.Text
        className="fedlify-ws-threadbar-title"
        strong
        ellipsis
        editable={view.canArchive && !view.metadataOnly ? { onChange: (value) => value.trim() && value.trim() !== view.thread.title && onRename(value.trim()), maxLength: 80, tooltip: "Rename chat" } : false}
      >
        {view.metadataOnly ? "Chat (details hidden)" : view.thread.title}
      </Typography.Text>
      <span className="fedlify-ws-threadbar-tags">
        {archived ? <Tag>Archived</Tag> : null}
        <StatusTag tone={view.phase === "NEEDS_INPUT" || view.phase === "PLAN_DRAFT" ? "info" : view.phase === "STALE" ? "warning" : view.phase === "ACCEPTED" ? "success" : "neutral"} label={PHASE_LABEL[view.phase]} />
        {plan ? (
          <Tooltip title={`${PLAN_STATUS_LABEL[plan.status]}. Based on commit ${plan.baseCommit.slice(0, 8)}${head && head !== plan.baseCommit ? `; the saved head is now ${head.slice(0, 8)}` : ""}.`}>
            <Tag>{`plan v${plan.version} base ${plan.baseCommit.slice(0, 7)}`}</Tag>
          </Tooltip>
        ) : null}
        {view.canArchive && !archived ? (
          <Tooltip title="Archive chat (hides it from the list; nothing is deleted)">
            <Button size="small" type="text" icon={<InboxOutlined />} onClick={onArchive} aria-label="Archive chat" />
          </Tooltip>
        ) : null}
      </span>
    </div>
  );
}
