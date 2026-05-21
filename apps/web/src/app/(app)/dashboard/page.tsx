"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppPage, AppPageHeader } from "@/components/AppPage";
import { CardGridSkeleton, InlineLoadError } from "@/components/LoadStates";
import { chooseSelectedStudy, SELECTED_STUDY_EVENT, SELECTED_STUDY_STORAGE_KEY, type StudySummary } from "@/lib/studies";

export default function DashboardPage() {
  const router = useRouter();
  const [loadError, setLoadError] = useState<string | null>(null);

  const routeToOverview = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetch("/api/v1/studies?status=active", { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "Study workspaces could not be loaded.");

      const selected = chooseSelectedStudy((body?.studies ?? []) as StudySummary[], window.localStorage.getItem(SELECTED_STUDY_STORAGE_KEY));
      if (!selected) {
        router.replace("/studies/manage");
        return;
      }

      window.localStorage.setItem(SELECTED_STUDY_STORAGE_KEY, selected.id);
      window.dispatchEvent(new CustomEvent(SELECTED_STUDY_EVENT, { detail: { studyId: selected.id } }));
      router.replace(`/studies/${selected.id}`);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Study workspaces could not be loaded.");
    }
  }, [router]);

  useEffect(() => {
    void routeToOverview();
  }, [routeToOverview]);

  return (
    <AppPage>
      <AppPageHeader title="Study summary" subtitle="Opening the selected study workspace." />
      {loadError ? <InlineLoadError message={loadError} onRetry={() => void routeToOverview()} /> : <CardGridSkeleton count={4} />}
    </AppPage>
  );
}
