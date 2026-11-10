"use client";

import { PlusOutlined } from "@ant-design/icons";
import { Alert, Button, Checkbox, Modal, Popconfirm, Radio, Space, Tooltip, Typography, message } from "antd";
import { useMemo, useState } from "react";
import type { SiteRole, StudyRole } from "@prisma/client";
import { SectionHeader } from "@/components/AppPage";
import { InvitePersonModal } from "@/components/InvitePersonModal";
import { RecordTable } from "@/components/RecordTable";
import { StatusTag } from "@/components/StatusTag";
import { closestPlainRole, describeStudyRoles, PLAIN_ROLES, plainRole, STUDY_ROLE_LABELS, toStudyRoles, type PlainRoleKey } from "@/lib/plain-roles";
import { groupMembers, invitationSummary, roleDisabledReason, siteContactRows, siteRolesLabel, type InviteChoice, type SiteContactRow, type TeamMember } from "@/lib/team-roles";
import { clearPermissionsCache, useStudyPermissions } from "@/lib/use-permissions";

type Person = { id?: string; name?: string | null; email?: string | null };
type Invitation = { id: string; email: string; status?: string; expiresAt?: string; studySiteId?: string | null; siteName?: string | null; siteRoles?: SiteRole[]; roles?: StudyRole[]; role?: StudyRole };

export type TeamStudy = {
  members: Array<{ userId?: string; role: StudyRole; user?: Person }>;
  invitations: Array<Record<string, unknown>>;
  studySites: Array<{ id: string; name: string; participationStatus?: string; members?: Array<{ userId?: string; role: SiteRole; user?: Person }> }>;
};

const ADVANCED_ROLES: StudyRole[] = [
  "PRINCIPAL_INVESTIGATOR", "STUDY_COORDINATOR", "CLINICAL_LEAD", "ETHICS_REVIEWER", "DATA_SCIENTIST",
  "PIPELINE_DEVELOPER", "PRIVACY_SECURITY_OFFICER", "RELEASE_APPROVER", "AUDITOR"
];

