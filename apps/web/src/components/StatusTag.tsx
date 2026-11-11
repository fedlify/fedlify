"use client";

import { Tag, type TagProps } from "antd";
import type { ReactNode } from "react";
import { statusLabel } from "@/lib/terms";

/** One colour per meaning: success = done, info = in progress, warning = needs attention, danger = problem, neutral = nothing to act on. */
export type StatusTone = "success" | "info" | "warning" | "danger" | "neutral";

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
  OUTDATED: "warning",
  NEEDS_ATTENTION: "warning",
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
  RELEASED: "info",
  RUNNING: "info",
  SUBMITTED: "info",

  DRAFT: "neutral",
  EVENT: "neutral",
  INTAKE: "neutral",
  INVITED: "neutral",
  NOT_CREATED: "neutral",
  NOT_RELEASED: "neutral",
  ARCHIVED: "neutral",
  NOT_STARTED: "neutral",
  OPTIONAL: "neutral",
  PENDING: "neutral",
  PENDING_CHANGES: "neutral"
};

function normalizeStatus(value?: string | null) {
  return String(value ?? "UNKNOWN").trim().toUpperCase().replace(/\s+/g, "_");
}

/** The only status tag. Give it a status value, or a tone and a label for a status that is not an enum value. */
export function StatusTag({ value, label, tone, ...rest }: { value?: string | null; label?: ReactNode; tone?: StatusTone } & Omit<TagProps, "color" | "children">) {
  const normalized = normalizeStatus(value);
  return (
    <Tag className="fedlify-status-tag" data-status={normalized} data-tone={tone ?? tones[normalized] ?? "neutral"} {...rest}>
      {label ?? statusLabel(value)}
    </Tag>
  );
}
