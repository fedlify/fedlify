"use client";

import { documentKindLabel } from "@/lib/terms";
import { SafetyCertificateOutlined, UploadOutlined } from "@ant-design/icons";
import { Button, Form, Input, Modal, Select, Space, Upload } from "antd";
import type { UploadFile } from "antd";
import { useState } from "react";
import { FormError } from "@/components/FormFeedback";
import { RichTextEditor } from "@/components/RichTextEditor";
import {
  CLINICAL_USE_CASE_OPTIONS,
  DATA_MODALITY_OPTIONS,
  INTENDED_USE_OPTIONS,
  normalizeMultiSelectValue,
  splitMultiSelectValue,
} from "@/lib/governance-options";
import {
  displayEnum,
  GovernanceSection,
  normalizeStudyDesignPayload,
  REQUIRED_RICH_TEXT_RULE,
  useStudyRequest,
  type EntityRecord,
  type StudyDetail,
} from "./shared";

/** The four forms on the study pages. Each opens in a modal and keeps the API call and validation it always had. */

async function sha256File(file: File): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type ModalProps = {
  open: boolean;
  studyId: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
};

export function StudyDesignModal({
  open,
  study,
  studyId,
  onClose,
  onSaved,
}: ModalProps & { study: StudyDetail }) {
  const { submitting, error, setError, patch, contextHolder } =
    useStudyRequest(onSaved);
  function close() {
    setError(null);
    onClose();
  }
  return (
    <>
      {contextHolder}
      <Modal
        title="Edit study details"
        open={open}
        onCancel={close}
        footer={null}
        width={920}
        destroyOnClose
        maskClosable={false}
      >
        <Form
          layout="vertical"
          className="fedlify-inline-create-form"
          initialValues={{
            title: study.title,
            description: study.description,
            goal: study.goal,
            researchQuestion: study.researchQuestion,
            hypothesis: study.hypothesis,
            secondaryObjectives: study.secondaryObjectives,
            clinicalUseCase: study.clinicalUseCase,
            studyDesign: study.studyDesign,
            population: study.population,
            eligibilityCriteria: study.eligibilityCriteria,
            dataModalities: splitMultiSelectValue(study.dataModalities),
            primaryOutcome: study.primaryOutcome,
            primaryEndpointDetails: study.primaryEndpointDetails,
            secondaryOutcomes: study.secondaryOutcomes,
            sampleSizeRationale: study.sampleSizeRationale,
            analysisPlan: study.analysisPlan,
            dataHandlingPlan: study.dataHandlingPlan,
            humanAiWorkflow: study.humanAiWorkflow,
            fairnessPlan: study.fairnessPlan,
            disseminationPlan: study.disseminationPlan,
            riskLevel: study.riskLevel ?? "MODERATE",
            intendedUse: study.intendedUse,
          }}
          onFinish={async (values) => {
            const result = await patch(
              `/api/v1/studies/${studyId}`,
              {
                action: "updateDetails",
                ...normalizeStudyDesignPayload(values),
                dataModalities: normalizeMultiSelectValue(
                  values.dataModalities,
                ),
              },
              "Study details saved.",
            );
            if (result) close();
          }}
        >
          <FormError title="Study details were not saved" message={error} />
          <GovernanceSection title="Overview">
            <div className="fedlify-intake-field-grid">
              <Form.Item
                name="title"
                label="Study title"
                rules={[{ required: true, min: 3 }]}
              >
                <Input />
              </Form.Item>
              <Form.Item name="riskLevel" label="Risk level">
                <Select
                  options={[
                    { value: "LOW", label: "Low" },
                    { value: "MODERATE", label: "Moderate" },
                    { value: "HIGH", label: "High" },
                  ]}
                />
              </Form.Item>
              <Form.Item
                name="description"
                label="Study summary"
                className="fedlify-intake-full"
              >
                <RichTextEditor
                  minRows={4}
                  placeholder="Summarize the study rationale, context, and scope."
                />
              </Form.Item>
              <Form.Item
                name="clinicalUseCase"
                label="Clinical use case"
                rules={[{ required: true }]}
              >
                <Select
                  showSearch
                  options={CLINICAL_USE_CASE_OPTIONS}
                  optionFilterProp="label"
                  placeholder="Select clinical use case"
                />
              </Form.Item>
              <Form.Item
                name="intendedUse"
                label="Intended use"
                rules={[{ required: true }]}
              >
                <Select
                  showSearch
                  options={INTENDED_USE_OPTIONS}
                  optionFilterProp="label"
                  placeholder="Select intended use"
                />
              </Form.Item>
            </div>
          </GovernanceSection>
          <GovernanceSection title="Scientific question">
            <div className="fedlify-intake-field-grid">
              <Form.Item
                name="goal"
                label="Primary objective"
                className="fedlify-intake-full"
                rules={[REQUIRED_RICH_TEXT_RULE]}
              >
                <RichTextEditor
                  minRows={3}
                  placeholder="State the primary scientific or operational objective."
                />
              </Form.Item>
              <Form.Item
                name="researchQuestion"
                label="Research question"
                className="fedlify-intake-full"
                rules={[REQUIRED_RICH_TEXT_RULE]}
              >
                <RichTextEditor
                  minRows={3}
                  placeholder="State the question this study should answer."
                />
              </Form.Item>
              <Form.Item
                name="hypothesis"
                label="Hypothesis"
                className="fedlify-intake-full"
              >
                <RichTextEditor
                  minRows={3}
                  placeholder="Optional: state the hypothesis if this study is hypothesis-driven."
                />
              </Form.Item>
              <Form.Item
                name="secondaryObjectives"
                label="Secondary objectives"
                className="fedlify-intake-full"
              >
                <RichTextEditor
                  minRows={4}
                  placeholder="Optional: add secondary objectives or exploratory questions."
                />
              </Form.Item>
            </div>
          </GovernanceSection>
          <GovernanceSection title="Design and population">
            <div className="fedlify-intake-field-grid">
              <Form.Item
                name="studyDesign"
                label="Type of study"
                className="fedlify-intake-full"
                rules={[REQUIRED_RICH_TEXT_RULE]}
              >
                <RichTextEditor
                  minRows={4}
                  placeholder="Describe the type of study, its timing, and how data stays at each site."
                />
              </Form.Item>
              <Form.Item
                name="population"
                label="Population"
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
              <Form.Item
                name="dataModalities"
                label="Data modalities"
                rules={[{ required: true }]}
              >
                <Select
                  mode="tags"
                  options={DATA_MODALITY_OPTIONS}
                  optionFilterProp="label"
                  placeholder="Select modalities"
                />
              </Form.Item>
              <Form.Item
                name="eligibilityCriteria"
                label="Eligibility criteria"
                className="fedlify-intake-full"
                rules={[REQUIRED_RICH_TEXT_RULE]}
              >
                <RichTextEditor
                  minRows={4}
                  placeholder="Define inclusion, exclusion, site, and cohort criteria."
                />
              </Form.Item>
            </div>
          </GovernanceSection>
          <GovernanceSection title="Outcomes and analysis">
            <div className="fedlify-intake-field-grid">
              <Form.Item
                name="primaryOutcome"
                label="Primary endpoint / outcome"
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
              <Form.Item
                name="primaryEndpointDetails"
                label="Endpoint details"
                className="fedlify-intake-full"
                rules={[REQUIRED_RICH_TEXT_RULE]}
              >
                <RichTextEditor
                  minRows={4}
                  placeholder="Describe how the primary endpoint is measured and evaluated."
                />
              </Form.Item>
              <Form.Item
                name="secondaryOutcomes"
                label="Secondary outcomes"
                className="fedlify-intake-full"
              >
                <RichTextEditor
                  minRows={4}
                  placeholder="Optional: list secondary or exploratory outcomes."
                />
              </Form.Item>
              <Form.Item
                name="sampleSizeRationale"
                label="Sample size / rationale"
                className="fedlify-intake-full"
              >
                <RichTextEditor
                  minRows={4}
                  placeholder="Optional: explain sample size, site count, or cohort availability rationale."
                />
              </Form.Item>
              <Form.Item
                name="analysisPlan"
                label="Analysis plan"
                className="fedlify-intake-full"
                rules={[REQUIRED_RICH_TEXT_RULE]}
              >
                <RichTextEditor
                  minRows={5}
                  placeholder="Describe statistical, model-performance, validation, and how results from sites are combined."
                />
              </Form.Item>
            </div>
          </GovernanceSection>
          <GovernanceSection title="AI and data sharing">
            <div className="fedlify-intake-field-grid">
              <Form.Item
                name="dataHandlingPlan"
                label="Data handling plan"
                className="fedlify-intake-full"
                rules={[REQUIRED_RICH_TEXT_RULE]}
              >
                <RichTextEditor
                  minRows={5}
                  placeholder="Describe site-local data handling, privacy boundaries, artifacts, and outputs."
                />
              </Form.Item>
              <Form.Item
                name="humanAiWorkflow"
                label="How people and the AI work together"
                className="fedlify-intake-full"
              >
                <RichTextEditor
                  minRows={4}
                  placeholder="Optional: describe human review, overrides, and AI-assisted decision points."
                />
              </Form.Item>
              <Form.Item
                name="fairnessPlan"
                label="Fairness / subgroup plan"
                className="fedlify-intake-full"
              >
                <RichTextEditor
                  minRows={4}
                  placeholder="Optional: describe subgroup checks, fairness risks, and mitigation steps."
                />
              </Form.Item>
              <Form.Item
                name="disseminationPlan"
                label="Dissemination plan"
                className="fedlify-intake-full"
              >
                <RichTextEditor
                  minRows={4}
                  placeholder="Optional: describe release, reporting, and communication plans."
                />
              </Form.Item>
            </div>
          </GovernanceSection>
          <Space className="fedlify-form-actions">
            <Button onClick={close} disabled={submitting}>
              Cancel
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              className="fedlify-dark-action"
              loading={submitting}
            >
              Save study design
            </Button>
          </Space>
        </Form>
      </Modal>
    </>
  );
}

