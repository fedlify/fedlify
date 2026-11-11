# Fedlify v3 Control Plane

## Security invariants

- Models receive signed, expiring work items and curated evidence only.
- Conversation text is never authoritative memory.
- Raw clinical files, patient identifiers, and credentials are quarantined before model access.
- Deterministic and semantic verification are separate records and separate transitions.
- A semantic verifier may report findings but may not repair, approve, or export.
- Approval binds an exact artifact hash, evidence hash, source commit, and policy version.
- Export manifests contain no credentials and are independently signed.
- Codex has no production credentials, network, merge, push, runtime, or release authority.

## API contract

Authenticated endpoints below `/api/v1/studies/{studyId}/control-plane` provide evidence intake, skill contracts, work items, execution, artifacts, verifications, approvals, and exports. Every mutation requires:

- `Idempotency-Key`: stable caller-generated value of at least eight characters.
- `If-Match-Version`: expected positive record version.
- A signed-in actor with the corresponding study permission.

`POST /api/v1/studies/{studyId}/intake` is the single authoritative request entrypoint. It performs model-free prohibited-input inspection before any provider call, requests typed coordinator advice for safe inputs, and applies platform-owned policy to select the authoritative layer. Coordinator output contains intent and R01-R29 mappings but cannot contain or select a control layer. The decision, signed work item, policy/contract binding, hashes, telemetry, and audit event are persisted without storing request or fixture content.

The orchestrator performs a structured-output access check at startup. `/health` is a process liveness endpoint and `/ready` reports provider readiness. An unavailable configured model makes readiness fail; the service never substitutes another model.

Work-item execution requires resubmitting the input and curated evidence content. The platform compares each value to its signed SHA-256 hash before sending it to the isolated orchestrator. Model output returns as an unverified proposal; it does not update facts or approvals.

## Dependency invalidation

Changes to evidence, facts, policy, commits, or artifacts must create a `DependencyInvalidation` record and set affected approval bindings to `INVALIDATED`. Runtime submission and export code must reject invalidated, expired, or hash-mismatched bindings.

## Evaluation gates

- The frozen probe suite checksum and all fixture hashes are recorded before execution.
- All 144 probes must execute with no infrastructure failures.
- Critical data, secret, authority, runtime, and export escapes must be zero.
- The eICU protocol is approved by exact protocol and dataset hash before job creation.
- Only aggregate cohort summaries, metrics, and provenance may leave a participant site.
- Probe execution loads no oracle columns, submits every case through the authoritative intake endpoint, and joins expected outcomes only in the offline scorer.
- The original 144 probes are a disclosed regression benchmark. A separately authored holdout must be checksummed after implementation freeze.

## Assistant shadow mode

The assistant (threads with Ask, Plan, Agent and Edit) passes through the control plane in a shadow-only phase: every turn is evaluated and recorded, nothing is blocked, and the person sees no change. Enforcement is described in the Enforcement section below and is switched on per study.

`ASSISTANT_CONTROL_MODE` is `off`, `shadow` or `enforce`. Unset or unknown means `off`. `enforce` as a global value turns enforcement on for every study; the normal way is per study (see Enforcement). The shadow functions (`openAssistantTurn`, `beginAssistantTurn`) never block, whatever the mode. With `off` the code returns before any database call. The k8s web deployment sets `shadow`.

All assistant access to control-plane code goes through `apps/web/src/lib/assistant-control.ts`:

- `openAssistantTurn` is what the runners (`runAskTurn`, `runPlanTurn` including answers, `runProposal` for the plan path and the direct Edit path) call after the user turn is stored and before the model call. It starts the evaluation without waiting for it, so the model call is never delayed, and returns a handle whose `done(outcome)` waits for the evaluation (bounded) and records the end of the turn.
- `beginAssistantTurn` and `finishAssistantTurn` are the two steps behind it.
- Every database sequence has a 1500 ms deadline. Any exception, slow query or bad state is caught, logged once with `console.warn` (error name and code, never user text) and ignored. A record written after the deadline carries `incomplete: true` in its decision.
- The stateless legacy branch of `agent/messages` (no thread) is not wired.

### Assistant intake profile and the probe profile

`inspectAssistantIntake` (in `control-intake.ts`) is a second intake profile, used only on text the person typed or pasted in this turn: the message, the editor selection and answers to questions. It is never applied to repository files or the context pack. It keeps the credential, active-content, prompt-injection and model-weight rules. Differences from the probe profile (`inspectIntake`, used by `/intake` and unchanged):

