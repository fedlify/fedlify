"use client";

import { CheckCircleFilled, LeftOutlined, RightOutlined, SaveOutlined } from "@ant-design/icons";
import { Button, Input, Progress, Space, Tag, Typography, message } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { REQUIREMENT_ORDER, type RequirementId } from "@/lib/requirements-catalog";

type RequirementRow = {
  id: RequirementId;
  title: string;
  definition: string;
  response: { answer: string; updatedAt: string } | null;
};

type RequirementsState = {
  requirements: RequirementRow[];
  answeredCount: number;
  totalCount: number;
  allowed: boolean;
};

// The 29 requirements in eight groups (same grouping as the method paper's C1–C8), so the navigator
// reads as a short outline instead of a 29-row list.
const GROUPS: Array<{ label: string; ids: RequirementId[] }> = [
  { label: "Purpose and consortium", ids: ["R01", "R02", "R03"] },
  { label: "Governance and accountability", ids: ["R04", "R05", "R06", "R07"] },
  { label: "Data specification and quality", ids: ["R08", "R09", "R10", "R11"] },
  { label: "Infrastructure and site readiness", ids: ["R12", "R13", "R14", "R15"] },
  { label: "Privacy and security", ids: ["R16", "R17", "R18", "R19"] },
  { label: "Federated protocol and execution", ids: ["R20", "R21", "R22", "R23"] },
  { label: "Evaluation and release", ids: ["R24", "R25", "R26"] },
  { label: "Operation and sustainability", ids: ["R27", "R28", "R29"] }
];

function groupOf(id: RequirementId) {
  return GROUPS.find((group) => group.ids.includes(id))?.label ?? "";
}

/**
 * Two-pane wizard for the 29 operational requirements (requirements-catalog.ts): a grouped navigator
 * on the left and a fixed editor on the right, so answering all 29 is a "Save and next" walk rather
 * than scrolling a long list. requirementsGate() (governance.ts) turns the answers into the
 * stop/proceed decision for activation and pipeline code generation.
 */
