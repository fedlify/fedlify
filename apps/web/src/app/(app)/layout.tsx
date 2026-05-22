"use client";

import {
  AppstoreOutlined,
  AuditOutlined,
  CloudDownloadOutlined,
  ClusterOutlined,
  DashboardOutlined,
  MailOutlined,
  MenuFoldOutlined,
  MonitorOutlined,
  RobotOutlined,
  SafetyCertificateOutlined
} from "@ant-design/icons";
import { Button, Layout, Menu } from "antd";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import type { MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FedlifyLogo } from "@/components/FedlifyLogo";
import { StudyQuickMenu } from "@/components/StudyQuickMenu";
import { UserMenu } from "@/components/UserMenu";
import {
  normalizeStudyWorkspaceSection,
  STUDY_WORKSPACE_SECTIONS,
  type StudyWorkspaceSection,
  studySectionHref
} from "@/lib/study-workspace";
import { chooseSelectedStudy, SELECTED_STUDY_EVENT, SELECTED_STUDY_STORAGE_KEY, type StudySummary } from "@/lib/studies";

const { Header, Sider, Content } = Layout;
const SIDEBAR_STORAGE_KEY = "fedlify:sidebarCollapsed";

export default function AppLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { data: session, status } = useSession();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedStudyId, setSelectedStudyId] = useState<string | null>(null);
  const currentStudySection = normalizeStudyWorkspaceSection(searchParams.get("section"));

  const loadSelectedStudy = useCallback(async () => {
    const pathMatch = /^\/studies\/([^/]+)$/.exec(pathname);
    if (pathMatch && pathMatch[1] !== "manage") {
      setSelectedStudyId(pathMatch[1]);
      window.localStorage.setItem(SELECTED_STUDY_STORAGE_KEY, pathMatch[1]);
      return;
    }

    const stored = window.localStorage.getItem(SELECTED_STUDY_STORAGE_KEY);
    if (stored) setSelectedStudyId(stored);

    try {
      const response = await fetch("/api/v1/studies?status=active", { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json();
      const selected = chooseSelectedStudy((body.studies ?? []) as StudySummary[], stored);
      if (selected) {
        setSelectedStudyId(selected.id);
        window.localStorage.setItem(SELECTED_STUDY_STORAGE_KEY, selected.id);
      }
    } catch {
      // Keep the locally selected study if the menu preload fails.
    }
  }, [pathname]);

  useEffect(() => {
    setSidebarCollapsed(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true");
  }, []);

  useEffect(() => {
    if (!session) return;
    void loadSelectedStudy();

    function onSelectedStudyChanged(event: Event) {
      const detail = (event as CustomEvent<{ studyId?: string }>).detail;
      setSelectedStudyId(detail?.studyId ?? window.localStorage.getItem(SELECTED_STUDY_STORAGE_KEY));
    }

    function onStudiesUpdated() {
      void loadSelectedStudy();
    }

    window.addEventListener(SELECTED_STUDY_EVENT, onSelectedStudyChanged);
    window.addEventListener("fedlify:studiesUpdated", onStudiesUpdated);
    return () => {
      window.removeEventListener(SELECTED_STUDY_EVENT, onSelectedStudyChanged);
      window.removeEventListener("fedlify:studiesUpdated", onStudiesUpdated);
    };
  }, [loadSelectedStudy, session]);

  useEffect(() => {
    if (status !== "loading" && !session) {
      router.replace(`/signin?callbackUrl=${encodeURIComponent(pathname)}`);
    }
  }, [pathname, router, session, status]);

  const studySectionIcons: Record<StudyWorkspaceSection, ReactNode> = useMemo(
    () => ({
      overview: <DashboardOutlined />,
      protocol: <SafetyCertificateOutlined />,
      sites: <ClusterOutlined />,
      team: <MailOutlined />,
      pipeline: <RobotOutlined />,
      run: <MonitorOutlined />,
      results: <CloudDownloadOutlined />,
      audit: <AuditOutlined />
    }),
    []
  );

  const menuItems = useMemo(
    () => [
      ...STUDY_WORKSPACE_SECTIONS.map((section) => ({
        key: `study:${section.key}`,
        icon: studySectionIcons[section.key],
        label: section.label,
        disabled: !selectedStudyId,
        onClick: () => {
          if (selectedStudyId) router.push(studySectionHref(selectedStudyId, section.key));
        }
      }))
    ],
    [router, selectedStudyId, studySectionIcons]
  );

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      return next;
    });
  }

  function openCollapsedSidebar(event: MouseEvent<HTMLElement>) {
    if (!sidebarCollapsed) return;
    const target = event.target as HTMLElement;
    if (target.closest(".ant-menu-item")) return;
    setSidebarCollapsed(false);
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, "false");
  }

  if (status === "loading") {
    return <div className="fedlify-content">Loading...</div>;
  }

  if (!session) {
    return null;
  }

  return (
    <Layout className="fedlify-app-shell">
      <Sider
        width={208}
        collapsedWidth={72}
        collapsed={sidebarCollapsed}
        collapsible
        trigger={null}
        theme="light"
        className={`fedlify-sidebar${sidebarCollapsed ? " is-collapsed" : ""}`}
        onClick={openCollapsedSidebar}
      >
        <div className="fedlify-brand">
          <div className="fedlify-brand-row">
            <div className="fedlify-brand-identity">
              <FedlifyLogo variant={sidebarCollapsed ? "mark" : "lockup"} />
            </div>
            {!sidebarCollapsed ? (
              <Button
                type="text"
                className="fedlify-sidebar-toggle"
                icon={<MenuFoldOutlined />}
                aria-label="Close app menu"
                title="Close app menu"
                onClick={toggleSidebar}
              />
            ) : null}
          </div>
        </div>
        <Menu
          className="fedlify-app-menu"
          mode="inline"
          inlineCollapsed={sidebarCollapsed}
          selectedKeys={
            pathname.startsWith("/studies/") && pathname !== "/studies/manage"
              ? [`study:${currentStudySection}`]
              : []
          }
          items={menuItems}
        />
      </Sider>
      <Layout className="fedlify-main-shell">
        <Header className="fedlify-app-header">
          <StudyQuickMenu />
          <div className="fedlify-header-actions">
            <Button
              className="fedlify-header-tool-button"
              icon={<AppstoreOutlined />}
              onClick={() => router.push("/templates")}
            >
              Template Catalog
            </Button>
            <UserMenu />
          </div>
        </Header>
        <Content className="fedlify-content">{children}</Content>
      </Layout>
    </Layout>
  );
}
