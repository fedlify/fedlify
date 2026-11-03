"use client";

import { MailOutlined } from "@ant-design/icons";
import { Alert, Button, Space, Tag, Typography, message } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { SELECTED_STUDY_EVENT, SELECTED_STUDY_STORAGE_KEY } from "@/lib/studies";

type PendingInvitation = {
  id: string;
  studyId: string;
  studyTitle: string;
  organizationName: string;
  roles: string[];
  invitedBy: string | null;
  expiresAt: string;
};

function roleLabel(role: string) {
  return role.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Shows the signed-in user's pending study invitations with an Accept action. Rendered on the study
 * summary and the study list, so a collaborator who was invited sees it on sign-in without an email.
 */
export function PendingInvitationsCard({ onAccepted }: { onAccepted?: (studyId: string) => void }) {
  const router = useRouter();
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/me/invitations", { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json().catch(() => null);
      setInvitations((body?.invitations ?? []) as PendingInvitation[]);
    } catch {
      // The card is advisory; a failed load just hides it.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function accept(invitation: PendingInvitation) {
    setAcceptingId(invitation.id);
    try {
      const response = await fetch("/api/v1/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invitationId: invitation.id })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "The invitation could not be accepted.");
      messageApi.success(`You joined ${invitation.studyTitle}.`);
      setInvitations((current) => current.filter((item) => item.id !== invitation.id));
      window.localStorage.setItem(SELECTED_STUDY_STORAGE_KEY, invitation.studyId);
      window.dispatchEvent(new CustomEvent(SELECTED_STUDY_EVENT, { detail: { studyId: invitation.studyId } }));
      window.dispatchEvent(new Event("fedlify:studiesUpdated"));
      if (onAccepted) onAccepted(invitation.studyId);
      else router.push(`/studies/${invitation.studyId}`);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "The invitation could not be accepted.");
    } finally {
      setAcceptingId(null);
    }
  }

  if (invitations.length === 0) return <>{contextHolder}</>;

  return (
    <>
      {contextHolder}
      <Alert
        type="info"
        showIcon
        icon={<MailOutlined />}
        style={{ marginBottom: 16 }}
        message={invitations.length === 1 ? "You have been invited to a study" : `You have ${invitations.length} study invitations`}
        description={
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            {invitations.map((invitation) => (
              <Space key={invitation.id} wrap align="center" style={{ justifyContent: "space-between", width: "100%" }}>
                <span>
                  <Typography.Text strong>{invitation.studyTitle}</Typography.Text>
                  <Typography.Text type="secondary"> · {invitation.organizationName}</Typography.Text>
                  {invitation.invitedBy ? <Typography.Text type="secondary"> · invited by {invitation.invitedBy}</Typography.Text> : null}
                  <span style={{ marginLeft: 8 }}>
                    {invitation.roles.map((role) => (
                      <Tag key={role}>{roleLabel(role)}</Tag>
                    ))}
                  </span>
                </span>
                <Button type="primary" size="small" loading={acceptingId === invitation.id} onClick={() => void accept(invitation)}>
                  Accept and open study
                </Button>
              </Space>
            ))}
          </Space>
        }
      />
    </>
  );
}
