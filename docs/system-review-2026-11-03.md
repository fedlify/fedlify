# Fedlify system review (2026-11-03)

Written after a full read of `fedlify/` (web app, services, deploy, templates), `IaC/`, the paper draft in
`paper/Journal_2026_Omid_Method/`, and the evaluation artifacts. Goal: understand the system as built, find
what blocks a real online end-to-end run (chat -> project repo -> publish -> hospitals -> training), and
rank the work.

## 1. What is live right now

| Service | URL | State (2026-11-03) |
|---|---|---|
| Web app | https://app.fedlify.com | up, `/api/v1/health` ok |
| Gitea 1.27 | https://git.fedlify.com | up |
| Harbor | https://harbor.fedlify.com | up (direct to 206.12.103.4, not Cloudflare-proxied) |
| Argo Workflows | https://argo.fedlify.com | up (basic auth) |
| Argo CD | https://argocd.fedlify.com | up |
| Kube API tunnel | 127.0.0.1:16443 | down on this laptop (`ssh -L 16443:10.44.0.1:6443 ubuntu@206.12.103.4`) |

Cluster: one kubespray Kubernetes cluster over WireGuard spanning two Compute Canada OpenStack clouds
(`hive`: control plane + worker, `arc`: two workers). Public IP 206.12.103.4 is `hive-cp`'s floating IP and
is hard-coded as the ingress target everywhere.

Local state: web unit tests 138/139 pass. The one failure (`tests/probe-deterministic-routing.test.ts:150`)
writes a report to a hard-coded scratchpad path from an old session. 44 files in `fedlify/` and ~20 in
`IaC/` are uncommitted; they are the Save -> Publish -> Run implementation from 2026-10-21 and were verified
locally with `pnpm publish:local-e2e` (real eICU partitions, FINISHED:COMPLETED), not yet applied to the cluster.

## 2. Architecture as built

### 2.1 The current (target) path: Code -> Publish -> Sites -> Run

Page: `/studies/<id>/projects` (`apps/web/src/app/(app)/studies/[studyId]/projects/page.tsx`).

1. **New project** -> `POST pipeline-projects/clone`: copies `fedlify-templates/fedlify-starter` (or another
   template/study repo) into a new repo in the study's Gitea org `fedlify-study-<slug>-<id8>` and creates a
   `PipelineProject` with `status: DRAFT`. Data-like paths are filtered out.
2. **Save** -> `POST pipeline-projects/<id>/save`: one atomic commit on `main` via Gitea's ChangeFiles API,
   authored as the researcher, with a `baseCommit` optimistic-concurrency check (409 on stale editor).
3. **Publish** -> `POST pipeline-projects/<id>/publish`: gates = ethics cleared + all 29 `RequirementResponse`
   rows exist + at least one site; tags `v<N>` in Gitea; creates/updates the per-study `NvflareDeployment`
   (`runtimeMode: k8s`, hostname `<slug>.fedlify.com`, namespace `study-<slug>`); submits Argo
   `fedlify-study-publish` via the in-cluster Kubernetes API.
4. **Argo publish workflow** (`deploy/k8s/publish-workflow-template.yaml`): clone exact commit ->
   `validate_repo.py` + `python -m unittest` -> kaniko build `harbor.fedlify.com/fedlify-studies/<slug>:v<N>`
   (digest) -> `nvflare provision` kits for `<slug>.fedlify.com` + sites (only when site list changed) ->
   namespace + Secrets (`nvflare-kits`, `fedlify-adapter`, `harbor-registry` pull robot) -> client kits to S3
   -> render `studies/<slug>/aggregator.yaml` into the `fedlify/fedlify-gitops` repo (Gitea, branch `gitops`)
   -> Argo CD ApplicationSet `fedlify-studies` deploys it -> wait for rollout -> HMAC-signed callback to
   `/api/webhooks/argo` (`kind: study-publish`).
