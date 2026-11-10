"use client";

import { CheckCircleFilled, ExclamationCircleFilled } from "@ant-design/icons";
import { Button, Skeleton, Typography } from "antd";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PreflightItem, PreflightKind, PreflightOwner, PreflightResult } from "@/lib/preflight";
import { ApiError, apiCall } from "@/lib/web-api";

const OWNER_LABEL: Record<PreflightOwner, string> = { study: "Study team", site: "The site", system: "Automatic" };

export function failingCount(result: PreflightResult | null | undefined): number {
  return result ? result.items.filter((item) => !item.ok).length : 0;
}

/** "2 things to fix" for the stage card. */
export function thingsToFix(count: number): string {
  return `${count} ${count === 1 ? "thing" : "things"} to fix`;
}

/** An API error that also carries the checklist items the server returned with a 409. */
export class PreflightApiError extends ApiError {
  constructor(
    message: string,
    status: number,
    code: string | undefined,
    readonly items: PreflightItem[]
  ) {
    super(message, status, code);
  }
}

function readItems(value: unknown): PreflightItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is PreflightItem => Boolean(item) && typeof item === "object" && typeof (item as PreflightItem).text === "string" && typeof (item as PreflightItem).ok === "boolean"
  );
}

/** POST JSON; on failure throws a PreflightApiError with the checklist items the server sent along, if any. */
export async function postWithChecklist<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new PreflightApiError(payload?.error?.message ?? `Request failed (${response.status}).`, response.status, payload?.error?.code, readItems(payload?.error?.details?.items));
  }
  return payload as T;
}

/**
 * Loads the checklist for Publish or Start run. Reloads when the query changes, when `refreshToken` changes
 * (the page passes its overview, which is reloaded after a save, a publish, a run and on polling) or on `refresh()`.
 */
export function usePreflight(studyId: string, kind: PreflightKind, params: Record<string, string | undefined>, enabled: boolean, refreshToken: unknown) {
  const [result, setResult] = useState<PreflightResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);
  const search = new URLSearchParams({ kind });
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const url = `/api/v1/studies/${studyId}/preflight?${search.toString()}`;

  useEffect(() => {
    if (!enabled) return;
    const mine = ++seq.current;
    apiCall<PreflightResult>(url)
      .then((body) => {
        if (mine !== seq.current) return;
        setResult({ ok: body.ok, items: readItems(body.items) });
        setError(null);
      })
      .catch((cause) => {
        if (mine !== seq.current) return;
        setError(cause instanceof Error ? cause.message : "Could not check what is needed.");
      });
    return () => {
      seq.current += 1;
    };
  }, [url, enabled, refreshToken, nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  /** Show the items a 409 returned in the same checklist. */
  const showItems = useCallback((items: PreflightItem[]) => {
    if (items.length) setResult({ ok: items.every((item) => item.ok), items });
  }, []);
  return { result, error, refresh, showItems, loading: enabled && result === null && error === null };
}

type PreflightChecklistProps = {
  title: string;
  result: PreflightResult | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Leave out the "Fix the item above first" footer (a page that has its own main button). */
  compact?: boolean;
};

export function PreflightChecklist({ title, result, loading, error, onRetry, compact }: PreflightChecklistProps) {
  const failing = failingCount(result);
  return (
    <section className="fedlify-preflight" aria-label={title}>
      <Typography.Text strong className="fedlify-preflight-title">
        {title}
      </Typography.Text>
      {loading ? <Skeleton active paragraph={{ rows: 2 }} title={false} /> : null}
      {error && !result ? (
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          We could not check what is needed. {onRetry ? <Button type="link" size="small" onClick={onRetry}>Try again</Button> : null}
        </Typography.Paragraph>
      ) : null}
      {result ? (
        <ul className="fedlify-preflight-list">
          {result.items.map((item) => (
            <li key={item.code} className={item.ok ? "is-ok" : "is-fail"}>
              <span className="fedlify-preflight-icon" aria-label={item.ok ? "Done" : "Needs attention"}>
                {item.ok ? <CheckCircleFilled /> : <ExclamationCircleFilled />}
              </span>
              <span className="fedlify-preflight-copy">
                <span className="fedlify-preflight-text">{item.text}</span>
                {!item.ok && item.detail ? <span className="fedlify-preflight-detail">{item.detail}</span> : null}
              </span>
              {!item.ok ? (
                <span className="fedlify-preflight-side">
                  <span className="fedlify-preflight-owner">{OWNER_LABEL[item.owner]}</span>
                  {item.fixHref ? <Link href={item.fixHref}>Fix</Link> : item.owner === "study" ? <span className="fedlify-preflight-owner">Ask a study lead</span> : null}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {failing > 0 && !compact ? (
        <Typography.Text type="secondary" className="fedlify-preflight-reason">
          {failing === 1 ? "Fix the item above first." : `Fix the ${failing} items above first.`}
        </Typography.Text>
      ) : null}
    </section>
  );
}