export function EthicsModal({
  open,
  record,
  studyId,
  onClose,
  onSaved,
}: ModalProps & { record: EntityRecord | null }) {
  const { submitting, error, setError, post, patch, contextHolder } =
    useStudyRequest(onSaved);
  const editing = Boolean(record?.id);
  function close() {
    setError(null);
    onClose();
  }
  return (
    <>
      {contextHolder}
      <Modal
        title={editing ? "Edit ethics decision" : "Record ethics decision"}
        open={open}
        onCancel={close}
        footer={null}
        width={640}
        destroyOnClose
        maskClosable={false}
      >
        <p className="fedlify-muted">
          Write down the review status, approval identifier, who reviewed it,
          and any notes.
        </p>
        <Form
          key={record?.id ?? "new-ethics-record"}
          layout="vertical"
          className="fedlify-inline-create-form"
          initialValues={{
            status: record?.status ?? "PENDING",
            approvalNumber: record?.approvalNumber ?? undefined,
            approvingBody: record?.approvingBody ?? undefined,
            notes: record?.notes ?? undefined,
          }}
          onFinish={async (values) => {
            const result = editing
              ? await patch(
                  `/api/v1/studies/${studyId}/ethics/${String(record?.id)}`,
                  values,
                  "Ethics decision updated.",
                )
              : await post(
                  `/api/v1/studies/${studyId}/ethics`,
                  values,
                  "Ethics decision saved.",
                );
            if (result) close();
          }}
        >
          <FormError
            title={
              editing
                ? "Ethics decision was not updated"
                : "Ethics decision was not saved"
            }
            message={error}
          />
          <div className="fedlify-intake-field-grid">
            <Form.Item name="status" label="Review status">
              <Select
                options={[
                  "NOT_REQUIRED",
                  "PENDING",
                  "APPROVED",
                  "REJECTED",
                  "EXPIRED",
                ].map((value) => ({
                  value,
                  label: displayEnum(value),
                }))}
              />
            </Form.Item>
            <Form.Item name="approvalNumber" label="Approval identifier">
              <Input />
            </Form.Item>
            <Form.Item
              name="approvingBody"
              label="Review body"
              className="fedlify-intake-full"
            >
              <Input />
            </Form.Item>
            <Form.Item
              name="notes"
              label="Decision notes"
              className="fedlify-intake-full"
            >
              <Input.TextArea rows={3} />
            </Form.Item>
          </div>
          <Space className="fedlify-form-actions">
            <Button onClick={close}>Cancel</Button>
            <Button
              type="primary"
              htmlType="submit"
              icon={<SafetyCertificateOutlined />}
              className="fedlify-dark-action"
              loading={submitting}
            >
              {editing ? "Update decision" : "Save decision"}
            </Button>
          </Space>
        </Form>
      </Modal>
    </>
  );
}