5. **Aggregator pod**: `nvflare-server` (8002 FL, 8003 admin) + `flare-adapter` sidecar (3010, bearer token =
   HMAC(adapter secret, "adapter:<studyId>")). Ingress with `ssl-passthrough`, routed by SNI; external-dns
   creates `<slug>.fedlify.com` -> 206.12.103.4, unproxied. NetworkPolicy restricts 8002 to ingress-nginx and
   3010 to namespace `fedlify`.
6. **Site kit** (`POST sites/<id>/join-package`, `lib/site-kit.ts`): docker-compose + `fedlify-runner.sh` +
   `.env` with the image digest, read-only Harbor robot login, the real NVFLARE client kit under `nvflare/`,
   and a heartbeat sidecar. Hospital mounts its CSV at `./data` and runs the same image by digest.
   `fedlify-runner.sh update` asks the heartbeat endpoint for `desiredImageDigest`.
7. **Start run** (`POST studies/<id>/nvflare/jobs`): checks `pipelineExecutionGate` (ethics, APPROVED+PASSED
   version, all selected sites have a PASSED readiness check), that the aggregator serves this version, and
   that every selected site is connected per the adapter's `/system-info`. Adapter copies the baked-in `job/`
   folder, rewrites `min_clients` / `num_rounds`, and `submit_job`s via `nvflare.fuel.flare_api`.
8. **Progress** (`GET nvflare/jobs/<id>/progress`): per-round per-site metrics from
   `fedlify_metrics.jsonl` written by the `FedlifyMetricsCollector` server widget; sample-weighted averages.
   **Save model** (`results/sync`) downloads the result zip through the adapter and records a
   `NvflareJobResult` for the model-release flow.

Starter template (`templates/fedlify-starter`): FedAvg logistic regression on eICU heart-failure mortality
(27 features, label `hospitaldischargestatus == Expired`), NVFLARE Client API (`client.py`), ScatterAndGather
with `InTimeAccumulateWeightedAggregator`, `IntimeModelSelector` on AUROC, synthetic-data unit tests.
Only `nvflare`, `numpy`, `pandas`, `scikit-learn` are in the base image; extra deps must be pinned.

### 2.2 The AI agent paths (disconnected from 2.1)

- **Pipeline-agent chat** (`/studies/<id>/pipeline-agent`, `lib/template-agent.ts`,
  `template-agent-sessions/*`): OpenAI Responses API, model `OPENAI_CODE_AGENT_MODEL`. Chat is advisory
  only; the 29 **intake fields** (a different list from R01-R29) are filled by a guided wizard that only
  appears in plan mode. "Generate & push" writes a branch + unmerged PR in a *template* repo, and the one
  LLM call that generates an executor is discarded: the runnable job is always the synthetic
  `sag_np_metrics` + `cifar10.py` numpy client (`lib/pipeline-code.ts:271-276`).
- **Quick-deploy** (`pipeline/quick-deploy`): copies that PR branch into a third `<slug>-pipeline` repo as
  another unmerged PR, hard-codes `validationStatus: PASSED, approvalStatus: APPROVED`, skips the
  requirements gate, and marks an `AgentProposal` as MERGED when nothing was merged.
- **Code review agent** (`CodeReviewPanel` + `template-review-agent.ts`): works only for template sessions;
  the projects page does not pass `reviewTemplateId`, so the per-project editor has no AI assistance.
- **Control-plane intake** (`studies/<id>/intake`, `lib/control-intake.ts`, orchestrator service): the
  deterministic regex cascade first; the orchestrator's coordinator model (`FEDLIFY_HOSTED_MODEL` or local)
  can only escalate to a stop/ask gate. This is what the 144-probe evaluation exercises.
- **Orchestrator work-items / Codex worker**: `/v1/work-items/codex` (Codex SDK, no network, returns a diff)
  and `/v1/work-items/verify` have **no callers** in the web app.
- **Legacy**: `AgentRun`, `buildDraftPipelineSpec`, `submitAgentWorkflow`, the `agent-worker` Python
  service, the local-docker runtime (`FEDLIFY_RUNTIME_MODE=local-docker`), and the
  `fedlify-study-pipeline-ci` buildah workflow.