function formatDate(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

type RowData = { key: string; name: string; email: string; member?: TeamMember; site?: SiteContactRow };

/** The Team page: people with plain roles, a modal to invite someone, a modal to change a role, and pending invitations. */
export function TeamSection({ studyId, study, onChanged }: { studyId: string; study: TeamStudy; onChanged: () => void | Promise<void> }) {
  const { can } = useStudyPermissions(studyId);
  const [messageApi, contextHolder] = message.useMessage();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState<TeamMember | null>(null);

  const members = useMemo(() => groupMembers(study.members), [study.members]);
  const contacts = useMemo(() => siteContactRows(study.studySites), [study.studySites]);
  const sites = useMemo(() => study.studySites.filter((site) => site.participationStatus !== "DISABLED").map((site) => ({ id: site.id, name: site.name })), [study.studySites]);
  const pending = (study.invitations as unknown as Invitation[]).filter((invitation) => (invitation.status ?? "PENDING") === "PENDING");

  const mayInvite = Boolean(can.invite || can.manageSites);
  const mayChangeRoles = Boolean(can.invite);
  const mayRemoveContacts = Boolean(can.manageSites);

  const rows: RowData[] = [
    ...members.map((member) => ({ key: `m:${member.userId}`, name: member.name, email: member.email, member })),
    ...contacts.map((site) => ({ key: `s:${site.key}`, name: site.name, email: site.email, site }))
  ];

  async function cancelInvitation(invitationId: string) {
    const response = await fetch(`/api/v1/studies/${studyId}/invitations/${invitationId}`, { method: "DELETE" });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      messageApi.error(body?.error?.message ?? "The invitation could not be cancelled.");
      return;
    }
    messageApi.success("Invitation cancelled.");
    await onChanged();
  }

  async function removeContact(row: SiteContactRow) {
    const response = await fetch(`/api/v1/sites/${row.studySiteId}/members`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: row.userId })
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      messageApi.error(body?.error?.message ?? "The person could not be removed.");
      return;
    }
    messageApi.success("Removed from the site.");
    await onChanged();
  }

  return (
    <div className="fedlify-section-stack">
      {contextHolder}
      <SectionHeader
        title="People"
        description="Everyone who works on this study, and the contacts at each site."
        actions={
          mayInvite ? (
            <Button type="primary" className="fedlify-dark-action" icon={<PlusOutlined />} onClick={() => setInviteOpen(true)}>
              Invite someone
            </Button>
          ) : null
        }
      />
      <RecordTable<RowData>
        rowKey="key"
        dataSource={rows}
        pagination={false}
        emptyText={mayInvite ? "No one yet. Use Invite someone to add the first person." : "No one has been added yet."}
        columns={[
          { title: "Name", dataIndex: "name" },
          { title: "Email", dataIndex: "email" },
          {
            title: "Role",
            key: "role",
            render: (_, row) => {
              if (row.site) {
                return (
                  <span>
                    {siteRolesLabel(row.site.siteRoles)} <span className="fedlify-muted">at {row.site.siteName}</span>
                  </span>
                );
              }
              const described = describeStudyRoles(row.member?.roles ?? []);
              return described.detail ? (
                <Tooltip title={described.detail}>
                  <span>{described.label}</span>
                </Tooltip>
              ) : (
                described.label
              );
            }
          },
          {
            title: "",
            key: "actions",
            render: (_, row) => {
              if (row.member && mayChangeRoles) {
                return (
                  <Button size="small" onClick={() => setEditing(row.member as TeamMember)}>
                    Change role
                  </Button>
                );
              }
              if (row.site && mayRemoveContacts) {
                return (
                  <Popconfirm
                    title={`Remove ${row.site.name} from ${row.site.siteName}?`}
                    description="They will lose access to this site. A site kit and access code they already have still work until the access code is reset."
                    okText="Remove"
                    onConfirm={() => void removeContact(row.site as SiteContactRow)}
                  >
                    <Button size="small">Remove</Button>
                  </Popconfirm>
                );
              }
              return null;
            }
          }
        ]}
      />

      <SectionHeader title="Waiting to accept" description="Invitations that have been sent and not accepted yet." />
      <RecordTable<Invitation>
        rowKey="id"
        dataSource={pending}
        pagination={false}
        emptyText="No invitations are waiting."
        columns={[
          { title: "Email", dataIndex: "email" },
          {
            title: "Invited as",
            key: "role",
            render: (_, invitation) => {
              const summary = invitationSummary(invitation);
              return summary.detail ? (
                <Tooltip title={summary.detail}>
                  <span>{summary.label}</span>
                </Tooltip>
              ) : (
                summary.label
              );
            }
          },
          { title: "Expires", dataIndex: "expiresAt", render: (value?: string) => formatDate(value) },
          { title: "Status", dataIndex: "status", render: (value?: string) => <StatusTag value={value ?? "PENDING"} /> },
          {
            title: "",
            key: "cancel",
            render: (_, invitation) => {
              const isSite = Boolean((invitation as unknown as { studySiteId?: string | null }).studySiteId);
              if (!(isSite ? can.manageSites : can.invite)) return null;
              return (
                <Popconfirm
                  title="Cancel this invitation?"
                  description="The link in the email will stop working."
                  okText="Cancel invitation"
                  onConfirm={() => void cancelInvitation(invitation.id)}
                >
                  <Button size="small">Cancel</Button>
                </Popconfirm>
              );
            }
          }
        ]}
      />

      <InvitePersonModal
        open={inviteOpen}
        studyId={studyId}
        can={can}
        sites={sites}
        onClose={() => setInviteOpen(false)}
        onInvited={() => void onChanged()}
      />
      <ChangeRoleModal
        studyId={studyId}
        member={editing}
        can={can}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          messageApi.success("Role updated.");
          await onChanged();
        }}
      />
    </div>
  );
}

