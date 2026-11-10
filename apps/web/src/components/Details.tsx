"use client";

import { useId, useState, type ReactNode } from "react";

export type DetailsItem = {
  label: string;
  value: ReactNode;
  /** When set, a "Copy" button copies this text. */
  copyText?: string;
};

/**
 * Collapsed-by-default disclosure for technical values (ids, hashes, raw names).
 * Keep the main label of a screen in plain words and put the technical text here.
 */
export function Details({ items, title = "Details", defaultOpen = false }: { items: DetailsItem[]; title?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState<string | null>(null);
  const panelId = useId();

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1500);
    } catch {
      setCopied(null);
    }
  }

  if (items.length === 0) return null;
  return (
    <div className="fedlify-details" data-open={open ? "true" : "false"}>
      <button type="button" className="fedlify-details-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
        {title}
      </button>
      {open ? (
        <dl id={panelId} className="fedlify-details-list">
          {items.map((item) => (
            <div key={item.label} className="fedlify-details-row">
              <dt>{item.label}</dt>
              <dd>
                <span className="fedlify-details-value">{item.value}</span>
                {item.copyText ? (
                  <button type="button" className="fedlify-details-copy" onClick={() => void copy(item.label, item.copyText as string)} aria-label={`Copy ${item.label}`}>
                    {copied === item.label ? "Copied" : "Copy"}
                  </button>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