**Net effect:** no agent flow ever calls the project Save route. The researcher-facing story in the paper
("agent generates/aligns code, human gates, publish, run") exists as two halves that do not meet.

### 2.3 Governance gates (as coded)

| Gate | Where | Checks |
|---|---|---|
| activationGate | `lib/governance.ts:88` | 13 protocol fields, >=1 site, ethics APPROVED/NOT_REQUIRED |
| requirementsGate | `lib/governance.ts:109` | a `RequirementResponse` row exists for every R01-R29 (content not checked) |
| publish gate | `publish/route.ts:73-79` | ethics + requirementsGate + >=1 site; role `approvePipeline` |
| pipelineExecutionGate | `lib/governance.ts:115` | ethics, version APPROVED + PASSED, all selected sites readiness PASSED |
| run connectivity | `nvflare/jobs/route.ts:125-140` | every selected site connected per the aggregator |
| release gate | `model-release/route.ts` | run COMPLETED + result synced; role `approveRelease` |

## 3. Findings, ranked

### P0: security

1. **Credentials committed to `IaC` git history and pushed to `github.com:fedlify/IaC`.** Eight tracked
   `*.tfvars` files; `day0/prod/terraform.tfvars` and `day1/cicd/terraform.tfvars` hold the Cloudflare token,
   Harbor admin, Gitea admin and Argo passwords. The uncommitted diff adds a real OpenAI `sk-proj-` key to
   `day1/cicd/terraform.tfvars`. Adding `*.tfvars` to `.gitignore` does not untrack them.
   Action: `git rm --cached` the files, rotate every secret in them, keep the OpenAI key out of git
   (env var or Vault), consider history rewrite if the repo is or was public.
2. Harbor **admin** credentials are used by the pipeline/publish workflows and the `fedlify` pull secret;
   `fedlify-study-publisher` ClusterRole can create Secrets in any namespace. Lower priority than (1).

### P1: blockers for an online end-to-end run

3. **Cluster rollout not done.** The 2026-10-21 implementation is uncommitted and the runbook
   (`docs/publish-runbook.md` section 2) has not been applied: day1 `fedlify.tf`, images in Harbor
   (`nvflare-base`, `web`, `agent-orchestrator` for `r20261022-1`), day2 platform path, starter seed,
   ssl-passthrough patch. The tunnel must be up first.
4. **ssl-passthrough is only a `kubectl patch`** (`deploy-fedlify.sh passthrough`); it is not in
   `modules/kubernetes/main.tf` kubespray extra-vars, so a kubespray re-run reverts it. Add
   `ingress_nginx_extra_args: ["--enable-ssl-passthrough"]` (or equivalent) to the module.
5. **Aggregator NetworkPolicy may block passthrough traffic.** ingress-nginx runs with `hostNetwork`, so
   packets to 8002 arrive from the node IP, not a pod in namespace `ingress-nginx`. Verify on the cluster;
   if blocked, allow node CIDRs or drop the 8002 rule.
6. **`letsencrypt-http01` ClusterIssuer** used by `web-ingress.yaml` and `minio.yaml` is defined only in the
   untracked `day2/github-hivelab-courses` stack. Use `letsencrypt-prod` or define the issuer in day1.
7. **Image naming is inconsistent** across kustomization (`web`, `agent-orchestrator`, `agent-worker`),
   `deploy-fedlify.sh images` (no `agent-worker`), and GitHub CI (`fedlify-web`, `fedlify-agent-orchestrator`,
   `fedlify-agent-worker`, kustomize targets `harbor.fedlify.local/...`). CI `deploy` also checks out a
   GitHub repo, but the GitOps repo now lives in Gitea; and day2 Terraform overwrites the platform path on
   every apply. Decide one owner for `platform/` (recommend: Terraform owns manifests, CI only bumps a
   `kustomization` image tag that Terraform does not render) and fix the names.
8. **Gitea org `fedlify`** (for `fedlify-gitops`) and `fedlify-templates` are not created by IaC.

