"use client";

import { Typography } from "antd";
import type { KeyboardEvent, ReactNode } from "react";

function runKeyboardAction(event: KeyboardEvent<HTMLElement>, action?: () => void) {
  if (!action) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

type CardGridProps = {
  children: ReactNode;
  className?: string;
};

type StatCardProps = {
  label: ReactNode;
  value: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
};

type EntityCardProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  meta?: ReactNode[];
  actionsMenu?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  onClick?: () => void;
};

type WorkspaceCardTone = "default" | "ready" | "needs_attention" | "blocked" | "optional" | "active" | "muted";

type WorkspaceCardGridProps = {
  children: ReactNode;
  className?: string;
};

type WorkspaceBaseCardProps = {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  meta?: ReactNode[];
  actionsMenu?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: WorkspaceCardTone;
  ariaLabel?: string;
};

export function CardGrid({ children, className = "fl-grid" }: CardGridProps) {
  return <div className={className}>{children}</div>;
}

export function WorkspaceCardGrid({ children, className }: WorkspaceCardGridProps) {
  return <div className={["fl-grid", className].filter(Boolean).join(" ")}>{children}</div>;
}

function workspaceClickProps(onClick?: () => void, disabled = false, ariaLabel?: string) {
  if (!onClick || disabled) {
    return {
      "aria-disabled": disabled || undefined,
      "aria-label": ariaLabel
    };
  }

  return {
    role: "button",
    tabIndex: 0,
    onClick,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => runKeyboardAction(event, onClick),
    "aria-label": ariaLabel
  };
}

function workspaceCardClass(baseClass: string, tone: WorkspaceCardTone = "default", disabled = false, className?: string) {
  return [baseClass, `is-${tone}`, disabled ? "is-disabled" : "", className].filter(Boolean).join(" ");
}

function WorkspaceCardMain({ icon, title, description }: { icon: ReactNode; title: ReactNode; description?: ReactNode }) {
  return (
    <span className="fedlify-workspace-card-main">
      <span className="fedlify-workspace-card-icon">{icon}</span>
      <span className="fedlify-workspace-card-copy">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
      </span>
    </span>
  );
}

export function WorkspaceRecordCard({
  icon,
  title,
  description,
  status,
  meta = [],
  actionsMenu,
  onClick,
  disabled = false,
  tone = "default",
  ariaLabel
}: WorkspaceBaseCardProps) {
  return (
    <article
      className={workspaceCardClass("fedlify-workspace-record-card", tone, disabled)}
      {...workspaceClickProps(onClick, disabled, ariaLabel)}
    >
      <WorkspaceCardMain icon={icon} title={title} description={description} />
      {status || actionsMenu ? (
        <span className="fedlify-workspace-card-meta">
          {status}
          {actionsMenu}
        </span>
      ) : null}
      {meta.length > 0 ? (
        <span className="fedlify-workspace-card-data">
          {meta.map((item, index) => (
            <span key={index}>{item}</span>
          ))}
        </span>
      ) : null}
    </article>
  );
}

export function StatCard({ label, value, icon, onClick }: StatCardProps) {
  const clickableProps = onClick
    ? {
        role: "button",
        tabIndex: 0,
        onClick,
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => runKeyboardAction(event, onClick)
      }
    : {};

  return (
    <article className={`fedlify-stat-card${onClick ? " is-clickable" : ""}`} {...clickableProps}>
      {icon ? <span className="fedlify-stat-icon">{icon}</span> : null}
      <span className={`fedlify-stat-value${typeof value === "number" ? "" : " is-text"}`}>{value}</span>
      <span className="fedlify-stat-label">{label}</span>
    </article>
  );
}

export function EntityCard({ title, subtitle, status, meta = [], actionsMenu, actions, children, className, onClick }: EntityCardProps) {
  const clickableProps = onClick
    ? {
        role: "button",
        tabIndex: 0,
        onClick,
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => runKeyboardAction(event, onClick)
      }
    : {};

  return (
    <article className={["fedlify-entity-card", className].filter(Boolean).join(" ")} {...clickableProps}>
      <div className="fedlify-entity-card-top">
        <Typography.Title level={4}>{title}</Typography.Title>
        <span className="fedlify-entity-card-top-actions">
          {status}
          {actionsMenu}
        </span>
      </div>
      {subtitle ? <Typography.Text className="fedlify-muted">{subtitle}</Typography.Text> : null}
      {meta.length > 0 ? (
        <div className="fedlify-entity-card-meta">
          {meta.map((item, index) => (
            <span key={index}>{item}</span>
          ))}
        </div>
      ) : null}
      {children}
      {actions ? <div className="fedlify-entity-card-actions">{actions}</div> : null}
    </article>
  );
}