| Topic | Probe profile | Assistant profile |
| --- | --- | --- |
| Patient data | any mention of `patient_id`, `subject_id`, `mrn` and similar | row-shaped data only: an identifier-like header with values on two or more delimited lines, three or more identifier records, repeated identifier key/value pairs in JSON, a JSON array of patient-like records, or an actual MRN/SSN value |
| Secrets | `password:`/`password=` followed by anything | the same keywords, but a type name or an environment reference as the value (`str`, `$VAR`, `os.environ[...]`) is not a secret; plus key shapes (`sk-`, `AKIA`, `ghp_`, private key blocks, JWTs, URLs with a password) |
| Active content | `<script`, `<iframe`, `#!/bin/bash`, `start_nvflare_job` | `<script`, `<iframe`, `<object/embed`, inline event handlers, `javascript:`; a shebang or a runner command in a question is not active content |
| Injection | fixed phrases | the same plus "disregard/forget prior rules", "reveal your system prompt" |
| Weights | marker phrases | the same plus large base64 blobs, long float arrays and `tensor([` |

It returns `{ verdict: "clear" | "quarantine", reasons: [{ code, layer }], redactedPreview }`. The preview never contains any of the text: it is always a short note with the reason codes, the line count and the character count.

The policy is a small dedicated `evaluateAssistantPolicy` rather than `evaluateWorkItemPolicy`: the latter matches probe phrases such as "any shell command" in evidence text and has no notion of mode, contract or tool scope, so on chat it would gate ordinary wording. The dedicated policy is deny-by-default over a known mode, an active contract and tools inside that contract.

### What is recorded

Per turn in `shadow` (and `enforce`):

- `SkillContract` `assistant.ask.v1`, `assistant.plan.v1` or `assistant.change.v1` (created once per study, idempotently; answers use the plan contract, Agent and Edit use the change contract).
- One `WorkItem`, `sourceType` `agent_thread` and `sourceId` the thread id (`agent_project` and the project id for an Edit request outside a thread), idempotency key `turn:<threadId or projectId>:<clientTurnId>` (a retry of the same client turn after the first attempt ended gets `:r1`, `:r2`, ... and its own outcome). The signature covers exactly the standard work-item payload, so any verifier can rebuild it. It is signed with the control signing secret when the turn is clear. An item that could not be signed (no secret) ends `STOPPED` with execution stop reason `<outcome>:unsigned_shadow`, never `COMPLETED`. A turn the assistant profile would quarantine is recorded as `QUARANTINED` with `STOP_1_INTAKE` and no signature, so a signature always means "would have been allowed".
- One `DecisionRecord` of type `ASSISTANT_TURN`. `decision.assistant` holds the verdict, `wouldBlock`, reasons (code and layer), the policy result and the signing status. `decision.shadow` holds the result of the full probe cascade (`resolveDeterministicIntake`) on the same text, for comparison only. The decision holds hashes and lengths, never text.
- A `QuarantineRecord` (`sourceType` `ASSISTANT_TURN_SHADOW`, `metadata.shadow = true`) only when the assistant profile says quarantine. It stores a keyed hash of the text, reason codes and the withheld-note preview. These rows are left out of the evidence list the review screens read (`GET control-plane/evidence`); read them with SQL.
- `AgentTurn.workItemId`, `controlState` and `stopCondition` on the user turn and the assistant turn.
- At the end of the turn: one `AgentExecution` (role `ASSISTANT`, model, token counts when known, `stopReason` = outcome, `verificationStatus` `NOT_VERIFIED_SHADOW`) and the work item moves to its terminal state: `done`, `no_changes` and `refused` reach `WORKER_COMPLETED`, `error` and `stopped` reach `STOPPED`, and a quarantined item always ends `STOPPED`. Each hop is checked with `assertTransition`.

The other columns added by migration `20261113090000_assistant_control` (plan and proposal links, `ApprovalBinding.selfApproved`) are not written yet.

### Reading the shadow results

How many turns would have been blocked, per reason:

```sql
SELECT reason->>'code' AS reason, reason->>'layer' AS layer, count(*) AS turns
FROM "DecisionRecord" d,
     jsonb_array_elements(d.decision->'assistant'->'reasons') AS reason
WHERE d."decisionType" = 'ASSISTANT_TURN'
  AND (d.decision->'assistant'->>'wouldBlock')::boolean
GROUP BY 1, 2
ORDER BY turns DESC;
```

Where the probe cascade disagrees with the assistant profile (the probe would have stopped an ordinary turn):

