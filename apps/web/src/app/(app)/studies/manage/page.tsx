"use client";

import {
  EditOutlined,
  FolderOpenOutlined,
  InboxOutlined,
  MoreOutlined,
  PlusOutlined,
  RedoOutlined
} from "@ant-design/icons";
import {
  Button,
  Dropdown,
  Form,
  Input,
  Segmented,
  Select,
  Space,
  Typography,
  message
} from "antd";
import type { MenuProps } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppPage, AppPageHeader } from "@/components/AppPage";
import { CardListState } from "@/components/LoadStates";
import { FormError } from "@/components/FormFeedback";
import { IntakeSteps } from "@/components/IntakeSteps";
import { StatusTag } from "@/components/StatusTag";
import {
  CLINICAL_USE_CASE_OPTIONS,
  DATA_MODALITY_OPTIONS,
  INTENDED_USE_OPTIONS,
  normalizeMultiSelectValue
} from "@/lib/governance-options";
import { SELECTED_STUDY_STORAGE_KEY, type StudyListStatusFilter, type StudySummary } from "@/lib/studies";

type Organization = {
  id: string;
  name: string;
};

type StudyFormValues = {
  orgId: string;
  title: string;
  description?: string;
  goal?: string;
  researchQuestion?: string;
  clinicalUseCase?: string;
  population?: string;
  dataModalities?: string[];
  primaryOutcome?: string;
  riskLevel?: "LOW" | "MODERATE" | "HIGH";
  intendedUse?: string;
};

