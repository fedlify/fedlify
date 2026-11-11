"use client";

import { FileSearchOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Skeleton, Typography } from "antd";
import type { ReactNode } from "react";

type CardGridSkeletonProps = {
  count?: number;
  className?: string;
};

export function CardGridSkeleton({ count = 4, className = "fl-grid" }: CardGridSkeletonProps) {
  return (
    <div className={className} aria-label="Loading cards">
      {Array.from({ length: count }).map((_, index) => (
        <article key={index} className="fedlify-skeleton-card fl-card">
          <Skeleton active paragraph={{ rows: 3 }} title={{ width: "62%" }} />
        </article>
      ))}
    </div>
  );
}

export function InlineLoadError({
  message,
  onRetry,
  title = "Content could not be loaded"
}: {
  message?: string;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <Alert
      className="fedlify-inline-alert"
      type="error"
      showIcon
      message={title}
      description={message ?? "Check the connection and try again."}
      action={
        onRetry ? (
          <Button icon={<ReloadOutlined />} onClick={onRetry}>
            Retry
          </Button>
        ) : null
      }
    />
  );
}

export function EmptyState({
  icon = <FileSearchOutlined />,
  title = "No records",
  description,
  action,
  compact = false
}: {
  icon?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  /** One button that fixes the emptiness, for example "Create study". */
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`fedlify-empty-state${compact ? " is-compact" : ""}`}>
      <span className="fedlify-empty-state-icon">{icon}</span>
      <Typography.Text className="fedlify-empty-state-title">{title}</Typography.Text>
      {description ? <Typography.Text className="fedlify-empty-state-description">{description}</Typography.Text> : null}
      {action}
    </div>
  );
}

export function CardListState({
  loading,
  error,
  onRetry,
  isEmpty,
  emptyTitle,
  emptyDescription,
  emptyIcon,
  emptyAction,
  skeletonCount = 3,
  skeletonClassName = "fl-grid",
  children
}: {
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
  isEmpty: boolean;
  emptyTitle?: ReactNode;
  emptyDescription?: ReactNode;
  emptyIcon?: ReactNode;
  emptyAction?: ReactNode;
  skeletonCount?: number;
  skeletonClassName?: string;
  children: ReactNode;
}) {
  if (loading) return <CardGridSkeleton count={skeletonCount} className={skeletonClassName} />;
  if (error) return <InlineLoadError message={error} onRetry={onRetry} />;
  if (isEmpty) {
    return (
      <EmptyState
        icon={emptyIcon}
        title={emptyTitle ?? emptyDescription ?? "No records"}
        description={emptyTitle ? emptyDescription : undefined}
        action={emptyAction}
      />
    );
  }
  return <>{children}</>;
}
