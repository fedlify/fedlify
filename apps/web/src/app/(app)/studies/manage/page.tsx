"use client";

import { EditOutlined, FolderOpenOutlined, InboxOutlined, MoreOutlined, PlusOutlined, RedoOutlined } from "@ant-design/icons";
import { Button, Dropdown, Form, Input, Modal, Segmented, Select, Space, Typography, message } from "antd";
import type { MenuProps } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppPage, AppPageHeader } from "@/components/AppPage";
import { CardListState } from "@/components/LoadStates";
import { FormError } from "@/components/FormFeedback";
import { PendingInvitationsCard } from "@/components/PendingInvitationsCard";
import { StatusTag } from "@/components/StatusTag";
import { meaningfulProtocolText } from "@/lib/governance";
import { SELECTED_STUDY_STORAGE_KEY, type StudyListStatusFilter, type StudySummary } from "@/lib/studies";
import { statusLabel } from "@/lib/terms";

type Organization = {
  id: string;
  name: string;
};

type CreateValues = {
  orgId?: string;
  title: string;
  description?: string;
};

/** Where a new or opened study goes first: Study setup, Details. */
const DETAILS_TAB = "section=protocol&tab=details";

export default function ManageStudiesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [filter, setFilter] = useState<StudyListStatusFilter>("active");
  const [studies, setStudies] = useState<StudySummary[]>([]);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  // Every workspace the person belongs to (not only the ones they can create studies in).
  const [workspaceCount, setWorkspaceCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createForm] = Form.useForm<CreateValues>();
  const [messageApi, contextHolder] = message.useMessage();
  const [modal, modalContextHolder] = Modal.useModal();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [studiesResponse, meResponse] = await Promise.all([
        fetch(`/api/v1/studies?status=${filter}`, { cache: "no-store" }),
        fetch("/api/v1/me", { cache: "no-store" })
      ]);
      const studiesBody = await studiesResponse.json().catch(() => null);
      const meBody = await meResponse.json().catch(() => null);
      if (!studiesResponse.ok) throw new Error(studiesBody?.error?.message ?? "Your studies could not be loaded.");
      if (!meResponse.ok) throw new Error(meBody?.error?.message ?? "Your institutions could not be loaded.");
      setStudies(studiesBody?.studies ?? []);
      const memberships: Array<{ role: string; organization: Organization }> = meBody?.user?.orgMemberships ?? [];
      setWorkspaceCount(memberships.length);
      setOrganizations(memberships.filter((membership) => membership.role === "ORG_ADMIN").map((membership) => membership.organization));
    } catch (error) {
      setStudies([]);
      setOrganizations([]);
      setLoadError(error instanceof Error ? error.message : "Your studies could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (searchParams.get("new") === "1") setCreating(true);
  }, [searchParams]);

  const organizationOptions = useMemo(() => organizations.map((organization) => ({ value: organization.id, label: organization.name })), [organizations]);

  function announceStudyChange() {
    window.dispatchEvent(new Event("fedlify:studiesUpdated"));
  }

  function closeCreate() {
    setCreating(false);
    setCreateError(null);
    createForm.resetFields();
    if (searchParams.get("new") === "1") router.replace("/studies/manage");
  }

  function openStudy(study: StudySummary, query = "") {
    window.localStorage.setItem(SELECTED_STUDY_STORAGE_KEY, study.id);
    router.push(`/studies/${study.id}${query ? `?${query}` : ""}`);
  }

  async function createStudy(values: CreateValues) {
    const orgId = values.orgId ?? organizations[0]?.id;
    if (!orgId) {
      setCreateError("You need an institution to create a study. Ask an administrator to add you to one.");
      return;
    }
    setCreateSubmitting(true);
    setCreateError(null);
    try {
      const response = await fetch("/api/v1/studies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId, title: values.title, description: values.description?.trim() || undefined })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "The study could not be created.");
      const id = body?.study?.id as string | undefined;
      messageApi.success("Study created.");
      announceStudyChange();
      closeCreate();
      if (id) {
        window.localStorage.setItem(SELECTED_STUDY_STORAGE_KEY, id);
        router.push(`/studies/${id}?${DETAILS_TAB}`);
      } else {
        setFilter("active");
        await load();
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : "The study could not be created.";
      setCreateError(text);
    } finally {
      setCreateSubmitting(false);
    }
  }

  async function patchStudy(studyId: string, values: Record<string, unknown>, success: string) {
    const response = await fetch(`/api/v1/studies/${studyId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values)
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      messageApi.error(body?.error?.message ?? "The study could not be updated.");
      return false;
    }
    messageApi.success(success);
    announceStudyChange();
    await load();
    return true;
  }

  function confirmArchive(study: StudySummary) {
    modal.confirm({
      title: `Archive "${study.title}"?`,
      content: "An archived study is hidden from your list and stops sites from pulling code. You can restore it later.",
      okText: "Archive",
      okButtonProps: { danger: true },
      cancelText: "Cancel",
      onOk: () => patchStudy(study.id, { action: "archive" }, "Study archived.")
    });
  }

  function cardMenu(study: StudySummary): MenuProps["items"] {
    return [
      { key: "open", icon: <FolderOpenOutlined />, label: "Open", onClick: () => openStudy(study) },
      { key: "edit", icon: <EditOutlined />, label: "Edit", onClick: () => openStudy(study, DETAILS_TAB) },
      study.status === "ARCHIVED"
        ? { key: "reactivate", icon: <RedoOutlined />, label: "Restore", onClick: () => void patchStudy(study.id, { action: "reactivate" }, "Study restored.") }
        : { key: "archive", icon: <InboxOutlined />, label: "Archive", danger: true, onClick: () => confirmArchive(study) }
    ];
  }

  const showFirstStudyPrompt = !loading && !loadError && studies.length === 0 && filter === "active";
  const createButton = (
    <Button type="primary" icon={<PlusOutlined />} className="fedlify-dark-action" onClick={() => setCreating(true)}>
      Create study
    </Button>
  );

  return (
    <>
      {contextHolder}
      {modalContextHolder}
      <AppPage>
        <PendingInvitationsCard
          onAccepted={(studyId) => {
            void load();
            router.push(`/studies/${studyId}`);
          }}
        />
        <AppPageHeader
          title="Study management"
          subtitle="Your studies. Open one to continue."
          actions={
            <>
              <Segmented
                className="fedlify-soft-segmented"
                value={filter}
                onChange={(value) => setFilter(value as StudyListStatusFilter)}
                options={[
                  { label: "Active", value: "active" },
                  { label: "Archived", value: "archived" }
                ]}
              />
              {showFirstStudyPrompt ? null : createButton}
            </>
          }
        />

        <CardListState
          loading={loading}
          error={loadError}
          onRetry={() => void load()}
          isEmpty={studies.length === 0}
          emptyTitle={filter === "archived" ? "No archived studies" : "Create your first study"}
          emptyDescription={filter === "archived" ? "Archived studies can be restored when work resumes." : "Give it a title and a one-line summary. You add the details next."}
          emptyIcon={filter === "archived" ? <InboxOutlined /> : <PlusOutlined />}
          emptyAction={filter === "archived" ? undefined : createButton}
        >
          <div className="fl-grid">
            {studies.map((study) => {
              const summary = meaningfulProtocolText(study.description);
              return (
                <article
                  key={study.id}
                  className="fedlify-manage-study-card fl-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => openStudy(study)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openStudy(study);
                    }
                  }}
                >
                  <div className="fedlify-manage-study-top">
                    <Typography.Title level={4}>{study.title}</Typography.Title>
                    <Space>
                      {study.status === "ARCHIVED" ? <StatusTag value="ARCHIVED" /> : null}
                      <Dropdown menu={{ items: cardMenu(study) }} trigger={["click"]}>
                        <Button type="text" icon={<MoreOutlined />} aria-label={`Manage ${study.title}`} onClick={(event) => event.stopPropagation()} />
                      </Dropdown>
                    </Space>
                  </div>
                  {summary ? <p className="fedlify-manage-study-summary">{summary}</p> : null}
                  <div className="fedlify-manage-study-details">
                    <span>Sites {study._count?.sites ?? 0}</span>
                    <span>Ethics: {statusLabel(study.ethics?.[0]?.status ?? "PENDING")}</span>
                    {workspaceCount > 1 && study.organization?.name ? <span>{study.organization.name}</span> : null}
                  </div>
                </article>
              );
            })}
          </div>
        </CardListState>
      </AppPage>

      <Modal title="Create study" open={creating} onCancel={closeCreate} footer={null} width={520} destroyOnClose maskClosable={false}>
        <Form form={createForm} layout="vertical" onFinish={createStudy} className="fedlify-inline-create-form">
          <FormError title="The study was not created" message={createError} />
          {organizations.length > 1 ? (
            <Form.Item name="orgId" label="Institution" rules={[{ required: true, message: "Choose an institution." }]} initialValue={organizations[0]?.id}>
              <Select options={organizationOptions} />
            </Form.Item>
          ) : null}
          <Form.Item name="title" label="Study title" rules={[{ required: true, min: 3, message: "Enter a title of at least 3 characters." }]}>
            <Input autoFocus />
          </Form.Item>
          <Form.Item name="description" label="Summary">
            <Input placeholder="One line about the study" />
          </Form.Item>
          <Space className="fedlify-form-actions">
            <Button onClick={closeCreate} disabled={createSubmitting}>
              Cancel
            </Button>
            <Button type="primary" htmlType="submit" className="fedlify-dark-action" loading={createSubmitting}>
              Create study
            </Button>
          </Space>
        </Form>
      </Modal>
    </>
  );
}
