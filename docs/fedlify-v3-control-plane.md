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

The assistant (threads with Ask, Plan, Agent and Edit) passes through the control plane in a shadow-only phase: every turn is evaluated and recorded, nothing is blocked, and the person sees no change. Enforcement is the next phase.

`ASSISTANT_CONTROL_MODE` is `off`, `shadow` or `enforce`. Unset or unknown means `off`. In this phase `enforce` behaves exactly like `shadow` (the decision records which one was configured). With `off` the code returns before any database call. The k8s web deployment sets `shadow`.

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
