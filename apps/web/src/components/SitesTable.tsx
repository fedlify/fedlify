"use client";

import { PlusOutlined } from "@ant-design/icons";
import { Alert, Button, Popover, Tag } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Details } from "@/components/Details";
import { InvitePersonModal } from "@/components/InvitePersonModal";
import { RecordTable } from "@/components/RecordTable";
import { StatusTag } from "@/components/StatusTag";
import { formatHeartbeat, type SiteOverviewRow } from "@/lib/site-overview";
import { kitStateLabel, TERMS } from "@/lib/terms";
import { useStudyPermissions } from "@/lib/use-permissions";
import { ApiError, apiCall } from "@/lib/web-api";

/**
 * The one Sites table, used on the study's Sites page and on Code & run. Columns: Site, Site kit, Runner, Code version,
 * Sign-off, People. Technical values (site ID, certificate, institution, last report) sit under Details. Row actions
 * follow the viewer's permissions: Open, Invite site contact, and Release site kit when a site has none.
 */

const CERTIFICATE_WORDS: Record<SiteOverviewRow["certificate"], string> = {
  ISSUED: "Issued",
  ON_REPUBLISH: "Issued when you republish",
  ON_PUBLISH: "Issued on publish"
};

function CodeVersionCell({ row }: { row: SiteOverviewRow }) {
  if (row.imageState === "OUTDATED" || row.imageState === "NOT_REPORTED") {
    return (
      <Popover
        title="How to bring this site up to date"
        content={<ol style={{ margin: 0, paddingLeft: 18, maxWidth: 360 }}>{row.imageFix.map((step) => <li key={step}>{step}</li>)}</ol>}
      >
        <Tag color="orange" style={{ cursor: "help" }}>{row.imageState === "OUTDATED" ? "Needs update" : "Not reported"}</Tag>
      </Popover>
    );
  }
  return row.imageState === "CURRENT" ? <Tag color="green">Up to date</Tag> : <Tag>Not yet seen</Tag>;
}

function RunnerCell({ row, live }: { row: SiteOverviewRow; live?: boolean | null | undefined }) {
  // Code & run knows live from the study server; the Sites page shows what the site last reported.
  if (live !== undefined) {
    if (live === null) return <Tag>{TERMS.runnerNotReporting}</Tag>;
    return live ? <Tag color="green">{TERMS.runnerConnected}</Tag> : <Tag>{TERMS.runnerNotConnected}</Tag>;
  }
  return (
    <span title={row.lastHeartbeatAt ?? undefined}>
      <StatusTag value={row.connection} />
    </span>
  );
}

export function SitesTable({
  studyId,
  onRegister,
  onInvited,
  onNavigate,
  liveConnection,
  refreshKey
}: {
  studyId: string;
  /** Shows "Add site" (for people who may manage sites). */
  onRegister?: () => void;
  onInvited?: () => void | Promise<void>;
  /** Lets a page with unsaved work confirm before leaving; defaults to a plain navigation. */
  onNavigate?: (href: string) => void;
  /** Live runner state per site (by study site id) when the page has it. null = not reporting. */
  liveConnection?: Record<string, boolean | null>;
  /** Change to reload the rows. */
  refreshKey?: string | number;
}) {
  const router = useRouter();
  const { can, loading: permissionsLoading } = useStudyPermissions(studyId);
  const [inviteSiteId, setInviteSiteId] = useState<string | null>(null);
  const [rows, setRows] = useState<SiteOverviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Code & run lists the sites the study server knows about; a disabled site is not one of them.
  const visibleRows = (rows ?? []).filter((row) => !liveConnection || row.studySiteId in liveConnection);
  const go = onNavigate ?? ((href: string) => router.push(href));
  const mayManage = permissionsLoading ? false : Boolean(can.manageSites || can.manageSiteProfiles);

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
  }, [load, refreshKey]);

  return (
    <div className="fedlify-section-stack">
      {error ? <Alert type="error" showIcon message="Sites could not be loaded" description={error} action={<Button size="small" onClick={() => void load()}>Retry</Button>} /> : null}
      {onRegister && can.manageSites ? (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button icon={<PlusOutlined />} onClick={onRegister}>
            Add site
          </Button>
        </div>
      ) : null}
      <RecordTable<SiteOverviewRow>
        rowKey="studySiteId"
        loading={rows === null && !error}
        dataSource={visibleRows}
        emptyText="No sites yet. Add at least one site before releasing site kits."
        expandable={{
          expandedRowRender: (row) => (
            <Details
              defaultOpen
              items={[
                { label: "Institution", value: row.institutionName },
                { label: TERMS.siteId, value: <code>{row.nvflareClientName}</code>, copyText: row.nvflareClientName },
                { label: "Site security certificate", value: CERTIFICATE_WORDS[row.certificate] },
                { label: "Runner last reported", value: formatHeartbeat(row.lastHeartbeatAt) }
              ]}
            />
          ),
          columnTitle: TERMS.details
        }}
        columns={[
          {
            title: TERMS.site,
            dataIndex: "name",
            render: (value: string, row) => (
              <span>
                <strong>{value}</strong> <span className="fedlify-muted">{row.code}</span>
              </span>
            )
          },
          {
            title: <span title="The package you give a site so its computer can join this study.">{TERMS.siteKit}</span>,
            dataIndex: "kitState",
            render: (value: string, row) =>
              value === "NOT_RELEASED" && mayManage ? (
                <Button size="small" type="link" onClick={() => go(`/sites/${row.studySiteId}`)}>
                  Release site kit
                </Button>
              ) : (
                <StatusTag value={value} label={kitStateLabel(value)} />
              )
          },
          {
            title: <span title="The program on the site's computer that does the work for this study.">{TERMS.runner}</span>,
            dataIndex: "connection",
            render: (_: string, row) => <RunnerCell row={row} live={liveConnection ? (liveConnection[row.studySiteId] ?? null) : undefined} />
          },
          { title: TERMS.codeVersion, dataIndex: "imageState", render: (_: string, row) => <CodeVersionCell row={row} /> },
          { title: TERMS.siteSignOff, dataIndex: "readiness", render: (value: string) => <StatusTag value={value} /> },
          {
            title: "People",
            key: "people",
            render: (_: unknown, row) => (
              <span>
                {row.people === 1 ? "1 person" : `${row.people} people`}
                {row.waiting > 0 ? <span className="fedlify-muted"> ({row.waiting} waiting to accept)</span> : null}
              </span>
            )
          },
          {
            title: "",
            key: "action",
            render: (_, row) => (
              <span style={{ display: "inline-flex", gap: 8 }}>
                <Button size="small" onClick={() => go(`/sites/${row.studySiteId}`)} aria-label={`Open ${row.name}`}>
                  Open
                </Button>
                {can.manageSites ? (
                  <Button size="small" onClick={() => setInviteSiteId(row.studySiteId)} aria-label={`Invite site contact for ${row.name}`}>
                    Invite site contact
                  </Button>
                ) : null}
              </span>
            )
          }
        ]}
        pagination={false}
      />
      <InvitePersonModal
        open={inviteSiteId !== null}
        studyId={studyId}
        can={can}
        sites={(rows ?? []).map((row) => ({ id: row.studySiteId, name: row.name }))}
        presetSiteId={inviteSiteId}
        onClose={() => setInviteSiteId(null)}
        onInvited={() => {
          void load();
          void onInvited?.();
        }}
      />
    </div>
  );
}
