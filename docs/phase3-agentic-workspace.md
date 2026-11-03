# Phase 3: the agentic code workspace (UX/UI plan)

Goal: a researcher who has finished the protocol and the 29 requirements reaches a published, running study
without writing federated code alone. The assistant behaves like an IDE copilot (chat beside the code,
proposes diffs, runs checks, explains failures) but is scoped to one project repo and can never cross a
human gate (Publish, Start run, Release).

Mockup: `docs/mockups/phase3-workspace.html` (also published as a Claude artifact). Baseline verified on the
cluster 2026-11-03: New project -> Save -> stale-save 409 all work via the API (`phase3-code.sh`).

## 1. One screen: Study -> Code & run

Replace the two current entry points (`/studies/<id>/pipeline-agent` and `/studies/<id>/projects`) with one
page, `Code & run`, reached from the study sidebar as "Pipeline". The old pipeline-agent page and
quick-deploy are retired once this lands (they write to template PRs that never reach the project repo).

```
┌ Pipeline rail ───────────────────────────────────────────────────────────────────────────┐
│ ● Code (3 unsaved)  →  ○ Publish (v1 live, v2 pending)  →  ○ Sites (1/2 connected)  →  ○ Run │
└──────────────────────────────────────────────────────────────────────────────────────────┘
┌ Files ─────────┐ ┌ Editor / Diff ───────────────────────────────┐ ┌ Assistant ──────────────┐
│ ▸ job/         │ │ model.py                       base bb534f09 │ │ Study context ✓ 29/29   │
│   client.py  M │ │ ─────────────────────────────────────────── │ │ "Add BMI as a feature"  │
│   model.py   M │ │  def prepare_features(...)                   │ │ ▸ Proposal #3           │
│   fedlify-     │ │ +   frame["bmi"] = weight / height**2        │ │   model.py +4 −1        │
│   pipeline.json│ │ ...                                          │ │   fedlify-pipeline.json │
│                │ │                                              │ │   [Review diff] [Accept]│
│ Checks         │ │                                              │ │ Checks: tests passed ✓  │
│ ✓ layout       │ │                                              │ │ ─────────────────────── │
│ ✓ no data files│ │                                              │ │ Ask… /fix /test /explain│
│ ✓ tests (2)    │ │ [Save = commit to main]  message: ________   │ │                         │
└────────────────┘ └──────────────────────────────────────────────┘ └─────────────────────────┘
```

- **Pipeline rail** (top): the four stages with live status and exactly one primary action for the current
  stage (Save, Publish, Release kit, Start run). Human gates live here, never in the chat.
- **Files** (left, 260px): the repo at head, with `M` for unsaved edits and a dot for agent-proposed changes.
  Below it, **Checks**: the same rules the publish workflow runs (layout, no data files, no secrets, pinned
  requirements, unit tests), runnable on demand before publishing.
- **Editor / Diff** (centre): Monaco, already in `CodeReviewPanel`. Tabs per file. Diff mode when reviewing a
  proposal. Save bar shows the base commit and commits to `main` through the existing Save route.
- **Assistant** (right, 380px, collapsible): chat scoped to this project. Shows what context it has
  (protocol, 29 answers, sites and data profiles, data contract, `AGENTS.md`), proposal cards, check results
  and run summaries.

## 1b. Starting a pipeline: choose, describe, or bring your own

Today "New project" is a modal with one name field that always clones the starter, and the Template
Catalog is a separate page. Replace it with a **Start a pipeline** screen (shown when a study has no
pipeline, and from "New pipeline" on the list) with three ways in, each ending in the same workspace:

| Path | For whom | What happens |
|---|---|---|
| **Choose a template** | most studies | Gallery of approved templates (public catalog + this study's templates). Each card: task (binary classification, regression, survival), algorithm (FedAvg logistic regression, FedProx MLP, histogram XGBoost), data type (tabular EHR, imaging, time series), data contract summary (label + feature count), version and last validation, "used by N studies". A **fit** badge computed from the study (protocol data modalities, primary outcome, sites' data profiles) explains why it matches or what differs, e.g. "tabular EHR + binary outcome: fits; 3 contract columns not in Hospital B's profile". Filters by task and data type. |
| **Describe it to the assistant** | researchers without a preferred method | Chat-first: the assistant starts from the protocol and the 29 answers, asks the two or three questions it still needs (outcome, candidate features, privacy constraints), picks the closest template, and proposes the initial repository as a proposal card (files + rationale). Accept creates the project. |
| **Bring your own code** | teams with existing training code | Import from a Git URL (a repo in this study's Gitea org, or an external public repo) or upload a zip. The assistant produces an **alignment report** against the Fedlify contract (`AGENTS.md`: Client API loop, launcher path, no data files, pinned requirements, data contract in `fedlify-pipeline.json`) with proposed edits; accept creates the project with those edits as the first commit. |
| **Copy a pipeline in this study** | v2 experiments, ablations | Clone another pipeline (at a chosen published version) into a new one, keeping lineage ("forked from HF mortality FedAvg v1"). |

Then a short wizard, identical for all paths: **1 Source** (chosen above) -> **2 Data contract and run defaults**
(label, positive value, features suggested from the sites' data profiles with per-site availability shown;
rounds and min sites) -> **3 Name and create**. Creation lands in the workspace with the assistant's first
message: what was set up, what is still open, and the suggested next action.

**Pipelines list**: a study can hold several pipelines. Replace the project dropdown with a table (name,
source, latest version and publish state, live aggregator, last run and AUROC, lineage), with "Open",
"Copy" and "Archive". The Template Catalog stays as the place to publish a pipeline *as* a reusable template
(existing proposal/approval flow), reached from a pipeline's menu: "Propose as template".

Data model: `PipelineProject` already has `templateId` and Gitea fields; add `sourceKind`
(template | assistant | import | copy), `sourceRef` (template version, repo URL, or parent project + version)
and `lineage` for display. Import needs a `POST .../pipeline-projects/import` route (git URL or zip, size-
and path-checked with the same rules as Save) and the alignment step reuses the proposal machinery.

## 2. What the assistant can do (and not)

| Capability | How | Gate |
|---|---|---|
| Read study context | protocol fields, 29 requirement answers, sites + data profiles, `fedlify-pipeline.json` | read |
| Read and explain code, logs, failures | repo files at head; publish workflow log; run events and site tracebacks | read |
| Propose changes | returns a diff as a **proposal card** (files, summary, rationale); user opens it in the diff view | human accept |
| Accept -> commit | accepted files go through `POST .../save` as one commit, author "Fedlify agent (requested by <user>)" | audit `pipeline_project.agent_save` |
| Run checks | validate + unit tests in a disposable container (same image as publish); results in chat and Checks pane | none (read-only on the repo) |
| Fix loop | on failing checks, "Fix and re-run" up to 3 iterations, each a new proposal | human accept each |
| Plan from requirements | first message on a new project: data contract from R08/R09, sites from R02, metrics from R24, privacy from R16-R18 | none |
| Publish, Start run, Release kit, Release model | **never**; it can tell the user they are ready and why | human only |
| Touch data, secrets, network | **never**; guardrails reject data paths, credentials and outbound calls in proposals | validator |

Chat is working context only (not authoritative memory), consistent with the control-plane invariants.

## 3. Interaction patterns

- **Proposal card**: title, files touched with +/- counts, one-paragraph rationale, status chip
  (Proposed / Accepted -> commit `abc123` / Rejected). "Review diff" opens the centre pane in diff mode with
  per-file Accept and Reject. "Accept all" commits.
- **Quick prompts** on an empty chat: "Explain this repository", "Plan from my requirements", "Add a feature",
  "Why did publish fail?", "Why is site B not connected?".
- **Slash commands**: `/plan`, `/fix`, `/test`, `/explain <file>`, `/publish-readiness`.
- **Editor selection -> Ask assistant**: right-click or ⌘K sends the selection as context.
- **Streaming** replies; a stop button; per-session turn and token budget shown as a small meter.
- **Failures stream in**: a failed publish or run posts a system message with the first error lines and two
  buttons, "Explain" and "Propose fix".
- **Nothing happens silently**: every commit the agent produced is listed in the Publish stage's version
  table with an "agent" tag, and in Audit.

## 4. Backend plan (reuse first)

- **Model access**: OpenAI Responses API with tools, through the orchestrator (`FEDLIFY_HOSTED_MODEL`), so the
  key stays off the web pod. Codex worker (`/v1/work-items/codex`, already implemented, no network, returns a
  diff) is the engine for multi-file proposals: clone project repo at head -> patch -> diff back.
- **New model** `ProjectAgentSession { projectId, createdById, messages JSON, proposals[] }` and
  `AgentProposal` reuse (exists) with `files` JSON + status.
- **Routes** under `/api/v1/studies/<id>/pipeline-projects/<pid>/agent/`:
  `sessions` (create/list), `messages` (POST, SSE stream), `proposals/<id>/accept` (-> `commitGiteaFiles`),
  `checks` (POST: run validate + unittest in an Argo `fedlify-study-check` WorkflowTemplate, callback with
  results; same clone-validate step as publish with a `check-only` flag).
- **Context pack builder** (server): protocol + 29 answers + sites/data profiles + `fedlify-pipeline.json` +
  `AGENTS.md` + file list; hashed and recorded on the session so a reviewer can see what the agent saw.
- **Guardrails**: existing `isProhibitedDataPath`, `validate_repo.py` secret/data patterns, plus a static
  scan for `requests|urllib|socket|open(` outside allowed data-path reads.
- **UI**: new `ProjectWorkspace` page composed of `CodeReviewPanel` (editor/diff), a `FileTree`, a
  `ChecksPanel`, and `AssistantPanel`; the existing Publish/Sites/Run cards become the pipeline rail.

## 5. Delivery

| Step | Scope | Done when |
|---|---|---|
| 3a | Verify Save -> Publish -> v2 on the cluster (no agent) | v1 and v2 published, aggregator live, passthrough cert check |
| 3b | Workspace shell: rail, file tree, editor, checks, assistant with read + explain + plan | user can ask "explain client.py" and "plan from requirements" on the live site |
| 3c | Proposals -> diff review -> Accept -> Save; checks on demand; fix loop | agent-authored commit visible in Gitea and Publish table |
| 3d | Publish/run assist (failure explain, site troubleshooting); retire pipeline-agent + quick-deploy | Phase 4 runs use agent-written code |

Each step: unit tests, a Playwright spec against the deployed server, and a manual click-through.
