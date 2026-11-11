"use client";

import { CheckCircleFilled, ExclamationCircleFilled, LeftOutlined, QuestionCircleOutlined, RightOutlined } from "@ant-design/icons";
import { Alert, Button, Checkbox, Collapse, Input, Modal, Progress, Space, Typography, message } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Details } from "@/components/Details";
import { StopNoticeCard } from "@/components/AssistantControlParts";
import { InlineLoadError } from "@/components/LoadStates";
import { StatusTag } from "@/components/StatusTag";
import type { PlanQuestion } from "@/lib/agent-thread-types";
import type { StopPayload } from "@/lib/terms";
import type { ChecklistItem, ChecklistStatus, ChecklistPayload } from "@/lib/study-questions";
import {
  FILTER_LABELS,
  PUBLISH_NEEDS_LINE,
  QUESTION_STATUS_VIEW,
  acceptAllLine,
  answeredByLine,
  confirmState,
  confirmedLine,
  draftResultLine,
  filterCounts,
  filterItems,
  groupByCategory,
  isDone,
  nextNeedingId,
  openForTeamLine,
  originLabel,
  progressLine,
  questionsStage,
  rowActions,
  truncateAnswer,
  type QuestionFilter,
  type QuestionsStage
} from "@/lib/study-questions-client";
import { useStudyPermissions } from "@/lib/use-permissions";

type DraftSummary = { suggested: number; unknown: number; conflicts: number; unchanged: number; replaced?: number };
type ApiResult = { ok: boolean; status: number; data: Record<string, unknown> & { error?: { code?: string; message?: string } } };

