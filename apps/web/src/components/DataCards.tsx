"use client";

import { ArrowRightOutlined, RightOutlined } from "@ant-design/icons";
import { Button, Typography } from "antd";
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

type NavigationCardProps = {
  label: ReactNode;
  metric: ReactNode;
  caption: ReactNode;
  icon: ReactNode;
  onClick: () => void;
};

type NextActionCardProps = {
  title: ReactNode;
  description: ReactNode;
  buttonLabel: ReactNode;
  icon?: ReactNode;
  state?: "ready" | "needs_attention" | "done";
  onClick: () => void;
};

type ActionCardProps = {
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  onClick?: () => void;
};

export function CardGrid({ children, className = "fedlify-entity-grid" }: CardGridProps) {
  return <div className={className}>{children}</div>;
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

export function NavigationCard({ label, metric, caption, icon, onClick }: NavigationCardProps) {
  return (
    <article
      className="fedlify-navigation-card"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => runKeyboardAction(event, onClick)}
    >
      <div className="fedlify-navigation-card-top">
        <span className="fedlify-navigation-icon">{icon}</span>
        <span className="fedlify-navigation-label">{label}</span>
        <span className="fedlify-navigation-open" aria-hidden="true">
          <RightOutlined />
        </span>
      </div>
      <div className="fedlify-navigation-card-body">
        <strong className="fedlify-navigation-metric">{metric}</strong>
        <Typography.Text className="fedlify-navigation-caption">{caption}</Typography.Text>
      </div>
    </article>
  );
}

export function NextActionCard({ title, description, buttonLabel, icon, state = "needs_attention", onClick }: NextActionCardProps) {
  return (
    <article className={`fedlify-next-action-card is-${state}`}>
      <div className="fedlify-next-action-copy">
        {icon ? <span className="fedlify-next-action-icon">{icon}</span> : null}
        <div>
          <Typography.Title level={3}>{title}</Typography.Title>
          <Typography.Text>{description}</Typography.Text>
        </div>
      </div>
      <Button type="primary" className="fedlify-dark-action" icon={<ArrowRightOutlined />} onClick={onClick}>
        {buttonLabel}
      </Button>
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

export function ActionCard({ icon, title, description, onClick }: ActionCardProps) {
  return (
    <article
      className="fedlify-action-card"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => runKeyboardAction(event, onClick)}
    >
      {icon}
      <div>
        <Typography.Title level={4}>{title}</Typography.Title>
        <Typography.Text className="fedlify-muted">{description}</Typography.Text>
      </div>
    </article>
  );
}
