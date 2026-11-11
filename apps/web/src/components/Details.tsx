"use client";

import { InfoCircleOutlined } from "@ant-design/icons";
import { Button, Modal } from "antd";
import { useId, useState, type ReactNode } from "react";

export type DetailsItem = {
  label: string;
  value: ReactNode;
  /** When set, a "Copy" button copies this text. */
  copyText?: string;
};

type DetailsProps = {
  items: DetailsItem[];
  /** The link text, for example "Details" or "Why the assistant said this". */
  title?: string;
  /** Title of the window; defaults to the link text. */
  modalTitle?: string;
  /**
   * Show the values in place under the link instead of in a window. Use it only where the link already sits inside a
   * window (a window on top of a window is hard to follow).
   */
  inline?: boolean;
  /** Inline only: start open. */
  defaultOpen?: boolean;
};

function DetailsList({ items, id }: { items: DetailsItem[]; id?: string }) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1500);
    } catch {
      setCopied(null);
    }
  }

  return (
    <dl id={id} className="fedlify-details-list">
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
  );
}

/**
 * Technical values (ids, hashes, raw names) and other secondary facts, kept out of the way: a small link that opens
 * them in a window, so the table or card around it never changes size. Keep the main label of a screen in plain words
 * and put the technical text here.
 */
export function Details({ items, title = "Details", modalTitle, inline = false, defaultOpen = false }: DetailsProps) {
  const [open, setOpen] = useState(inline ? defaultOpen : false);
  const panelId = useId();

  if (items.length === 0) return null;

  if (inline) {
    return (
      <div className="fedlify-details" data-open={open ? "true" : "false"}>
        <button type="button" className="fedlify-details-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
          {title}
        </button>
        {open ? <DetailsList items={items} id={panelId} /> : null}
      </div>
    );
  }

  return (
    <>
      <button type="button" className="fedlify-details-open" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <InfoCircleOutlined aria-hidden /> {title}
      </button>
      <Modal
        open={open}
        title={modalTitle ?? title}
        onCancel={() => setOpen(false)}
        footer={<Button onClick={() => setOpen(false)}>Close</Button>}
        width={640}
        destroyOnHidden
      >
        <DetailsList items={items} />
      </Modal>
    </>
  );
}