async function call(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<ApiResult> {
  try {
    const response = await fetch(path, {
      method,
      cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = (await response.json().catch(() => ({}))) as ApiResult["data"];
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: { message: "Could not reach the server. Check your connection and try again." } } };
  }
}

const errorText = (result: ApiResult, fallback: string) => result.data?.error?.message ?? fallback;

/** The small mark in front of each question in the list. */
function StatusMark({ status }: { status: ChecklistStatus }) {
  if (status === "ANSWERED") return <CheckCircleFilled className="fedlify-sq-mark is-done" aria-hidden />;
  if (status === "ASSUMED") return <CheckCircleFilled className="fedlify-sq-mark is-assumed" aria-hidden />;
  if (status === "CONFLICT") return <ExclamationCircleFilled className="fedlify-sq-mark is-conflict" aria-hidden />;
  if (status === "SUGGESTED") return <QuestionCircleOutlined className="fedlify-sq-mark is-check" aria-hidden />;
  return <span className="fedlify-sq-mark is-open" aria-hidden />;
}

const STAGES: Array<{ key: Exclude<QuestionsStage, "done">; title: string; text: string }> = [
  { key: "describe", title: "Describe your study", text: "The assistant drafts answers from your description." },
  { key: "check", title: "Check each answer", text: "Accept, change or answer each question." },
  { key: "confirm", title: "Confirm", text: "Say the answers describe the study correctly." }
];

/**
 * Protocol > Study questions. Three parts: describe the study (the assistant drafts answers), check each answer one
 * question at a time, then confirm the study specification. The list on the left shows where every question stands;
 * the right side shows one question with its suggestion, the answer box and the buttons for it.
 */
export function StudyQuestionsSection({ studyId, onChange }: { studyId: string; onChange?: () => void }) {
  const { can } = useStudyPermissions(studyId);
  const canEdit = Boolean(can.manage);
  const [messageApi, contextHolder] = message.useMessage();
  const base = `/api/v1/studies/${studyId}/requirements`;

  const [data, setData] = useState<ChecklistPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<QuestionFilter>("all");

  const [text, setText] = useState("");
  const [describeOpen, setDescribeOpen] = useState<boolean | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftLine, setDraftLine] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [conflictNotes, setConflictNotes] = useState<Array<{ requirementId: string; note: string }>>([]);
  const [stop, setStop] = useState<StopPayload | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [asAssumption, setAsAssumption] = useState(false);
  const [saving, setSaving] = useState(false);
  const [choices, setChoices] = useState<{ id: string; question: PlanQuestion | null; loading: boolean; notice: string | null } | null>(null);
  const questionRef = useRef<HTMLDivElement | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await call("GET", base);
    if (result.ok) {
      setData(result.data as unknown as ChecklistPayload);
      setLoadError(null);
    } else {
      setLoadError(errorText(result, "The study questions could not be loaded."));
    }
    setLoading(false);
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => data?.requirements ?? [], [data]);
  const selected = items.find((item) => item.id === selectedId) ?? null;

  // Open on the first question that needs the person, once the list is known.
  useEffect(() => {
    if (!data || selectedId) return;
    setSelectedId(nextNeedingId(data.requirements) ?? data.requirements[0]?.id ?? null);
  }, [data, selectedId]);

  // The answer box follows the selected question (and its saved answer, after a save from elsewhere).
  useEffect(() => {
    if (!selected) return;
    setEditText(selected.answer);
    setAsAssumption(selected.status === "ASSUMED");
    // Only when the question or its stored answer changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.answer, selected?.status]);

  /** Take a full payload from a write, keep the screen in step and tell the page. */
  function accept(payload: unknown) {
    const next = payload as ChecklistPayload & { confirmationCleared?: boolean };
    if (next && Array.isArray(next.requirements)) setData(next);
    if (next?.confirmationCleared) messageApi.info("Your earlier confirmation of the study questions no longer applies because an answer changed. Please confirm again.");
    onChange?.();
    return next && Array.isArray(next.requirements) ? next.requirements : null;
  }

  function select(id: string | null) {
    setSelectedId(id);
    setChoices(null);
    // On a narrow screen the question sits under the list: bring it into view.
    if (id && typeof window !== "undefined" && window.innerWidth < 980) {
      requestAnimationFrame(() => questionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }

  /** Save one change to the selected question; on success move on to the next question that needs the person. */
  async function save(item: ChecklistItem, body: Record<string, unknown>, done: string, moveOn = true) {
    setSaving(true);
    const result = await call("PATCH", base, { requirementId: item.id, ...body });
    setSaving(false);
    if (!result.ok) {
      messageApi.error(errorText(result, "Could not save. Please try again."));
      if (result.status === 409 && result.data?.error?.code === "suggestion_changed") await load();
      return;
    }
    const next = accept(result.data);
    messageApi.success(done);
    setConflictNotes((notes) => notes.filter((note) => note.requirementId !== item.id));
    setChoices(null);
    if (moveOn && next) {
      const following = nextNeedingId(next, item.id);
      if (following) select(following);
    }
  }

  /** Mark "Not decided yet". An answer that is already there stops counting, so ask first. */
  function markUnknown(item: ChecklistItem) {
    if (!item.answer.trim()) {
      void save(item, { action: "unknown" }, "Marked as not decided yet.");
      return;
    }
    Modal.confirm({
      title: "Mark as not decided yet?",
      content: "The answer stays in the box but will not count as an answer until you decide again.",
      okText: "Mark as not decided",
      cancelText: "Cancel",
      onOk: () => save(item, { action: "unknown" }, "Marked as not decided yet.")
    });
  }

  async function draftAnswers() {
    if (!text.trim() || drafting) return;
    setDrafting(true);
    setDraftError(null);
    setStop(null);
    setDraftLine(null);
    const result = await call("POST", `${base}/draft`, { text });
    setDrafting(false);
    if (!result.ok) {
      setDraftError(errorText(result, "The assistant could not draft answers. Nothing was changed."));
      return;
    }
    if (result.data.stopped) {
      setStop(result.data.stop as StopPayload);
      return;
    }
    const next = accept(result.data);
    setDraftLine(draftResultLine(result.data.summary as DraftSummary));
    setConflictNotes((result.data.conflictNotes as Array<{ requirementId: string; note: string }>) ?? []);
    if (next) {
      setFilter("all");
      select(nextNeedingId(next));
    }
  }

  async function acceptAll() {
    if (!data) return;
    const shown = data.requirements.filter((item) => item.status === "SUGGESTED" && item.answer.trim());
    const guesses = shown.filter((item) => item.evidenceClass !== "fact").length;
    Modal.confirm({
      title: "Accept all suggestions",
      width: 640,
      content: (
        <div>
          <p>{acceptAllLine(shown.length, guesses)}</p>
          <ul className="fedlify-sq-assumptions">
            {shown.map((item) => (
              <li key={item.id}>
                <strong>{item.question}</strong> <em>({originLabel(item) ?? "Suggestion"})</em>
                <br />
                {truncateAnswer(item.answer, 200).text}
              </li>
            ))}
          </ul>
        </div>
      ),
      okText: `Accept ${shown.length}`,
      cancelText: "Cancel",
      onOk: async () => {
        // Only what was listed here can be accepted: if a suggestion changed meanwhile, nothing is.
        const result = await call("PATCH", base, { action: "acceptAll", seen: shown.map((item) => ({ requirementId: item.id, answer: item.answer })) });
        if (!result.ok) {
          messageApi.error(errorText(result, "Could not accept the suggestions."));
          if (result.status === 409) await load();
          return;
        }
        const next = accept(result.data);
        messageApi.success(`${result.data.accepted ?? shown.length} accepted.`);
        if (next) select(nextNeedingId(next) ?? selectedId);
      }
    });
  }

  /** Ask the assistant for two to four answers to click for the selected open question. */
  async function suggestChoices(item: ChecklistItem) {
    setChoices({ id: item.id, question: null, loading: true, notice: null });
    const result = await call("POST", `${base}/questions`, { requirementId: item.id });
    if (!result.ok) {
      setChoices({ id: item.id, question: null, loading: false, notice: errorText(result, "Could not get suggestions. Write the answer in your own words.") });
      return;
    }
    const question = ((result.data.questions as PlanQuestion[]) ?? [])[0] ?? null;
    const notice =
      !question || question.options.length === 0
        ? ((result.data.notice as string | undefined) ?? "The assistant has no answers to suggest for this question. Write the answer in your own words.")
        : null;
    setChoices({ id: item.id, question, loading: false, notice });
  }

  async function confirmSpecification() {
    setConfirming(true);
    const result = await call("POST", `${base}/confirm`, { ackAssumptions: ack });
    setConfirming(false);
    if (!result.ok) {
      messageApi.error(errorText(result, "Could not confirm the study specification."));
      return;
    }
    setConfirmOpen(false);
    setAck(false);
    messageApi.success("The study specification is confirmed.");
    onChange?.();
    await load();
  }

  const shownItems = useMemo(() => filterItems(items, filter), [items, filter]);
  const groups = useMemo(() => groupByCategory(shownItems), [shownItems]);
  const counts = useMemo(() => filterCounts(items), [items]);

  if (loading && !data) return <Typography.Text type="secondary">Loading the study questions…</Typography.Text>;
  if (!data) return <InlineLoadError title="The study questions could not be loaded" message={loadError ?? "Please try again."} onRetry={() => void load()} />;

  const assumptions = items.filter((item) => item.status === "ASSUMED");
  const confirmed = Boolean(data.specification.confirmedAt);
  const openCount = data.counts.total - data.counts.answered - data.counts.assumed;
  const confirm = confirmState({ total: data.counts.total, answered: data.counts.answered, assumed: data.counts.assumed }, canEdit);
  const stage = questionsStage(data.counts, confirmed);
  const percent = Math.round((data.answeredCount / data.totalCount) * 100);
  const describeExpanded = describeOpen ?? stage === "describe";

  // Position of the selected question in the list on screen, for Previous / Next.
  const position = selected ? shownItems.findIndex((item) => item.id === selected.id) : -1;
  const previousId = position > 0 ? shownItems[position - 1].id : null;
  const nextId = position >= 0 && position < shownItems.length - 1 ? shownItems[position + 1].id : null;
  const overall = selected ? items.findIndex((item) => item.id === selected.id) + 1 : 0;

  // The one button under the three parts: what to do next. Data only; the click is handled by runStageAction.
  const nextTarget = stage === "check" ? nextNeedingId(items, null) : null;
  const stageAction: { label: string } | null = !canEdit
    ? null
    : stage === "describe"
      ? { label: "Describe your study" }
      : stage === "check" && nextTarget
        ? { label: data.counts.suggested > 0 ? "Check the next suggestion" : "Answer the next question" }
        : stage === "confirm"
          ? { label: "Confirm study specification" }
          : null;
  function runStageAction() {
    if (stage === "describe") setDescribeOpen(true);
    else if (stage === "check" && nextTarget) {
      setFilter("all");
      select(nextTarget);
    } else if (stage === "confirm") setConfirmOpen(true);
  }

  const actions = selected ? rowActions(selected.status, Boolean(selected.answer)) : null;
  const changed = selected ? editText.trim() !== selected.answer.trim() || asAssumption !== (selected.status === "ASSUMED") : false;

  return (
    <div className="fedlify-sq">
      {contextHolder}

      {/* 1. Where the questions stand and what to do next */}
      <div className="fedlify-sq-card fedlify-sq-head">
        <div className="fedlify-sq-bar">
          <div>
            <Typography.Title level={5}>Study questions</Typography.Title>
            <Typography.Text type="secondary">
              {data.totalCount} questions describe your study: who takes part, the data, privacy, how training runs and how the result is checked. The code assistant and your reviewers read the answers.
            </Typography.Text>
          </div>
          <div className="fedlify-sq-progress">
            <Progress percent={percent} size="small" status={confirmed ? "success" : "active"} />
            <Typography.Text type="secondary">{progressLine(data.answeredCount, data.totalCount, data.counts.assumed)}</Typography.Text>
          </div>
        </div>
        <ol className="fedlify-sq-stages" aria-label="How to fill in the study questions">
          {STAGES.map((entry, index) => {
            const order = STAGES.findIndex((item) => item.key === stage);
            const state = stage === "done" || index < order ? "is-done" : index === order ? "is-current" : "";
            return (
              <li key={entry.key} className={state}>
                <span className="fedlify-sq-stage-number" aria-hidden>{state === "is-done" ? <CheckCircleFilled /> : index + 1}</span>
                <span>
                  <strong>{entry.title}</strong>
                  <span>{entry.text}</span>
                </span>
              </li>
            );
          })}
        </ol>
        {confirmed ? (
          <Alert type="success" showIcon message={confirmLineOrDefault(data)} description="If you change any answer later, the specification needs to be confirmed again." />
        ) : !canEdit ? (
          <Alert type="info" showIcon message="You can read the study questions. A study lead can change them." description={openForTeamLine(openCount)} />
        ) : stageAction ? (
          <div>
            <Button type="primary" className="fedlify-dark-action" onClick={runStageAction}>
              {stageAction.label}
            </Button>
          </div>
        ) : null}
      </div>

      {/* 2. Describe the study: the assistant drafts suggestions */}
      {canEdit ? (
        <Collapse
          className="fedlify-sq-describe"
          activeKey={describeExpanded ? ["describe"] : []}
          onChange={(keys) => setDescribeOpen((Array.isArray(keys) ? keys : [keys]).includes("describe"))}
          items={[
            {
              key: "describe",
              label: (
                <span>
                  <strong>{stage === "describe" ? "Describe your study" : "Draft more answers from a description"}</strong>
                  <Typography.Text type="secondary"> The assistant suggests answers. Nothing counts until you check it.</Typography.Text>
                </span>
              ),
              children: (
                <Space direction="vertical" size={10} style={{ width: "100%" }}>
                  <Input.TextArea
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    autoSize={{ minRows: 5, maxRows: 14 }}
                    maxLength={40000}
                    showCount
                    disabled={drafting}
                    placeholder="Paste your protocol summary or describe the study in your own words. Do not paste patient data."
                    aria-label="Describe your study"
                  />
                  <Space wrap>
                    <Button type="primary" className="fedlify-dark-action" loading={drafting} disabled={!text.trim()} onClick={() => void draftAnswers()}>
                      Draft answers
                    </Button>
                    {drafting ? <Typography.Text type="secondary">The assistant is reading your description. This can take a minute.</Typography.Text> : null}
                  </Space>
                  {draftError ? <Alert type="error" showIcon message={draftError} /> : null}
                  {stop ? <StopNoticeCard stop={stop} /> : null}
                </Space>
              )
            }
          ]}
        />
      ) : null}
      {draftLine ? <Alert type="success" showIcon closable onClose={() => setDraftLine(null)} message={draftLine} description="Check each suggestion below before it counts." /> : null}
      {conflictNotes.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message="Your description disagrees with an answer you already gave. Your answers were not changed."
          description={
            <ul className="fedlify-sq-assumptions">
              {conflictNotes.map((note) => (
                <li key={note.requirementId}>
                  <Button type="link" size="small" className="fedlify-sq-inline-link" onClick={() => select(note.requirementId)}>
                    {items.find((item) => item.id === note.requirementId)?.title ?? "A question"}
                  </Button>{" "}
                  {note.note}
                </li>
              ))}
            </ul>
          }
        />
      ) : null}

      {/* 3. The questions: the list on the left, one question on the right */}
      <div className="fedlify-sq-work">
        <nav className="fedlify-sq-card fedlify-sq-list" aria-label="Study questions">
          <div className="fedlify-sq-filters" role="tablist" aria-label="Show">
            {(Object.keys(FILTER_LABELS) as QuestionFilter[]).map((key) =>
              key === "check" && counts.check === 0 ? null : (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={filter === key}
                  className={`fedlify-sq-filter${filter === key ? " is-active" : ""}`}
                  onClick={() => setFilter(key)}
                >
                  {FILTER_LABELS[key]} <span>{counts[key]}</span>
                </button>
              )
            )}
          </div>
          {canEdit && data.counts.suggested > 1 ? (
            <Button size="small" onClick={() => void acceptAll()}>
              Accept all {data.counts.suggested} suggestions
            </Button>
          ) : null}
          <div className="fedlify-sq-list-scroll">
            {groups.length === 0 ? (
              <Typography.Text type="secondary">{filter === "needs" ? "Nothing needs you right now." : "No questions to show."}</Typography.Text>
            ) : (
              groups.map((group) => {
                const all = items.filter((item) => item.category === group.category);
                const done = all.filter((item) => isDone(item.status)).length;
                return (
                  <div key={group.category} className="fedlify-sq-group">
                    <div className="fedlify-sq-group-head">
                      <span>{group.name}</span>
                      <span>
                        {done}/{all.length}
                      </span>
                    </div>
                    <ul>
                      {group.items.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            className={`fedlify-sq-item${item.id === selectedId ? " is-selected" : ""}`}
                            aria-current={item.id === selectedId ? "true" : undefined}
                            onClick={() => select(item.id)}
                            title={QUESTION_STATUS_VIEW[item.status].label}
                          >
                            <StatusMark status={item.status} />
                            <span className="fedlify-sq-item-text">{item.title}</span>
                            <span className="fedlify-sq-sr">{QUESTION_STATUS_VIEW[item.status].label}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })
            )}
          </div>
        </nav>

        <div className="fedlify-sq-card fedlify-sq-question" ref={questionRef}>
          {selected ? (
            <>
              <div className="fedlify-sq-question-top">
                <Typography.Text type="secondary">
                  {selected.categoryName} · Question {overall} of {items.length}
                </Typography.Text>
                <span title={QUESTION_STATUS_VIEW[selected.status].hint}>
                  <StatusTag value={QUESTION_STATUS_VIEW[selected.status].tag} label={QUESTION_STATUS_VIEW[selected.status].label} />
                </span>
              </div>
              <h3 className="fedlify-sq-question-text">{selected.question}</h3>
              {selected.definition && selected.definition !== selected.question ? (
                <Details title="What this question means" modalTitle={selected.question} items={[{ label: "In short", value: selected.definition }]} />
              ) : null}

              {selected.status === "SUGGESTED" && selected.answer ? (
                <div className="fedlify-sq-suggestion">
                  <div className="fedlify-sq-suggestion-head">
                    <strong>The assistant suggests</strong>
                    {originLabel(selected) ? <span className="fedlify-sq-origin">{originLabel(selected)}</span> : null}
                  </div>
                  <p>{selected.answer}</p>
                  {selected.sourceNote ? (
                    <Typography.Text type="secondary" className="fedlify-sq-why">
                      Why: {selected.sourceNote}
                    </Typography.Text>
                  ) : null}
                  {canEdit ? (
                    <Space wrap>
                      <Button
                        type="primary"
                        className="fedlify-dark-action"
                        loading={saving}
                        onClick={() => void save(selected, { action: "accept", seenAnswer: selected.answer }, "Suggestion accepted.")}
                      >
                        Accept this answer
                      </Button>
                      <Typography.Text type="secondary">or change it in the box below.</Typography.Text>
                    </Space>
                  ) : null}
                </div>
              ) : null}

              {selected.status === "CONFLICT" ? (
                <Alert
                  type="warning"
                  showIcon
                  message="Your answers disagree here"
                  description={`${selected.sourceNote ? `${selected.sourceNote} ` : ""}Write the answer you want to use. The assistant cannot decide this for you.`}
                />
              ) : null}
              {selected.status !== "SUGGESTED" && selected.status !== "CONFLICT" && selected.sourceNote ? (
                <Details title="Why the assistant said this" modalTitle="Why the assistant said this" items={[{ label: "Quote or reason", value: selected.sourceNote }]} />
              ) : null}
              {answeredByLine(selected) ? <Typography.Text type="secondary">{answeredByLine(selected)}</Typography.Text> : null}

              {canEdit && confirmed ? (
                <Alert
                  type="warning"
                  showIcon
                  message={`Saving a change removes the confirmation made by ${data.specification.confirmedByName ?? "a study lead"}. You will need to confirm the study specification again.`}
                />
              ) : null}

              <div className="fedlify-sq-answer-box">
                <label htmlFor="fedlify-sq-answer" className="fedlify-sq-answer-label">
                  {selected.status === "SUGGESTED" ? "Your answer (starts from the suggestion)" : "Your answer"}
                </label>
                <Input.TextArea
                  id="fedlify-sq-answer"
                  value={editText}
                  onChange={(event) => setEditText(event.target.value)}
                  autoSize={{ minRows: 3, maxRows: 10 }}
                  maxLength={4000}
                  disabled={!canEdit}
                  placeholder={canEdit ? "Write the answer in your own words." : "No answer yet."}
                />

                {canEdit && !isDone(selected.status) && selected.status !== "SUGGESTED" ? (
                  <div className="fedlify-sq-choices">
                    {choices?.id === selected.id && choices.question && choices.question.options.length > 0 ? (
                      <>
                        <Typography.Text type="secondary">Pick one to fill in the box, then change it if you need to:</Typography.Text>
                        <div className="fedlify-sq-choice-list">
                          {choices.question.options.map((option) => (
                            <button
                              key={option.id}
                              type="button"
                              className={`fedlify-sq-choice${editText.trim() === option.label.trim() ? " is-picked" : ""}`}
                              onClick={() => setEditText(option.label)}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </>
                    ) : (
                      <Button size="small" loading={choices?.id === selected.id && choices.loading} onClick={() => void suggestChoices(selected)}>
                        Suggest answers to pick from
                      </Button>
                    )}
                    {choices?.id === selected.id && choices.notice ? <Typography.Text type="secondary">{choices.notice}</Typography.Text> : null}
                  </div>
                ) : null}

                {canEdit ? (
                  <>
                    <Checkbox checked={asAssumption} onChange={(event) => setAsAssumption(event.target.checked)}>
                      I am not sure: save it as an assumption
                    </Checkbox>
                    <Typography.Text type="secondary" className="fedlify-sq-hint">
                      An assumption is an answer you go ahead with without being sure. It counts, and reviewers see it flagged.
                    </Typography.Text>
                    <Space wrap>
                      <Button
                        type={selected.status === "SUGGESTED" ? "default" : "primary"}
                        className={selected.status === "SUGGESTED" ? undefined : "fedlify-dark-action"}
                        loading={saving}
                        disabled={!editText.trim() || (isDone(selected.status) && !changed)}
                        onClick={() => void save(selected, { answer: editText.trim(), assumption: asAssumption }, asAssumption ? "Saved as an assumption." : "Answer saved.")}
                      >
                        {selected.status === "SUGGESTED" ? "Save my version" : "Save answer"}
                      </Button>
                      {actions?.unknown ? (
                        <Button type="text" loading={saving} onClick={() => markUnknown(selected)}>
                          Not decided yet
                        </Button>
                      ) : null}
                    </Space>
                  </>
                ) : null}
              </div>

              <div className="fedlify-sq-pager">
                <Button icon={<LeftOutlined />} disabled={!previousId} onClick={() => select(previousId)}>
                  Previous
                </Button>
                <Typography.Text type="secondary">
                  {position + 1} of {shownItems.length}
                  {filter !== "all" ? ` (${FILTER_LABELS[filter].toLowerCase()})` : ""}
                </Typography.Text>
                <Button disabled={!nextId} onClick={() => select(nextId)}>
                  Next <RightOutlined />
                </Button>
              </div>
            </>
          ) : (
            <Typography.Text type="secondary">Choose a question from the list.</Typography.Text>
          )}
        </div>
      </div>

      {/* 4. Confirm */}
      {!confirmed ? (
        <div className="fedlify-sq-card">
          <Typography.Title level={5}>Confirm study specification</Typography.Title>
          <Typography.Text type="secondary">
            Confirming says you have read every answer and the study is described correctly. {data.strict ? "Publishing needs this. " : ""}
            {PUBLISH_NEEDS_LINE}
          </Typography.Text>
          {confirm.reason ? (
            <Typography.Text type="secondary">
              {confirm.reason}{" "}
              {openCount > 0 ? (
                <Button type="link" size="small" className="fedlify-sq-inline-link" onClick={() => { setFilter("needs"); select(nextNeedingId(items)); }}>
                  Show the {openCount} that need you
                </Button>
              ) : null}
            </Typography.Text>
          ) : null}
          {canEdit ? (
            <div>
              <Button type="primary" className="fedlify-dark-action" disabled={!confirm.enabled} onClick={() => setConfirmOpen(true)}>
                Confirm study specification
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <Modal
        open={confirmOpen}
        title="Confirm study specification"
        onCancel={() => setConfirmOpen(false)}
        okText="Confirm"
        cancelText="Cancel"
        confirmLoading={confirming}
        okButtonProps={{ disabled: assumptions.length > 0 && !ack }}
        onOk={() => void confirmSpecification()}
        width={680}
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Text>You are confirming that all {data.totalCount} answers describe the study correctly. This is recorded with your name and the date.</Typography.Text>
          <Details
            inline
            title={`Read all ${data.totalCount} answers`}
            items={items.map((item) => ({ label: item.question, value: truncateAnswer(item.answer, 300).text || "No answer" }))}
          />
          {assumptions.length > 0 ? (
            <>
              <Alert
                type="warning"
                showIcon
                message={`${assumptions.length} ${assumptions.length === 1 ? "answer is an assumption" : "answers are assumptions"}`}
                description={
                  <ul className="fedlify-sq-assumptions">
                    {assumptions.map((item) => (
                      <li key={item.id}>
                        {item.question} <em>{truncateAnswer(item.answer, 120).text}</em>
                      </li>
                    ))}
                  </ul>
                }
              />
              <Checkbox checked={ack} onChange={(event) => setAck(event.target.checked)}>
                I know these are assumptions and I accept them.
              </Checkbox>
            </>
          ) : null}
        </Space>
      </Modal>
    </div>
  );
}

function confirmLineOrDefault(data: ChecklistPayload): string {
  return `Study specification confirmed. ${confirmedLine(data.specification.confirmedByName, data.specification.confirmedAt)}.`;
}
