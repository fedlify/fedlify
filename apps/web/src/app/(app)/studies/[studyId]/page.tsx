"use client";

import { documentKindLabel } from "@/lib/terms";
import { EditOutlined, FileTextOutlined } from "@ant-design/icons";
import { Alert, Button } from "antd";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppPage, AppPageHeader } from "@/components/AppPage";
import { EntityDetailView, FieldGrid, FieldRow } from "@/components/EntityDetail";
import { EmptyState, CardGridSkeleton, InlineLoadError } from "@/components/LoadStates";
import { StatusTag } from "@/components/StatusTag";
import { getStudyWorkspaceSection, normalizeStudyWorkspaceSection, type StudyWorkspaceSection } from "@/lib/study-workspace";
import { parseStudyDetailParam, serializeStudyDetailParam, type StudyDetailKind, type StudyDetailState } from "@/lib/study-detail";
import {
  resolveUnavailableStudyTarget,
  SELECTED_STUDY_EVENT,
  SELECTED_STUDY_STORAGE_KEY,
  type StudySummary
} from "@/lib/studies";
import { ProtocolSection, type ProtocolTab } from "./sections/ProtocolSection";
import { SitesSection } from "./sections/SitesSection";
import { EthicsModal } from "./sections/StudyFormModals";
import { SummarySection } from "./sections/SummarySection";
import { TeamSection, type TeamStudy } from "./sections/TeamSection";
import { displayEnum, formatDate, status, text, type EntityRecord, type StudyDetail } from "./sections/shared";

type DetailPageMeta = {
  title: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  backLabel?: string;
};