function formatDate(value?: string) {
  if (!value) return "Not updated";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function displayEnum(value?: string | null, fallback = "Not recorded") {
  if (!value) return fallback;
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function ManageStudiesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [filter, setFilter] = useState<StudyListStatusFilter>("active");
  const [studies, setStudies] = useState<StudySummary[]>([]);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingStudy, setEditingStudy] = useState<StudySummary | null>(null);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [createForm] = Form.useForm<StudyFormValues>();
  const [editForm] = Form.useForm<Pick<StudyFormValues, "title" | "description">>();
  const [messageApi, contextHolder] = message.useMessage();

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
      if (!studiesResponse.ok) throw new Error(studiesBody?.error?.message ?? "Study workspaces could not be loaded.");
      if (!meResponse.ok) throw new Error(meBody?.error?.message ?? "Institution memberships could not be loaded.");
      setStudies(studiesBody?.studies ?? []);
      setOrganizations(
        meBody?.user?.orgMemberships
          ?.filter((membership: { role: string }) => membership.role === "ORG_ADMIN")
          ?.map((membership: { organization: Organization }) => membership.organization) ?? []
      );
    } catch (error) {
      setStudies([]);
      setOrganizations([]);
      setLoadError(error instanceof Error ? error.message : "Study workspaces could not be loaded.");
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

  const organizationOptions = useMemo(
    () => organizations.map((organization) => ({ value: organization.id, label: organization.name })),
    [organizations]
  );

  function announceStudyChange() {
    window.dispatchEvent(new Event("fedlify:studiesUpdated"));
  }

  function openStudy(study: StudySummary) {
    window.localStorage.setItem(SELECTED_STUDY_STORAGE_KEY, study.id);
    router.push(`/studies/${study.id}`);
  }

  async function createStudy(values: StudyFormValues) {
    setCreateSubmitting(true);
    setCreateError(null);
    try {
      const response = await fetch("/api/v1/studies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...values,
          dataModalities: normalizeMultiSelectValue(values.dataModalities)
        })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "The study workspace could not be created.");
      messageApi.success("Study workspace created.");
      createForm.resetFields();
      setCreating(false);
      setFilter("active");
      announceStudyChange();
      await load();
    } catch (error) {
      const message = error instanceof Error ? error.message : "The study workspace could not be created.";
      setCreateError(message);
      messageApi.error(message);
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
      messageApi.error(body?.error?.message ?? "The study workspace could not be updated.");
      return false;
    }
    messageApi.success(success);
    announceStudyChange();
    await load();
    return true;
  }

  async function saveEdit(values: Pick<StudyFormValues, "title" | "description">) {
    if (!editingStudy) return;
    setEditSubmitting(true);
    setEditError(null);
    try {
      const ok = await patchStudy(
        editingStudy.id,
        { action: "updateDetails", title: values.title, description: values.description ?? null },
        "Study details updated."
      );
      if (ok) {
        setEditingStudy(null);
        editForm.resetFields();
      } else {
        setEditError("The study details could not be updated. Check your permissions and try again.");
      }
    } finally {
      setEditSubmitting(false);
    }
  }

  function cardMenu(study: StudySummary): MenuProps["items"] {
    return [
      {
        key: "open",
        icon: <FolderOpenOutlined />,
        label: "Open study",
        onClick: () => openStudy(study)
      },
      {
        key: "edit",
        icon: <EditOutlined />,
        label: "Edit study details",
        onClick: () => {
          setEditingStudy(study);
          editForm.setFieldsValue({ title: study.title, description: study.description ?? "" });
        }
      },
      study.status === "ARCHIVED"
        ? {
            key: "reactivate",
            icon: <RedoOutlined />,
            label: "Restore study",
            onClick: () => void patchStudy(study.id, { action: "reactivate" }, "Study workspace restored.")
          }
        : {
            key: "archive",
            icon: <InboxOutlined />,
            label: "Archive study",
            danger: true,
            onClick: () => void patchStudy(study.id, { action: "archive" }, "Study workspace archived.")
          }
    ];
  }

  return (
    <>
      {contextHolder}
      <AppPage>
        {creating ? (
          <>
            <AppPageHeader
              title="Create study"
              subtitle="Define the institution, study objective, and governance boundary for a new workspace."
              backLabel="Study management"
              onBack={() => setCreating(false)}
            />

            <div className="fedlify-intake-shell">
              <IntakeSteps
                steps={[
                  { title: "Method", description: "Manual entry", state: "complete" },
                  { title: "Definition", description: "Study details", state: "current" },
                  { title: "Governance", description: "Confirm boundary" }
                ]}
              />

              <Form form={createForm} layout="vertical" onFinish={createStudy} className="fedlify-intake-form">
                <FormError title="Study workspace was not created" message={createError} />
                <div className="fedlify-form-section-title">
                  <span />
                  <strong>Study definition</strong>
                  <span />
                </div>
                <div className="fedlify-intake-field-grid">
                  <Form.Item name="orgId" label="Institution / workspace" rules={[{ required: true }]}>
                    <Select size="large" options={organizationOptions} placeholder="Select institution" />
                  </Form.Item>
                  <Form.Item name="title" label="Study title" rules={[{ required: true, min: 3 }]}>
                    <Input size="large" placeholder="Enter study title" />
                  </Form.Item>
                  <Form.Item name="description" label="Study summary" className="fedlify-intake-full">
                    <Input.TextArea rows={3} placeholder="Summarize the scientific or operational objective for this federated study." />
                  </Form.Item>
                  <Form.Item name="goal" label="Primary objective" className="fedlify-intake-full" rules={[{ required: true }]}>
                    <Input.TextArea rows={2} placeholder="What should this study enable or prove?" />
                  </Form.Item>
                  <Form.Item name="researchQuestion" label="Research question" className="fedlify-intake-full" rules={[{ required: true }]}>
                    <Input.TextArea rows={2} placeholder="State the health-AI question this federation should answer." />
                  </Form.Item>
                  <Form.Item name="clinicalUseCase" label="Clinical use case" rules={[{ required: true }]}>
                    <Select
                      showSearch
                      options={CLINICAL_USE_CASE_OPTIONS}
                      optionFilterProp="label"
                      placeholder="Select clinical use case"
                    />
                  </Form.Item>
                  <Form.Item name="population" label="Population" rules={[{ required: true }]}>
                    <Input placeholder="Intended cohort or patient population" />
                  </Form.Item>
                  <Form.Item name="dataModalities" label="Data modalities" rules={[{ required: true }]}>
                    <Select
                      mode="tags"
                      options={DATA_MODALITY_OPTIONS}
                      optionFilterProp="label"
                      placeholder="Select modalities"
                    />
                  </Form.Item>
                  <Form.Item name="primaryOutcome" label="Primary endpoint / outcome" rules={[{ required: true }]}>
                    <Input placeholder="Primary model or operational outcome" />
                  </Form.Item>
                  <Form.Item name="riskLevel" label="Risk level" initialValue="MODERATE">
                    <Select
                      options={[
                        { value: "LOW", label: "Low" },
                        { value: "MODERATE", label: "Moderate" },
                        { value: "HIGH", label: "High" }
                      ]}
                    />
                  </Form.Item>
                  <Form.Item name="intendedUse" label="Intended use" rules={[{ required: true }]}>
                    <Select
                      showSearch
                      options={INTENDED_USE_OPTIONS}
                      optionFilterProp="label"
                      placeholder="Select intended use"
                    />
                  </Form.Item>
                </div>

                <div className="fedlify-form-section-title">
                  <span />
                  <strong>Governance</strong>
                  <span />
                </div>
                <Typography.Paragraph className="fedlify-muted">
                  Fedlify coordinates the study control plane. Participant-level clinical data must remain at
                  participating sites; releases are gated by ethics status, site onboarding, and human approval.
                </Typography.Paragraph>

                <Space style={{ justifyContent: "flex-end", width: "100%" }}>
                  <Button onClick={() => setCreating(false)} disabled={createSubmitting}>
                    Cancel
                  </Button>
                  <Button type="primary" htmlType="submit" className="fedlify-dark-action" loading={createSubmitting}>
                    Create study
                  </Button>
                </Space>
              </Form>
            </div>
          </>
        ) : editingStudy ? (
          <>
            <AppPageHeader
              title="Edit study"
              subtitle="Update study details without changing membership, approvals, or releases."
              backLabel="Study management"
              onBack={() => {
                setEditingStudy(null);
                setEditError(null);
              }}
            />

            <div className="fedlify-inline-create-card">
              <Form form={editForm} layout="vertical" onFinish={saveEdit} className="fedlify-inline-create-form">
                <FormError title="Study details were not updated" message={editError} />
                <div className="fedlify-intake-field-grid">
                  <Form.Item name="title" label="Study title" rules={[{ required: true, min: 3 }]}>
                    <Input />
                  </Form.Item>
                  <Form.Item name="description" label="Study summary" className="fedlify-intake-full">
                    <Input.TextArea rows={3} />
                  </Form.Item>
                </div>
                <Space className="fedlify-form-actions">
                  <Button
                    onClick={() => {
                      setEditingStudy(null);
                      setEditError(null);
                    }}
                    disabled={editSubmitting}
                  >
                    Cancel
                  </Button>
                  <Button type="primary" htmlType="submit" className="fedlify-dark-action" loading={editSubmitting}>
                    Save changes
                  </Button>
                </Space>
              </Form>
            </div>
          </>
        ) : (
          <>
            <AppPageHeader
              title="Study management"
              subtitle="Create, open, edit, archive, or restore governed study workspaces."
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
                <Button type="primary" icon={<PlusOutlined />} className="fedlify-dark-action" onClick={() => setCreating(true)}>
                  Create study
                </Button>
                </>
              }
            />

            <CardListState
              loading={loading}
              error={loadError}
              onRetry={() => void load()}
              isEmpty={studies.length === 0}
              emptyTitle={filter === "archived" ? "No archived studies" : "No active studies"}
              emptyDescription={
                filter === "archived"
                  ? "Archived studies remain available for restoration when work resumes."
                  : "Create a study workspace before adding sites, documents, approvals, or releases."
              }
              emptyIcon={filter === "archived" ? <InboxOutlined /> : <PlusOutlined />}
              skeletonClassName="fedlify-study-card-grid"
            >
              <div className="fedlify-study-card-grid">
                {studies.map((study) => (
                  <article
                    key={study.id}
                    className="fedlify-manage-study-card"
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
                        <StatusTag value={study.status === "ARCHIVED" ? "ARCHIVED" : "ACTIVE"} />
                        <Dropdown menu={{ items: cardMenu(study) }} trigger={["click"]}>
                          <Button
                            type="text"
                            icon={<MoreOutlined />}
                            aria-label={`Manage ${study.title}`}
                            onClick={(event) => event.stopPropagation()}
                          />
                        </Dropdown>
                      </Space>
                    </div>
                    <div className="fedlify-manage-study-meta">
                      <span>Updated</span>
                      <strong>{formatDate(study.updatedAt)}</strong>
                    </div>
                    <div className="fedlify-manage-study-details">
                      <span>{study.organization?.name}</span>
                      <span>Ethics: {displayEnum(study.ethics?.[0]?.status, "Pending")}</span>
                      <span>{study._count?.sites ?? 0} sites</span>
                      <span>{study._count?.releases ?? 0} releases</span>
                    </div>
                  </article>
                ))}
              </div>
            </CardListState>
          </>
        )}
      </AppPage>
    </>
  );
}
