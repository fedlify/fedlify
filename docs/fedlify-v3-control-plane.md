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