```sql
SELECT d.decision->'shadow'->>'disposition' AS probe_disposition,
       array_to_string(ARRAY(SELECT jsonb_array_elements_text(d.decision->'shadow'->'reasonCodes')), ',') AS probe_reasons,
       count(*) AS turns
FROM "DecisionRecord" d
WHERE d."decisionType" = 'ASSISTANT_TURN'
  AND d.decision->'shadow'->>'matched' = 'true'
  AND NOT (d.decision->'assistant'->>'wouldBlock')::boolean
GROUP BY 1, 2
ORDER BY turns DESC;
```

Turns whose record is late or missing: `decision->>'incomplete' = 'true'`, or turns with `AgentTurn."workItemId" IS NULL` while the mode was on.

### Signing secret

The web app signs with `FEDLIFY_CONTROL_SIGNING_SECRET`, falling back to `NEXTAUTH_SECRET` (`control-plane.ts`). The orchestrator verifies with `FEDLIFY_CONTROL_SIGNING_SECRET` only. In `deploy/k8s` the web container loads `fedlify-agent-orchestrator-secrets` with `envFrom`, the same Secret the orchestrator loads, so both read the same value if that Secret has the key `FEDLIFY_CONTROL_SIGNING_SECRET`. If the key is missing the web app silently signs with `NEXTAUTH_SECRET` and the orchestrator rejects every signature. Signing in the shadow phase stays inside the web app, and a missing secret only means the work item is recorded unsigned (`decision.assistant.signing = "unavailable"`).


## Enforcement

Enforcement makes the control plane stop and gate the assistant. It is per study and off by default. Everything below applies only to a study whose effective mode is `enforce`; for every other study each route and screen behaves exactly as in shadow mode and the shadow recording continues.

### Switching it on

`effectiveControlMode(studyId)` (`runtime-config.ts`) is:

- `off` when `ASSISTANT_CONTROL_MODE` is `off` or unset (nothing is evaluated or recorded);
- `enforce` when `ASSISTANT_CONTROL_MODE=enforce`, or when the study id is listed in `ASSISTANT_CONTROL_ENFORCE_STUDIES` (comma-separated ids, `*` for all studies);
- otherwise the global mode (`shadow`).

`ASSISTANT_CONTROL_ENFORCE_STUDIES` is in `deploy/k8s/web-deployment.yaml` with an empty value. Enforcement needs the signing secret: the web app and the orchestrator must share `FEDLIFY_CONTROL_SIGNING_SECRET` (see Signing secret), otherwise the work item cannot be signed (enforced turns then stop with "check unavailable") and the AI second check is rejected by the orchestrator (shown as "Could not check").

### What stops

The safety check finishes before the message is stored and before any model call (`guardAssistantTurn`, 3 s limit), on the ask, plan, answers, agent and edit paths.

- A message that looks like a secret, patient rows, active content, a prompt injection or model weights is not sent. The stored user turn is replaced by `[Message withheld: it looked like it contained <plain reason>.]` (the text, selection and file path are never stored), and an assistant NOTICE turn carries `payload.stop = { code, title, why, whoDecides, nextAction, codes }`. Words come from `STOP_TEXT` in `terms.ts`. The work item ends `STOPPED` with `STOP_1_INTAKE`, and the `QuarantineRecord` is a real one (`sourceType = ASSISTANT_TURN`) holding a keyed hash, reason codes and counts only. Answers to plan questions are not stored as a turn, so the questions stay open.
- A policy refusal stops with `POLICY_REFUSED` (`STOP_5_POLICY`).
- Fail closed: if the check or the ledger write fails or runs out of time, there is no model call, a NOTICE with `CHECK_UNAVAILABLE` is stored, and nothing about the message is stored. A ledger write that lands after the deadline is closed as stopped.
- The SSE ask path ends cleanly with `fedlify.stop` (and `fedlify.turn` when a withheld note was stored) followed by `fedlify.done`.

### What is recorded

