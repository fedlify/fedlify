"use client";

import { Alert, Button, Checkbox, Input, Modal, Progress, Segmented, Space, Typography, message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Details } from "@/components/Details";
import { StopNoticeCard } from "@/components/AssistantControlParts";
import { InlineLoadError } from "@/components/LoadStates";
import { PlanQuestionsCard } from "@/components/PlanQuestionsCard";
import { RecordTable } from "@/components/RecordTable";
import { StatusTag } from "@/components/StatusTag";
import type { PlanQuestion } from "@/lib/agent-thread-types";
import type { StopPayload } from "@/lib/terms";
import type { ChecklistItem, ChecklistPayload } from "@/lib/study-questions";
import {
  FILTER_LABELS,
  PUBLISH_NEEDS_LINE,
  QUESTION_STATUS_VIEW,
  acceptAllLine,
  answerTextFor,
  answeredByLine,
  nothingToAskLine,
  openForTeamLine,
  originLabel,
  questionLabel,
  confirmState,
  confirmedLine,
  draftResultLine,
  filterItems,
  isDone,
  groupByCategory,
  progressLine,
  rowActions,
  truncateAnswer,
  type QuestionFilter
} from "@/lib/study-questions-client";
import { useStudyPermissions } from "@/lib/use-permissions";

type DraftSummary = { suggested: number; unknown: number; conflicts: number; unchanged: number; replaced?: number };

/** The extra choice on the question card: it saves "Not decided yet" instead of an answer. */
const UNSURE_OPTION_ID = "__not_sure_yet";
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