### P2: product gaps for "agent helps a researcher with little expertise"

9. **Connect the agent to the project repo.** Minimum viable: give the projects page the review agent
   (pass `reviewTemplateId`-equivalent for a project), and route its applied edits through
   `pipeline-projects/<id>/save` so they become commits authored "Fedlify agent (requested by <user>)".
   Better: a project-scoped chat ("make localEpochs configurable", "add BMI feature") that proposes a diff,
   shows it in `CodeReviewPanel`, and saves on accept. The orphaned Codex worker is a ready-made diff
   generator for this (clone project repo -> patch -> human accept -> Save).
10. **Requirements intake is a form, not a chat.** `RequirementsChatWindow` is a one-at-a-time textarea.
    The paper describes an agent that *extracts* requirements; today nothing extracts them from conversation
    and the gate only checks that a row exists.
11. **Readiness gate vs. published runtime.** `pipelineExecutionGate` requires a PASSED readiness check per
    site, which belongs to the old manual flow; in the published runtime the real signal is "connected to the
    aggregator". Either auto-pass readiness on first heartbeat with matching digest, or drop the check for
    `runtimeMode: k8s`.
12. **Publish is blocked while any run is active, and republish rolls the aggregator**, which kills in-flight
    jobs. Fine for now, but document it in the UI.
13. **Site kit re-issue on any site change** forces every site to re-download. Acceptable for a pilot.
14. **Retire legacy paths** once (9) lands: quick-deploy, local-docker runtime, `agent-worker`, `AgentRun`,
    `fedlify-study-pipeline-ci`. They confuse the UI (the study page still routes to `pipeline-agent`).

### P3: code hygiene

15. Duplicated system prompt in `template-agent-sessions/[sessionId]/stream/route.ts` vs `lib/template-agent.ts`
    (already drifted). OpenAI base URL hard-coded in three files. Model defaults disagree
    (`gpt-4.1` code / `gpt-4o` `.env` / `gpt-5.4` `.env.example`; hosted `gpt-5.6-sol` vs `gpt-4.1`).
16. `lib/control-plane.ts:81` signs with `FEDLIFY_CONTROL_SIGNING_SECRET ?? NEXTAUTH_SECRET`; orchestrator
    verifies with the former only.
17. `tests/probe-deterministic-routing.test.ts:150` hard-coded scratchpad path.
18. Stale docs: `docs/CI_CD.md` (GitHub GitOps repo, `harbor.fedlify.local`), `docs/runbook.md:115`,
    `docs/two-site-study-tutorial.md` (describes the old local-docker flow), `web-deployment.yaml` comment
    pointing at `IaC/day2/fedlify-runtime`, `IaC/README.md` (`env/prod`).

## 4. Paper vs. artifacts (summary; details in the review notes)

The current draft (`paper/Journal_2026_Omid_Method/Main.tex`) reports probe results (122/144 exact,
72/79 adversarial caught, 35/47 paused, 15/18 proceeded) that match **no artifact**. The citable run
`fedlify/probe-results/live-e2e-3rep-majority/summary.json` gives 88 PASS / 56 WRONG_LAYER / 0 NOT_BLOCKED
(61.1% exact, boundary held 100%, 137/144 unanimous). The older draft in `fedlify/paper/v3/` reports those
numbers correctly and keeps the leakage disclosure (last-value-in-stay features; demographics-only AUROC
~0.66) that the current draft drops. The eICU table `tab:fed_external` equals the hard-coded `BASELINES`
dict in `evaluation/eicu/run_case_study.py:54`, not the cited 20260818 run (e.g. DP-SGD Brier 0.038 vs
0.19 in the table). All eICU results are from the numpy/sklearn simulation
(`simulation_not_production_nvflare: true`, approvals `SYNTHETIC_E2E`); no NVFLARE run evidence exists for
the case study. Probes exercised only the intake endpoint with hosted `gpt-4.1`, not local inference. The
holdout suite was never sealed or run. TODO markers remain (`Main.tex:275`, stray `TTTT%` at :750).