export function DocumentModal({ open, studyId, onClose, onSaved }: ModalProps) {
  const { submitting, error, setError, post, messageApi, contextHolder } =
    useStudyRequest(onSaved);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  function close() {
    setError(null);
    setFile(null);
    onClose();
  }

  async function upload(values: { kind: string; extractedText?: string }) {
    if (!file) {
      setError("Select a document before registering the record.");
      messageApi.error("Select a document before registering the record.");
      return false;
    }
    setUploading(true);
    setError(null);
    try {
      const uploadUrlResponse = await fetch(
        `/api/v1/studies/${studyId}/documents/upload-url`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: values.kind,
            filename: file.name,
            contentType: file.type || "application/octet-stream",
          }),
        },
      );
      const uploadUrlBody = await uploadUrlResponse.json();
      if (!uploadUrlResponse.ok)
        throw new Error(
          uploadUrlBody?.error?.message ?? "The document upload was rejected.",
        );

      await fetch(uploadUrlBody.uploadUrl, {
        method: "PUT",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
      });

      const checksum = await sha256File(file);
      const result = await post(
        `/api/v1/studies/${studyId}/documents`,
        {
          kind: values.kind,
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          storageKey: uploadUrlBody.storageKey,
          sha256: checksum,
          extractedText: values.extractedText,
        },
        "Study document registered.",
      );
      return Boolean(result);
    } catch (err) {
      const next =
        err instanceof Error
          ? err.message
          : "The study document could not be registered.";
      setError(next);
      messageApi.error(next);
      return false;
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      {contextHolder}
      <Modal
        title="Upload a study document"
        open={open}
        onCancel={close}
        footer={null}
        width={640}
        destroyOnClose
        maskClosable={false}
      >
        <p className="fedlify-muted">
          Add a study protocol, ethics, policy, or agreement document. Do not
          upload patient-level data.
        </p>
        <Form
          layout="vertical"
          className="fedlify-inline-create-form"
          onFinish={async (values) => {
            if (await upload(values)) close();
          }}
        >
          <FormError
            title="Study document was not registered"
            message={error}
          />
          <Form.Item
            name="kind"
            label="Document type"
            initialValue="REQUIREMENTS_PDF"
          >
            <Select
              options={[
                "REQUIREMENTS_PDF",
                "ETHICS_APPROVAL",
                "DATA_PROCESSING_AGREEMENT",
                "SITE_POLICY",
                "OTHER",
              ].map((value) => ({
                value,
                label: documentKindLabel(value),
              }))}
            />
          </Form.Item>
          <Upload.Dragger
            beforeUpload={(next) => {
              setFile(next);
              return false;
            }}
            maxCount={1}
            fileList={
              file
                ? ([
                    { uid: file.name, name: file.name } as UploadFile,
                  ] as UploadFile[])
                : []
            }
            onRemove={() => setFile(null)}
          >
            <p>
              <UploadOutlined /> Choose a file
            </p>
          </Upload.Dragger>
          <Form.Item
            name="extractedText"
            label="Document summary or extracted text"
            style={{ marginTop: 16 }}
          >
            <Input.TextArea rows={4} />
          </Form.Item>
          <Space className="fedlify-form-actions">
            <Button onClick={close}>Cancel</Button>
            <Button
              type="primary"
              htmlType="submit"
              icon={<UploadOutlined />}
              className="fedlify-dark-action"
              loading={submitting || uploading}
            >
              Register document
            </Button>
          </Space>
        </Form>
      </Modal>
    </>
  );
}

