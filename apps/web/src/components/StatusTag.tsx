"use client";

import { Tag } from "antd";

const colors: Record<string, string> = {
  APPROVED: "green",
  NOT_REQUIRED: "cyan",
  PENDING: "gold",
  REJECTED: "red",
  EXPIRED: "volcano",
  DRAFT_READY: "blue",
  VALIDATED: "green",
  QUEUED: "gold",
  RUNNING: "processing",
  FAILED: "red",
  ACTIVE: "green",
  DRAFT: "blue",
  CONNECTED: "green",
  OFFLINE: "red",
  DEGRADED: "orange"
};

function formatStatus(value: string) {
  return value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function StatusTag({ value }: { value?: string | null }) {
  if (!value) return <Tag>Unknown</Tag>;
  return <Tag color={colors[value] ?? "default"}>{formatStatus(value)}</Tag>;
}