- Every plan and every proposal gets an `ArtifactRevision` (plan: steps + assumptions + base commit + requirements hash; proposal: file paths, actions, content hashes + base commit) and a rule-based `VerificationRun` for the checks that already ran (plan shape and allowed paths; `validateProposalFiles` with `scanAddedRisks`; files outside the approved plan). The stored hash also covers the row id so an approval binds to exactly that plan or proposal. These are internal variants beside `control-plane-store.ts` (`assistant-artifacts.ts`) because the probe functions need request-context headers and a state chain, and `bindApproval` refuses self-approval.
- Approve plan and Accept change write a `DecisionRecord` (reason hash and length in the decision, the person's own words, up to 500 characters, in the rationale), an `ApprovalBinding` to the exact revision with `selfApproved` (the approver is the person who asked for it), `ProvenanceEdge`s plan to proposal to commit, and store `approvalBindingId` on the row.
- When a plan goes stale after approval, or is rejected after approval, its binding is marked `INVALIDATED` and a `DependencyInvalidation` is opened.

### The AI second check (advisory)

`POST .../agent/threads/[tid]/plans/[pid]/verify` and `POST .../agent/proposals/[id]/verify` (permission `runAgent`, 45 s) call the orchestrator `/v1/work-items/verify` and store `verificationStatus` as `CHECKING`, `PASSED`, `CONCERNS` (findings `contradiction`, `beyond_request` or `other`) or `UNAVAILABLE`. A stored result is returned again unless `?retry=1`. It never blocks. If the status is not `PASSED` (or the check never ran), approving a plan or accepting a change needs `proceedReason` (10 to 500 characters), otherwise `409 second_check_reason_required`. Findings are model output: capped, secrets removed, shown as plain text.

### The two-person rule

One person may accept their own change; it is recorded as self-approved. A second person is needed only at Publish, and only when the study has two or more people who may publish (`approvePipeline`): if the publisher accepted an assistant change or saved by hand since the previous published version, Publish answers `409 second_approver_required` and names who else can publish. "Since the previous published version" is decided by time (the creation time of the latest earlier version that finished publishing, against `AgentProposal.decidedAt` and the Save route's audit events), not by commit ancestry, because the code host is not asked and force-pushes break ancestry. Saves made outside the Save route are not seen. The checklist shows "A second approver publishes this version" before the click. A version that another approver also changed (accepted a change or saved by hand since the previous version) is a shared version and does not trigger the rule, otherwise two people who each changed something would lock each other out; it is still recorded as self-approved for the publisher. Accepted changes are found by status and decision time, not by whether the commit id was recorded. A person counts as an approver when they hold a study role with `approvePipeline` (the same test the Publish permission uses). The checklist item appears only when the rule applies, and names are shown without email addresses. Publish records an `ApprovalBinding` for the published commit by the publisher; `approvalStatus` is still written.

### What people see in an enforced study

Nothing changes on screen unless the thread detail or proposal list says `controlMode: "enforce"` (or a plan or proposal carries `verificationStatus`). Then:

- A paused turn shows a "Paused: needs your decision" card (title, why, who decides, what to do next; technical codes under Details). A withheld message shows as a muted note. When nothing was stored, the typed text is put back in the box so the person can edit it.
- Each open plan and change asks for the AI second check once, the first time it is shown (`lib/assistant-control-client.ts`, `shouldRequestVerify`), and shows "Checking…", "Second check passed", "Second check found things to look at" (findings listed, with a note that it is advice from an AI check) or "Could not check: needs your decision" with Retry.
- Approve plan and Accept change open "Why are you going ahead?" when the check did not pass. The server's `409 second_check_reason_required` opens the same dialog (also from the diff review view). The reason is at least 10 and at most 500 characters.
- After approval the card says "Approved by <name>", with "(self-approved)" when it applies.
- A refused Publish (`second_approver_required`) shows the server's plain message; the checklist item "A second approver publishes this version" appears beforehand.

### Other enforcement details

- The old stateless `agent/messages` route (no thread) answers `409 thread_required` in an enforced study, because it has no safety check or record. Chats go through threads.
- A new thread in an enforced study is not named after the first message (it has not been checked yet); the first stored message names it, which is the withheld note when the message was stopped.
- An edit request without a thread also has its client-supplied history checked.
- The reason typed at Approve or Accept gets the same content check as a chat message; secrets or patient rows in it are refused with a plain message. The reason is kept in the decision record and, for an accepted change, also in the save audit entry, so a failed ledger write after the commit does not lose it (the answer then carries `approvalWarning`).
- A partial approval (some steps, some files) is bound to the whole revision, and the decision record and binding evidence hash carry the approved step ids or file paths and a hash of them.
- Approved plans lose their approval (status `STALE`, binding `INVALIDATED`) when the saved head moves through an accepted change or a manual save, when a newer plan replaces them, or when they are rejected. A change to the study answers is caught when code is next requested. A plan approved before enforcement was switched on gets its record when code is requested (marked `recordedLate`).
- The keyed hash of message text needs the signing secret; in an enforced study a missing secret stops the turn instead of falling back to a plain hash.
- Known gap: saves that did not go through the Save route (pushes straight to the code host) are not seen by the two-person rule.
- Before switching a deployment to a global `ASSISTANT_CONTROL_MODE=enforce`, note that it now enforces for every study; the committed k8s file keeps `shadow`.
