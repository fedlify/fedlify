"use client";

import { ArrowLeftOutlined } from "@ant-design/icons";
import { Button, Space, Typography } from "antd";
import type { ReactNode } from "react";
import { StatusTag } from "@/components/StatusTag";

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
