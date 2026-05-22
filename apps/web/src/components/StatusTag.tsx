"use client";

import { Tag } from "antd";
import type { ReactNode } from "react";

type StatusTone = "success" | "warning" | "danger" | "info" | "neutral" | "muted";

const tones: Record<string, StatusTone> = {
  ACCEPTED: "success",
  ACTIVE: "success",
  APPROVED: "success",
  CLEAN: "success",
  COMPLETED: "success",
  CONNECTED: "success",
  DONE: "success",
  MERGED: "success",
  NOT_REQUIRED: "success",
  PASSED: "success",
  READY: "success",
  VALIDATED: "success",

  DEGRADED: "warning",
  EXPIRED: "warning",
  NEEDS_ATTENTION: "warning",
  PENDING: "warning",
  QUEUED: "warning",
  SCHEDULED: "warning",
  WARNING: "warning",

  ABORTED: "danger",
  BLOCKED: "danger",
  DISABLED: "danger",
  FAILED: "danger",
  OFFLINE: "danger",
  REJECTED: "danger",

  CODING: "info",
  DRAFT_READY: "info",
  KIT_RELEASED: "info",
  NEXT: "info",
  PROVISIONED: "info",
  RUNNING: "info",
  SUBMITTED: "info",

  ARCHIVED: "muted",
  OPTIONAL: "muted",

  DRAFT: "neutral",
  EVENT: "neutral",
  INTAKE: "neutral",
  INVITED: "neutral",
  NOT_CREATED: "neutral",
  NOT_STARTED: "neutral",
  PENDING_CHANGES: "neutral"
};

function formatStatus(value: string) {
  return value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeStatus(value?: string | null) {
  return String(value ?? "UNKNOWN").trim().toUpperCase().replace(/\s+/g, "_");
}

export function StatusTag({ value, label }: { value?: string | null; label?: ReactNode }) {
  const normalized = normalizeStatus(value);
  return (
    <Tag className="fedlify-status-tag" data-status={normalized} data-tone={tones[normalized] ?? "neutral"}>
      {label ?? formatStatus(normalized)}
    </Tag>
  );
}
