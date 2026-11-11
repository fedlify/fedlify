"use client";

import { documentKindLabel } from "@/lib/terms";
import {
  CheckCircleOutlined,
  ClusterOutlined,
  EditOutlined,
  FileTextOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  SafetyCertificateOutlined,
  UploadOutlined
} from "@ant-design/icons";
import { Alert, Tabs } from "antd";
import { useState, type ReactNode } from "react";
import { WorkspaceActionCard, WorkspaceCardGrid, WorkspaceRecordCard, WorkspaceReviewCard } from "@/components/DataCards";
import { RichTextContent } from "@/components/RichTextEditor";
import { StatusTag } from "@/components/StatusTag";
import {
  CLINICAL_USE_CASE_OPTIONS,
  DATA_MODALITY_OPTIONS,
  INTENDED_USE_OPTIONS,
  governanceOptionLabel,
  splitMultiSelectValue
} from "@/lib/governance-options";
import { DocumentModal, StudyDesignModal } from "./StudyFormModals";
import { StudyQuestionsSection } from "./StudyQuestionsSection";
import {
  displayEnum,
  formatDate,
  GovernanceSection,
  latestEthicsStatus,
  protocolStatus,
  REQUIREMENTS_TOTAL,
  status,
  summarizeMissingLabels,
  text,
  useStudyRequest,
  type EntityRecord,
  type StudyDetail
} from "./shared";

function renderGovernanceField(label: string, value: unknown, className?: string, rich = false) {
  return (
    <div className={["fedlify-governance-field", className].filter(Boolean).join(" ")}>
      <span className="fedlify-governance-label">{label}</span>
      {rich ? <RichTextContent value={typeof value === "string" ? value : null} /> : <span className="fedlify-governance-value">{text(value)}</span>}
    </div>
  );
}

function renderGovernanceTags(label: string, values: string[]) {
  return (
    <div className="fedlify-governance-field">
      <span className="fedlify-governance-label">{label}</span>
      {values.length > 0 ? (
        <span className="fedlify-governance-tags">
          {values.map((value) => (
            <span key={value} className="fedlify-governance-tag">
              {value}
            </span>
          ))}
        </span>
      ) : (
        <span className="fedlify-governance-value">Not set</span>
      )}
    </div>
  );
}

export type ProtocolTab = "review" | "metadata" | "ethics" | "documents" | "requirements";

