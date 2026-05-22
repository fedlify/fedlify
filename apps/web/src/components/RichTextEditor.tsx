"use client";

import {
  BoldOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  ItalicOutlined,
  OrderedListOutlined,
  UnderlineOutlined,
  UnorderedListOutlined
} from "@ant-design/icons";
import { Button, Tooltip } from "antd";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FocusEvent } from "react";

type RichTextEditorProps = {
  id?: string;
  value?: string | null;
  onChange?: (value: string) => void;
  onBlur?: (event: FocusEvent<HTMLDivElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  minRows?: number;
};

const FORMAT_ACTIONS = [
  { command: "bold", label: "Bold", icon: <BoldOutlined /> },
  { command: "italic", label: "Italic", icon: <ItalicOutlined /> },
  { command: "underline", label: "Underline", icon: <UnderlineOutlined /> },
  { command: "insertUnorderedList", label: "Bullet list", icon: <UnorderedListOutlined /> },
  { command: "insertOrderedList", label: "Numbered list", icon: <OrderedListOutlined /> }
];

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function richTextPlainText(value: unknown) {
  return String(value ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function richTextHasText(value: unknown) {
  return richTextPlainText(value).length > 0;
}

function plainTextToHtml(value: string) {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function richTextDisplayHtml(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/<\/?[a-z][\s\S]*>/i.test(text)) return sanitizeRichTextHtml(text);
  return plainTextToHtml(text);
}

export function sanitizeRichTextHtml(html: string) {
  if (typeof document === "undefined") return escapeHtml(richTextPlainText(html));

  const allowedTags = new Set(["B", "BR", "DIV", "EM", "I", "LI", "OL", "P", "STRONG", "U", "UL"]);
  const tagMap: Record<string, string> = {
    B: "strong",
    DIV: "p",
    I: "em"
  };
  const template = document.createElement("template");
  template.innerHTML = html;

  function cleanNode(node: Node): Node {
    if (node.nodeType === Node.TEXT_NODE) {
      return document.createTextNode(node.textContent ?? "");
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return document.createDocumentFragment();
    }

    const sourceElement = node as HTMLElement;
    const tagName = sourceElement.tagName.toUpperCase();
    const children = Array.from(sourceElement.childNodes).map(cleanNode);

    if (!allowedTags.has(tagName)) {
      const fragment = document.createDocumentFragment();
      children.forEach((child) => fragment.appendChild(child));
      return fragment;
    }

    const element = document.createElement(tagMap[tagName] ?? tagName.toLowerCase());
    children.forEach((child) => element.appendChild(child));
    return element;
  }

  const wrapper = document.createElement("div");
  Array.from(template.content.childNodes)
    .map(cleanNode)
    .forEach((node) => wrapper.appendChild(node));

  if (!richTextPlainText(wrapper.innerHTML)) return "";
  return wrapper.innerHTML;
}

export function normalizeRichTextValue(value: unknown) {
  const text = String(value ?? "");
  if (!text.trim()) return "";
  return richTextDisplayHtml(text);
}

export function RichTextContent({ value }: { value?: string | null }) {
  const fallback = useMemo(() => richTextPlainText(value), [value]);
  const [html, setHtml] = useState("");

  useEffect(() => {
    setHtml(richTextDisplayHtml(value));
  }, [value]);

  if (!fallback) return <div className="fedlify-governance-value">Not set</div>;
  if (!html) return <div className="fedlify-governance-value">{fallback}</div>;

  return <div className="fedlify-rich-text-content" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function RichTextEditor({
  id,
  value,
  onChange,
  onBlur,
  placeholder,
  disabled = false,
  minRows = 4
}: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const lastHtmlRef = useRef("");
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const nextHtml = normalizeRichTextValue(value);
    if (!editorRef.current || document.activeElement === editorRef.current || nextHtml === lastHtmlRef.current) return;
    editorRef.current.innerHTML = nextHtml;
    lastHtmlRef.current = nextHtml;
  }, [value]);

  useEffect(() => {
    if (!fullscreen) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setFullscreen(false);
    }

    window.addEventListener("keydown", closeOnEscape);
    window.setTimeout(() => editorRef.current?.focus(), 0);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [fullscreen]);

  function emitChange() {
    if (!editorRef.current) return;
    const html = sanitizeRichTextHtml(editorRef.current.innerHTML);
    lastHtmlRef.current = html;
    if (editorRef.current.innerHTML !== html) editorRef.current.innerHTML = html;
    onChange?.(html);
  }

  function applyCommand(command: string) {
    if (disabled) return;
    editorRef.current?.focus();
    document.execCommand(command, false);
    emitChange();
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const pastedText = event.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, pastedText);
    emitChange();
  }

  return (
    <div className={["fedlify-rich-text-editor", fullscreen ? "is-fullscreen" : "", disabled ? "is-disabled" : ""].filter(Boolean).join(" ")}>
      <div className="fedlify-rich-text-toolbar" aria-label="Rich text formatting toolbar">
        <span className="fedlify-rich-text-toolbar-group">
          {FORMAT_ACTIONS.map((action) => (
            <Tooltip title={action.label} key={action.command}>
              <Button
                type="text"
                size="small"
                icon={action.icon}
                aria-label={action.label}
                disabled={disabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyCommand(action.command)}
              />
            </Tooltip>
          ))}
        </span>
        <span className="fedlify-rich-text-toolbar-spacer" />
        <Tooltip title={fullscreen ? "Exit full screen" : "Full screen"}>
          <Button
            type="text"
            size="small"
            icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
            aria-label={fullscreen ? "Exit full screen editor" : "Open full screen editor"}
            aria-pressed={fullscreen}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setFullscreen((current) => !current)}
          />
        </Tooltip>
      </div>
      <div
        id={id}
        ref={editorRef}
        className="fedlify-rich-text-surface"
        contentEditable={!disabled}
        role="textbox"
        aria-multiline="true"
        aria-disabled={disabled}
        data-placeholder={placeholder}
        style={{ minHeight: `${Math.max(minRows, 3) * 1.6 + 1.8}rem` }}
        suppressContentEditableWarning
        onInput={emitChange}
        onBlur={onBlur}
        onPaste={handlePaste}
      />
    </div>
  );
}