export function RequirementsChatWindow({ studyId, onChange }: { studyId: string; onChange?: () => void }) {
  const [state, setState] = useState<RequirementsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [activeId, setActiveId] = useState<RequirementId | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/v1/studies/${studyId}/requirements`, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (response.ok && data) setState(data);
    } finally {
      setLoading(false);
    }
  }, [studyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const byId = useMemo(() => new Map((state?.requirements ?? []).map((requirement) => [requirement.id, requirement])), [state]);

  // Start on the first unanswered requirement; afterwards follow the user's selection.
  const current = useMemo(() => {
    if (!state) return null;
    if (activeId) return byId.get(activeId) ?? null;
    return state.requirements.find((requirement) => !requirement.response) ?? state.requirements[0] ?? null;
  }, [state, byId, activeId]);

  useEffect(() => {
    setDraft(current?.response?.answer ?? "");
    textareaRef.current?.focus();
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const position = current ? REQUIREMENT_ORDER.indexOf(current.id) : -1;
  const previousId = position > 0 ? REQUIREMENT_ORDER[position - 1] : null;
  const nextId = position >= 0 && position < REQUIREMENT_ORDER.length - 1 ? REQUIREMENT_ORDER[position + 1] : null;
  const nextUnansweredAfter = (id: RequirementId | null) => {
    if (!state) return null;
    const start = id ? REQUIREMENT_ORDER.indexOf(id) + 1 : 0;
    const ordered = [...REQUIREMENT_ORDER.slice(start), ...REQUIREMENT_ORDER.slice(0, start)];
    return ordered.find((candidate) => !byId.get(candidate)?.response) ?? null;
  };
  const dirty = Boolean(current) && draft.trim() !== (current?.response?.answer ?? "").trim();

  async function save(advance: boolean) {
    if (!current || !draft.trim() || saving) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/v1/studies/${studyId}/requirements`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requirementId: current.id, answer: draft.trim() })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error?.message ?? "Could not save answer.");
      // Update in place so the navigator and progress move without a reload or scroll jump.
      setState((previous) =>
        previous
          ? {
              ...previous,
              requirements: previous.requirements.map((requirement) =>
                requirement.id === current.id ? { ...requirement, response: data?.response ?? { answer: draft.trim(), updatedAt: new Date().toISOString() } } : requirement
              ),
              answeredCount: data?.answeredCount ?? previous.answeredCount,
              totalCount: data?.totalCount ?? previous.totalCount,
              allowed: data?.allowed ?? previous.allowed
            }
          : previous
      );
      message.success(`${current.id} saved.`);
      onChange?.(); // let the study page refresh its activation readiness
      if (advance) {
        const target = nextUnansweredAfter(current.id) ?? nextId;
        if (target) setActiveId(target);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Could not save answer.");
    } finally {
      setSaving(false);
    }
  }

  if (loading || !state) {
    return (
      <div className="fedlify-requirements-window is-loading">
        <Typography.Text type="secondary">Loading requirements…</Typography.Text>
      </div>
    );
  }

  const percent = Math.round((state.answeredCount / state.totalCount) * 100);
  const remaining = state.totalCount - state.answeredCount;

  return (
    <div className="fedlify-requirements-window">
      <div className="fedlify-requirements-header">
        <div>
          <Typography.Title level={5} style={{ margin: 0 }}>
            Requirements checklist
          </Typography.Title>
          <Typography.Text type="secondary">
            {remaining === 0
              ? "All 29 answered. You can still revise any answer; changes are recorded in the audit trail."
              : `${state.answeredCount} of ${state.totalCount} answered. Answer each one and press "Save and next"; ${remaining} to go.`}
          </Typography.Text>
        </div>
        <Progress percent={percent} size="small" style={{ maxWidth: 220, margin: 0 }} status={remaining === 0 ? "success" : "active"} />
      </div>

      <div className="fedlify-requirements-layout">
        <nav className="fedlify-requirements-nav" aria-label="Requirements">
          {GROUPS.map((group) => {
            const done = group.ids.filter((id) => byId.get(id)?.response).length;
            return (
              <div key={group.label} className="fedlify-requirements-group">
                <div className="fedlify-requirements-group-head">
                  <span>{group.label}</span>
                  <span className="fedlify-requirements-group-count">
                    {done}/{group.ids.length}
                  </span>
                </div>
                {group.ids.map((id) => {
                  const requirement = byId.get(id);
                  if (!requirement) return null;
                  const isActive = current?.id === id;
                  return (
                    <button
                      type="button"
                      key={id}
                      className={["fedlify-requirements-row", requirement.response ? "is-answered" : "is-open", isActive ? "is-active" : ""].filter(Boolean).join(" ")}
                      onClick={() => setActiveId(id)}
                      aria-current={isActive ? "step" : undefined}
                    >
                      <span className="fedlify-requirements-row-id">{id}</span>
                      <span className="fedlify-requirements-row-title">{requirement.title}</span>
                      {requirement.response ? <CheckCircleFilled className="fedlify-requirements-row-check" /> : <span className="fedlify-requirements-row-dot" />}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>

        {current ? (
          <div className="fedlify-requirements-editor">
            <div className="fedlify-requirements-editor-crumb">
              <Typography.Text type="secondary">{groupOf(current.id)}</Typography.Text>
              <Typography.Text type="secondary">
                {position + 1} of {REQUIREMENT_ORDER.length}
              </Typography.Text>
            </div>
            <div className="fedlify-requirements-active-head">
              <Tag color="purple">{current.id}</Tag>
              <Typography.Title level={5} style={{ margin: 0 }}>
                {current.title}
              </Typography.Title>
              {current.response ? <Tag color="green">Answered</Tag> : <Tag>Open</Tag>}
            </div>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
              {current.definition}
            </Typography.Paragraph>
            <Input.TextArea
              ref={textareaRef}
              autoSize={{ minRows: 7, maxRows: 16 }}
              value={draft}
              placeholder="Describe how this study satisfies this requirement. Plain language is fine; this is what reviewers and the agent will read."
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void save(true);
                }
              }}
            />
            <div className="fedlify-requirements-active-actions">
              <Space>
                <Button icon={<LeftOutlined />} disabled={!previousId} onClick={() => previousId && setActiveId(previousId)}>
                  Previous
                </Button>
                <Button disabled={!nextId} onClick={() => nextId && setActiveId(nextId)}>
                  Next <RightOutlined />
                </Button>
              </Space>
              <Space>
                <Typography.Text type="secondary" className="fedlify-requirements-hint">
                  {dirty ? "Unsaved changes" : current.response ? `Saved ${new Date(current.response.updatedAt).toLocaleString()}` : ""} · ⌘/Ctrl+Enter saves
                </Typography.Text>
                {current.response ? (
                  <Button icon={<SaveOutlined />} loading={saving} disabled={!dirty || !draft.trim()} onClick={() => void save(false)}>
                    Update
                  </Button>
                ) : null}
                <Button type="primary" className="fedlify-dark-action" icon={<SaveOutlined />} loading={saving} disabled={!draft.trim() || (!dirty && remaining === 0)} onClick={() => void save(true)}>
                  {remaining === 0 || (remaining === 1 && !current.response) ? "Save" : "Save and next"}
                </Button>
              </Space>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
