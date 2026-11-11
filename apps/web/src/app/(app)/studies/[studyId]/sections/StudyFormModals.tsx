"use client";

import { documentKindLabel } from "@/lib/terms";
import { SafetyCertificateOutlined, UploadOutlined } from "@ant-design/icons";
import { Button, Form, Input, Modal, Select, Space, Upload } from "antd";
import type { UploadFile } from "antd";
import { useState } from "react";
import { FormError } from "@/components/FormFeedback";
import { normalizeMultiSelectValue } from "@/lib/governance-options";
import { displayEnum, intendedUseText, plainText, useStudyRequest, type EntityRecord, type StudyDetail } from "./shared";

/** The forms on the study pages. Each opens in a modal and keeps the API call and validation it always had. */

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

/** Study details: a title, a one-line summary and six short fields. One title, one Save button. */
export function StudyDetailsModal({ open, study, studyId, onClose, onSaved }: ModalProps & { study: StudyDetail }) {
  const { submitting, error, setError, patch, contextHolder } = useStudyRequest(onSaved);
  function close() {
    setError(null);
    onClose();
  }
  // Empty text is sent as null so a field can be cleared.
  const clean = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  return (
    <>
      {contextHolder}
      <Modal title="Study details" open={open} onCancel={close} footer={null} width={640} destroyOnClose maskClosable={false}>
        <Form
          layout="vertical"
          className="fedlify-inline-create-form"
          initialValues={{
            title: study.title,
            description: plainText(study.description),
            goal: plainText(study.goal),
            researchQuestion: plainText(study.researchQuestion),
            intendedUse: intendedUseText(study),
            population: plainText(study.population),
            dataModalities: plainText(study.dataModalities),
            primaryOutcome: plainText(study.primaryOutcome)
          }}
          onFinish={async (values) => {
            const result = await patch(
              `/api/v1/studies/${studyId}`,
              {
                action: "updateDetails",
                title: values.title,
                description: clean(values.description),
                goal: clean(values.goal),
                researchQuestion: clean(values.researchQuestion),
                intendedUse: clean(values.intendedUse),
                population: clean(values.population),
                dataModalities: clean(values.dataModalities),
                primaryOutcome: clean(values.primaryOutcome)
              },
              "Study details saved."
            );
            if (result) close();
          }}
        >
          <FormError title="Study details were not saved" message={error} />
          <Form.Item name="title" label="Study title" rules={[{ required: true, min: 3 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Summary">
            <Input placeholder="One line about the study" />
          </Form.Item>
          <Form.Item name="goal" label="Objective" rules={[{ required: true, message: "Write the objective in a sentence or two." }]}>
            <Input.TextArea rows={2} placeholder="What should this study achieve?" />
          </Form.Item>
          <Form.Item name="researchQuestion" label="Research question">
            <Input.TextArea rows={2} placeholder="The question the study answers" />
          </Form.Item>
          <Form.Item name="intendedUse" label="Intended use">
            <Input.TextArea rows={2} placeholder="How the model will be used, for example research only" />
          </Form.Item>
          <Form.Item name="population" label="Population">
            <Input placeholder="Who the data is about" />
          </Form.Item>
          <Form.Item name="dataModalities" label="Data types">
            <Input placeholder="For example: health records, lab results, images" />
          </Form.Item>
          <Form.Item name="primaryOutcome" label="Main outcome">
            <Input placeholder="What the model predicts or measures" />
          </Form.Item>
          <Space className="fedlify-form-actions">
            <Button onClick={close} disabled={submitting}>
              Cancel
            </Button>
            <Button type="primary" htmlType="submit" className="fedlify-dark-action" loading={submitting}>
              Save
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
