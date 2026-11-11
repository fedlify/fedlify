"use client";

import { DownloadOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  DatePicker,
  Input,
  Select,
  Space,
  Typography,
} from "antd";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppPage, AppPageHeader } from "@/components/AppPage";
import { RecordTable } from "@/components/RecordTable";
import { Details } from "@/components/Details";
import type { AuditEventDto } from "@/lib/audit-query";
import { auditActionLabel } from "@/lib/terms";
import { ApiError, apiCall } from "@/lib/web-api";

type AuditPayload = {
  events: AuditEventDto[];
  page: number;
  pageSize: number;
  total: number;
  facets: { actions: string[]; actors: Array<{ id: string; name: string }> };
};
type Filters = {
  actor?: string;
  action?: string;
  target?: string;
  from?: string;
  to?: string;
};

const TARGET_LABELS: Record<string, string> = {
  Study: "Study",
  StudySite: "Site",
  PipelineProject: "Pipeline",
  PipelineVersion: "Pipeline version",
  NvflareJob: "Run",
  NvflareDeployment: "Study server",
  SiteJoinPackage: "Site kit",
  ModelRelease: "Model release",
  User: "Person",
};

function targetLabel(type: string) {
  if (TARGET_LABELS[type]) return TARGET_LABELS[type];
  const words = type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function buildQuery(filters: Filters, extra: Record<string, string> = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...extra }))
    if (value) params.set(key, value);
  return params.toString();
}

export default function StudyAuditPage() {
  const { studyId } = useParams<{ studyId: string }>();
  const [filters, setFilters] = useState<Filters>({});
  const [targetDraft, setTargetDraft] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState<AuditPayload | null>(null);
  const [error, setError] = useState<{
    message: string;
    status?: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await apiCall<AuditPayload>(
          `/api/v1/studies/${studyId}/audit?${buildQuery(filters, { page: String(page), pageSize: String(pageSize) })}`,
        ),
      );
      setError(null);
    } catch (err) {
      setError({
        message:
          err instanceof Error
            ? err.message
            : "The activity log could not be loaded.",
        status: err instanceof ApiError ? err.status : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, [studyId, filters, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportHref = useMemo(
    () => (format: "csv" | "json") =>
      `/api/v1/studies/${studyId}/audit?${buildQuery(filters, { format })}`,
    [studyId, filters],
  );

  function applyFilter(next: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...next }));
    setPage(1);
  }

  return (
    <AppPage>
      <AppPageHeader
        title="Activity log"
        subtitle="Who did what in this study: access, approvals, files, runs and model release decisions."
        actions={
          <Space>
            <Button
              icon={<DownloadOutlined />}
              href={exportHref("csv")}
              disabled={!data}
            >
              Export CSV
            </Button>
            <Button
              icon={<DownloadOutlined />}
              href={exportHref("json")}
              disabled={!data}
            >
              Export JSON
            </Button>
          </Space>
        }
      />
      {error ? (
        <Alert
          type={error.status === 403 ? "warning" : "error"}
          showIcon
          message={
            error.status === 403
              ? "You do not have access to this study's activity log"
              : "The activity log could not be loaded"
          }
          description={error.message}
        />
      ) : (
        <div className="fedlify-section-stack">
          <Space wrap>
            <Select
              allowClear
              showSearch
              placeholder="What happened"
              style={{ minWidth: 220 }}
              value={filters.action}
              options={(data?.facets.actions ?? []).map((value) => ({
                value,
                label: auditActionLabel(value),
              }))}
              onChange={(value) => applyFilter({ action: value })}
            />
            <Select
              allowClear
              placeholder="Person"
              style={{ minWidth: 200 }}
              value={filters.actor}
              options={(data?.facets.actors ?? []).map((actor) => ({
                value: actor.id,
                label: actor.name,
              }))}
              onChange={(value) => applyFilter({ actor: value })}
            />
            <Input.Search
              allowClear
              placeholder="Search by item or run ID"
              style={{ width: 240 }}
              value={targetDraft}
              onChange={(event) => setTargetDraft(event.target.value)}
              onSearch={(value) =>
                applyFilter({ target: value.trim() || undefined })
              }
            />
            <DatePicker.RangePicker
              showTime
              onChange={(range) =>
                applyFilter({
                  from: range?.[0]?.toISOString(),
                  to: range?.[1]?.toISOString(),
                })
              }
            />
          </Space>
          <RecordTable<AuditEventDto>
            rowKey="id"
            loading={loading}
            dataSource={data?.events ?? []}
            emptyText="No activity matches."
            pagination={{
              current: page,
              pageSize,
              total: data?.total ?? 0,
              showSizeChanger: true,
              pageSizeOptions: [25, 50, 100],
              onChange: (nextPage, nextSize) => {
                setPage(nextPage);
                setPageSize(nextSize);
              },
            }}
            columns={[
              {
                title: "Time",
                dataIndex: "createdAt",
                render: (value: string) => new Date(value).toLocaleString(),
              },
              {
                title: "Person",
                render: (_, event) =>
                  event.actorName ??
                  event.actorEmail ?? (
                    <Typography.Text type="secondary">System</Typography.Text>
                  ),
              },
              {
                title: "What happened",
                dataIndex: "action",
                render: (value: string) => auditActionLabel(value),
              },
              {
                title: "Item",
                dataIndex: "targetType",
                render: (value: string, event) => (
                  <span title={event.targetId ?? undefined}>
                    {targetLabel(value)}
                  </span>
                ),
              },
              {
                title: "Details",
                key: "details",
                render: (_, event) => (
                  <Details
                    modalTitle={auditActionLabel(event.action)}
                    items={[
                      {
                        label: "Action key",
                        value: <code>{event.action}</code>,
                        copyText: event.action,
                      },
                      {
                        label: "Item type",
                        value: <code>{event.targetType}</code>,
                      },
                      ...(event.targetId
                        ? [
                            {
                              label: "Item ID",
                              value: <code>{event.targetId}</code>,
                              copyText: event.targetId,
                            },
                          ]
                        : []),
                      ...(event.actorUserId
                        ? [
                            {
                              label: "User ID",
                              value: <code>{event.actorUserId}</code>,
                              copyText: event.actorUserId,
                            },
                          ]
                        : []),
                      {
                        label: "Data",
                        value: (
                          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                            {JSON.stringify(event.metadata ?? {}, null, 2)}
                          </pre>
                        ),
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
        </div>
      )}
    </AppPage>
  );
}