Implication for the plan: once the online path works, a real multi-site NVFLARE run of the starter on the
eICU partitions (two or more hospitals, logged through the adapter) would replace the simulation claims with
evidence the repo can actually show, and the paper should be re-based on the v3 numbers.

## 4b. Phase 1 verification log (2026-11-03, afternoon)

Access procedure (each new network): `IaC/tools/update-prod-ssh.sh` (targeted day0 apply, resolves the
caller IP and rewrites the SSH rules on `hive-sg` and `arc-sg`), then open the tunnel on the day2 control
socket so kubectl and Terraform share it:

```sh
ssh -M -S /tmp/tf-ssh-fedlify.sock -o ExitOnForwardFailure=yes -f -N -L 127.0.0.1:16443:10.44.0.1:6443 ubuntu@206.12.103.4
export KUBECONFIG=~/.kube/remote-206-12-103-4.config
```

Note: `deploy-fedlify.sh` and day1 use `/tmp/tf-ssh-206.12.103.4.sock`; day2 uses `/tmp/tf-ssh-fedlify.sock`.
Both bind 127.0.0.1:16443, so only one stack's tunnel can be open at a time.

Verified on the cluster: the October runbook **was already applied**. Secrets, images `r20261022-1`, the
three workflow templates, the `fedlify-studies` ApplicationSet, SSL passthrough, Gitea starter + GitOps repo,
and Harbor `nvflare-base` are all present, and `platform/` in GitOps is byte-identical to local `deploy/k8s`.
Day2 plan: no changes. Findings 3 and 4 in section 3 are therefore resolved; 5, 6 and 7 remain to be
exercised in Phases 3-4.

Fixed today: the orchestrator was not ready because `gpt-5.6-sol` is not available to the OpenAI key.
Changed `deploy/k8s/agent-orchestrator-config.yaml` to `FEDLIFY_HOSTED_MODEL=gpt-5.5` and
`FEDLIFY_CODEX_MODEL=gpt-5.3-codex` (same in `.env.example`), applied day2, restarted the deployment;
`/ready` now returns `hostedProvider: available`. Also imported the pre-existing port-80 rule on `hive-sg`
into day0 state.

Still open from Phase 1: secrets untracking in `IaC` (P0), committing the local work.

## 4c. Phase 2 verification log (governance workflows, deployed server)

Method: Playwright specs run from the laptop against `https://app.fedlify.com`, seeding through the
cluster Postgres over `kubectl port-forward svc/fedlify-postgres 15432:5432` and the cluster MinIO at
`s3.fedlify.com`. Command shape (credentials derived in-process from the `fedlify-web-runtime` Secret):

```sh
export PLAYWRIGHT_BASE_URL=https://app.fedlify.com
export DATABASE_URL="$(kubectl -n fedlify get secret fedlify-web-runtime -o jsonpath='{.data.DATABASE_URL}' | base64 -d | sed -E 's#@[^/]+/#@127.0.0.1:15432/#')"
export S3_ENDPOINT=https://s3.fedlify.com S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... S3_FORCE_PATH_STYLE=true
pnpm --filter @fedlify/web exec playwright test e2e/<spec>.spec.ts
```

Results (2026-11-03): **141 passed, 1 failed, 5 not run** across site-onboarding, site-readiness-gate,
policy-engine, intake-classifier, evidence-classification, no-block-proceed, workflow-engine-reopen,
authoritative-intake, verifier-gates, handoff-exporter, control-plane-approval-binding. Unit tests 141/141.
Test accounts for manual checks: `pi.test@fedlify.com`, `site-a.test@fedlify.com`, `site-b.test@fedlify.com`
(passwords given out of band; each has an auto-created Default Study).

Bugs found and fixed in the working tree (need a new web image to take effect on the cluster):

1. **Test harness:** 39 hard-coded `baseURL: "http://localhost:3000"` across 11 specs now honour
   `PLAYWRIGHT_BASE_URL`; `tests/probe-deterministic-routing.test.ts` no longer writes to a machine-specific
   path.
