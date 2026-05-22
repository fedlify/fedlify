"use client";

import { ArrowLeftOutlined, MoreOutlined } from "@ant-design/icons";
import { Button, Dropdown, Space, Typography } from "antd";
import type { ItemType } from "antd/es/menu/interface";
import type { MouseEvent, ReactNode } from "react";
import { StatusTag } from "@/components/StatusTag";

export type EntityActionItem = {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  href?: string;
  target?: string;
  onClick?: () => void;
};

type EntityActionMenuProps = {
  items: EntityActionItem[];
  label?: string;
};

type EntityDetailViewProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  onBack: () => void;
  children: ReactNode;
  technicalMetadata?: unknown;
  bodyOnly?: boolean;
};

type FieldGridProps = {
  children: ReactNode;
};

type FieldRowProps = {
  label: ReactNode;
  value?: ReactNode;
  full?: boolean;
};

type ArtifactListProps = {
  artifacts?: Array<Record<string, any>>;
  onDownload?: (artifact: Record<string, any>) => void;
};

type TimelineListProps = {
  events?: Array<Record<string, any>>;
  emptyText?: string;
};

function stopMenuClick(event: MouseEvent<HTMLElement>) {
  event.stopPropagation();
}

export function EntityActionMenu({ items, label = "Actions" }: EntityActionMenuProps) {
  const menuItems: ItemType[] = items
    .filter(Boolean)
    .map((item) => ({
      key: item.key,
      icon: item.icon,
      danger: item.danger,
      disabled: item.disabled,
      label: item.href ? (
        <a href={item.href} target={item.target} rel={item.target === "_blank" ? "noreferrer" : undefined}>
          {item.label}
        </a>
      ) : (
        item.label
      ),
      onClick: item.onClick
    }));

  if (menuItems.length === 0) return null;

  return (
    <Dropdown menu={{ items: menuItems }} trigger={["click"]}>
      <Button
        type="text"
        className="fedlify-card-menu-button"
        icon={<MoreOutlined />}
        aria-label={label}
        title={label}
        onClick={stopMenuClick}
      />
    </Dropdown>
  );
}

export function EntityDetailView({ title, subtitle, status, actions, onBack, children, technicalMetadata, bodyOnly = false }: EntityDetailViewProps) {
  return (
    <div className={["fedlify-entity-detail", bodyOnly ? "is-body-only" : ""].filter(Boolean).join(" ")}>
      {bodyOnly ? null : (
        <div className="fedlify-entity-detail-header">
          <div className="fedlify-title-row">
            <Button
              type="text"
              className="fedlify-back-link"
              icon={<ArrowLeftOutlined />}
              aria-label="Back to list"
              title="Back to list"
              onClick={onBack}
            />
            <div className="fedlify-title-copy">
              <div className="fedlify-entity-detail-title-row">
                <Typography.Title level={2}>{title}</Typography.Title>
                {status}
              </div>
              {subtitle ? <Typography.Text className="fedlify-muted">{subtitle}</Typography.Text> : null}
            </div>
          </div>
          {actions ? <Space wrap>{actions}</Space> : null}
        </div>
      )}
      {children}
      {technicalMetadata !== undefined ? (
        <details className="fedlify-technical-metadata">
          <summary>Technical metadata</summary>
          <pre className="fedlify-detail-json">{JSON.stringify(technicalMetadata, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

export function FieldGrid({ children }: FieldGridProps) {
  return <div className="fedlify-field-grid">{children}</div>;
}

export function FieldRow({ label, value, full }: FieldRowProps) {
  return (
    <div className={["fedlify-field-row", full ? "is-full" : ""].filter(Boolean).join(" ")}>
      <span>{label}</span>
      <strong>{value ?? "Not set"}</strong>
    </div>
  );
}

export function ArtifactList({ artifacts = [], onDownload }: ArtifactListProps) {
  if (artifacts.length === 0) {
    return <Typography.Text className="fedlify-muted">No artifacts recorded.</Typography.Text>;
  }

  return (
    <div className="fedlify-artifact-list">
      {artifacts.map((artifact, index) => (
        <div key={artifact.id ?? `${artifact.filename}-${index}`} className="fedlify-artifact-row">
          <div>
            <Typography.Text strong>{artifact.filename ?? artifact.path ?? artifact.kind ?? "Artifact"}</Typography.Text>
            <Typography.Text className="fedlify-muted">
              {[artifact.kind, artifact.checksum ? String(artifact.checksum).slice(0, 16) : null, artifact.sizeBytes ? `${artifact.sizeBytes} bytes` : null]
                .filter(Boolean)
                .join(" · ")}
            </Typography.Text>
          </div>
          {onDownload ? (
            <Button size="small" onClick={() => onDownload(artifact)}>
              Download
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function TimelineList({ events = [], emptyText = "No events recorded." }: TimelineListProps) {
  if (events.length === 0) return <Typography.Text className="fedlify-muted">{emptyText}</Typography.Text>;

  return (
    <div className="fedlify-job-event-list">
      {events.map((event, index) => (
        <div key={event.id ?? index} className="fedlify-job-event">
          <StatusTag value={event.eventType ?? event.action ?? event.status ?? "EVENT"} />
          <div>
            <strong>{event.message ?? event.action ?? "Event"}</strong>
            <span>{event.createdAt ?? event.timestamp ?? "Time not recorded"}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
