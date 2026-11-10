"use client";

import { CopyOutlined, FolderOpenOutlined } from "@ant-design/icons";
import { Button, Space, Table, Tag, Typography } from "antd";
import type { ListJob, ListProject } from "@/lib/pipeline-start";
import { statusLabel } from "@/lib/terms";
import { pipelineRows, type PipelineRow } from "@/lib/pipeline-start";

type Props = {
  projects: ListProject[];
  liveVersionId: string | null | undefined;
  jobs: ListJob[];
  openId: string | null;
  statusColor: Record<string, string>;
  onOpen: (id: string) => void;
  onCopy: (id: string) => void;
};

/** The study's pipelines as a table: name, source, latest version and state, live marker, last run, lineage. */
export function PipelinesList({ projects, liveVersionId, jobs, openId, statusColor, onOpen, onCopy }: Props) {
  const rows = pipelineRows(projects, liveVersionId, jobs);
  return (
    <Table<PipelineRow>
      size="small"
      rowKey="id"
      pagination={false}
      scroll={{ x: "max-content" }}
      className="fedlify-pipelines-table"
      dataSource={rows}
      columns={[
        {
          title: "Pipeline",
          dataIndex: "name",
          render: (value: string, row) => (
            <Space size={6} wrap>
              <strong>{value}</strong>
              {row.id === openId ? <Tag color="purple">open</Tag> : null}
            </Space>
          )
        },
        { title: "Source", dataIndex: "source" },
        {
          title: "Latest version",
          render: (_, row) => (
            <Space size={6} wrap>
              <span>{row.latestVersion ?? "none"}</span>
              <Tag color={statusColor[row.state] ?? "default"}>{statusLabel(row.state)}</Tag>
            </Space>
          )
        },
        {
          title: "Live",
          render: (_, row) => (row.live ? <Tag color="green">live {row.liveVersion}</Tag> : <Typography.Text type="secondary">no</Typography.Text>)
        },
        {
          title: "Last run",
          render: (_, row) =>
            row.lastRun ? (
              <Space size={6} wrap>
                <Tag color={statusColor[row.lastRun.status] ?? "default"}>{statusLabel(row.lastRun.status)}</Tag>
                <span className="fedlify-muted">
                  {row.lastRun.version ?? ""} {new Date(row.lastRun.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              </Space>
            ) : (
              <Typography.Text type="secondary">no runs</Typography.Text>
            )
        },
        { title: "Lineage", render: (_, row) => row.lineage ?? <Typography.Text type="secondary">none</Typography.Text> },
        {
          title: "",
          key: "actions",
          render: (_, row) => (
            <Space size={4}>
              <Button size="small" type="primary" icon={<FolderOpenOutlined />} onClick={() => onOpen(row.id)} aria-label={`Open ${row.name}`}>
                Open
              </Button>
              <Button size="small" icon={<CopyOutlined />} onClick={() => onCopy(row.id)} aria-label={`Copy ${row.name}`}>
                Copy
              </Button>
            </Space>
          )
        }
      ]}
    />
  );
}
