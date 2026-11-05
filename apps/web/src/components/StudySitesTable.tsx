"use client";

import { PlusOutlined } from "@ant-design/icons";
import { Alert, Button, Popover, Tag } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { RecordTable } from "@/components/RecordTable";
import { StatusTag } from "@/components/StatusTag";
import { formatHeartbeat, type SiteOverviewRow } from "@/lib/site-overview";
import { ApiError, apiCall } from "@/lib/web-api";

/** The study's Sites page: one table (site, institution, readiness, kit state, last heartbeat) and a row action to the site page. */
export function StudySitesTable({ studyId, onRegister, canRegister = true }: { studyId: string; onRegister?: () => void; canRegister?: boolean }) {
  const router = useRouter();
  const [rows, setRows] = useState<SiteOverviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await apiCall<{ sites: SiteOverviewRow[] }>(`/api/v1/studies/${studyId}/sites/overview`);
      setRows(body.sites);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Sites could not be loaded.");
    }
  }, [studyId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="fedlify-section-stack">
      {error ? <Alert type="error" showIcon message="Sites could not be loaded" description={error} action={<Button size="small" onClick={() => void load()}>Retry</Button>} /> : null}
      {onRegister && canRegister ? (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button icon={<PlusOutlined />} onClick={onRegister}>
            Register site
          </Button>
        </div>
      ) : null}
      <RecordTable<SiteOverviewRow>
        rowKey="studySiteId"
        loading={rows === null && !error}
        dataSource={rows ?? []}
        emptyText="No participant sites yet. Register at least one institution before releasing site kits."
        columns={[
          {
            title: "Site",
            dataIndex: "name",
            render: (value: string, row) => (
              <span>
                <strong>{value}</strong> <span className="fedlify-muted">{row.code}</span>
              </span>
            )
          },
          { title: "Institution", dataIndex: "institutionName" },
          { title: "Readiness", dataIndex: "readiness", render: (value: string) => <StatusTag value={value} /> },
          { title: "Kit state", dataIndex: "kitState", render: (value: string) => <StatusTag value={value} /> },
          {
            title: "Study image",
            dataIndex: "imageState",
            render: (value: string, row) => {
              if (value === "OUTDATED" || value === "NOT_REPORTED") {
                return (
                  <Popover
                    title="How to bring this site up to date"
                    content={<ol style={{ margin: 0, paddingLeft: 18, maxWidth: 360 }}>{row.imageFix.map((step) => <li key={step}>{step}</li>)}</ol>}
                  >
                    <Tag color="orange" style={{ cursor: "help" }}>{value === "OUTDATED" ? "Outdated: update needed" : "Image not reported"}</Tag>
                  </Popover>
                );
              }
              return value === "CURRENT" ? <Tag color="green">Current</Tag> : <span className="fedlify-muted">-</span>;
            }
          },
          { title: "Connection", dataIndex: "connection", render: (value: string) => <StatusTag value={value} /> },
          {
            title: "Last heartbeat",
            dataIndex: "lastHeartbeatAt",
            render: (value: string | null) => <span title={value ?? undefined}>{formatHeartbeat(value)}</span>
          },
          {
            title: "",
            key: "action",
            render: (_, row) => (
              <Button size="small" onClick={() => router.push(`/sites/${row.studySiteId}`)} aria-label={`Open ${row.name}`}>
                Open
              </Button>
            )
          }
        ]}
        pagination={false}
      />
    </div>
  );
}
