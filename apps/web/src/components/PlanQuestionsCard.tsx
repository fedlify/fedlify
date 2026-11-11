"use client";

import { Button, Checkbox, Input, Radio, Tag, Typography } from "antd";
import { useState } from "react";
import type { AnswersPayload, PlanQuestion } from "@/lib/agent-thread-types";
import { canSubmitAnswers, initialDraft, selectOption, setOther, toAnswers, type AnswerDraft } from "@/lib/agent-thread-client";

/** The agent's clarifying questions, inline in the chat. Answered cards are read-only. */
export function PlanQuestionsCard({
  questions,
  round,
  answered,
  disabled,
  busy,
  hideRound,
  onSubmit
}: {
  questions: PlanQuestion[];
  round: number;
  answered: AnswersPayload | null;
  disabled: boolean;
  busy: boolean;
  /** Leave out the "round N" tag where there are no rounds (the study questions tab). */
  hideRound?: boolean;
  onSubmit: (answers: Record<string, string | string[]>, skipped: boolean) => void;
}) {
  const [draft, setDraft] = useState<AnswerDraft>(() => initialDraft(questions));
  const [index, setIndex] = useState(0);
  const locked = Boolean(answered) || disabled;
  const shownAnswer = (q: PlanQuestion) => {
    const value = answered?.answers?.[q.id];
    const values = Array.isArray(value) ? value : value ? [value] : [];
    return values.map((v) => q.options.find((o) => o.id === v)?.label ?? v).join(", ") || "No answer";
  };
  return (
    <div className="fedlify-ws-card" role="group" aria-label="Questions from the assistant" data-testid="plan-questions">
      <div className="fedlify-ws-card-head">
        <strong>{answered ? (answered.skipped ? "Questions (skipped)" : "Questions (answered)") : `Questions ${questions.length > 1 ? `(${index + 1}/${questions.length})` : ""}`}</strong>
        {hideRound ? null : <Tag>{`round ${round}`}</Tag>}
      </div>
      {questions.map((question, i) => {
        const entry = draft[question.id] ?? { selected: [], other: "" };
        // Unanswered cards show one question at a time; answered cards list all of them.
        if (!answered && i !== index) return null;
        return (
          <div key={question.id} className="fedlify-ws-question">
            <Typography.Text strong>{question.text}</Typography.Text>
            {question.requirementKey ? <Tag color="orange">{`Requirement "${question.requirementKey}" is blank`}</Tag> : null}
            {answered ? (
              <Typography.Text className="fedlify-muted">{shownAnswer(question)}</Typography.Text>
            ) : question.multi ? (
              <div className="fedlify-ws-options">
                {question.options.map((option) => (
                  <Checkbox key={option.id} checked={entry.selected.includes(option.id)} disabled={locked} onChange={() => setDraft((d) => selectOption(d, question, option.id))}>
                    {option.label}
                    {option.recommended ? <em className="fedlify-muted"> (recommended)</em> : null}
                  </Checkbox>
                ))}
              </div>
            ) : (
              <Radio.Group className="fedlify-ws-options" value={entry.other.trim() ? undefined : entry.selected[0]} disabled={locked} onChange={(e) => setDraft((d) => selectOption(d, question, e.target.value as string))}>
                {question.options.map((option) => (
                  <Radio key={option.id} value={option.id}>
                    {option.label}
                    {option.recommended ? <em className="fedlify-muted"> (recommended)</em> : null}
                  </Radio>
                ))}
              </Radio.Group>
            )}
            {!answered && question.allowOther ? (
              <Input size="small" placeholder="Other..." value={entry.other} disabled={locked} maxLength={500} aria-label={`Other answer for: ${question.text}`} onChange={(e) => setDraft((d) => setOther(d, question, e.target.value))} />
            ) : null}
          </div>
        );
      })}
      {!answered ? (
        <div className="fedlify-ws-card-actions">
          {questions.length > 1 ? (
            <>
              <Button size="small" disabled={index === 0} onClick={() => setIndex((v) => v - 1)}>Back</Button>
              <Button size="small" disabled={index >= questions.length - 1} onClick={() => setIndex((v) => v + 1)}>Next</Button>
            </>
          ) : null}
          <Button size="small" disabled={locked || busy} onClick={() => onSubmit({}, true)}>Skip</Button>
          <Button size="small" type="primary" loading={busy} disabled={locked || !canSubmitAnswers(questions, draft)} onClick={() => onSubmit(toAnswers(questions, draft), false)}>
            Submit answers
          </Button>
        </div>
      ) : null}
    </div>
  );
}
