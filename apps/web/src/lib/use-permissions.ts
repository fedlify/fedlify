"use client";

import { useEffect, useState } from "react";
import type { SiteAction, StudyAction } from "@/lib/rbac";

type Result<A extends string> = { can: Record<A, boolean>; loading: boolean; error: boolean; backHref?: string | null };

/**
 * When the permissions request fails, buttons stay available and the server still decides on every action (it did
 * before these hooks existed). Locking people out on a network blip is worse than a clear "not allowed" reply.
 */
function permissive<A extends string>(): Record<A, boolean> {
  return new Proxy({} as Record<A, boolean>, { get: () => true });
}

// Cached per id for the session (the page lifetime). Until the answer arrives every `can` entry is false.
const studyCache = new Map<string, Promise<unknown>>();
const siteCache = new Map<string, Promise<unknown>>();

async function load<T>(url: string, cache: Map<string, Promise<unknown>>, key: string): Promise<T> {
  let pending = cache.get(key) as Promise<T> | undefined;
  if (!pending) {
    const attempt = async (): Promise<T> => {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error("permissions");
      return (await response.json()) as T;
    };
    // One retry covers a transient network or server error.
    pending = attempt().catch(() => attempt());
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
  }
  return pending;
}

export function useStudyPermissions(studyId: string | null | undefined): Result<StudyAction> {
  const [state, setState] = useState<{ id: string | null; can: Record<StudyAction, boolean>; error: boolean }>({ id: null, can: {} as Record<StudyAction, boolean>, error: false });
  useEffect(() => {
    if (!studyId) return;
    let active = true;
    load<{ can: Record<StudyAction, boolean> }>(`/api/v1/studies/${studyId}/permissions`, studyCache, studyId)
      .then((body) => active && setState({ id: studyId, can: body.can, error: false }))
      .catch(() => active && setState({ id: studyId, can: permissive<StudyAction>(), error: true }));
    return () => {
      active = false;
    };
  }, [studyId]);
  return {
    can: state.id === studyId ? state.can : ({} as Record<StudyAction, boolean>),
    loading: Boolean(studyId) && state.id !== studyId,
    error: state.id === studyId && state.error
  };
}

export function useSitePermissions(siteId: string | null | undefined): Result<SiteAction> {
  const [state, setState] = useState<{ id: string | null; can: Record<SiteAction, boolean>; backHref: string | null; error: boolean }>({
    id: null,
    can: {} as Record<SiteAction, boolean>,
    backHref: null,
    error: false
  });
  useEffect(() => {
    if (!siteId) return;
    let active = true;
    load<{ can: Record<SiteAction, boolean>; backHref: string | null }>(`/api/v1/sites/${siteId}/permissions`, siteCache, siteId)
      .then((body) => active && setState({ id: siteId, can: body.can, backHref: body.backHref ?? null, error: false }))
      .catch(() => active && setState({ id: siteId, can: permissive<SiteAction>(), backHref: null, error: true }));
    return () => {
      active = false;
    };
  }, [siteId]);
  const ready = state.id === siteId;
  return { can: ready ? state.can : ({} as Record<SiteAction, boolean>), loading: Boolean(siteId) && !ready, backHref: ready ? state.backHref : null, error: ready && state.error };
}

/** Test/helper: forget cached answers (e.g. after a role change). */
export function clearPermissionsCache(): void {
  studyCache.clear();
  siteCache.clear();
}
