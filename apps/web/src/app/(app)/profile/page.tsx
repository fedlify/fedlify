"use client";

import { ExperimentOutlined, FolderOpenOutlined, TeamOutlined, UserOutlined } from "@ant-design/icons";
import type { SiteRole, StudyRole } from "@prisma/client";
import { Button, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppPage, AppPageHeader, SectionHeader } from "@/components/AppPage";
import { CardGrid, EntityCard, StatCard } from "@/components/DataCards";
import { CardGridSkeleton, InlineLoadError } from "@/components/LoadStates";
import { StatusTag } from "@/components/StatusTag";
import { describeStudyRoles } from "@/lib/plain-roles";
import { groupStudyRoles, siteRolesLabel } from "@/lib/team-roles";

type MeResponse = {
  user?: {
    id: string;
    name?: string | null;
    email?: string | null;
    profile?: {
      displayName?: string | null;
      title?: string | null;
      institution?: string | null;
    } | null;
    orgMemberships?: Array<{
      id: string;
      role: string;
      organization: { id: string; name: string; domain?: string | null };
    }>;
    studyMembers?: Array<{
      id: string;
      role: StudyRole;
      study: { id: string; title: string; organization: { name: string } };
    }>;
  };
  sites?: Array<{ studySiteId: string; name: string; studyTitle: string; roles: SiteRole[] }>;
};

export default function ProfilePage() {
  const router = useRouter();
  const { data: session } = useSession();
  const [profile, setProfile] = useState<MeResponse["user"] | null>(null);
  const [siteAccess, setSiteAccess] = useState<NonNullable<MeResponse["sites"]>>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadProfile = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/v1/me", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as MeResponse | null;
      if (!response.ok) throw new Error("Profile information could not be loaded.");
      setProfile(body?.user ?? null);
      setSiteAccess(body?.sites ?? []);
    } catch (error) {
      setProfile(null);
      setLoadError(error instanceof Error ? error.message : "Profile information could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const userName = profile?.profile?.displayName || profile?.name || session?.user?.name || "Fedlify user";
  const userEmail = profile?.email || session?.user?.email || "Signed in";
  const organizations = profile?.orgMemberships ?? [];
  const studies = useMemo(() => groupStudyRoles(profile?.studyMembers ?? []), [profile?.studyMembers]);

  const stats = useMemo(
    () => [
      { label: "Organizations", value: organizations.length, icon: <TeamOutlined /> },
      { label: "Studies", value: studies.length, icon: <ExperimentOutlined /> },
      { label: "Sites", value: siteAccess.length, icon: <TeamOutlined /> }
    ],
    [organizations.length, studies.length, siteAccess.length]
  );

  return (
    <AppPage>
      <AppPageHeader
        title="Profile"
        subtitle="Review account identity, institution memberships, and study-scoped roles."
        actions={
          <Button icon={<FolderOpenOutlined />} onClick={() => router.push("/studies/manage")}>
            Study management
          </Button>
        }
      />

      {loading ? (
        <CardGridSkeleton count={3} />
      ) : loadError ? (
        <InlineLoadError message={loadError} onRetry={() => void loadProfile()} />
      ) : (
        <>
          <CardGrid className="fedlify-stat-grid">
            <StatCard label="Account" value={userName} icon={<UserOutlined />} />
            {stats.map((stat) => (
              <StatCard key={stat.label} label={stat.label} value={stat.value} icon={stat.icon} />
            ))}
          </CardGrid>

          <SectionHeader title="Account details" />
          <CardGrid>
            <EntityCard
              title={userName}
              subtitle={userEmail}
              status={<StatusTag value={profile?.profile?.title ?? "ACTIVE"} />}
              meta={[profile?.profile?.institution || "Institution not recorded"]}
            />
          </CardGrid>

          <SectionHeader title="Organizations" />
          {organizations.length === 0 ? (
            <Typography.Text className="fedlify-muted">No institution memberships recorded.</Typography.Text>
          ) : (
            <CardGrid>
              {organizations.map((membership) => (
                <EntityCard
                  key={membership.id}
                  title={membership.organization.name}
                  subtitle={membership.organization.domain || "Institution domain not recorded"}
                  status={<StatusTag value={membership.role} />}
                />
              ))}
            </CardGrid>
          )}

          {siteAccess.length > 0 ? (
            <>
              <SectionHeader title="Your sites" />
              <CardGrid>
                {siteAccess.map((site) => (
                  <EntityCard
                    key={site.studySiteId}
                    title={site.name}
                    subtitle={site.studyTitle}
                    status={<StatusTag value={siteRolesLabel(site.roles)} />}
                    actions={
                      <Button icon={<FolderOpenOutlined />} onClick={() => router.push(`/sites/${site.studySiteId}`)}>
                        Open
                      </Button>
                    }
                  />
                ))}
              </CardGrid>
            </>
          ) : null}

          <SectionHeader title="Study roles" />
          {studies.length === 0 ? (
            <Typography.Text className="fedlify-muted">No study roles recorded.</Typography.Text>
          ) : (
            <CardGrid>
              {studies.map((membership) => (
                <EntityCard
                  key={membership.study.id}
                  title={membership.study.title}
                  subtitle={membership.study.organization.name}
                  status={<StatusTag value={describeStudyRoles(membership.roles).label} />}
                  actions={
                    <Button icon={<FolderOpenOutlined />} onClick={() => router.push(`/studies/${membership.study.id}`)}>
                      Open
                    </Button>
                  }
                />
              ))}
            </CardGrid>
          )}
        </>
      )}
    </AppPage>
  );
}
