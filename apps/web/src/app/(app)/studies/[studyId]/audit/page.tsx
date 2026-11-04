"use client";

import { DownloadOutlined } from "@ant-design/icons";
import { Alert, Button, DatePicker, Input, Select, Space, Typography } from "antd";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppPage, AppPageHeader } from "@/components/AppPage";
import { RecordTable } from "@/components/RecordTable";
import { StatusTag } from "@/components/StatusTag";
import type { AuditEventDto } from "@/lib/audit-query";
import { ApiError, apiCall } from "@/lib/web-api";

type AuditPayload = {
  events: AuditEventDto[];
  page: number;
  pageSize: number;
  total: number;
  facets: { actions: string[]; actors: Array<{ id: string; name: string }> };
};
type Filters = { actor?: string; action?: string; target?: string; from?: string; to?: string };

function buildQuery(filters: Filters, extra: Record<string, string> = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...extra })) if (value) params.set(key, value);
  return params.toString();
}

export default function StudyAuditPage() {
  const { studyId } = useParams<{ studyId: string }>();
  const [filters, setFilters] = useState<Filters>({});
  const [targetDraft, setTargetDraft] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState<AuditPayload | null>(null);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiCall<AuditPayload>(`/api/v1/studies/${studyId}/audit?${buildQuery(filters, { page: String(page), pageSize: String(pageSize) })}`));
      setError(null);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : "Audit log could not be loaded.", status: err instanceof ApiError ? err.status : undefined });
    } finally {
      setLoading(false);
    }
  }, [studyId, filters, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportHref = useMemo(() => (format: "csv" | "json") => `/api/v1/studies/${studyId}/audit?${buildQuery(filters, { format })}`, [studyId, filters]);

  function applyFilter(next: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...next }));
    setPage(1);
  }

  return (
    <AppPage>
      <AppPageHeader
        title="Audit log"
        subtitle="Study-scoped events for access, governance, artifacts, runs, and release decisions."
        actions={
          <Space>
            <Button icon={<DownloadOutlined />} href={exportHref("csv")} disabled={!data}>
              Export CSV
            </Button>
            <Button icon={<DownloadOutlined />} href={exportHref("json")} disabled={!data}>
              Export JSON
            </Button>
          </Space>
        }
      />
      {error ? (
        <Alert
          type={error.status === 403 ? "warning" : "error"}
          showIcon
          message={error.status === 403 ? "You do not have access to this study's audit log" : "Audit log could not be loaded"}
          description={error.message}
        />
      ) : (
        <div className="fedlify-section-stack">
          <Space wrap>
            <Select
              allowClear
              showSearch
              placeholder="Action"
              style={{ minWidth: 220 }}
              value={filters.action}
              options={(data?.facets.actions ?? []).map((value) => ({ value, label: value }))}
              onChange={(value) => applyFilter({ action: value })}
            />
            <Select
              allowClear
              placeholder="Actor"
              style={{ minWidth: 200 }}
              value={filters.actor}
              options={(data?.facets.actors ?? []).map((actor) => ({ value: actor.id, label: actor.name }))}
              onChange={(value) => applyFilter({ actor: value })}
            />
            <Input.Search
              allowClear
              placeholder="Target or run id"
              style={{ width: 240 }}
              value={targetDraft}
              onChange={(event) => setTargetDraft(event.target.value)}
              onSearch={(value) => applyFilter({ target: value.trim() || undefined })}
            />
            <DatePicker.RangePicker
              showTime
              onChange={(range) => applyFilter({ from: range?.[0]?.toISOString(), to: range?.[1]?.toISOString() })}
            />
          </Space>
          <RecordTable<AuditEventDto>
            rowKey="id"
            loading={loading}
            dataSource={data?.events ?? []}
            emptyText="No audit events match."
            expandable={{
              expandedRowRender: (event) => (
                <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(event.metadata ?? {}, null, 2)}</pre>
              ),
              rowExpandable: (event) => event.metadata !== null && event.metadata !== undefined
            }}
            pagination={{
              current: page,
              pageSize,
              total: data?.total ?? 0,
              showSizeChanger: true,
              pageSizeOptions: [25, 50, 100],
              onChange: (nextPage, nextSize) => {
                setPage(nextPage);
                setPageSize(nextSize);
              }
            }}
            columns={[
              { title: "Time", dataIndex: "createdAt", render: (value: string) => new Date(value).toLocaleString() },
              { title: "Actor", render: (_, event) => event.actorName ?? event.actorEmail ?? <Typography.Text type="secondary">system</Typography.Text> },
              { title: "Action", dataIndex: "action" },
              {
                title: "Target",
                render: (_, event) => (
                  <Space size={6}>
                    <StatusTag value={event.targetType} />
                    <span className="fedlify-muted">{event.targetId ?? ""}</span>
                  </Space>
                )
              }
            ]}
          />
        </div>
      )}
    </AppPage>
  );
}