2. **Invitations unusable without SMTP (product):** the cluster has no SMTP and the UI discarded the
   `inviteUrl` the API returns. `POST .../invitations` now reports `emailSent`, survives a mail failure,
   and the study page shows a copyable invite link after "Send role invitation". (User plans Twilio
   SendGrid later; the link stays as a fallback.)
3. **Model release broken on the published runtime (product):** `results/sync` downloads the NVFLARE
   result into a temp dir and deletes it, but `model-release` re-read `resultPath` from disk, so promotion
   would always fail on Kubernetes ("missing required artifact: workspace/models/server.npy"). Added
   `collectModelResultArtifactsFromStorage` (rebuilds the package from the synced S3 artifacts and
   re-verifies each sync-time checksum) and `resultPathAvailable`; the route uses storage whenever the
   local directory is gone. The LIFE-02/07 and LIFE-14/16 specs now also store their fixture bytes in S3.
   Unit coverage added in `tests/model-results.test.ts`.

4. **Invite link pointed at `https://localhost:3000`** on the cluster: the route built it from
   `request.nextUrl.origin`, which behind the ingress is the pod's own address. Now uses `publicBaseUrl()`
   like the kit routes. (Found by exercising the API after image `r20261103-1` went live.)

Deployed: web `r20261103-1` (fixes 1-3) rolled out through Harbor -> kustomization -> day2 -> Argo CD;
`control-plane-approval-binding.spec.ts` then passed 10/10 on the server. `r20261103-2` carries fix 4.

Scripted PI walkthrough on the server (scratchpad `phase2-walkthrough.sh`, test study
`cmw0vc9x50008s70ih27kxd7i`): ethics APPROVED, two sites (HA, HB), activate -> ACTIVE/APPROVED (note:
`activationGate` does not require the 29 answers; only Publish does), 29/29 requirements -> gate allowed,
audit events recorded. Phase 2 automated checks are green; the manual click-through by the user is next.

User feedback from the click-through (2026-11-03) and the resulting changes, deployed as web `r20261103-3`:

5. **Requirements come before activation.** `activationGate` now takes `requirementResponses` and blocks
   with `requirements (n/29 answered)`; the study PATCH and deployment routes pass the rows, the study GET
   includes them, and the Protocol tabs are ordered ... Documents -> Requirements (n/29) -> Activation. The
   readiness cards show the live count and refresh when an answer is saved.
6. **Invitations are visible on sign-in.** `GET /api/v1/me/invitations` lists pending, unexpired invitations
   for the signed-in email; `POST /api/v1/invitations/accept` accepts `{invitationId}` as well as `{token}`
   (same email-match check). `PendingInvitationsCard` renders on the study Summary and on the study list with
   "Accept and open study". Verified live: site-a saw the PI's invitation, accepted by id, and the PI's study
   appeared in its list.

Open UX note: every account's auto-created study is titled "Default Study", so a collaborator who joins
another user's default study sees two identical titles in the selector. Consider naming it after the owner
or showing the organisation name in the selector.

## 4d. Phase 3a verification log (Code -> Publish on the cluster)

Baseline via API as the PI (`phase3-code.sh`): New project cloned `fedlify-templates/fedlify-starter` into
`fedlify-study-default-study-h27kxd7i/hf-mortality-fedavg` (DRAFT), Save committed `localEpochs 5 -> 6`,
a stale save with the old base commit returned 409 `save_conflict`, head reflected the edit. Design for the
agentic workspace and the "Start a pipeline" flow: `docs/phase3-agentic-workspace.md` + mockup.

First Publish exposed two cluster defects (both fixed, deployed as web `r20261103-5` + templates):

7. **Workflow pods could not pull the base image.** The `fedlify` Harbor project is private and neither the
   `fedlify-pipeline-ci` service account nor the WorkflowTemplates carried `imagePullSecrets`, so
   `clone-validate` sat in ImagePullBackOff (and so did the exit-handler callback). Added
   `imagePullSecrets: [harbor-registry]` to both workflow service accounts and the publish template spec.
