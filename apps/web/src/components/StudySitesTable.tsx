"use client";

import { PlusOutlined } from "@ant-design/icons";
import { Alert, Button, Popover, Tag } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { InvitePersonModal } from "@/components/InvitePersonModal";
import { RecordTable } from "@/components/RecordTable";
import { StatusTag } from "@/components/StatusTag";
import { formatHeartbeat, type SiteOverviewRow } from "@/lib/site-overview";
import { kitStateLabel } from "@/lib/terms";
import { useStudyPermissions } from "@/lib/use-permissions";
import { ApiError, apiCall } from "@/lib/web-api";

/** The study's Sites page: one table (site, institution, sign-off, site kit, code version, connection, last report) and a row action to the site page. */

export function StudySitesTable({
  studyId,
  onRegister,
  canRegister = true,
  siteContacts,
  onInvited
}: {
  studyId: string;
  onRegister?: () => void;
  canRegister?: boolean;
  /** People and waiting invitations per site (by study site id), when the page already has them. */
  siteContacts?: Record<string, { people: number; waiting: number }>;
  onInvited?: () => void | Promise<void>;
}) {
  const router = useRouter();
  const { can } = useStudyPermissions(studyId);
  const [inviteSiteId, setInviteSiteId] = useState<string | null>(null);
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
      {onRegister && canRegister && can.manageSites ? (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button icon={<PlusOutlined />} onClick={onRegister}>
            Add site
          </Button>
        </div>
      ) : null}
      <RecordTable<SiteOverviewRow>
        rowKey="studySiteId"
        loading={rows === null && !error}
        dataSource={rows ?? []}
        emptyText="No sites yet. Add at least one site before creating site kits."
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
          { title: "Site sign-off", dataIndex: "readiness", render: (value: string) => <StatusTag value={value} /> },
          { title: "Site kit", dataIndex: "kitState", render: (value: string) => <StatusTag value={value} label={kitStateLabel(value)} /> },
          {
            title: "Code version",
            dataIndex: "imageState",
            render: (value: string, row) => {
              if (value === "OUTDATED" || value === "NOT_REPORTED") {
                return (
                  <Popover
                    title="How to bring this site up to date"
                    content={<ol style={{ margin: 0, paddingLeft: 18, maxWidth: 360 }}>{row.imageFix.map((step) => <li key={step}>{step}</li>)}</ol>}
                  >
                    <Tag color="orange" style={{ cursor: "help" }}>{value === "OUTDATED" ? "Needs update" : "Not reported"}</Tag>
                  </Popover>
                );
              }
              return value === "CURRENT" ? <Tag color="green">Up to date</Tag> : <span className="fedlify-muted">-</span>;
            }
          },
          { title: "Connection", dataIndex: "connection", render: (value: string) => <StatusTag value={value} /> },
          {
            title: "Runner last reported",
            dataIndex: "lastHeartbeatAt",
            render: (value: string | null) => <span title={value ?? undefined}>{formatHeartbeat(value)}</span>
          },
          ...(siteContacts
            ? [
                {
                  title: "People",
                  key: "people",
                  render: (_: unknown, row: SiteOverviewRow) => {
                    const entry = siteContacts[row.studySiteId];
                    if (!entry) return <span className="fedlify-muted">-</span>;
                    return (
                      <span>
                        {entry.people === 1 ? "1 person" : `${entry.people} people`}
                        {entry.waiting > 0 ? <span className="fedlify-muted"> ({entry.waiting} waiting to accept)</span> : null}
                      </span>
                    );
                  }
                }
              ]
            : []),
          {
            title: "",
            key: "action",
            render: (_, row) => (
              <span style={{ display: "inline-flex", gap: 8 }}>
                <Button size="small" onClick={() => router.push(`/sites/${row.studySiteId}`)} aria-label={`Open ${row.name}`}>
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
        onInvited={() => void onInvited?.()}
      />
    </div>
  );
}