export function SiteModal({
  open,
  studyId,
  onClose,
  onSaved,
  onAdded,
}: ModalProps & { onAdded: (accessCode: string | null) => void }) {
  const { submitting, error, setError, post, contextHolder } =
    useStudyRequest(onSaved);
  function close() {
    setError(null);
    onClose();
  }
  return (
    <>
      {contextHolder}
      <Modal
        title="Add site"
        open={open}
        onCancel={close}
        footer={null}
        width={640}
        destroyOnClose
        maskClosable={false}
      >
        <p className="fedlify-muted">
          Add the hospital or institution first. Its team will describe its data and computers on the site&apos;s own page.
        </p>
        <Form
          layout="vertical"
          className="fedlify-inline-create-form"
          onFinish={async (values) => {
            const dataProfile = values.dataProfile
              ? {
                  ...values.dataProfile,
                  modality: normalizeMultiSelectValue(
                    values.dataProfile.modality,
                  ),
                }
              : undefined;
            const body = await post(
              `/api/v1/studies/${studyId}/sites`,
              { ...values, dataProfile },
              "Site added.",
            );
            if (body) {
              onAdded(body?.apiToken ?? null);
              close();
            }
          }}
        >
          <FormError title="Site was not added" message={error} />
          <div className="fedlify-intake-field-grid">
            <Form.Item
              name="name"
              label="Site name"
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
            <Form.Item
              name="institutionName"
              label="Institution name"
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
            <Form.Item name="principalInvestigator" label="Site PI">
              <Input />
            </Form.Item>
            <Form.Item
              name="notes"
              label="Note for the site"
              className="fedlify-intake-full"
            >
              <Input.TextArea
                rows={2}
                placeholder="Optional note for the person setting up the site."
              />
            </Form.Item>
          </div>
          <Space className="fedlify-form-actions">
            <Button onClick={close}>Cancel</Button>
            <Button
              type="primary"
              htmlType="submit"
              className="fedlify-dark-action"
              loading={submitting}
            >
              Add site
            </Button>
          </Space>
        </Form>
      </Modal>
    </>
  );
}
