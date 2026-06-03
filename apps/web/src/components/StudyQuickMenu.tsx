"use client";

import {
  CheckOutlined,
  DownOutlined,
  ExperimentOutlined,
  SettingOutlined
} from "@ant-design/icons";
import { Button, Dropdown, Space, Typography } from "antd";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/LoadStates";
import { normalizeStudyWorkspaceSection, studySectionHref } from "@/lib/study-workspace";
import { chooseSelectedStudy, SELECTED_STUDY_EVENT, SELECTED_STUDY_STORAGE_KEY, type StudySummary } from "@/lib/studies";

type StudyQuickMenuProps = {
  disabled?: boolean;
};

export function StudyQuickMenu({ disabled }: StudyQuickMenuProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [studies, setStudies] = useState<StudySummary[]>([]);
  const [selectedStudyId, setSelectedStudyId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const loadStudies = useCallback(async () => {
    const response = await fetch("/api/v1/studies?status=active", { cache: "no-store" });
    if (!response.ok) {
      setStudies([]);
      return;
    }

    const body = await response.json();
    const nextStudies = (body.studies ?? []) as StudySummary[];
    setStudies(nextStudies);

    const stored = window.localStorage.getItem(SELECTED_STUDY_STORAGE_KEY);
    const selected = chooseSelectedStudy(nextStudies, stored);
    if (selected) {
      setSelectedStudyId(selected.id);
      window.localStorage.setItem(SELECTED_STUDY_STORAGE_KEY, selected.id);
    }
  }, []);

  useEffect(() => {
    void loadStudies();

    function onStudiesUpdated() {
      void loadStudies();
    }

    window.addEventListener("fedlify:studiesUpdated", onStudiesUpdated);
    return () => window.removeEventListener("fedlify:studiesUpdated", onStudiesUpdated);
  }, [loadStudies]);

  useEffect(() => {
    const match = /^\/studies\/([^/]+)$/.exec(pathname);
    if (!match || match[1] === "manage") return;
    setSelectedStudyId(match[1]);
    window.localStorage.setItem(SELECTED_STUDY_STORAGE_KEY, match[1]);
  }, [pathname]);

  const selectedStudy = useMemo(() => chooseSelectedStudy(studies, selectedStudyId), [selectedStudyId, studies]);

  function selectStudy(study: StudySummary) {
    setSelectedStudyId(study.id);
    window.localStorage.setItem(SELECTED_STUDY_STORAGE_KEY, study.id);
    window.dispatchEvent(new CustomEvent(SELECTED_STUDY_EVENT, { detail: { studyId: study.id } }));
    setOpen(false);
    const currentSection = normalizeStudyWorkspaceSection(searchParams.get("section"));
    router.push(studySectionHref(study.id, pathname.startsWith("/studies/") ? currentSection : "overview"));
  }

  const dropdown = (
    <div className="fedlify-study-menu">
      <Typography.Text className="fedlify-study-menu-label">Study workspace</Typography.Text>
      <div className="fedlify-study-menu-list">
        {studies.length === 0 ? (
          <EmptyState
            compact
            icon={<ExperimentOutlined />}
            title="No active studies"
            description="Create or restore a study before selecting a workspace."
          />
        ) : (
          studies.map((study) => (
            <button
              key={study.id}
              type="button"
              className={`fedlify-study-menu-item${study.id === selectedStudy?.id ? " is-selected" : ""}`}
              onClick={() => selectStudy(study)}
            >
              <Space>
                <ExperimentOutlined />
                <span>{study.title}</span>
              </Space>
              {study.id === selectedStudy?.id ? <CheckOutlined /> : null}
            </button>
          ))
        )}
      </div>
      <div className="fedlify-study-menu-divider" />
      <button
        type="button"
        className="fedlify-study-menu-manage"
        onClick={() => {
          setOpen(false);
          router.push("/studies/manage");
        }}
      >
        <Space>
          <SettingOutlined />
          <span>Study management</span>
        </Space>
      </button>
    </div>
  );

  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      popupRender={() => dropdown}
      trigger={["click"]}
      placement="bottomLeft"
      disabled={disabled}
    >
      <Button className="fedlify-study-switcher" icon={<ExperimentOutlined />}>
        <span className="fedlify-study-switcher-title">{selectedStudy?.title ?? "Select study"}</span>
        <DownOutlined />
      </Button>
    </Dropdown>
  );
}
