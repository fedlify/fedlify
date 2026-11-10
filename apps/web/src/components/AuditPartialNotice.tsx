"use client";

import { Alert } from "antd";

/** Shown when the audit endpoint holds more events than the table loaded, so the table never looks complete when it is not. */
export function AuditPartialNotice({ shown, total }: { shown: number | null; total: number | null }) {
  if (shown === null || total === null || total <= shown) return null;
  return <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={`Showing the latest ${shown} of ${total} activity entries`} description="Export the log (CSV) for the complete list." data-testid="audit-partial" />;
}
