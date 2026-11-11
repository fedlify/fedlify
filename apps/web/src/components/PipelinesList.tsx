"use client";

import { CopyOutlined, FolderOpenOutlined } from "@ant-design/icons";
import { Button, Space, Table, Tag, Typography } from "antd";
import { StatusTag } from "@/components/StatusTag";
import type { ListJob, ListProject } from "@/lib/pipeline-start";
import { formatDate } from "@/lib/format";
import { pipelineRows, type PipelineRow } from "@/lib/pipeline-start";

type Props = {
  projects: ListProject[];
  liveVersionId: string | null | undefined;
  jobs: ListJob[];
  openId: string | null;
  onOpen: (id: string) => void;
  onCopy: (id: string) => void;
};

/** The study's pipelines as a table: name, source, latest version and state, live marker, last run, lineage. */
export function PipelinesList({ projects, liveVersionId, jobs, openId, onOpen, onCopy }: Props) {
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
              {row.id === openId ? <Tag>open</Tag> : null}
            </Space>
          )
        },
        { title: "Source", dataIndex: "source" },
        {
          title: "Latest version",
          render: (_, row) => (
            <Space size={6} wrap>
              <span>{row.latestVersion ?? "none"}</span>
              <StatusTag value={row.state} />
            </Space>
          )
        },
        {
          title: "Live",
          render: (_, row) => (row.live ? <StatusTag tone="success" label={`Live ${row.liveVersion}`} /> : <Typography.Text type="secondary">no</Typography.Text>)
        },
        {
          title: "Last run",
          render: (_, row) =>
            row.lastRun ? (
              <Space size={6} wrap>
                <StatusTag value={row.lastRun.status} />
                <span className="fedlify-muted">
                  {row.lastRun.version ?? ""} {formatDate(row.lastRun.at)}
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
