"use client";

import { MailOutlined } from "@ant-design/icons";
import { Alert, Checkbox, Collapse, Form, Input, Modal, Radio, Select, Tooltip, Typography } from "antd";
import { useEffect, useState } from "react";
import type { StudyRole } from "@prisma/client";
import { PLAIN_ROLES, STUDY_ROLE_LABELS, type PlainRoleKey } from "@/lib/plain-roles";
import { buildInviteBody, roleDisabledReason, type InviteChoice } from "@/lib/team-roles";

const ADVANCED_ROLES: StudyRole[] = [
  "PRINCIPAL_INVESTIGATOR",
  "STUDY_COORDINATOR",
  "CLINICAL_LEAD",
  "ETHICS_REVIEWER",
  "DATA_SCIENTIST",
  "PIPELINE_DEVELOPER",
  "PRIVACY_SECURITY_OFFICER",
  "RELEASE_APPROVER",
  "AUDITOR"
];

export type InviteSite = { id: string; name: string };

type Props = {
  open: boolean;
  studyId: string;
  can: Partial<Record<string, boolean>>;
  sites: InviteSite[];
  /** Start on "Site contact" with this site chosen (from the Sites table). */
  presetSiteId?: string | null;
  onClose: () => void;
  onInvited: () => void;
};

type Sent = { email: string; inviteUrl: string; emailSent: boolean };

/** "Invite someone": email, one of the plain roles (or the detailed roles under Advanced) and, for a site contact, the site. */
export function InvitePersonModal({ open, studyId, can, sites, presetSiteId, onClose, onInvited }: Props) {
  const [email, setEmail] = useState("");
  const [choice, setChoice] = useState<InviteChoice>("RESEARCHER");
  const [advanced, setAdvanced] = useState<StudyRole[]>([]);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setAdvanced([]);
    setError(null);
    setSent(null);
    setSiteId(presetSiteId ?? null);
    setChoice(presetSiteId ? "SITE_CONTACT" : "RESEARCHER");
  }, [open, presetSiteId]);

  const siteOptions = sites.map((site) => ({ value: site.id, label: site.name }));

  async function submit() {
    const built = buildInviteBody({ email, choice, advancedRoles: advanced, studySiteId: siteId });
    if ("error" in built) {
      setError(built.error);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/studies/${studyId}/invitations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(built.body)
      });
      const body = await response.json().catch(() => null);
      // The server's answer is the final word, including its 403 message about roles.
      if (!response.ok) throw new Error(body?.error?.message ?? "The invitation could not be sent.");
      setSent({ email: email.trim(), inviteUrl: String(body?.inviteUrl ?? ""), emailSent: Boolean(body?.emailSent) });
      onInvited();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The invitation could not be sent.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Invite someone"
      onCancel={onClose}
      destroyOnClose
      width={640}
      okText={sent ? "Done" : "Send invitation"}
      okButtonProps={{ icon: sent ? undefined : <MailOutlined />, loading: submitting, className: "fedlify-dark-action" }}
      cancelButtonProps={{ style: sent ? { display: "none" } : undefined }}
      onOk={() => (sent ? onClose() : void submit())}
    >
      {sent ? (
        <Alert
          type={sent.emailSent ? "success" : "warning"}
          showIcon
          message={sent.emailSent ? `Invitation emailed to ${sent.email}` : `Invitation created for ${sent.email}. Email is not set up, so send them this link yourself.`}
          description={sent.inviteUrl ? <Typography.Text copyable={{ text: sent.inviteUrl }} style={{ wordBreak: "break-all" }}>{sent.inviteUrl}</Typography.Text> : undefined}
        />
      ) : (
        <Form layout="vertical" onFinish={() => void submit()}>
          {error ? <Alert type="error" showIcon style={{ marginBottom: 16 }} message="Invitation was not sent" description={error} /> : null}
          <Form.Item label="Email address" required>
            <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@hospital.ca" autoFocus />
          </Form.Item>
          <Form.Item label="What will this person do?" required>
            <Radio.Group
              className="fedlify-role-cards"
              value={choice === "ADVANCED" ? undefined : choice}
              onChange={(event) => setChoice(event.target.value as PlainRoleKey)}
            >
              {PLAIN_ROLES.map((role) => {
                const reason = roleDisabledReason(role.key, can, { siteCount: sites.length });
                const card = (
                  <label key={role.key} className={`fedlify-role-card${choice === role.key ? " is-selected" : ""}${reason ? " is-disabled" : ""}`}>
                    <Radio value={role.key} disabled={Boolean(reason)}>
                      <strong>{role.label}</strong>
                    </Radio>
                    <span className="fedlify-role-card-text">{role.description}</span>
                    {reason ? <span className="fedlify-role-card-reason">{reason}</span> : null}
                  </label>
                );
                return reason ? <Tooltip key={role.key} title={reason}>{card}</Tooltip> : card;
              })}
            </Radio.Group>
          </Form.Item>
          {choice === "SITE_CONTACT" ? (
            <Form.Item label="Which site?" required extra="This person will see only this site. They will not be added to the study itself.">
              <Select value={siteId ?? undefined} onChange={setSiteId} options={siteOptions} placeholder="Choose a site" />
            </Form.Item>
          ) : null}
          <Collapse
            ghost
            items={[
              {
                key: "advanced",
                label: "Advanced: pick detailed roles",
                children: (
                  <div className="fedlify-advanced-roles">
                    <Typography.Paragraph type="secondary">Use this when none of the roles above fits. Picking any of these replaces the choice above.</Typography.Paragraph>
                    <Checkbox.Group
                      value={advanced}
                      onChange={(values) => {
                        const next = values as StudyRole[];
                        setAdvanced(next);
                        setChoice(next.length > 0 ? "ADVANCED" : "RESEARCHER");
                      }}
                    >
                      {ADVANCED_ROLES.map((role) => {
                        const reason = roleDisabledReason(role, can, { siteCount: sites.length });
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
                )
              }
            ]}
          />
        </Form>
      )}
    </Modal>
  );
}