/** The study page shell: loads the study, picks the section from the URL (?section=, &tab=, &detail=) and renders it. */
export default function StudyDetailPage() {
  const params = useParams<{ studyId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const studyId = params.studyId;
  const activeSection = normalizeStudyWorkspaceSection(searchParams.get("section"));
  const activeSectionMeta = getStudyWorkspaceSection(activeSection);
  const linkedTab = searchParams.get("tab");
  const activeDetail = useMemo(() => parseStudyDetailParam(searchParams.get("detail")), [searchParams]);
  const [study, setStudy] = useState<StudyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ethicsForm, setEthicsForm] = useState<{ open: boolean; record: EntityRecord | null }>({ open: false, record: null });

  function sectionUrl(section: StudyWorkspaceSection, detail?: StudyDetailState | null) {
    // Retired sections have no page of their own: go straight to the replacement instead of bouncing through a redirect
    // that would drop the detail anyway.
    if (section === "pipeline" || section === "run") return `/studies/${studyId}/projects`;
    if (section === "audit") return `/studies/${studyId}/audit`;
    const query = new URLSearchParams();
    if (section !== "overview" || detail) query.set("section", section);
    if (detail) query.set("detail", serializeStudyDetailParam(detail));
    const queryText = query.toString();
    return `/studies/${studyId}${queryText ? `?${queryText}` : ""}`;
  }

  function openDetail(kind: StudyDetailKind, id: string, section: StudyWorkspaceSection = activeSection) {
    router.push(sectionUrl(section, { kind, id }));
  }

  function closeDetail() {
    router.push(sectionUrl(activeSection));
  }

  const load = useCallback(async (redirectSection: StudyWorkspaceSection = "overview") => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/v1/studies/${studyId}`, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 403 || response.status === 404) {
          const meResponse = await fetch("/api/v1/me", { cache: "no-store" }).catch(() => null);
          const meBody = meResponse?.ok ? await meResponse.json().catch(() => null) : null;
          if (meBody?.landing === "/my-site") {
            router.replace("/my-site");
            return;
          }
          const studiesResponse = await fetch("/api/v1/studies?status=active", { cache: "no-store" });
          const studiesBody = await studiesResponse.json().catch(() => null);
          const studies = studiesResponse.ok ? ((studiesBody?.studies ?? []) as StudySummary[]) : [];
          const target = resolveUnavailableStudyTarget(studies, studyId, redirectSection);
          if (target.studyId) {
            window.localStorage.setItem(SELECTED_STUDY_STORAGE_KEY, target.studyId);
          } else {
            window.localStorage.removeItem(SELECTED_STUDY_STORAGE_KEY);
          }
          window.dispatchEvent(new CustomEvent(SELECTED_STUDY_EVENT, { detail: { studyId: target.studyId ?? undefined } }));
          router.replace(target.href);
          return;
        }
        throw new Error(body?.error?.message ?? "Study workspace could not be loaded.");
      }
      setStudy(body?.study ?? null);
    } catch (error) {
      setStudy(null);
      setLoadError(error instanceof Error ? error.message : "Study workspace could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [router, studyId]);

  useEffect(() => {
    void load(activeSection);
  }, [activeSection, load]);

  const reload = useCallback(() => load(activeSection), [activeSection, load]);

  if (!study && loading) {
    return (
      <AppPage>
        <CardGridSkeleton count={6} />
      </AppPage>
    );
  }
  if (!study && loadError) {
    return (
      <AppPage>
        <InlineLoadError message={loadError} onRetry={() => void load()} />
      </AppPage>
    );
  }
  if (!study) return <Alert type="error" message="Study not found or access was denied." />;
  const activeDetailMeta = activeDetail ? detailMetaFor(study, activeDetail) : null;

  function detailRecordFor(study: StudyDetail, detail: StudyDetailState): EntityRecord | undefined {
    if (detail.kind === "ethics") return study.ethics.find((record) => record.id === detail.id);
    if (detail.kind === "document") return study.documents.find((document) => document.id === detail.id);
    return undefined;
  }

  function detailMetaFor(study: StudyDetail, detail: StudyDetailState): DetailPageMeta {
    const record = detailRecordFor(study, detail);
    if (!record) {
      return {
        title: "Record not found",
        subtitle: "This item is no longer available in the current study payload.",
        backLabel: activeSectionMeta.title
      };
    }

    if (detail.kind === "ethics") {
      const title = text(record.approvalNumber, record.status === "PENDING" ? "Pending ethics review" : "Ethics decision");
      return {
        title,
        subtitle: text(record.approvingBody, "Review body not recorded"),
        status: <StatusTag value={status(record.status)} />,
        backLabel: "Study protocol"
      };
    }

    if (detail.kind === "document") {
      return {
        title: text(record.filename, "Study document"),
        subtitle: documentKindLabel(record.kind, "Document"),
        status: <StatusTag value={status(record.scanStatus, "PENDING")} />,
        backLabel: "Study protocol"
      };
    }

    return { title: "Record", backLabel: "Study protocol" };
  }

  function renderEntityDetail(study: StudyDetail, detail: StudyDetailState) {
    const record = detailRecordFor(study, detail);
    if (!record) {
      return (
        <EntityDetailView bodyOnly title="Record not found" subtitle="This item is no longer available in the current study payload." onBack={closeDetail}>
          <EmptyState icon={<FileTextOutlined />} title="No matching record" description="Return to the list and refresh the workspace." />
        </EntityDetailView>
      );
    }

    if (detail.kind === "ethics") {
      const title = text(record.approvalNumber, record.status === "PENDING" ? "Pending ethics review" : "Ethics decision");
      return (
        <EntityDetailView
          bodyOnly
          title={title}
          subtitle={text(record.approvingBody, "Review body not recorded")}
          status={<StatusTag value={status(record.status)} />}
          onBack={closeDetail}
          actions={
            <Button icon={<EditOutlined />} onClick={() => setEthicsForm({ open: true, record })}>
              Edit decision
            </Button>
          }
        >
          <FieldGrid>
            <FieldRow label="Review status" value={displayEnum(record.status)} />
            <FieldRow label="Approval identifier" value={text(record.approvalNumber)} />
            <FieldRow label="Review body" value={text(record.approvingBody)} />
            <FieldRow label="Recorded" value={formatDate(record.createdAt)} />
            <FieldRow label="Decision notes" value={text(record.notes)} full />
          </FieldGrid>
        </EntityDetailView>
      );
    }

    if (detail.kind === "document") {
      return (
        <EntityDetailView bodyOnly title={text(record.filename, "Study document")} subtitle={documentKindLabel(record.kind, "Document")} status={<StatusTag value={status(record.scanStatus, "PENDING")} />} onBack={closeDetail}>
          <FieldGrid>
            <FieldRow label="Filename" value={text(record.filename)} full />
            <FieldRow label="Document type" value={documentKindLabel(record.kind, "Not set")} />
            <FieldRow label="Version" value={text(record.version, "1")} />
            <FieldRow label="Content type" value={text(record.contentType)} />
            <FieldRow label="Size" value={record.sizeBytes ? `${record.sizeBytes} bytes` : "Not recorded"} />
            <FieldRow label="Checksum" value={text(record.sha256)} full />
            <FieldRow label="Summary" value={text(record.extractedText)} full />
          </FieldGrid>
        </EntityDetailView>
      );
    }

    return null;
  }

  function renderCurrentSection(section: StudyWorkspaceSection) {
    const currentStudy = study;
    if (!currentStudy) return null;
    if (activeDetail) return renderEntityDetail(currentStudy, activeDetail);

    if (section === "overview") return <SummarySection studyId={studyId} />;

    if (section === "protocol") {
      // A link can open a protocol tab directly (?section=protocol&tab=ethics or tab=requirements).
      const initialTab: ProtocolTab = linkedTab === "ethics" || linkedTab === "requirements" ? linkedTab : "review";
      return (
        <ProtocolSection
          key={`${studyId}:${initialTab}`}
          study={currentStudy}
          studyId={studyId}
          initialTab={initialTab}
          onChanged={reload}
          onRecordEthics={(record) => setEthicsForm({ open: true, record: record ?? null })}
          onOpenDetail={(kind, id) => openDetail(kind, id, "protocol")}
          onOpenSites={() => router.push(sectionUrl("sites"))}
        />
      );
    }

    if (section === "team") {
      return <TeamSection studyId={studyId} study={currentStudy as unknown as TeamStudy} onChanged={reload} />;
    }

    if (section === "sites") return <SitesSection studyId={studyId} onChanged={reload} />;

    return null;
  }

  return (
    <AppPage className={activeDetailMeta ? "is-detail-mode" : undefined}>
      <AppPageHeader
        title={activeDetailMeta?.title ?? activeSectionMeta.title}
        subtitle={activeDetailMeta?.subtitle ?? activeSectionMeta.subtitle}
        backLabel={activeDetailMeta?.backLabel}
        onBack={activeDetailMeta ? closeDetail : undefined}
        badges={activeDetailMeta?.status}
      />

      {renderCurrentSection(activeSection)}

      <EthicsModal
        open={ethicsForm.open}
        record={ethicsForm.record}
        studyId={studyId}
        onClose={() => setEthicsForm((current) => ({ ...current, open: false }))}
        onSaved={reload}
      />
    </AppPage>
  );
}
