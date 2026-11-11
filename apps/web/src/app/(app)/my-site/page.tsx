"use client";

import { HomeOutlined } from "@ant-design/icons";
import type { SiteRole } from "@prisma/client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppPage, AppPageHeader } from "@/components/AppPage";
import { CardGrid, EntityCard } from "@/components/DataCards";
import { StatusTag, type StatusTone } from "@/components/StatusTag";
import { EmptyState, InlineLoadError, CardGridSkeleton } from "@/components/LoadStates";
import { PendingInvitationsCard } from "@/components/PendingInvitationsCard";
import { isSiteContact } from "@/lib/plain-roles";
import { roleLabel } from "@/lib/terms";

type MySite = { studySiteId: string; name: string; studyTitle: string; roles: string[] };
type RunnerLine = { text: string; tone: "ok" | "warn" | "error" | "idle"; next: string | null };

const RUNNER_TONE: Record<RunnerLine["tone"], StatusTone> = { ok: "success", warn: "warning", error: "danger", idle: "neutral" };

function roleText(roles: string[]) {
  return isSiteContact(roles as SiteRole[]) ? "Site contact" : roles.map((role) => roleLabel(role)).join(", ");
}

/** "My site": a person invited to a site sees only their site(s). One site opens straight away. */
export default function MySitePage() {
  const router = useRouter();
  const [sites, setSites] = useState<MySite[] | null>(null);
  const [runner, setRunner] = useState<Record<string, RunnerLine>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [invitationWaiting, setInvitationWaiting] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetch("/api/v1/me", { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "Your site could not be loaded.");
      const list = (body?.sites ?? []) as MySite[];
      const waiting = Boolean(body?.pendingSiteInvite);
      setInvitationWaiting(waiting);
      // With an invitation still waiting, stay here so it can be seen and accepted.
      if (list.length === 1 && !waiting) {
        router.replace(`/sites/${list[0].studySiteId}`);
        return;
      }
      setSites(list);
      // A short status line per site, from the same report the site page uses. A failure just leaves the line out.
      const lines = await Promise.all(
        list.map(async (site) => {
          try {
            const res = await fetch(`/api/v1/sites/${site.studySiteId}`, { cache: "no-store" });
            if (!res.ok) return [site.studySiteId, { text: "Runner: status unavailable", tone: "idle", next: null }] as const;
            const detail = await res.json();
            const stage = (detail?.runtime?.stages ?? []).find((item: { key: string }) => item.key === "runner");
            return stage
              ? ([site.studySiteId, { text: `Runner: ${stage.status}`, tone: stage.tone, next: detail?.runtime?.nextStep ?? null }] as const)
              : null;
          } catch {
            return [site.studySiteId, { text: "Runner: status unavailable", tone: "idle", next: null }] as const;
          }
        })
      );
      setRunner(Object.fromEntries(lines.filter((line): line is NonNullable<typeof line> => line !== null)));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Your site could not be loaded.");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AppPage>
      <AppPageHeader title="My site" subtitle="The sites you have been asked to set up and look after." />
      <PendingInvitationsCard />
      {loadError ? (
        <InlineLoadError message={loadError} onRetry={() => void load()} />
      ) : sites === null ? (
        <CardGridSkeleton count={2} />
      ) : sites.length === 0 && invitationWaiting ? null : sites.length === 0 ? (
        <EmptyState
          icon={<HomeOutlined />}
          title="You have not been added to a site yet"
          description="Ask the study lead to send you a site invitation. When you accept it, your site appears here."
        />
      ) : (
        <CardGrid>
          {sites.map((site) => {
            const line = runner[site.studySiteId];
            return (
              <EntityCard
                key={site.studySiteId}
                title={site.name}
                subtitle={site.studyTitle}
                status={line ? <StatusTag tone={RUNNER_TONE[line.tone]} label={line.text} /> : undefined}
                meta={[`Your role: ${roleText(site.roles)}`, ...(line?.next ? [`Next step: ${line.next}`] : [])]}
                actions={<Link href={`/sites/${site.studySiteId}`}>Open site</Link>}
              />
            );
          })}
        </CardGrid>
      )}
    </AppPage>
  );
}
