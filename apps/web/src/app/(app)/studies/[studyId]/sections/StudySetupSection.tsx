"use client";

import { documentKindLabel } from "@/lib/terms";
import { EditOutlined, FileTextOutlined, PlusOutlined, SafetyCertificateOutlined, UploadOutlined } from "@ant-design/icons";
import { Alert, Button, Space, Tabs, Typography } from "antd";
import { useState } from "react";
import { WorkspaceCardGrid, WorkspaceRecordCard } from "@/components/DataCards";
import { Details } from "@/components/Details";
import { FieldGrid, FieldRow } from "@/components/EntityDetail";
import { StatusTag } from "@/components/StatusTag";
import { DATA_MODALITY_OPTIONS, governanceOptionLabel, splitMultiSelectValue } from "@/lib/governance-options";
import { ethicsExpired } from "@/lib/governance";
import { firstIncompleteSetupTab, type StudySetupTab } from "@/lib/study-workspace";
import { DocumentModal, StudyDetailsModal } from "./StudyFormModals";
import { StudyQuestionsSection } from "./StudyQuestionsSection";
import {
  EARLIER_DESIGN_NOTES,
  formatDate,
  intendedUseText,
  plainText,
  protocolStatus,
  REQUIREMENTS_TOTAL,
  status,
  text,
  type EntityRecord,
  type StudyDetail
} from "./shared";

function ethicsLine(study: StudyDetail, ready: boolean) {
  const latest = study.ethics[0];
  if (!latest) return "Not recorded";
  if (ethicsExpired(latest.validUntil)) return "Expired";
  if (ready) return latest.status === "NOT_REQUIRED" ? "Not required" : "Approved";
  return "Pending";
}

/** Study setup: Details, Ethics and documents, Questions. The checklist and the Start button are on Summary. */
export function StudySetupSection({
  study,
  studyId,
  initialTab,
  onChanged,
  onRecordEthics,
  onOpenDetail
}: {
  study: StudyDetail;
  studyId: string;
  /** The tab a link asked for; null opens the first one that is not finished. */
  initialTab: StudySetupTab | null;
  onChanged: () => void | Promise<void>;
  onRecordEthics: (record?: EntityRecord) => void;
  onOpenDetail: (kind: "ethics" | "document", id: string) => void;
}) {
  const { detailsReady, ethicsReady, requirementsAnswered, requirementsReady } = protocolStatus(study);
  const [tab, setTab] = useState<string>(initialTab ?? firstIncompleteSetupTab({ details: detailsReady, ethics: ethicsReady, questions: requirementsReady }));
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [documentOpen, setDocumentOpen] = useState(false);

  const modalities = splitMultiSelectValue(plainText(study.dataModalities)).map((value) => governanceOptionLabel(DATA_MODALITY_OPTIONS, value) ?? value);
  const earlierNotes = EARLIER_DESIGN_NOTES.map((note) => ({ label: note.label, value: plainText(study[note.field]) })).filter((note) => note.value);

  const extra =
    tab === "details" ? (
      <Button icon={<EditOutlined />} onClick={() => setDetailsOpen(true)}>
        Edit
      </Button>
    ) : tab === "ethics" ? (
      <Space>
        <Button icon={<PlusOutlined />} onClick={() => onRecordEthics()}>
          Record ethics decision
        </Button>
        <Button icon={<UploadOutlined />} onClick={() => setDocumentOpen(true)}>
          Upload document
        </Button>
      </Space>
    ) : null;

  return (
    <div className="fedlify-section-stack">
      <Tabs
        className="fedlify-card-tabs fedlify-protocol-tabs"
        activeKey={tab}
        onChange={setTab}
        tabBarExtraContent={extra}
        items={[
          {
            key: "details",
            label: "Details",
            children: (
              <section className="fedlify-protocol-module is-wide">
                <div className="fl-card" style={{ padding: 20 }}>
                  <FieldGrid>
                    <FieldRow label="Study title" value={study.title} full />
                    <FieldRow label="Summary" value={text(plainText(study.description))} full />
                    <FieldRow label="Objective" value={text(plainText(study.goal))} full />
                    <FieldRow label="Research question" value={text(plainText(study.researchQuestion))} full />
                    <FieldRow label="Intended use" value={text(intendedUseText(study))} full />
                    <FieldRow label="Population" value={text(plainText(study.population))} />
                    <FieldRow label="Data types" value={modalities.length > 0 ? modalities.join(", ") : "Not set"} />
                    <FieldRow label="Main outcome" value={text(plainText(study.primaryOutcome))} full />
                  </FieldGrid>
                </div>
                {earlierNotes.length > 0 ? <Details title="Earlier design notes" modalTitle="Earlier design notes" items={earlierNotes} /> : null}
              </section>
            )
          },
          {
            key: "ethics",
            label: "Ethics and documents",
            children: (
              <section className="fedlify-protocol-module is-wide">
                <Typography.Text className="fedlify-muted">
                  Needed before the pipeline can be published. Status: {ethicsLine(study, ethicsReady)}
                </Typography.Text>
                {study.ethics.length === 0 ? (
                  <Typography.Text>No ethics decision yet. Record an approval, an exemption, or a review that is still pending.</Typography.Text>
                ) : (
                  <WorkspaceCardGrid>
                    {study.ethics.map((record) => (
                      <WorkspaceRecordCard
                        key={text(record.id, `${record.status}-${record.createdAt}`)}
                        icon={<SafetyCertificateOutlined />}
                        title={text(record.approvalNumber, record.status === "PENDING" ? "Pending ethics review" : "Ethics decision")}
                        description={`${text(record.approvingBody, "Review body not recorded")} · ${formatDate(record.createdAt)}`}
                        status={<StatusTag value={status(record.status)} />}
                        onClick={() => onOpenDetail("ethics", String(record.id))}
                      />
                    ))}
                  </WorkspaceCardGrid>
                )}
                <Alert type="warning" showIcon className="fedlify-protocol-note" message="Do not upload patient-level data." />
                {study.documents.length === 0 ? (
                  <Typography.Text>No documents yet. Add a study protocol, ethics approval, policy, or agreement.</Typography.Text>
                ) : (
                  <WorkspaceCardGrid>
                    {study.documents.map((document) => (
                      <WorkspaceRecordCard
                        key={text(document.id, document.filename)}
                        icon={<FileTextOutlined />}
                        title={text(document.filename, "Study document")}
                        description={`${documentKindLabel(document.kind)} · Version ${text(document.version, "1")}`}
                        status={<StatusTag value={status(document.scanStatus, "PENDING")} />}
                        onClick={() => onOpenDetail("document", String(document.id))}
                      />
                    ))}
                  </WorkspaceCardGrid>
                )}
              </section>
            )
          },
          {
            key: "requirements",
            label: `Questions (${requirementsAnswered}/${REQUIREMENTS_TOTAL})`,
            children: (
              <section className="fedlify-protocol-module is-wide">
                <StudyQuestionsSection studyId={studyId} onChange={() => void onChanged()} />
              </section>
            )
          }
        ]}
      />
      <StudyDetailsModal open={detailsOpen} study={study} studyId={studyId} onClose={() => setDetailsOpen(false)} onSaved={onChanged} />
      <DocumentModal open={documentOpen} studyId={studyId} onClose={() => setDocumentOpen(false)} onSaved={onChanged} />
    </div>
  );
}