8. **Workflow callbacks never reached the app.** Callbacks went to `https://app.fedlify.com` through
   Cloudflare, which returns 403 to the `Python-urllib` user agent the callback step uses, so the app would
   have stayed at RUNNING forever. Fixed twice over: `FEDLIFY_CALLBACK_BASE_URL` points callbacks at the
   in-cluster Service (`http://fedlify-web.fedlify.svc.cluster.local`), and the callback steps send
   `User-Agent: fedlify-argo-callback/1`. The stuck run was released by stopping the workflow and sending
   the signed failure callback by hand.
9. **`bitnami/kubectl:1.31.4` no longer exists on Docker Hub** (Bitnami withdrew its tags), so
   `prepare-namespace` and `wait-ready` could not start. Replaced with `alpine/k8s:1.31.13` (kubectl + bash).
   Second attempt got through clone-validate and the kaniko build: `fedlify-studies/default-study` is in Harbor.
10. **The exit-handler callback crashed on its own input.** `{{workflow.failures}}` (JSON) was interpolated
    into a Python triple-quoted literal, raising SyntaxError, so no failed publish could report back. The
    summary now travels in the `FEDLIFY_SUMMARY` env var. Also: the publish route writes `kitGeneration` and
    `provisionedSites` before the workflow runs, so a failed first publish would make the next one skip
    kit provisioning; the webhook now resets that bookkeeping when nothing was ever published (web
    `r20261103-6`), and the test deployment row was reset by hand once.

## 5. Proposed order of work

1. Secrets: untrack tfvars, rotate, move OpenAI key out of git. (hours)
2. Bring the tunnel up; commit the 2026-10-21 work in `fedlify/` and `IaC/` (without tfvars).
3. Apply the runbook: day1 `fedlify.tf` -> images -> day2 -> seed starter -> passthrough (and put passthrough
   into kubespray vars). Fix (6) and (7) on the way. Verify (5) with a real site connecting.
4. Run runbook section 3 end-to-end on the cluster with two "hospital" machines (can be two OpenStack VMs or
   laptops) using `deploy/local-e2e/data/site_*/extract.csv`. Record the result as the first real
   multi-site artifact.
5. Connect the agent to the project repo (9), starting with review-agent-on-project + Save, then a
   project chat backed by the Codex worker. Fix the readiness gate (11).
6. Retire legacy paths (14), fix hygiene (15-18), update docs and the tutorial for the published runtime.
7. Re-base the paper on citable artifacts (section 4) and add the real NVFLARE run from step 4.

## 4e. Phase 3a result and publish speed (2026-11-03)

First reachable publish: `default-study-7kxd7i.fedlify.com` serves a certificate issued by the study's NVFLARE CA through
SSL passthrough. Further fixes: NVFLARE org names (hyphens), aggregator NetworkPolicy on 8002 (hostNetwork ingress),
unique hostname policy `<slug>-<id6>`, owner-named default studies, publish watchdog, slim web image (1.43 GB -> 444 MB),
Harbor `fedlify-mirror` plus image prepuller. Script wall time 17m22s -> 11m04s, including rollout waits and test cleanup.
Pending: argoexec `IfNotPresent` (each step still costs about 30s), `harbor_project.fedlify_mirror` import into day1 state
(project was created by API), and exercising the watchdog against a real stuck pull.

## 4f. Phase 4 first run (2026-11-03, sites on one laptop)

Two kits released through the API and started with `fedlify-runner.sh` on the same Mac (amd64 emulation, shared network),
eICU partitions from `deploy/local-e2e/data`. Both registered over mTLS through `default-study-7kxd7i.fedlify.com:443`.
Three rounds, FINISHED:COMPLETED; weighted AUROC 0.50 -> 0.925 -> 0.929 (features are last-value-in-stay, so an upper bound).
Result synced and draft release `model-v1.0.0` created. Readiness was attested by the test PI, not by site staff.
Not citable as multi-institution evidence: repeat on separate machines with real site accounts.