/**
 * Protocol > Study questions. The assistant drafts, a person checks: describe the study, get suggested answers,
 * accept or edit each one, answer what is left, then confirm the study specification.
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [text, setText] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftLine, setDraftLine] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [conflictNotes, setConflictNotes] = useState<Array<{ requirementId: string; note: string }>>([]);
  const [stop, setStop] = useState<StopPayload | null>(null);

  const [open, setOpen] = useState<ChecklistItem | null>(null);
  const [editText, setEditText] = useState("");
  const [asAssumption, setAsAssumption] = useState(false);
  const [saving, setSaving] = useState(false);

  const [asking, setAsking] = useState(false);
  const [questions, setQuestions] = useState<PlanQuestion[] | null>(null);
  const [askKey, setAskKey] = useState(0);
  const [askNotice, setAskNotice] = useState<string | null>(null);
  const [submittingAnswers, setSubmittingAnswers] = useState(false);

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

  /** Take a full payload from a write, keep the screen in step and tell the page. */
  function accept(payload: unknown) {
    const next = payload as ChecklistPayload & { confirmationCleared?: boolean };
    if (next && Array.isArray(next.requirements)) setData(next);
    if (next?.confirmationCleared) messageApi.info("The study specification was confirmed before. Because an answer changed, it needs to be confirmed again.");
    onChange?.();
  }

  async function write(body: Record<string, unknown>, done: string): Promise<boolean> {
    const result = await call("PATCH", base, body);
    if (!result.ok) {
      messageApi.error(errorText(result, "Could not save. Please try again."));
      if (result.status === 409 && result.data?.error?.code === "suggestion_changed") await load();
      return false;
    }
    accept(result.data);
    messageApi.success(done);
    const touched = typeof body.requirementId === "string" ? body.requirementId : null;
    if (touched) setConflictNotes((notes) => notes.filter((note) => note.requirementId !== touched));
    return true;
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
    accept(result.data);
    setDraftLine(draftResultLine(result.data.summary as DraftSummary));
    setConflictNotes((result.data.conflictNotes as Array<{ requirementId: string; note: string }>) ?? []);
  }

  function openItem(item: ChecklistItem) {
    setOpen(item);
    setEditText(item.answer);
    setAsAssumption(item.status === "ASSUMED");
  }

  async function runRowAction(item: ChecklistItem, body: Record<string, unknown>, done: string) {
    setSaving(true);
    const ok = await write({ requirementId: item.id, ...body }, done);
    setSaving(false);
    if (ok) setOpen(null);
  }

  /** Mark "Not decided yet". An answer that is already there is thrown away, so ask first. */
  function markUnknown(item: ChecklistItem) {
    if (!item.answer.trim()) {
      void runRowAction(item, { action: "unknown" }, "Marked as not decided yet.");
      return;
    }
    Modal.confirm({
      title: "Mark as not decided yet?",
      content: "The answer you see now stays in the box but will not count as an answer until you decide again.",
      okText: "Mark as not decided",
      cancelText: "Cancel",
      onOk: () => runRowAction(item, { action: "unknown" }, "Marked as not decided yet.")
    });
  }

  async function acceptOne(item: ChecklistItem) {
    setSaving(true);
    await write({ action: "accept", requirementId: item.id, seenAnswer: item.answer }, "Suggestion accepted.");
    setSaving(false);
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
        accept(result.data);
        messageApi.success(`${result.data.accepted ?? shown.length} accepted.`);
      }
    });
  }

  async function askOpenQuestions() {
    setAsking(true);
    setAskNotice(null);
    const result = await call("POST", `${base}/questions`, {});
    setAsking(false);
    if (!result.ok) {
      messageApi.error(errorText(result, "Could not get the questions. Please try again."));
      return;
    }
    const list = (result.data.questions as PlanQuestion[]) ?? [];
    // The card's "Requirement is blank" tag is wrong for a disagreement, so the question text carries the meaning.
    setQuestions(list.map((question) => ({ ...question, requirementKey: undefined, options: [...question.options, { id: UNSURE_OPTION_ID, label: "Not sure yet" }] })));
    setAskKey((value) => value + 1);
    setAskNotice(list.length === 0 ? nothingToAskLine(data?.counts ?? { suggested: 0 }) : ((result.data.notice as string | undefined) ?? null));
  }

  async function submitAnswers(answers: Record<string, string | string[]>, skipped: boolean) {
    if (skipped || !questions) {
      setQuestions(null);
      return;
    }
    setSubmittingAnswers(true);
    let saved = 0;
    const left: PlanQuestion[] = [];
    let failedText: string | null = null;
    for (const question of questions) {
      const chosen = Array.isArray(answers[question.id]) ? (answers[question.id] as string[])[0] : (answers[question.id] as string | undefined);
      const unsure = chosen === UNSURE_OPTION_ID;
      const answer = unsure ? "" : answerTextFor(question, answers[question.id]);
      if (!unsure && !answer) {
        left.push(question);
        continue;
      }
      if (failedText) {
        left.push(question);
        continue;
      }
      const result = await call("PATCH", base, unsure ? { action: "unknown", requirementId: question.id } : { requirementId: question.id, answer });
      if (!result.ok) {
        failedText = `Could not save the answer to "${question.text}". ${errorText(result, "Please try again.")}`;
        left.push(question);
        continue;
      }
      saved += 1;
      accept(result.data);
      setConflictNotes((notes) => notes.filter((note) => note.requirementId !== question.id));
    }
    setSubmittingAnswers(false);
    if (saved > 0) messageApi.success(`${saved === 1 ? "1 answer" : `${saved} answers`} saved.`);
    if (failedText) messageApi.error(failedText);
    else if (saved === 0) messageApi.info("Nothing was saved. Choose or write an answer first, or skip.");
    if (failedText || saved === 0) {
      // Keep only what was not saved on the card.
      setQuestions(left.length ? left : questions);
      setAskKey((value) => value + 1);
    } else if (left.length > 0) {
      messageApi.info(`${left.length === 1 ? "1 question was" : `${left.length} questions were`} left without an answer.`);
      setQuestions(null);
    } else setQuestions(null);
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

  const items = useMemo(() => data?.requirements ?? [], [data]);
  const groups = useMemo(() => groupByCategory(filterItems(items, filter)), [items, filter]);
  const assumptions = items.filter((item) => item.status === "ASSUMED");
  const confirmed = Boolean(data?.specification.confirmedAt);
  const openCount = data ? data.counts.total - data.counts.answered - data.counts.assumed : 0;
  const confirm = data ? confirmState({ total: data.counts.total, answered: data.counts.answered, assumed: data.counts.assumed }, canEdit) : { enabled: false, reason: null };

  if (loading && !data) return <Typography.Text type="secondary">Loading the study questions…</Typography.Text>;
  if (!data) return <InlineLoadError title="The study questions could not be loaded" message={loadError ?? "Please try again."} onRetry={() => void load()} />;

  const percent = Math.round((data.answeredCount / data.totalCount) * 100);
  // The bar turns green only when the study specification is confirmed, not just when every row has a value.
  const barStatus = confirmed ? "success" : "active";

  return (
    <div className="fedlify-sq">
      {contextHolder}

      <div className="fedlify-sq-card">
        <Typography.Title level={5}>Study questions</Typography.Title>
        <Typography.Text type="secondary">
          These {data.totalCount} questions describe your study: who takes part, the data, privacy, how training runs and how the result is checked. The code assistant and your reviewers read the answers. The assistant can fill in a first draft from a description you give it. It only suggests. You check every answer before it counts.
        </Typography.Text>
        <Typography.Text type="secondary">
          An assumption is an answer you are going ahead with without being sure. Reviewers see it flagged. {PUBLISH_NEEDS_LINE}
        </Typography.Text>
      </div>

      {canEdit ? (
        <div className="fedlify-sq-card">
          <Typography.Title level={5}>Describe your study</Typography.Title>
          <Input.TextArea
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoSize={{ minRows: 6, maxRows: 16 }}
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
          {draftLine ? <Alert type="success" showIcon message={draftLine} description="Check each suggestion below before it counts." /> : null}
          {conflictNotes.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message="Your description disagrees with an answer you already gave. Your answers were not changed."
              description={
                <ul className="fedlify-sq-assumptions">
                  {conflictNotes.map((note) => (
                    <li key={note.requirementId}>
                      <strong>{items.find((item) => item.id === note.requirementId)?.question ?? "A question"}</strong> {note.note}
                    </li>
                  ))}
                </ul>
              }
            />
          ) : null}
          {draftError ? <Alert type="error" showIcon message={draftError} /> : null}
          {stop ? <StopNoticeCard stop={stop} /> : null}
        </div>
      ) : (
        <Alert type="info" showIcon message="You can read the study questions. A study lead can change them." description={openForTeamLine(openCount)} />
      )}

      <div className="fedlify-sq-card">
        <div className="fedlify-sq-bar">
          <div>
            <Typography.Title level={5}>Checklist</Typography.Title>
            <Typography.Text type="secondary">{progressLine(data.answeredCount, data.totalCount, data.counts.assumed)}</Typography.Text>
          </div>
          <Progress percent={percent} size="small" style={{ maxWidth: 220, margin: 0 }} status={barStatus} />
        </div>
        <Typography.Text type="secondary">{PUBLISH_NEEDS_LINE}</Typography.Text>
        <div className="fedlify-sq-bar">
          <Segmented<QuestionFilter>
            value={filter}
            onChange={setFilter}
            options={(Object.keys(FILTER_LABELS) as QuestionFilter[]).map((key) => ({ value: key, label: FILTER_LABELS[key] }))}
          />
          {canEdit && data.counts.suggested > 0 ? <Button onClick={() => void acceptAll()}>Accept all suggestions ({data.counts.suggested})</Button> : null}
        </div>

        {groups.length === 0 ? (
          <Typography.Text type="secondary">{filter === "needs" ? "Nothing needs you right now." : "No questions to show."}</Typography.Text>
        ) : (
          groups.map((group) => (
            <div key={group.category}>
              <Typography.Text strong>{group.name}</Typography.Text>
              <RecordTable<ChecklistItem>
                rowKey="id"
                pagination={false}
                dataSource={group.items}
                columns={[
                  {
                    title: "Question",
                    dataIndex: "question",
                    render: (_: unknown, item) => <div style={{ minWidth: 200, maxWidth: 380 }}>{item.question}</div>
                  },
                  {
                    title: "Status",
                    dataIndex: "status",
                    render: (_: unknown, item) => {
                      const view = QUESTION_STATUS_VIEW[item.status];
                      const origin = originLabel(item);
                      const by = answeredByLine(item);
                      return (
                        <div style={{ minWidth: 150 }}>
                          <span title={view.hint}>
                            <StatusTag value={view.tag} label={view.label} />
                          </span>
                          {origin ? <div><Typography.Text type="secondary">{origin}</Typography.Text></div> : null}
                          {by ? <div><Typography.Text type="secondary">{by}</Typography.Text></div> : null}
                          {item.status === "CONFLICT" && item.sourceNote ? <div><Typography.Text type="warning">{item.sourceNote}</Typography.Text></div> : null}
                          {item.sourceNote && item.status !== "CONFLICT" ? <Details title="Why the assistant said this" items={[{ label: "Quote or reason", value: item.sourceNote }]} /> : null}
                        </div>
                      );
                    }
                  },
                  {
                    title: "Answer",
                    dataIndex: "answer",
                    render: (_: unknown, item) => {
                      if (!item.answer) return <Typography.Text type="secondary">No answer yet</Typography.Text>;
                      const isOpen = expanded.has(item.id);
                      const view = truncateAnswer(item.answer);
                      return (
                        <div className="fedlify-sq-answer">
                          {isOpen ? item.answer : view.text}
                          {view.truncated ? (
                            <Button
                              type="link"
                              size="small"
                              onClick={() =>
                                setExpanded((previous) => {
                                  const next = new Set(previous);
                                  if (next.has(item.id)) next.delete(item.id);
                                  else next.add(item.id);
                                  return next;
                                })
                              }
                            >
                              {isOpen ? "Show less" : "Show more"}
                            </Button>
                          ) : null}
                        </div>
                      );
                    }
                  },
                  {
                    title: "",
                    key: "actions",
                    render: (_: unknown, item) => (
                      <Space size={4} wrap>
                        {canEdit && item.status === "SUGGESTED" && item.answer.trim() ? (
                          <Button size="small" type="primary" className="fedlify-dark-action" loading={saving} onClick={() => void acceptOne(item)}>
                            Accept
                          </Button>
                        ) : null}
                        <Button size="small" onClick={() => openItem(item)}>
                          {!canEdit ? "View" : item.status === "SUGGESTED" ? "Edit" : isDone(item.status) ? "Review" : "Answer"}
                        </Button>
                      </Space>
                    )
                  }
                ]}
              />
            </div>
          ))
        )}
      </div>

      {canEdit ? (
        <div className="fedlify-sq-card">
          <Typography.Title level={5}>Ask me the open questions</Typography.Title>
          <Typography.Text type="secondary">
            Get up to four of the questions that still need you at a time, with answers you can click. {data.counts.suggested > 0 ? `${data.counts.suggested === 1 ? "1 suggestion is" : `${data.counts.suggested} suggestions are`} waiting for you to check in the list above; they are not asked here.` : ""}
          </Typography.Text>
          <div>
            <Button loading={asking} onClick={() => void askOpenQuestions()}>
              Show me the next open questions
            </Button>
            {openCount > 0 ? (
              <Button type="link" onClick={() => setFilter("needs")}>
                Show the {openCount} that need you in the list
              </Button>
            ) : null}
          </div>
          {askNotice ? <Alert type="info" showIcon message={askNotice} /> : null}
          {questions && questions.length > 0 ? (
            <PlanQuestionsCard key={askKey} questions={questions} round={1} answered={null} disabled={false} busy={submittingAnswers} hideRound onSubmit={(answers, skipped) => void submitAnswers(answers, skipped)} />
          ) : null}
        </div>
      ) : null}

      <div className="fedlify-sq-card">
        <Typography.Title level={5}>Confirm study specification</Typography.Title>
        {confirmed ? (
          <Alert
            type="success"
            showIcon
            message={confirmedLine(data.specification.confirmedByName, data.specification.confirmedAt)}
            description="If you change any answer later, the specification needs to be confirmed again."
          />
        ) : (
          <Typography.Text type="secondary">
            Confirming says you have read every answer and the study is described correctly. {data.strict ? "Publishing needs this." : ""}
          </Typography.Text>
        )}
        {!confirmed && confirm.reason ? (
          <Typography.Text type="secondary">
            {confirm.reason}{" "}
            {openCount > 0 ? (
              <Button type="link" size="small" onClick={() => setFilter("needs")}>
                Show the {openCount} that need you
              </Button>
            ) : null}
          </Typography.Text>
        ) : null}
        {canEdit && !confirmed ? (
          <div>
            <Button type="primary" className="fedlify-dark-action" disabled={!confirm.enabled} onClick={() => setConfirmOpen(true)}>
              Confirm study specification
            </Button>
          </div>
        ) : null}
      </div>

      <Modal
        open={Boolean(open)}
        title={open ? questionLabel(items, open.id) : ""}
        onCancel={() => setOpen(null)}
        footer={null}
        destroyOnClose
      >
        {open ? (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Typography.Text strong>{open.question}</Typography.Text>
            <div>
              <StatusTag value={QUESTION_STATUS_VIEW[open.status].tag} label={QUESTION_STATUS_VIEW[open.status].label} />
              {open.confirmedByName ? <Typography.Text type="secondary"> Checked by {open.confirmedByName}</Typography.Text> : null}
            </div>
            {open.sourceNote ? <Alert type={open.status === "CONFLICT" ? "warning" : "info"} message={open.sourceNote} /> : null}
            {open.status === "CONFLICT" ? <Typography.Text>Write the answer you want to use. The assistant cannot decide this for you.</Typography.Text> : null}
            {canEdit && confirmed ? (
              <Alert type="warning" showIcon message={`Saving will remove the confirmation made by ${data.specification.confirmedByName ?? "a study lead"}. You will need to confirm the study specification again.`} />
            ) : null}
            <Input.TextArea value={editText} onChange={(event) => setEditText(event.target.value)} autoSize={{ minRows: 4, maxRows: 12 }} maxLength={4000} disabled={!canEdit} aria-label="Answer" placeholder="Write the answer in your own words." />
            {canEdit ? (
              <>
                <Checkbox checked={asAssumption} onChange={(event) => setAsAssumption(event.target.checked)}>
                  This is an assumption
                </Checkbox>
                <Typography.Text type="secondary">An assumption is an answer you are going ahead with without being sure. Reviewers see it flagged.</Typography.Text>
                <Space wrap>
                  <Button type="primary" className="fedlify-dark-action" loading={saving} disabled={!editText.trim()} onClick={() => void runRowAction(open, { answer: editText.trim(), assumption: asAssumption }, "Answer saved.")}>
                    Edit answer
                  </Button>
                  {rowActions(open.status, Boolean(open.answer)).accept ? (
                    <Button loading={saving} onClick={() => void runRowAction(open, { action: "accept", seenAnswer: open.answer }, "Suggestion accepted.")}>
                      Accept suggestion
                    </Button>
                  ) : null}
                  {rowActions(open.status, Boolean(open.answer)).assume ? (
                    <Button loading={saving} onClick={() => void runRowAction(open, { action: "assume" }, "Marked as an assumption.")}>
                      Mark as an assumption
                    </Button>
                  ) : null}
                  {rowActions(open.status, Boolean(open.answer)).unknown ? (
                    <Button loading={saving} onClick={() => markUnknown(open)}>
                      Not decided yet
                    </Button>
                  ) : null}
                </Space>
              </>
            ) : null}
          </Space>
        ) : null}
      </Modal>

      <Modal
        open={confirmOpen}
        title="Confirm study specification"
        onCancel={() => setConfirmOpen(false)}
        okText="Confirm"
        cancelText="Cancel"
        confirmLoading={confirming}
        okButtonProps={{ disabled: assumptions.length > 0 && !ack }}
        onOk={() => void confirmSpecification()}
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Text>You are confirming that all {data.totalCount} answers describe the study correctly. This is recorded with your name and the date.</Typography.Text>
          <Details
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
