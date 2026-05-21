"use client";

import { ArrowLeftOutlined } from "@ant-design/icons";
import { Button, Space, Typography } from "antd";
import type { ReactNode } from "react";

type AppPageProps = {
  children: ReactNode;
  className?: string;
};

type AppPageHeaderProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  badges?: ReactNode;
  backLabel?: string;
  onBack?: () => void;
};

type SectionHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
};

type BackLinkProps = {
  label?: string;
  onClick: () => void;
};

export function AppPage({ children, className }: AppPageProps) {
  return <section className={["fedlify-workspace-panel", "fedlify-card-page", className].filter(Boolean).join(" ")}>{children}</section>;
}

export function AppPageHeader({ title, subtitle, actions, badges, backLabel, onBack }: AppPageHeaderProps) {
  return (
    <div className="fedlify-card-page-header">
      <div className="fedlify-page-title-block">
        <div className="fedlify-title-row">
          {onBack ? <BackLink onClick={onBack} label={backLabel ?? "Back"} /> : null}
          <div className="fedlify-title-copy">
            <Typography.Title level={1} className="fedlify-display-title">
              {title}
            </Typography.Title>
            {subtitle ? <Typography.Text className="fedlify-display-subtitle">{subtitle}</Typography.Text> : null}
          </div>
        </div>
      </div>
      {actions || badges ? (
        <div className="fedlify-page-header-actions">
          {actions}
          {badges}
        </div>
      ) : null}
    </div>
  );
}

export function SectionHeader({ title, description, actions }: SectionHeaderProps) {
  return (
    <div className="fedlify-section-header">
      <div className="fedlify-section-title-copy">
        <Typography.Title level={2}>{title}</Typography.Title>
        {description ? <Typography.Text className="fedlify-muted">{description}</Typography.Text> : null}
      </div>
      {actions ? <Space wrap>{actions}</Space> : null}
    </div>
  );
}

export function BackLink({ label = "Back", onClick }: BackLinkProps) {
  return (
    <Button
      type="text"
      className="fedlify-back-link"
      icon={<ArrowLeftOutlined />}
      aria-label={label}
      title={label}
      onClick={onClick}
    />
  );
}