/** The Protocol page: a checklist tab (with the Activate button), the study design, ethics decisions, documents and study questions. */
export function ProtocolSection({
  study,
  studyId,
  initialTab,
  onChanged,
  onRecordEthics,
  onOpenDetail,
  onOpenSites
}: {
  study: StudyDetail;
  studyId: string;
  initialTab: ProtocolTab;
  onChanged: () => void | Promise<void>;
  onRecordEthics: (record?: EntityRecord) => void;
  onOpenDetail: (kind: "ethics" | "document", id: string) => void;
  onOpenSites: () => void;
}) {
  const [tab, setTab] = useState<string>(initialTab);
  const [designOpen, setDesignOpen] = useState(false);
  const [documentOpen, setDocumentOpen] = useState(false);
  const { patch, contextHolder } = useStudyRequest(onChanged);

  const dataModalityLabels = splitMultiSelectValue(study.dataModalities).map((value) => governanceOptionLabel(DATA_MODALITY_OPTIONS, value) ?? value);
  const {
    missingProtocolFieldLabels,
    missingActivationItems,
    protocolMetadataReady,
    ethicsReady,
    siteCount,
    hasSite,
    requirementsAnswered,
    requirementsReady,
    activationReady
  } = protocolStatus(study);

  const checklist = [
    {
      key: "metadata",
      title: "Study details",
      detail: protocolMetadataReady ? "The core study details are filled in." : `Still to fill in: ${summarizeMissingLabels(missingProtocolFieldLabels)}.`,
      status: protocolMetadataReady ? "READY" : "NEEDS_ATTENTION",
      icon: <FileTextOutlined />,
      action: "Open study details",
      onClick: () => setTab("metadata")
    },
    {
      key: "ethics",
      title: "Ethics decision",
      detail: ethicsReady ? displayEnum(latestEthicsStatus(study), "Approved") : "Record that ethics review is approved or not required.",
      status: ethicsReady ? "READY" : "NEEDS_ATTENTION",
      icon: <SafetyCertificateOutlined />,
      action: "Open ethics",
      onClick: () => setTab("ethics")
    },
    {
      key: "documents",
      title: "Documents",
      detail: study.documents.length > 0 ? `${study.documents.length} document(s) uploaded.` : "Upload the protocol, ethics approval, or agreements if you have them.",
      status: study.documents.length > 0 ? "READY" : "OPTIONAL",
      icon: <UploadOutlined />,
      action: "Open documents",
      onClick: () => setTab("documents")
    },
    {
      key: "sites",
      title: "Sites",
      detail: hasSite ? `${siteCount} site(s) added.` : "Add at least one site.",
      status: hasSite ? "READY" : "NEEDS_ATTENTION",
      icon: <ClusterOutlined />,
      action: hasSite ? "Review sites" : "Add sites",
      onClick: onOpenSites
    },
    {
      key: "requirements",
      title: "Study questions",
      detail: requirementsReady
        ? `All ${REQUIREMENTS_TOTAL} study questions are answered.`
        : `${requirementsAnswered} of ${REQUIREMENTS_TOTAL} answered. All ${REQUIREMENTS_TOTAL} are needed before the study can be activated.`,
      status: requirementsReady ? "READY" : "NEEDS_ATTENTION",
      icon: <QuestionCircleOutlined />,
      action: requirementsReady ? "Review the study questions" : "Answer the study questions",
      onClick: () => setTab("requirements")
    }
  ];

  const active = study.status === "ACTIVE";
  const activateCard = (
    <WorkspaceActionCard
      icon={<CheckCircleOutlined />}
      title={active ? "Study active" : "Activate study"}
      description={
        active
          ? "The study is active. The team can publish code and start runs."
          : activationReady
            ? "Activating lets the team publish code and start runs."
            : `Finish first: ${summarizeMissingLabels(missingActivationItems)}.`
      }
      status={active ? <StatusTag value="ACTIVE" /> : !activationReady ? <StatusTag value="BLOCKED" /> : undefined}
      disabled={active || !activationReady}
      tone={active ? "active" : !activationReady ? "blocked" : "default"}
      onClick={() => void patch(`/api/v1/studies/${studyId}`, { action: "activate" }, "Study activated.")}
    />
  );

  return (
    <div className="fedlify-section-stack">
      {contextHolder}
      <Tabs
        className="fedlify-card-tabs fedlify-protocol-tabs"
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "review",
            label: "Progress",
            children: (
              <section className="fedlify-protocol-module is-wide">
                {active ? null : (
                  <Alert
                    type={activationReady ? "success" : "warning"}
                    showIcon
                    className="fedlify-protocol-note"
                    message={
                      activationReady
                        ? `Everything needed is in place: the study design, an ethics decision, a site, and all ${REQUIREMENTS_TOTAL} study questions.`
                        : `Not ready to activate yet. Still needed: ${summarizeMissingLabels(missingActivationItems)}.`
                    }
                  />
                )}
                <WorkspaceCardGrid>{activateCard}</WorkspaceCardGrid>
                <WorkspaceCardGrid className="fedlify-workspace-review-grid">
                  {checklist.map((item) => (
                    <WorkspaceReviewCard
                      key={item.key}
                      icon={item.icon}
                      title={item.title}
                      description={item.detail}
                      status={<StatusTag value={item.status} />}
                      tone={item.status.toLowerCase() as "ready" | "needs_attention" | "optional"}
                      onClick={item.onClick}
                      aria-label={`${item.action}: ${item.title}`}
                    />
                  ))}
                </WorkspaceCardGrid>
              </section>
            )
          },
          {
            key: "metadata",
            label: "Study details",
            children: (
              <section className="fedlify-protocol-module is-wide">
                <WorkspaceCardGrid>
                  <WorkspaceActionCard
                    icon={<EditOutlined />}
                    title="Edit study design"
                    description="Update the study question, population, outcomes, analysis and data handling plans."
                    onClick={() => setDesignOpen(true)}
                  />
                </WorkspaceCardGrid>
                <GovernanceSection title="Overview">
                  <div className="fedlify-governance-grid">
                    {renderGovernanceField("Study title", study.title)}
                    {renderGovernanceField("Risk level", displayEnum(study.riskLevel))}
                    {renderGovernanceField("Study summary", study.description, "fedlify-governance-full", true)}
                    {renderGovernanceField(
                      "Clinical use case",
                      governanceOptionLabel(CLINICAL_USE_CASE_OPTIONS, study.clinicalUseCase)
                    )}
                    {renderGovernanceField("Intended use", governanceOptionLabel(INTENDED_USE_OPTIONS, study.intendedUse))}
                  </div>
                </GovernanceSection>
                <GovernanceSection title="Scientific question">
                  <div className="fedlify-governance-grid">
                    {renderGovernanceField("Primary objective", study.goal, "fedlify-governance-full", true)}
                    {renderGovernanceField("Research question", study.researchQuestion, "fedlify-governance-full", true)}
                    {renderGovernanceField("Hypothesis", study.hypothesis, "fedlify-governance-full", true)}
                    {renderGovernanceField("Secondary objectives", study.secondaryObjectives, "fedlify-governance-full", true)}
                  </div>
                </GovernanceSection>
                <GovernanceSection title="Design and population">
                  <div className="fedlify-governance-grid">
                    {renderGovernanceField("Type of study", study.studyDesign, "fedlify-governance-full", true)}
                    {renderGovernanceField("Population", study.population)}
                    {renderGovernanceTags("Data modalities", dataModalityLabels)}
                    {renderGovernanceField("Eligibility criteria", study.eligibilityCriteria, "fedlify-governance-full", true)}
                  </div>
                </GovernanceSection>
                <GovernanceSection title="Outcomes and analysis">
                  <div className="fedlify-governance-grid">
                    {renderGovernanceField("Primary endpoint / outcome", study.primaryOutcome)}
                    {renderGovernanceField("Endpoint details", study.primaryEndpointDetails, "fedlify-governance-full", true)}
                    {renderGovernanceField("Secondary outcomes", study.secondaryOutcomes, "fedlify-governance-full", true)}
                    {renderGovernanceField("Sample size / rationale", study.sampleSizeRationale, "fedlify-governance-full", true)}
                    {renderGovernanceField("Analysis plan", study.analysisPlan, "fedlify-governance-full", true)}
                  </div>
                </GovernanceSection>
                <GovernanceSection title="AI and data sharing">
                  <div className="fedlify-governance-grid">
                    {renderGovernanceField("Data handling plan", study.dataHandlingPlan, "fedlify-governance-full", true)}
                    {renderGovernanceField("How people and the AI work together", study.humanAiWorkflow, "fedlify-governance-full", true)}
                    {renderGovernanceField("Fairness / subgroup plan", study.fairnessPlan, "fedlify-governance-full", true)}
                    {renderGovernanceField("Dissemination plan", study.disseminationPlan, "fedlify-governance-full", true)}
                  </div>
                </GovernanceSection>
              </section>
            )
          },
          {
            key: "ethics",
            label: "Ethics",
            children: (
              <section className="fedlify-protocol-module is-wide">
                <WorkspaceCardGrid>
                  <WorkspaceActionCard
                    icon={<PlusOutlined />}
                    title={study.ethics.length === 0 ? "Record first ethics decision" : "Record ethics decision"}
                    description={
                      study.ethics.length === 0
                        ? "No ethics decision yet. Record an approval, an exemption, or a review that is still pending."
                        : "Record an approval, an exemption, an expiry, or a review that is still pending."
                    }
                    onClick={() => onRecordEthics()}
                  />
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
              </section>
            )
          },
          {
            key: "documents",
            label: "Documents",
            children: (
              <section className="fedlify-protocol-module is-wide">
                <Alert type="warning" showIcon className="fedlify-protocol-note" message="Do not upload patient-level data." />
                <WorkspaceCardGrid>
                  <WorkspaceActionCard
                    icon={<UploadOutlined />}
                    title={study.documents.length === 0 ? "Upload first document" : "Upload document"}
                    description={
                      study.documents.length === 0
                        ? "No documents yet. Add a study protocol, ethics approval, policy, or agreement."
                        : "Add a study protocol, ethics approval, policy, or agreement."
                    }
                    onClick={() => setDocumentOpen(true)}
                  />
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
              </section>
            )
          },
          {
            key: "requirements",
            label: `Study questions (${requirementsAnswered} of ${REQUIREMENTS_TOTAL} answered)`,
            children: (
              <section className="fedlify-protocol-module is-wide">
                <StudyQuestionsSection studyId={studyId} onChange={() => void onChanged()} />
              </section>
            )
          }
        ]}
      />
      <StudyDesignModal open={designOpen} study={study} studyId={studyId} onClose={() => setDesignOpen(false)} onSaved={onChanged} />
      <DocumentModal open={documentOpen} studyId={studyId} onClose={() => setDocumentOpen(false)} onSaved={onChanged} />
    </div>
  );
}
