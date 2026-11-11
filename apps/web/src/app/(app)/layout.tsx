"use client";

import {
  AuditOutlined,
  CloudDownloadOutlined,
  ClusterOutlined,
  DashboardOutlined,
  HomeOutlined,
  MailOutlined,
  MenuFoldOutlined,
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
  activeStudyNavKey,
  isMySitePath,
  normalizeStudyWorkspaceSection,
  sidebarMode,
  type SidebarMode,
  STUDY_NAV_ITEMS,
  type StudyNavKey,
  studyNavHref
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
  const [mode, setMode] = useState<SidebarMode | null>(null);
  const currentStudySection = normalizeStudyWorkspaceSection(searchParams.get("section"));

  const loadSelectedStudy = useCallback(async () => {
    const pathMatch = /^\/studies\/([^/]+)(?:\/|$)/.exec(pathname);
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

  // Who is this person here for? Site contacts get a minimal sidebar; everyone else keeps the study sidebar.
  const loadMode = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/me", { cache: "no-store" });
      if (!response.ok) {
        setMode("study");
        return;
      }
      const body = await response.json().catch(() => null);
      setMode(sidebarMode(body));
    } catch {
      setMode("study");
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    void loadMode();
    const refresh = () => void loadMode();
    window.addEventListener("fedlify:studiesUpdated", refresh);
    return () => window.removeEventListener("fedlify:studiesUpdated", refresh);
  }, [loadMode, session]);

  // A site-only person has no study to open: send study pages (and the empty
  // default study) back to My site instead of showing an access error.
  useEffect(() => {
    // Creating a study of their own (/studies/manage) stays open to them.
    const startingOwnStudy = pathname.startsWith("/studies/manage");
    if (mode === "site-only" && !startingOwnStudy && pathname.startsWith("/studies")) {
      router.replace("/my-site");
    }
  }, [mode, pathname, router]);

  useEffect(() => {
    if (status !== "loading" && !session) {
      router.replace(`/signin?callbackUrl=${encodeURIComponent(pathname)}`);
    }
  }, [pathname, router, session, status]);

  const studyNavIcons: Record<StudyNavKey, ReactNode> = useMemo(
    () => ({
      overview: <DashboardOutlined />,
      protocol: <SafetyCertificateOutlined />,
      sites: <ClusterOutlined />,
      team: <MailOutlined />,
      code: <RobotOutlined />,
      results: <CloudDownloadOutlined />,
      audit: <AuditOutlined />
    }),
    []
  );

  const menuItems = useMemo(() => {
    const mySite = {
      key: "site:mine",
      icon: <HomeOutlined />,
      label: "My site",
      onClick: () => router.push("/my-site")
    };
    if (mode === null) return [];
    if (mode === "site-only") return [mySite];
    const studyItems = STUDY_NAV_ITEMS.map((item) => ({
        key: `study:${item.key}`,
        icon: studyNavIcons[item.key],
        label: item.key === "code" ? <span title="Code, publish and run the study pipeline">{item.label}</span> : item.label,
        disabled: !selectedStudyId,
        onClick: () => {
          if (selectedStudyId) router.push(studyNavHref(selectedStudyId, item.key));
        }
      }));
    return mode === "both" ? [...studyItems, mySite] : studyItems;
  }, [mode, router, selectedStudyId, studyNavIcons]);

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
        breakpoint="md"
        // On a phone the menu starts closed so it does not take half the screen; this choice is not remembered.
        onBreakpoint={(broken) => {
          if (broken) setSidebarCollapsed(true);
        }}
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
          selectedKeys={(() => {
            if (pathname.startsWith("/my-site") || (mode === "site-only" && isMySitePath(pathname))) return ["site:mine"];
            const key = activeStudyNavKey(pathname, currentStudySection);
            return key ? [`study:${key}`] : [];
          })()}
          items={menuItems}
        />
      </Sider>
      <Layout className="fedlify-main-shell">
        <Header className="fedlify-app-header">
          {mode === "site-only" ? <span /> : <StudyQuickMenu />}
          <div className="fedlify-header-actions">
            <UserMenu />
          </div>
        </Header>
        <Content className="fedlify-content">{children}</Content>
      </Layout>
    </Layout>
  );
}