function ChangeRoleModal({
  studyId,
  member,
  can,
  onClose,
  onSaved
}: {
  studyId: string;
  member: TeamMember | null;
  can: Partial<Record<string, boolean>>;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<{ memberId: string; choice: InviteChoice; advanced: StudyRole[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = member ? closestPlainRole(member.roles) : null;
  const state =
    member && draft?.memberId === member.userId
      ? draft
      : member
        ? { memberId: member.userId, choice: (current?.key ?? "ADVANCED") as InviteChoice, advanced: member.roles }
        : null;

  async function save() {
    if (!member || !state) return;
    const roles = state.choice === "ADVANCED" ? state.advanced : toStudyRoles(state.choice as PlainRoleKey);
    if (roles.length === 0) {
      setError("Choose at least one role.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/studies/${studyId}/members/${member.userId}/roles`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roles })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "The role could not be changed.");
      setDraft(null);
      // Roles changed, so earlier permission answers (including the actor's own) may be out of date.
      clearPermissionsCache();
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The role could not be changed.");
    } finally {
      setSaving(false);
    }
  }

  const held = new Set(member?.roles ?? []);
  const plainChoices = PLAIN_ROLES.filter((role) => role.key !== "SITE_CONTACT");

  return (
    <Modal
      open={Boolean(member)}
      title={member ? `Change role for ${member.name}` : "Change role"}
      onCancel={() => {
        setDraft(null);
        setError(null);
        onClose();
      }}
      onOk={() => void save()}
      okText="Save role"
      okButtonProps={{ loading: saving, className: "fedlify-dark-action" }}
      destroyOnClose
    >
      {error ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message="The role was not changed" description={error} /> : null}
      {state && member ? (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Radio.Group
            className="fedlify-role-cards"
            value={state.choice === "ADVANCED" ? undefined : state.choice}
            onChange={(event) => setDraft({ ...state, choice: event.target.value as PlainRoleKey })}
          >
            {plainChoices.map((role) => {
              const alreadyHeld = current?.key === role.key;
              const reason = alreadyHeld ? null : roleDisabledReason(role.key, can, { siteCount: 1 });
              return (
                <Tooltip key={role.key} title={reason ?? undefined}>
                  <label className={`fedlify-role-card${state.choice === role.key ? " is-selected" : ""}${reason ? " is-disabled" : ""}`}>
                    <Radio value={role.key} disabled={Boolean(reason)}>
                      <strong>{plainRole(role.key).label}</strong>
                    </Radio>
                    <span className="fedlify-role-card-text">{role.description}</span>
                    {reason ? <span className="fedlify-role-card-reason">{reason}</span> : null}
                  </label>
                </Tooltip>
              );
            })}
          </Radio.Group>
          <details open={state.choice === "ADVANCED"}>
            <summary>Advanced: pick detailed roles</summary>
            <div className="fedlify-advanced-roles">
              <Typography.Paragraph type="secondary">Picking any of these replaces the choice above.</Typography.Paragraph>
              <Checkbox.Group
                value={state.choice === "ADVANCED" ? state.advanced : toStudyRoles(state.choice as PlainRoleKey)}
                onChange={(values) => setDraft({ ...state, choice: "ADVANCED", advanced: values as StudyRole[] })}
              >
                {ADVANCED_ROLES.map((role) => {
                  const reason = held.has(role) ? null : roleDisabledReason(role, can, { siteCount: 1 });
                  return (
                    <Tooltip key={role} title={reason ?? undefined}>
                      <Checkbox value={role} disabled={Boolean(reason)}>
                        {STUDY_ROLE_LABELS[role]}
                      </Checkbox>
                    </Tooltip>
                  );
                })}
              </Checkbox.Group>
            </div>
          </details>
        </Space>
      ) : null}
    </Modal>
  );
}
