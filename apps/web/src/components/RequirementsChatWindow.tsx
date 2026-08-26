"use client";

import { CheckCircleOutlined, QuestionCircleOutlined, SendOutlined } from "@ant-design/icons";
import { Button, Input, Progress, Tag, Typography, message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RequirementId } from "@/lib/requirements-catalog";

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

/**
 * Guided question-and-answer window for the 29 operational requirements
 * (requirements-catalog.ts). This is the context-gathering half of the study's governance
 * gate: the static protocol form covers structured fields, this window covers a
 * requirement-by-requirement narrative answer, and requirementsGate() (governance.ts) is
 * what turns the combination into a stop/proceed decision for pipeline code generation.
 */
export function RequirementsChatWindow({ studyId }: { studyId: string }) {
  const [state, setState] = useState<RequirementsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [activeId, setActiveId] = useState<RequirementId | null>(null);

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

  useEffect(() => { void load(); }, [load]);

  const current = useMemo(() => {
    if (!state) return null;
    if (activeId) return state.requirements.find((requirement) => requirement.id === activeId) ?? null;
    return state.requirements.find((requirement) => !requirement.response) ?? null;
  }, [state, activeId]);

  useEffect(() => {
    setDraft(current?.response?.answer ?? "");
  }, [current?.id]);

  async function submitAnswer() {
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
      await load();
      setActiveId(null);
      message.success(`${current.id} recorded.`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Could not save answer.");
    } finally {
      setSaving(false);
    }
  }

  if (loading || !state) {
    return <div className="fedlify-requirements-window is-loading"><Typography.Text type="secondary">Loading requirements…</Typography.Text></div>;
  }

  const percent = Math.round((state.answeredCount / state.totalCount) * 100);

  return (
    <div className="fedlify-requirements-window">
      <div className="fedlify-requirements-header">
        <div>
          <Typography.Title level={5} style={{ margin: 0 }}>Requirements checklist (R01–R29)</Typography.Title>
          <Typography.Text type="secondary">
            {state.answeredCount} of {state.totalCount} answered. Every requirement needs a recorded answer before pipeline code generation is allowed.
          </Typography.Text>
        </div>
        <Progress type="circle" percent={percent} size={48} />
      </div>

      {current ? (
        <div className="fedlify-requirements-active">
          <div className="fedlify-requirements-active-head">
            <QuestionCircleOutlined />
            <Tag color="purple">{current.id}</Tag>
            <Typography.Text strong>{current.title}</Typography.Text>
          </div>
          <Typography.Paragraph type="secondary">{current.definition}</Typography.Paragraph>
          <Input.TextArea
            rows={3}
            value={draft}
            placeholder="Describe how this study satisfies this requirement…"
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="fedlify-requirements-active-actions">
            {current.response ? <Button onClick={() => setActiveId(null)}>Cancel</Button> : <span />}
            <Button type="primary" className="fedlify-dark-action" icon={<SendOutlined />} loading={saving} disabled={!draft.trim()} onClick={() => void submitAnswer()}>
              {current.response ? "Update answer" : "Confirm answer"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="fedlify-requirements-complete">
          <CheckCircleOutlined style={{ fontSize: 20 }} />
          <Typography.Text strong>All 29 requirements answered.</Typography.Text>
        </div>
      )}

      <div className="fedlify-requirements-list">
        {state.requirements.map((requirement) => (
          <button
            type="button"
            key={requirement.id}
            className={["fedlify-requirements-row", requirement.response ? "is-answered" : "is-open", current?.id === requirement.id ? "is-active" : ""].filter(Boolean).join(" ")}
            onClick={() => setActiveId(requirement.id)}
          >
            <span className="fedlify-requirements-row-id">{requirement.id}</span>
            <span className="fedlify-requirements-row-title">{requirement.title}</span>
            {requirement.response ? <CheckCircleOutlined className="fedlify-requirements-row-check" /> : <Tag bordered={false}>Open</Tag>}
          </button>
        ))}
      </div>
    </div>
  );
}
