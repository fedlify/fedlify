# Site runner, helper app and study UX: design and plan

Status: proposal for owner decision. Date: 2026-11-04. Nothing in this document has been implemented.
Mockup: `docs/mockups/study-workspace.html` (open in a browser; all content there is example content).

How to read the evidence labels. **Verified** means a code audit read the file named. **Assumption** means inferred and not run. No kit was unzipped, no cluster was touched, and no secret is printed here.

## 1. Decision summary

| # | Decision | Recommendation |
|---|---|---|
| 1 | One study lifecycle UI | Make the new workspace (`/studies/{id}/projects`) the single "Code & run" home. Redirect legacy `?section=run` and `?section=pipeline` to it. |
| 2 | Post-run views | One Results area: run list, Run detail with Summary, Performance, Code, Model, Audit tabs. One study-wide Audit table. Every record has a URL. |
| 3 | Runner | One engine (the existing bash runner plus compose, extended). Two front ends: the CLI for headless and GPU servers, an optional local web helper for simple machines. No Go rewrite and no desktop app now. |
| 4 | Kit password | Authenticated passphrase encryption of the kit with `age`. Passphrase shown once, delivered out of band. Step-up re-authentication on kit create and download. The UI states what this does not protect. |
| 5 | Docker install | Guide and verify, do not silently install: a public "Get ready" page and `preflight.sh` / `preflight.ps1` that need no Docker. |
| 6 | Evidence after a run | Persist round metrics, snapshot commit and image digest on the job, write a model card. Chart from stored data. |
| 7 | eICU window | Yes, fix it before the cited run. Remove two leaky features now. Re-extract with a landmark window in SQL (needs credentialed access and expert sign-off). Cite no number from the last-value data or from the simulation. |

## 2. Facts this plan rests on

Verified by audit (paths under `apps/web/src` unless noted):

- Sidebar has "Pipeline" (goes to `/projects`) and "Run" (goes to legacy `?section=run`). One lifecycle has three names: Pipeline, Code & run, Federated runs. (`app/(app)/layout.tsx`, `lib/study-workspace.ts`)
- Legacy study page `app/(app)/studies/[studyId]/page.tsx` is 3149 lines and holds overview, protocol, sites, team, pipeline, run, results, audit. New workspace `.../projects/page.tsx` is 1069 lines with a Code, Publish, Sites, Run rail.
- Summary next-action cards still open legacy pipeline (`lib/study-summary.ts` L138, L230; `page.tsx` L2024, L2918). Template fork Back goes to a dead `?section=pipeline&tab=templates`.
- Results has two tabs for different objects (model releases and legacy code/kit releases). Audit is a flat grid capped by `take: 50` in `api/v1/studies/[studyId]/route.ts` L137, with no filter, paging, actor name or export. Detail views are state-only, so nothing can be linked or cited.
- Per-round metrics are shown only live as a table (`GET api/v1/nvflare/jobs/{id}/progress`, 409 unless k8s). `fedlify_metrics.jsonl` is not stored by `lib/model-results.ts`. `NvflareJob` has no commit or digest of its own. No chart library is in `apps/web/package.json`. `jszip`, `argon2`, `next-auth` are present; no MFA library.
- Kit (`lib/site-kit.ts`, `join-package/route.ts`): zip with README, compose, bash runner, `.env`, manifest and the real NVFLARE client kit (private key and cert in plaintext). Registry pull login is written to `.env` in plaintext and is one global pair for all kits. The agent sidecar hardcodes `"status":"CONNECTED"`. The manifest lists `fedlify-runner.ps1`, which the published kit does not ship. Kit creation rotates the token and revokes the old kit even if the upload fails. Revoking does not revoke the NVFLARE cert.
- Base image is `python:3.10-slim`, no CUDA, and compose has no GPU reservation.
- Readiness is four human checkboxes (connectivity, kit installed, dependencies, policy) that gate job launch.
- Starter `templates/fedlify-starter/fedlify-pipeline.json` L15 lists `sao2_periodic` and `temperature_periodic`, which `evaluation/eicu/protocol.py` excludes. The v2 CSV uses last-value-in-stay labs and vitals (demographics-only AUROC about 0.66 versus about 0.94 with all features) and has no time columns. The repo's windowed `_24` extract keeps 2,108 of 15,173 rows (about 14%) for the six frozen hospitals, with 20 to 53 deaths per hospital, and contains identifier columns.

Assumptions, not verified: published image is amd64 only; `KitRelease`/`AgentRun` are empty for new-workspace studies; Publish fully covers legacy approve and validate; `stats_pool_summary.json` is never produced; a per-site data hash is not recorded on a run; scope of the Harbor account behind the global pull pair; the listed "dead" API routes have no external callers.

## 3. Navigation map: old to new

Rule: lifecycle pages use the new rail-and-panels style. Record pages (Sites, Results, Audit) use a table plus a detail route. One `StatusTag`, one table component, one detail layout. A URL for every record.

| Old | New | Notes |
|---|---|---|
| Sidebar "Pipeline" and "Run", legacy `?section=pipeline` and `?section=run` | **Code & run**, `/studies/{id}/projects` | Redirect both legacy sections. Replace the sidebar regex highlight with route-based state. Update the subtitle in `lib/study-workspace.ts`. |
| Legacy "Federated runs" with provision, start, stop deployment, Docker logs, `composeProject` | Admin-only **Runtime** panel, or removed | Researchers never see "Provision deployment". Local-docker is legacy per `docs/system-review-2026-11-03.md`. |
| Results & Releases, tab "Trained model releases" | **Results** list and Run detail Model tab | Organised per run, not per artifact type. |
| Results & Releases, tab "Code and kit artifacts" | Retired. Site kit state moves to Sites. | Check first that it is empty for new studies (assumption). |
| Audit card grid | **Audit** table at `/studies/{id}/audit`, plus a prefiltered tab in Run detail and in the site page | New paged endpoint `/api/v1/studies/{id}/audit`. |
| Sites & Data, two duplicate tabs | One **Sites** table | Columns: site, institution, readiness, kit state, last heartbeat, action. Remove legacy site-token alert later. |
| `/sites/{id}` tabs | Operator home: Get runner, Readiness, Data profile, Activity | One reusable "Get runner" panel, linked from the workspace Sites stage and the Sites table. |
| Header button "Template Catalog", `/templates` | "Start from template" in the Code stage; `/templates` stays as admin curation | Fix fork Back path to `/projects`. Retire the duplicate template assistant (`template-agent-sessions`) in favour of the workspace assistant. |
| Summary next-action cards | Point to `/projects` | Edit `lib/study-summary.ts`, `page.tsx`. |

Resulting sidebar: Summary, Protocol, Sites, Team, Code & run, Results, Audit.

Vocabulary, used everywhere: Start run, Save model, Release model, Site kit, Pipeline version. Retire "Submit federated run", "Sync result", "Promote to model release". "Release" means a model release only.

Separation. Researcher area is the sidebar above. Operator area is `/sites/{id}`. Admin area is the Runtime panel. The legacy monolith is split per section as each section moves; it is not rewritten in one step. Legacy deletion happens only after redirects ship and Publish is confirmed to cover approval.

## 4. Screen by screen

1. **Code & run** (`/projects`). Rail: Code, Publish, Sites, Run. Code stage gains "Start from template". Run stage shows live rounds (table now, small chart) and ends with a link "Open run detail", where Save model and Release model also live. Human gates stay explicit: Publish, Start run, Save model, Release model each need a click by a named role, and are audited.
2. **Sites.** One table. Row action opens `/sites/{id}`. Kit state values: not released, released, outdated (digest differs from the aggregator's), plus last heartbeat.
3. **Site page, Get runner.** Steps: (a) download kit, step-up re-auth, passphrase shown once; (b) headless command; (c) helper app link; (d) readiness evidence. Readiness shows machine evidence (preflight result, kit digest, heartbeat) separately from human attestation (data use agreement, named signer).
4. **Results list** (`/studies/{id}/runs`). One row per run: status, pipeline version, commit, best AUROC, model release state.
5. **Run detail** (`/studies/{id}/runs/{jobId}`). Tabs: Summary, Performance, Code, Model, Audit, Logs (admin and manager only).
6. **Audit** (`/studies/{id}/audit`). Table with time, actor name, action, target, link to run. Filters: run, actor, action, time. Server paging. CSV and JSON export with a head hash.

## 5. Runner design

### 5.1 Options considered

| Option | Headless | Simple machine | Windows/Mac | Effort | Verdict |
|---|---|---|---|---|---|
| A. Bash CLI plus compose (today) | yes | poor | Windows needs WSL | S | The engine |
| B. Local web helper as an optional compose service | unaffected | good | any OS with Docker | M | Recommended second layer |
| C. Desktop app (Tauri/Electron) | needs CLI anyway | best | per-OS builds, signing, notarization | L | Defer until a real site says B is not enough |
| D. Rewrite runner in Go | yes | poor alone | single binary, but signing per OS | M to L | Not now; delays everything |

### 5.2 Engine commands (headless contract)
`unlock`, `logout`, `preflight [--json]`, `start`, `stop`, `status [--json]`, `update` (requires confirmation of digest and pipeline version), `logs`, `support-bundle`. Passphrase and registry credential can come from a file or environment variable for scripts and systemd. Every helper action maps to one of these commands, so headless and UI share one code path.

**`update` in detail (kit 6).** The server never pushes an image to a site. `update` posts one heartbeat and reads `desiredImageDigest` and `desiredPipelineVersion` from the response (the full digest reference and a plain pipeline-version label), so the new digest comes from Fedlify and not from a file on the machine. It refuses to continue until the operator confirms both: interactively by typing the version and the first 12 characters of the digest, or in scripts with `--confirm-version V --confirm-digest HEX` (12 or more hex characters; `--show` prints the plan and changes nothing). The Windows wrapper does the prompting in PowerShell and passes the two flags to the runner. Nothing is changed before the confirmation matches; `.env` is rewritten only after the pull succeeds, and only with the digest (never a credential). If `docker compose up -d` then fails, `.env` is restored to the previous digest and a restart of the old image is attempted, so a rerun never reports a site as current when nothing runs. The helper's `update` button, if any, only shows the plan (`update --show`); the confirmed update is run from a terminal. Registry login: when the new image is in the same registry project the kit's own credential file still applies, so `update` logs in again from `.fedlify/registry-credential` (password on stdin, idempotent; covers a prior `docker logout` only. The runner's own `logout` deletes the credential file, and after it `update` stops with "no registry credential" before changing anything, so unlock a fresh kit first); no new kit is needed for a code-only publish. If the image moved to another host or project (the per-study registry move) the per-site pull robot cannot read it, and `update` stops before changing anything and tells the operator to download a new kit. An expired or revoked credential shows up as a failed pull with the same advice. Runs: `POST .../nvflare/jobs` refuses with `site_image_mismatch` (409) when a selected site reports a different sha256 than the aggregator or none at all (path is ignored), naming the sites and the steps; the Sites table and the project Sites panel show "Outdated" with the same steps.

**Lost sites during a run.** Run reconcile (on every run page view and every list view, and once a minute from the `run-sweeper` CronJob through `POST /api/webhooks/run-sweep`) classifies each selected site of a RUNNING run from its latest stored heartbeat and the aggregator's client list: `down` (the runner reported OFFLINE, or heartbeats stopped and the aggregator no longer lists it), `silent` (heartbeats stopped but the aggregator still lists it, which is usually a dead heartbeat agent on a live client) or `not_connected`. Every state shows a warning and writes a run event; only `down` runs the abort clock (`FEDLIFY_SITE_LOST_TIMEOUT_MS`, default 10 minutes, minimum 1 minute). The clock needs continuous observation (`FEDLIFY_SITE_LOST_MAX_GAP_MS`, default 5 minutes between evaluations, otherwise it restarts), and an unreadable aggregator skips the evaluation entirely. At the timeout the run goes through the same abort path as the abort route (log and metrics captured first) and ends FAILED with the lost sites in its reason. Without the sweeper nothing runs when nobody views the page.

Engine fixes (all verified gaps): real heartbeat from `docker inspect` health, FLARE registration, data directory, CSV count, disk, GPU; server marks OFFLINE after 3 missed beats; compose healthcheck and log rotation; manifest lists only shipped files; token rotation and revocation commit only after upload succeeds; heartbeat rate limit and `timingSafeEqual`; site token in a 0600 file, not `.env`.

Important gate: the runner only starts the FLARE client and keeps it connected. Training is started by the study owner after readiness and approval. A site's "Start" never starts a study.

### 5.3 Password model

What it protects: the kit zip at rest (email, shared drive, lost laptop), a hijacked web session or leaked presigned link (the download is useless without the passphrase), and other local users on the machine after unlock.

What it does not protect, stated in the UI and in the paper's threat model: the site's own operator or root on the host (the client private key is mounted into the container); a compromise of the Fedlify server (it holds the cert material); replay after the key has been decrypted. The password is access control for the handover. It is not "securing the site".

Design:
1. Wrap the finished zip with `age` passphrase mode (scrypt, authenticated). Do not use JSZip (no AES), ZipCrypto, or `openssl enc` (no authentication). Spike needed: confirm a Node-side library runs in the route; effort S.
2. Passphrase: generated, five or more diceware words, shown once to the creator, never stored by Fedlify. Delivered out of band; the UI warns not to send it with the file. Recommended: the site operator re-wraps it at first `unlock`, so the creator no longer knows the working passphrase. Lost passphrase means a new kit.
3. Local unlock decrypts to a 0600 directory or memory. Registry credential is never written to `.env`.
4. Step-up: re-enter the account password (existing `argon2`/NextAuth stack) on kit create and download; one-time download token; keep the 7-day expiry and 5-minute presigned URL.
5. Per-site, pull-only, expiring Harbor robot account scoped to the study repository, replacing the global pair. Without this, anyone with one site's passphrase can read a credential shared by all kits. This needs a Harbor change, so it needs your approval first.
6. Revocation is labelled "partial" in the UI until the NVFLARE cert can be re-provisioned. Add an S3 lifecycle rule to expire superseded kit objects.

## 6. Helper UI

Form: an optional local web app, compose profile `ui`, bound to `127.0.0.1`. It is a thin shell over the engine. Five screens: Unlock, Checks, Your data, Run status, Help bundle (see mockup).

Hardening (required, because a localhost service is reachable from the user's browser): random per-session token, `Host` and `Origin` validation, refuse non-loopback binding unless explicitly overridden with a warning, never mount `docker.sock`. The UI talks to the host-side runner through a narrow queue with a fixed, validated command set. It shows no row-level data: schema, counts and type errors only, with small-cell suppression. The support bundle is built by allowlist redaction, reviewed by the site, and sent deliberately; nothing is streamed.

Docker install: a web UI inside Docker cannot install Docker. Provide a public "Get ready" page with per-OS Docker steps and `preflight.sh` / `preflight.ps1` (no Docker, no secrets, published outside the encrypted kit) that check Docker, Compose v2, disk, RAM, DNS and port 443 to the aggregator, and GPU. Windows scope needs your decision (section 11).

## 7. Headless and GPU path

Headless is first class: every capability is a CLI command with `--json` where useful, a documented systemd unit, no UI dependency. GPU: add a CUDA base-image flavour selected per study and `docker-compose.gpu.yml`, enabled automatically when `nvidia-smi` and the container toolkit are detected; preflight reports GPU presence. Not blocking for the sklearn starter, so it is a stated limitation of the first cited run. Check image architecture with `docker buildx imagetools inspect`; if amd64 only, say so on the Get ready page (Apple Silicon runs under emulation).

## 8. Results, charts, code and audit

Run detail tabs:
- **Performance.** Per-round line chart: weighted mean plus one line per site, with a table fallback. Subtitle must say: "global model scored on each site's local validation split, not a held-out test". Source is stored round metrics, or live progress while running. No chart library is installed, so the first cut is plain SVG (decision in section 11).
- **Code.** Read-only file tree at the run's commit, diff against the parent version, Gitea link, image digest, and the digest each site reported.
- **Model.** Save model, Release model, download, model card. Never auto-released.
- **Audit.** Shared audit table prefiltered to this run, with export.

Durability work (small, first): new artifact kind `ROUND_METRICS` for `fedlify_metrics.jsonl` in `lib/model-results.ts`, copied into the release on promote (Prisma migration); snapshot `gitCommit`, `imageDigest`, per-site digests, selected sites and parameters on `NvflareJob` at submit; write `model-card.json` (feature list and order, preprocessing, threshold, round metrics, commit, digest, data-contract hash, window statement, approvers).

Audit: server-paged endpoint; add events for readiness submission, kit create, download, rotate, revoke (readiness is verified missing); merge `NvflareJobEvent` into the run timeline. A `prevHash` chain is needed only if the paper claims tamper evidence.

## 9. eICU feature-window fix

Answer to your question: yes, fix it first. The run you cite should not carry a known leak, and the earlier simulation AUROCs (0.939 to 0.977) must not be cited as performance.

1. Now, no data needed: remove `sao2_periodic` and `temperature_periodic` from `templates/fedlify-starter/fedlify-pipeline.json` `dataContract.features`. Add a contract check (starter and preflight) rejecting `patientunitstayid`, `patienthealthsystemstayid`, `uniquepid` and offset-like columns.
2. Count first: run per-hospital COUNT queries for T of 12, 24 and 48 h on the six frozen hospitals before choosing T.
3. Extract (credentialed eICU access, expert sign-off): landmark T, proposal 24 h after ICU admission, stays lasting at least T, values with offset in [0, T] only; per feature first, last-in-window, min, max, mean; diagnosis flags bounded by `diagnosisoffset <= T` (currently unbounded); one stay per patient chosen by a rule that ignores outcome (current rule prefers the Expired stay); no identifiers. Start from the repo's `_24` views.
4. State the limits: early deaths before T are excluded; with 20 to 53 deaths per hospital in the existing windowed file, a two-site test may be underpowered, so report confidence intervals and decide among widening the diagnosis filter, lowering T, or accepting the smaller cohort.
5. Update `dataContract.features` to the new columns; add held-out or external-site evaluation with AUPRC, calibration and a threshold; run through real NVFLARE.
6. The protocol is `DRAFT_REQUIRES_EXPERT_APPROVAL`; a named expert signs off T and the cohort rule.

Data location: whether eICU partitions may sit on the two machines depends on your data use agreement. Until confirmed, helper-app work and tests use synthetic data.

## 10. Phased plan, done criteria and tests

| Phase | Scope | Effort | Done when | Tests |
|---|---|---|---|---|
| 0 | Remove two leaky features and add identifier check; manifest lists only shipped files; kit create commits after upload; heartbeat rate limit and `timingSafeEqual`; compose log rotation; fix Back path and summary links | S | Starter contract has 25 features; manifest matches zip contents; failed upload leaves old kit valid | Unit tests for contract check and kit route with a failing storage mock; link tests |
| 1 | Navigation: redirects, one "Code & run" item, merged Sites table, audit endpoint and page, shared StatusTag and table | M | No sidebar item opens a legacy pipeline or run view; every Results and Audit record has a URL | Playwright: legacy URLs redirect; deep link to a run loads; audit paging, filter, export |
| 2 | Runner engine: `preflight`, `status --json`, `unlock`, `logout`, `support-bundle`, real heartbeat, server OFFLINE rule | M | Stopping the client container turns the site OFFLINE within 3 beats | Shell tests of preflight against a fake Docker; heartbeat integration test |
| 3 | Password: `age` spike, encrypted kit, step-up, one-time download, local unlock, S3 lifecycle | M | Download without passphrase yields no usable key; wrong passphrase fails closed; no registry password in `.env` | Round-trip and tamper tests; step-up route tests; grep test that `.env` has no secret |
| 4 | Results: `ROUND_METRICS`, job snapshot, model card, Run detail with chart and Code tab | M to L | Chart still renders after the aggregator is stopped; values match stored jsonl; code shown equals job's commit | Migration test; chart value test against the example data; Code tab commit test |
| 5 | Helper UI, Get ready page, GPU flavour | M to L | A non-engineer completes Unlock to Connected on a clean Mac and Windows machine using only the helper; GPU override engages only when detected | Origin/Host/token tests (DNS rebinding case); usability check with one real site operator; GPU smoke on a GPU host |
| 6 | Window re-extract, contract update, held-out evaluation, real two-site NVFLARE run | M plus your data work | Cited run uses the new extract and a signed protocol; evidence saved | Contract check on partitions; cohort counts recorded; end-to-end run |
| 7 | Cosign verification, per-site Harbor robot, cert revocation, multi-arch, optional hash chain | M each | As specified per item | Per item |

Phases 0 to 2 can run in parallel. Phase 6 is the paper's critical path because it waits on credentialed access, so start counting queries now. Harbor, Terraform and cluster changes need your approval each time.

## 11. Open decisions for you, with a recommendation

1. **Fix the window first, and landmark T.** Recommend yes; T = 24 h pending per-hospital counts and expert sign-off.
2. **eICU access and DUA.** Please confirm credentialed access and whether partitions may sit on the two machines. Recommend synthetic data until confirmed.
3. **Helper form.** Recommend a localhost browser helper now, desktop app only on evidence.
4. **Kit format.** Recommend `age` (authenticated). Rejected: `openssl enc` (no authentication, LibreSSL differences).
5. **Step-up authentication.** No MFA library exists, so recommend password re-entry first; MFA later.
6. **Windows scope.** Recommend Docker Desktop plus the helper UI; WSL-only otherwise. Without this decision the manifest keeps pointing at a missing script.
7. **Per-site Harbor robot accounts.** Recommend yes, before the real multi-site run. Needs your approval.
8. **Tamper-evident audit.** Recommend the hash chain only if the paper claims it.
9. **Chart library.** Recommend plain SVG for one line chart; adopt a library only if more chart types follow.
10. **Legacy deletion.** Recommend redirects now and deletion only after Publish is confirmed to cover approval and external callers of apparently dead routes are checked.
11. **Real sites and signers.** Readiness sign-off should come from each site's own person, not `site-a.test`/`site-b.test`. Who operates the two machines?

## 12. Risks

- Cohort size after windowing is the largest scientific risk and cannot be resolved without the data.
- Passphrase friction is the price of protecting a federation private key.
- A helper UI adds a localhost attack surface; the hardening list in section 6 is mandatory, not optional.
- Revocation stays partial until cert re-provisioning exists; the UI must say so.
- Collapsing the legacy page is a large refactor; redirects first, deletion later.

## 13. Phase 3 implementation notes (password-protected kits, 2026-11-04)

What shipped (working tree, not deployed):
- Kit encryption: `lib/kit-crypto.ts` wraps the inner kit zip with `age` passphrase mode (npm `age-encryption` 0.3.1, BSD-3, pure ESM JS, scrypt work factor 18). The output is a standard age file; real `age` 1.2.1 decrypts it (checked by hand, see below).
- Passphrase: 7 words from the EFF large list (7776 words, `lib/eff-wordlist.ts`), about 90 bits, drawn with `crypto.randomInt`. Returned once in the create response (`Cache-Control: no-store`). Not stored, logged, audited, or uploaded.
- Download is an outer plaintext zip: `kit.zip.age`, `unlock.sh`, `unlock.ps1`, `README.txt` (no secrets).
- Unlock: local `age` if present, else Docker with `docker.io/library/alpine@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f` (alpine 3.22 index digest from `docker buildx imagetools inspect`, confirmed with `docker manifest inspect`; `apk add age` gives 1.2.1; no official age image exists). The pin fixes the base image, not the apk package, and needs internet. The passphrase is typed at age's own tty prompt, so it is never in argv or the environment. Staging directory 0700, output renamed into place only after decrypt, `unzip -t` and a kit check; every failure removes staging. Directories 0700, files 0600. Windows: `icacls /inheritance:r` plus a grant to the current user (`unlock.ps1` is untested: no PowerShell here).
- Secrets: `.env` and `.env.example` carry none. Registry login is `.fedlify/registry-credential` (two lines, 0600); the runner reads it (or `FEDLIFY_REGISTRY_USERNAME/PASSWORD` from the environment for scripts) and pipes the password to `docker login --password-stdin`. Site token stays in `.fedlify/site-token`. `logout` deletes both files.
- Step-up: `lib/step-up.ts`, argon2 verify, 5 failures per 15 minutes per user (in-process `rate-limit.ts`, so per pod). Codes: `step_up_failed`, `step_up_required`, `password_not_set` (all 403), `step_up_rate_limited` (429). Failures are audited as `<action>_failed` with no password.
- One-time download: `POST .../download {password}` returns a 2-minute grant; `GET .../download?grant=` redeems it atomically once and returns the 5-minute presigned URL. Only the grant hash is stored (two new nullable columns). The create call's own step-up covers the URL it returns. Kit validity stays 7 days. Upload-first ordering is unchanged.
- Audit: `site.join_package.create`, `.create_failed`, `.download_authorized`, `.download`, `.download_failed`.
- Revocation is labelled "partial" in the UI (NVFLARE cert not re-issued).
- Local-runtime (non-published) kits get the same step-up, encryption and outer zip when storage is configured. Without storage nothing is downloadable, so no passphrase is issued. Its legacy runner still writes the site token into `.env` at `start`; that runner was not rewritten.

Not done:
- Re-wrap at first unlock: skipped. The creator keeps the original file and passphrase, so re-wrapping the operator's copy would not remove the creator's access and would add an interactive encrypt step across three platforms. The real mitigations are token rotation and cert re-provisioning.
- Headless passphrase from a file or environment variable (5.2).
- Per-site Harbor robot accounts: the global pull credential is still inside the encrypted part, so anyone with one site's passphrase can read a credential shared by all kits.
- The plaintext `unlock.*` scripts can be tampered with in transit; there is no signature on them.

### Pending infrastructure item: S3 lifecycle rule (do not apply from this repo)
The route now deletes the previous kit object after a new kit commits (best effort). Backstop for expired kits and failed deletes. S3 filters cannot match the `/join/` path segment, so the rule needs an object tag that the upload would set (`fedlify-kind=site-kit`, not yet implemented in `uploadObject`):
```json
{"Rules":[{"ID":"expire-site-kits","Status":"Enabled","Filter":{"Tag":{"Key":"fedlify-kind","Value":"site-kit"}},"Expiration":{"Days":14}}]}
```
14 days = 7-day kit validity plus margin. Until the tag exists, a prefix rule on `studies/` would also hit other objects and must not be used.

### Deploy and verification notes
- Migration `20261106090000_site_kit_download_grant` (two nullable columns, additive). Migrations apply through the `migrate` initContainer in `deploy/k8s/web-deployment.yaml` (`prisma migrate deploy`) on each web pod start. Not applied anywhere yet.
- `pnpm add age-encryption@0.3.1` changed `apps/web/package.json` and `pnpm-lock.yaml` (the Dockerfile uses `--frozen-lockfile`). No `serverExternalPackages` entry was added: the package is pure JS and bundles. A `next build` was not run (forbidden here), so the standalone build is unverified.
- Manual interop (not in vitest): kit encrypted by `age-encryption`, unlocked by `unlock.sh` through the pinned Docker image on a pty, under bash 5.3 and macOS bash 3.2. Correct passphrase unlocked with 0700/0600 modes; wrong passphrase and a flipped byte both failed with nothing left behind.
- Playwright specs were updated to send the password but were not run.

## 14. Phase 5 implementation notes (helper UI, Get ready, GPU, multi-arch; 2026-11-05)

Working tree only. Nothing was built as an image, pushed, deployed or run on a real Windows, macOS or Linux site machine. "Unverified" below means exactly that.

What was added:
- **Get ready** (public, no sign-in): `/get-ready` (`app/get-ready/page.tsx`, content in `lib/get-ready.ts`), `/get-ready/preflight.sh` and `/get-ready/preflight.ps1` (`lib/site-preflight-script.ts`). They need no Docker, kit or account, write nothing, and probe only the hosts passed as `--aggregator` and `--registry`. The page prints their SHA-256.
- **Windows path (decision 6):** Docker Desktop with WSL 2. The runner stays bash and runs inside WSL; there is no native PowerShell runner and no port. `fedlify-runner.ps1` (inside the kit), `start-helper.ps1` (outer zip) and `preflight.ps1` are launchers and checks. `start` on Windows runs the heartbeat agent in the PowerShell window (`FEDLIFY_NO_BG_AGENT=1` for the background one), because background jobs can end when WSL idles. On a Windows drive WSL does not enforce 0600/0700; the NTFS permissions from `unlock.ps1` protect the folder. Every PowerShell file is unverified (no PowerShell was available; only static checks).
- **Helper UI:** `deploy/images/helper/` (zero-framework Node 22 app, deps `age-encryption` 0.3.1 and `jszip` 3.10.1 from a lockfile), compose file `docker-compose.helper.yml` with profile `ui`, published only as `127.0.0.1:8765`, read-only root, all capabilities dropped, no Docker socket, no outbound code. Five screens: Unlock, Checks, Your data, Run status, Help bundle.
  - Delivered in the plaintext outer zip (it must run before unlock) only when `FEDLIFY_HELPER_IMAGE` is set to a digest-pinned reference: `start-helper.sh`, `start-helper.ps1`, `fedlify-helper-bridge.sh`, `docker-compose.helper.yml`, `unlock-headless.sh`.
  - Engine link: the container writes one fixed word (`preflight status start stop update logout support-bundle support-bundle-logs`) into a queue folder; the host-side bridge re-validates it and runs the matching `fedlify-runner.sh` command. After unlock the bridge moves the kit out of the container's mount, so a compromised container cannot rewrite the runner the host executes. The container never starts a process other than `tar` with fixed arguments.
  - Protection: Host header must be a loopback literal or `localhost` with the published port (DNS rebinding), one-time link exchanged for an HttpOnly SameSite=Strict session cookie, `Sec-Fetch-Site` same-origin only, POST needs our own Origin plus JSON type plus a custom header, strict CSP with no inline script, 8 KB body cap, unlock rate limit (5 misses per minute), non-loopback bind refused unless `FEDLIFY_HELPER_ALLOW_REMOTE=1` (warns) or inside our container.
  - No secret in the browser: the passphrase and site token live in a password field until submit, are cleared at once, and never touch storage, the URL or the page. The passphrase is decrypted in memory in the container and is in no file, argument or environment variable. The site token is written as a 0600 file for the bridge to move into the kit. The one-time link is passed through a 0600 file, not a log or the environment.
  - Data screen: column names, types, missing and type-problem counts, small cells under 10 shown as `<10`, category labels only for low-cardinality columns where every category has 10 or more rows. It flags identifier and offset-like columns (`patientunitstayid`, `patienthealthsystemstayid`, `uniquepid`, `*_id`, `*offset`). It returns no row.
  - Residual risks: a container compromised before the bridge adopts the kit (about one second) could alter it, but it already held the passphrase then. The helper image must be pullable without a login.
- **Headless:** every capability is still a runner command. `agent-unit` prints the systemd unit (documented on Get ready). New: `unlock-headless.sh --passphrase-file FILE` (file mode 0400/0600, owned by the caller, not a symlink). The file is redirected to stdin of `docker run -i --network none` on the helper image, which decrypts to a staging folder. It is in no argument and no environment variable. It needs the helper image, so it is unavailable until that image is published.
- **GPU:** `FEDLIFY_GPU=off|auto|on` in the kit `.env`, default `off`. `docker-compose.gpu.yml` is added through `COMPOSE_FILE` only if requested and `nvidia-smi` and an nvidia runtime in `docker info` are both found. `on` makes `start` fail when not detected; `auto` falls back to CPU with a note. `deploy/images/nvflare/Dockerfile.cuda` is the CUDA flavour (Ubuntu 22.04, Python 3.10, same layout as the CPU image). A study picks it through the `BASE_IMAGE` build arg of `deploy/images/study/Dockerfile`. Not built, not run on a GPU host. Docker Desktop on Windows may not list an nvidia runtime, so detection can say no there.
- **Multi-arch:** `deploy/images/build-multiarch.sh build|verify`. Build-time cost (estimate, not measured): the arm64 half doubles the work; under QEMU on an amd64 builder the emulated apt and pip layers are commonly several times slower, so expect tens of minutes instead of a few; a native arm64 builder avoids that. Every study image built from the base also needs both platforms, so each publish pays it unless cached. The published image stays amd64 only: nothing was built or tried on arm64, and whether the whole nvflare dependency tree installs there is unverified. Kits carry `FEDLIFY_IMAGE_ARCHES=amd64` (server env `FEDLIFY_STUDY_IMAGE_ARCHES` overrides it after `verify` passes) and the runner warns on ARM hosts while arm64 is not listed.

Deploy and image needs (none done): build and publish the helper image to a registry that needs no login, then set `FEDLIFY_HELPER_IMAGE` (digest-pinned) on the web deployment; pin the `node:22-alpine` base by digest when building. Build the CUDA base if any study wants a GPU. Publish workflow multi-arch change is in `deploy/k8s` and was not edited. No migration, no schema change.

Not done: native Windows runner; re-wrap at first unlock; per-site Harbor robot accounts; signing of the plaintext launcher scripts; a usability check with a real site operator; Playwright for the helper UI itself (only a read-only spec for the public page, `e2e/phase5-get-ready.spec.ts`, not run); GPU smoke on a GPU host.

## 15. Registry model: one private Harbor project per study, scoped robots (design, 2026-11-05)

Status: implemented in the working tree on 2026-11-05 (see 15.15 for what exists and where it differs from this design). Nothing is committed, applied, deployed or run against Harbor, the cluster or Terraform. Everything labelled Memory below is still unconfirmed until the live checks in 15.9 run. It replaces the "per-site Harbor robot accounts" item in sections 5.3 and 13 ("Not done") and sections 11 and 14 (helper image location).

Evidence labels. **Read** means I read the file in this tree. **Provider** means I found the attribute name as a string in the installed provider binary (`goharbor/harbor` 3.11.3, `IaC/day1/cicd/.terraform`), which proves only that the attribute exists. **Memory** means it comes from my recollection of the Harbor API and is **not confirmed** for Harbor v2.15.2. No provider docs or Harbor API docs are in the tree and I had no network access, so every Memory item is listed again in 15.9 as a live check.

### 15.1 Requirements

1. A hospital site must be able to pull only the image of the study it belongs to. One site's kit passphrase must never expose another study's image.
2. Revoking a kit, removing a site or retiring a study must also remove that site's registry access, and the UI must say honestly what was and was not revoked.
3. Fedlify must stop using Harbor's admin account. The Harbor is shared with hivelab, arclab and lab-sites, so a Fedlify credential must not be able to damage their projects.
4. Every study and site is handled by the same code path, with no per-run manual step.
5. Existing studies, kits and aggregators keep working until a study is republished. Cutover and rollback must be reversible by configuration.
6. Harbor being down must never leave a site with a half-rotated kit.
7. No robot secret is stored by Fedlify (database, audit log, logs, S3 outside the encrypted kit). Audit events record robot lifecycle without secrets.
8. The helper image must be pullable without a login, from a project that holds nothing else.
9. Cost control: each study project has a storage quota and a tag retention policy, as configuration.
10. Terraform changes must be targetable, because day1 has known drift (cert-manager, Harbor upgrade) that must not be applied.

### 15.2 Facts about today (Read)

- Every study pushes to the private project `fedlify-studies` (`publish-workflow-template.yaml`, parameter `study-image-repo`, repo `fedlify-studies/<slug>`), using `harbor-registry-credentials` in namespace `fedlify`. That secret holds Harbor's admin account (the day2 `github-fedlify` module creates it from `var.harbor_admin`; the hivelab and lab-sites modules use the same secret name in their own setups).
- One read-only robot `studies-pull` (`IaC/day1/cicd/fedlify.tf`, project level, `fedlify-studies`, pull on repository) feeds secret `harbor-studies-pull`. The web app puts it into every kit (`join-package/route.ts` reads `FEDLIFY_STUDY_PULL_USERNAME/PASSWORD`; `site-kit.ts` writes `.fedlify/registry-credential`). The publish workflow's `prepare-namespace` step copies it into each study namespace as `harbor-registry` for the aggregator. So any site that opens its kit can pull every study's image, and so can every aggregator namespace.
- `fedlify-mirror` is public and only holds mirrored helper images. `harbor_project.fedlify_mirror` exists in the file but its comment says it was not applied through Terraform yet.
- The web app makes no Harbor API call today. The kit route is ordered upload-first: the encrypted kit is uploaded, then one DB transaction revokes the old package, rotates the site token and creates the new package. The response says `revocation: "partial"` because the NVFLARE certificate is not re-issued.
- Admin credentials are used by: the kaniko push step in `publish-workflow-template.yaml`; `platform-build-workflow-template.yaml` (push to `fedlify`); `pipeline-workflow-template.yaml` (four `secretKeyRef`s to the same secret); `scripts/mirror-helper-images.sh` and `build-web-in-cluster.sh` (optional `HARBOR_USERNAME/PASSWORD`); and Terraform in `day2/github-fedlify` (`harbor_admin` for the provider).

### 15.3 What Harbor can and cannot scope

Believed (Memory, unconfirmed on v2.15.2):
- A robot's permissions are a list of (project namespace, resource, action). Pull and push are granted on the resource `repository` of a whole project. There is no repository-name pattern, no tag pattern and no "only this repository" selector. So **repository-level scoping is impossible and a project per study is the smallest isolation unit**. Section 5.3 item 5 says "scoped to the study repository"; that wording cannot be implemented and is superseded by this section.
- A project robot has one project. A system robot may list several projects or the wildcard `*` (all projects, including ones created later).
- Robot attributes `duration` (days; `-1` means never expires), `disable`, `level`, `permissions { kind, namespace, access { action, resource, effect } }` and the computed `full_name` and `secret` exist in the provider (Provider: `duration`, `effect`, `full_name`, `namespace` found in the 3.11.3 binary). `harbor_project` has `force_destroy` and `storage_quota` (Provider schema, read with `terraform providers schema -json`; an earlier note here said `storage_limit`, which is the Harbor REST field name, not the Terraform attribute). The web app sends `storage_limit` in the REST project body (Memory). The robot name in Harbor is `robot$<prefix><name>`; the `$` needs quoting in shells and the runner must pass it through a file or stdin, not interpolate it.
- The secret is returned once, in the create response.
- Project creation and quota update appear to be system-level permissions a system robot can hold (Memory).

Cannot confirm from this tree: all of the above semantically, and especially (a) whether a robot may create a project-scoped robot with permissions it does not itself hold, (b) whether `storage_limit` can be set at project creation by a non-admin robot, (c) whether a system robot can delete projects. 15.9 lists the throwaway-project test that settles them.

### 15.4 Model

**Projects.** One private project per study, named `fedlify-s-<slug>` (study slug is already validated and unique, and `<slug>` already names the hostname). Created idempotently at publish. A 409 from Harbor is accepted only if our database already records that project for this study; an unknown existing project with that name fails closed (it belongs to someone else on the shared Harbor). Auto scanning on, quota and retention set at creation (15.7). `fedlify-studies` stays as the legacy project.

**Robots.** All names carry the study and purpose so they can be reconciled by listing.

| Robot | Created by | Harbor level and scope | Permission | Expiry | Created | Deleted | Secret goes to |
|---|---|---|---|---|---|---|---|
| Site pull | web app, kit route | project `fedlify-s-<slug>` only | repository pull | `FEDLIFY_SITE_ROBOT_DAYS`, default 90 | at kit creation, name `site-<siteCode>-<packageId8>` | kit rotation, site removal, study retirement, sweeper | encrypted inner kit only |
| Aggregator pull | publish workflow | same project | repository pull | 365 days, replaced at every publish | `prepare-namespace` | next publish (old one), retirement | `harbor-registry` secret in the study namespace |
| Push (per publish run) | publish workflow | same project | repository push and pull | 1 day | before kaniko, name `push-<ciRunId>` | workflow exit handler, expiry as backstop | a 0600 docker config file on the workflow volume, deleted with the workflow |
| Provisioner | Terraform day1 | system robot, project namespace `*` plus system create | see the provisioner permissions table below | never (rotated by Terraform) | day1 apply | never | `harbor-provisioner` secret, mounted in web and in the publish workflow only |
| Helper push | Terraform day1 | project `fedlify-public` only | push, pull | never | day1 apply | never | not in the cluster; read from a sensitive Terraform output by whoever runs the release script |

**Provisioner permissions.**

| Scope | Resource | Actions | Why |
|---|---|---|---|
| system | project | create, list | create `fedlify-s-*` |
| system | quota | read, update | set study quota if Harbor refuses `storage_limit` at create (Memory) |
| namespace `*` | project | read | existence check |
| namespace `*` | robot | create, read, list, delete | all robot lifecycle |
| namespace `*` | tag-retention | create, read, update, list | retention policy |
| none | repository, artifact, tag | none | the provisioner never reads or writes images |

**Honest limit.** A robot permission on namespace `*` covers every project on this Harbor, including hivelab, arclab and lab-sites projects. Harbor has no name-prefix selector, so **Harbor cannot restrict this robot to `fedlify-s-*`.** The robot cannot read or push images (no repository permission), but robot create/delete on `*` means a stolen provisioner credential could delete other teams' robots (breaking their CI) and, depending on 15.3(a), could mint robots with pull/push on their projects. Mitigations, in order:
1. Provisioner secret exists only in the web pod and the publish workflow namespace; never in aggregator, agent or study namespaces; never in an environment variable of a user-code pod.
2. All Harbor calls go through one module (`lib/harbor-registry.ts`, and a Python twin in the runtime image for the workflow). The module refuses any project not matching `^fedlify-s-[a-z0-9-]+$`, `fedlify-public`, or the configured legacy project, and only ever sends the permission templates in the table above. Unit tests assert this. This protects against bugs and injection, not against a stolen credential.
3. If the live test shows Harbor lets the robot escalate (15.3(a)), or that robot create needs permissions it cannot have, use the fallback in 15.8: a non-admin Harbor user as project creator, which becomes admin of only the projects it creates. That needs `project_creation_restriction` set to everyone, a shared-Harbor change that affects other teams, so it needs the owner's decision.
4. Alert on any robot created outside `fedlify-s-*` (the sweeper lists robots and records anything unexpected as an audit event `registry.robot.unexpected`).

**Remaining admin uses after this design** (each is a human-run or break-glass path, none runs in the web pod):
1. Terraform `harbor` provider in day1 and day2 (apply time, by an operator).
2. Platform image pushes to project `fedlify`: `platform-build-workflow-template.yaml`, `pipeline-workflow-template.yaml`, `build-web-in-cluster.sh`. They still use `harbor-registry-credentials`. Follow-up (not in this design's targets): a TF robot `fedlify-platform-push`, push and pull on `fedlify` and `fedlify-mirror`, swapped in.
3. `mirror-helper-images.sh` (manual, uses an existing `docker login` or env credentials).
4. Study project deletion at retirement and quota update, only if the live test shows the provisioner cannot do them. Then a CronJob with admin credentials in its own namespace does only those two calls.
5. The existing `harbor-registry-credentials` in namespace `fedlify` stays until items 2 and the legacy path are gone. After cutover only the platform workflows reference it; the publish workflow stops referencing it.

**Public project.** `fedlify-public`, public, scanning on, holds only `fedlify-helper`. Pinned by digest in `FEDLIFY_HELPER_IMAGE`. Section 14 already requires the helper to be pullable without login. Retention keeps the last 5 tags. Release script (to be written, `fedlify/scripts/release-helper-image.sh`): `docker buildx build --platform linux/amd64,linux/arm64 --push --metadata-file`, log in with the helper-push robot, read the digest from the metadata, verify with an anonymous manifest request, and print `FEDLIFY_HELPER_IMAGE=harbor.fedlify.com/fedlify-public/fedlify-helper@sha256:...`. It never prints credentials.

### 15.5 Data model (additive Prisma migration, to be written)

- `RegistryProject`: `id`, `studyId` (unique), `name` (unique), `status` (`ACTIVE` | `RETIRED`), `quotaBytes`, `createdAt`, `retiredAt`.
- `RegistryRobot`: `id`, `registryProjectId`, `studySiteId?`, `siteJoinPackageId?`, `purpose` (`SITE_PULL`), `harborRobotId Int?`, `harborName`, `status` (`PENDING` | `ACTIVE` | `REVOKING` | `DELETED`), `expiresAt`, `createdAt`, `deletedAt?`, `lastError String?` (sanitized, 200 chars, never a Harbor response body). **No secret column.** Indexes on `(studySiteId, status)` and `(status, createdAt)`.
- Workflow-made robots (push, aggregator) are not in the database; they are found by name when listing the project.
- No existing column changes, so rollback needs no migration revert. The `migrate` initContainer applies it on web start.

### 15.6 Lifecycle

**Publish** (publish workflow):
1. `ensure-project`: if `FEDLIFY_REGISTRY_MODE=per-study`, create or confirm `fedlify-s-<slug>` with quota and retention; otherwise use `fedlify-studies`.
2. `mint-push-robot`: 1-day push robot, docker config written 0600 to the workflow volume. Kaniko reads that, not `harbor-registry-credentials`.
3. build and push by digest. After success the `update-gitops` step also tags the digest `active`, which retention excludes, so a long-running study image is never expired by later failed publishes.
4. `mint-aggregator-robot` then `prepare-namespace` writes the `harbor-registry` secret from it, then deletes the previous aggregator robot.
5. Exit handler `delete-push-robot` runs on success and failure. The robot's 1-day expiry covers a killed workflow.
6. The workflow reports the project to the web callback; the database upserts `RegistryProject`. The image reference is `harbor.fedlify.com/fedlify-s-<slug>/<slug>@sha256:...`, so the kit can read the project from the digest.

**Kit creation** (web, `join-package/route.ts`). Order matters:
1. Step-up, preconditions, and the encryption slot are unchanged and come first. A "busy" return must happen before any robot exists.
2. Only if storage is configured (otherwise no file is produced and no credential must be minted) and the deployment's image is in a per-study project: insert `RegistryRobot` `PENDING`, call Harbor to create the site pull robot, keep the secret in memory, update the row with the Harbor id.
3. Build kit files with that secret, encrypt, upload (the existing upload-first step).
4. One DB transaction (existing): revoke packages, rotate token, create the package, mark the new robot `ACTIVE` with the package id, mark the site's earlier `ACTIVE` robots `REVOKING`.
5. After commit: delete each `REVOKING` robot in Harbor (best effort), set `DELETED`, audit. Failure leaves `REVOKING` for the sweeper.
6. If Harbor create fails (step 2): return 502 `registry_unavailable`, `PENDING` row marked `DELETED` with the sanitized error. Nothing else changed, so the previous kit, previous robot and token remain valid, exactly as with a storage failure today.
7. If upload fails (step 3) or the transaction fails (step 4): delete the new robot immediately, best effort; a failed delete leaves the row for the sweeper.
8. For a deployment still in `fedlify-studies` (legacy), no robot is minted and the global `studies-pull` credential is used as today.
9. Per-study mode never falls back silently to the global credential when Harbor is down. Falling back would put the shared credential back inside a kit. Only deployments that have no per-study project use the global one.

**Rotation, removal, retirement.** The same function `revokeRegistryAccess({siteId|studyId})` marks robots `REVOKING`, deletes them, audits. Called from: kit creation (previous robots), site removal and site status change to removed, study retirement or archive. Study retirement also deletes the aggregator robot, marks `RegistryProject` `RETIRED`, and sets the project to be removed after `FEDLIFY_RETIRED_PROJECT_GRACE_DAYS` (default 30) by the sweeper, so audit and rollback are possible.

**Sweeper.** CronJob every 15 minutes calls an internal route authenticated like the Argo callback. It (a) deletes `PENDING` rows older than 15 minutes and their Harbor robots (orphans from a crashed request), (b) retries `REVOKING`, (c) lists robots per project and deletes any named `site-*` with no `ACTIVE` row, plus any `push-*` older than 1 day, (d) records `registry.robot.unexpected` for anything else not matching our naming. An opportunistic sweep for the site also runs at each kit creation. Harbor expiry bounds the exposure window for anything the sweeper misses.

**Audit.** `registry.project.ensure`, `registry.robot.create`, `registry.robot.delete`, `registry.robot.delete_failed`, `registry.robot.orphan_swept`, `registry.robot.unexpected`. Metadata: project, harborName, harborRobotId, purpose, expiresAt, packageId, reason. Never the secret, never a Harbor response body. Tests assert the serialised audit metadata contains neither the secret nor a `Basic` header.

**UI revocation label.** Today `revocation: "partial"` means the token is revoked but the NVFLARE certificate is not. The response becomes `{ token: "revoked", registry: "revoked" | "pending" | "not_applicable", certificate: "not_reissued" }`. The label stays "partial" while `certificate` is not re-issued, even when registry revocation completed. It changes only if certificate re-issue is built. `registry: "pending"` is shown when a Harbor delete failed and the sweeper is retrying.

**Robot expiry versus operations.** A running container keeps working after its robot expires or is deleted; only the next `docker pull` fails (update or a fresh start on a machine without the image). Default 90 days is a guess. The kit and runner should state the date. A "refresh registry credential" action that mints a new robot without rotating the site token is a sensible follow-up and is not in scope here.

### 15.7 Retention and quota (configuration)

| Variable | Default | Meaning |
|---|---|---|
| `FEDLIFY_REGISTRY_MODE` | `legacy` | `legacy` publishes to `fedlify-studies`; `per-study` publishes to `fedlify-s-<slug>` |
| `FEDLIFY_STUDY_PROJECT_QUOTA_GIB` | 20 | storage quota per study project |
| `FEDLIFY_STUDY_RETENTION_KEEP` | 10 | keep the most recent N pushed tags; tag `active` always kept |
| `FEDLIFY_SITE_ROBOT_DAYS` | 90 | site pull robot expiry |
| `FEDLIFY_RETIRED_PROJECT_GRACE_DAYS` | 30 | wait before deleting a retired project |
| `FEDLIFY_HARBOR_URL` | `https://harbor.fedlify.com` | provisioner API base; in-cluster service URL is cheaper if reachable |

The 20 GiB default is a guess. Layers of the shared base image count against each project's quota and I did not measure the base image size; measure it first and set the quota to at least three times the base plus one study layer. Harbor garbage collection is shared with other teams and runs on Harbor's own schedule; retention only untags, space returns after GC.

### 15.8 Migration, cutover and rollback

Phase A, additive and inert: apply Terraform (15.10), apply the Prisma migration, deploy web and workflow code with `FEDLIFY_REGISTRY_MODE=legacy`. Behaviour is unchanged; the provisioner exists but is unused for publishing. Smoke the live checks in 15.9 with a throwaway project before anything else.

Phase B, cutover per study: set `FEDLIFY_REGISTRY_MODE=per-study`. Studies already published keep `fedlify-studies`, their aggregator keeps the global pull secret, and their kits keep working (their kit route sees a legacy digest and mints no robot). A study moves when it is republished: the new image lands in `fedlify-s-<slug>`, the aggregator gets its own robot, and new kits get per-site robots. Old kits still pull the old digest from `fedlify-studies`; a site that wants the new image needs a new kit (a kit pins the digest it was built for).

Phase C, retire the global credential: when `SELECT count(*) FROM "SiteJoinPackage" WHERE status='ACTIVE' AND "imageDigest" LIKE '%/fedlify-studies/%'` is 0 and no aggregator still uses the global secret, remove `harbor_robot_account.fedlify_studies_pull` and the `harbor-studies-pull` secret, and empty `fedlify-studies`. Until then it stays. Removing it earlier breaks every old kit.

Rollback:
- Flip `FEDLIFY_REGISTRY_MODE` back to `legacy`: new publishes go to `fedlify-studies` again. Studies already published per-study keep working, because the kit route chooses by the deployment's image path, not by the flag. They need the provisioner for new kits.
- If the provisioner or Harbor misbehaves: per-study kit creation returns 502 and changes nothing; existing kits and aggregators are unaffected. The documented emergency path is to republish that study in legacy mode.
- Schema: additive only; no revert needed. Drop nothing.
- Terraform: new resources can be destroyed with the same `-target` list in reverse (`terraform destroy -target=...`, not run here). Destroying the public project requires `force_destroy` or an empty project.

### 15.9 Live checks (unverified until run)

Run once, against a throwaway project named `fedlify-s-zz-test`, with a human present. None was run.
1. Provisioner robot can create the project, set `storage_limit`, create a retention policy, create and delete a project robot. If quota or delete fails, use admin-credentialed CronJob for just those calls (15.4 item 4).
2. Provisioner robot cannot read or push images in any project, and cannot see hivelab/lab-sites repositories.
3. **Escalation test:** with the provisioner, try to create a robot with pull on a project the provisioner has no repository permission on. If it succeeds, treat the credential as able to read all projects and apply fallback 15.4 item 3. If it fails with "permission" it means Harbor enforces subset and the provisioner needs repository pull and push on `*`, which is worse (it could read other teams' images); then use the non-admin-user fallback instead.
4. A site robot with pull only: `docker pull` works, `docker push` and pulls from `fedlify-studies` fail.
5. Robot with `duration` expires and then fails to pull.
6. The `robot$name` string works through the runner's `docker login --password-stdin`.
7. Anonymous pull from `fedlify-public` works and anonymous pull from a study project fails.
8. Robot create response is the only place the secret appears; the list API does not return it.
9. Whether `harbor_robot_account` with namespace `*` and the system-level project permission is accepted by Harbor v2.15.2 and by provider 3.11.3 (schema and API both).

### 15.10 Terraform (to be written in `IaC/day1/cicd/fedlify.tf`; nothing applied)

Resources to add: `harbor_project.fedlify_public` (public), `harbor_robot_account.fedlify_provisioner` (system level, permissions per the provisioner table in 15.4), `harbor_robot_account.fedlify_helper_push` (project level on `fedlify-public`), a standalone `kubernetes_secret_v1.harbor_provisioner` (keys registry, url, username, password; its own resource, not an entry of `local.fedlify_secrets`, so a targeted apply does not depend on the Gitea token, the studies-pull robot or the random passwords), and a sensitive output for the helper-push secret. Variables get a `public_harbor_project` default `fedlify-public`.

Exact target list, so that cert-manager and Harbor upgrade drift is not touched:
```
terraform apply \
  -target=harbor_project.fedlify_public \
  -target=harbor_robot_account.fedlify_provisioner \
  -target=harbor_robot_account.fedlify_helper_push \
  -target=kubernetes_secret_v1.harbor_provisioner
```
Always run `terraform plan` with the same targets first and read it: the plan must show exactly 4 creates (public project, helper-push robot, provisioner robot, `kubernetes_secret_v1.harbor_provisioner`; the namespace is only refreshed) and nothing to change or replace. `terraform graph` shows the Secret depends only on the provisioner robot and the namespace. Targeting pulls in resources these depend on (the provider config, `kubernetes_namespace_v1.fedlify`); if the plan lists anything else, stop. The robot secrets will exist in Terraform state, as `studies-pull` already does. `fedlify-mirror` is not in the list; if it is not yet in state, import it separately.

### 15.11 Failure modes

| Failure | Result |
|---|---|
| Harbor down at kit creation | 502 `registry_unavailable`, nothing changed, previous kit, token and robot valid |
| Harbor create succeeds, encryption busy or upload fails or transaction fails | new robot deleted at once; if delete fails, row stays `PENDING`/`REVOKING` and the sweeper deletes it; robot expiry bounds it |
| Harbor down after commit | new kit works; old robot stays valid until retry; response says `registry: "pending"`; audit `delete_failed` |
| Web pod dies between robot create and DB update | `PENDING` row exists first, so the sweeper finds it by name even without a Harbor id |
| Two kit creations race for one site | last commit wins, as for packages; the other robot becomes `REVOKING` |
| Project name already exists, not ours | publish fails closed with a clear error |
| Push robot leak | 1-day expiry, push on one project, deleted at workflow exit |
| Provisioner credential stolen | see the honest limit in 15.4; rotate through Terraform, review `registry.robot.*` audit events and Harbor's robot list |
| Quota full | publish push fails with a Harbor error; retention frees tags after the next policy run; raise the variable for that study |
| Provisioner missing in `per-study` mode | publish fails at `ensure-project` before building; legacy mode still works |

### 15.12 Rejected alternatives

- **Per-repository robots in one project.** Impossible in Harbor (15.3).
- **Per-site-and-study project.** One robot per StudySite is already isolated; a project per pair multiplies projects, quotas and retention policies for no gain.
- **Global pull robot with rotation.** Shrinks the exposure window only; every kit still holds a credential good for every study.
- **Harbor admin or admin-like user inside the web pod.** One web bug would delete any team's projects.
- **Pre-creating projects with Terraform.** Studies are created at runtime; this would put application data into infrastructure state.
- **Kit-embedded image tarball (`docker save`).** No credential at all, but kits become gigabytes and cannot update. Rejected for size; worth keeping for air-gapped sites.
- **A Fedlify token service in front of the registry** (Distribution token auth with per-repo, per-hour tokens). True repository scoping, but a new internet-facing component to build and run. Upgrade path if per-study projects prove too coarse; not now.
- **No expiry on site robots.** A forgotten kit would be a permanent credential.
- **Falling back to the global credential when Harbor is down.** Would silently reintroduce the shared secret.

### 15.13 Tests that must fail if behaviour breaks (to be written with the code)

- Harbor client: project-name guard rejects `hivelab-*` and `fedlify-studies` in per-study mode; permission template sent is exactly pull for site robots and push+pull for push robots; expiry is set; the request body never includes a repository pattern.
- Kit route: Harbor create failure returns 502 and leaves token hash, packages and robots unchanged; upload failure deletes the new robot; transaction failure deletes the new robot; busy encryption mints no robot; no storage mints no robot; legacy digest mints no robot and uses the global credential; per-study digest with Harbor down never uses the global credential; the secret appears only inside the encrypted inner kit input and in no audit row, log call, DB write or response field.
- Lifecycle: rotation marks old robots `REVOKING` and deletes after commit; delete failure keeps `REVOKING` and reports `registry: "pending"`; site removal and study retirement revoke; sweeper deletes stale `PENDING`, retries `REVOKING`, flags unknown robot names.
- Revocation label: remains partial while the certificate is not re-issued.
- Publish template (static YAML test): no `harbor-registry-credentials` reference in the publish workflow; push robot step precedes build; exit handler deletes the push robot.
- Terraform (static): the robot resources exist with the expected permissions, no `repository` access on the provisioner, `fedlify_public` is public.
- Migration test: SQL only adds tables and enum types.

### 15.14 Open risks

1. 15.3(a) escalation is unknown and decides whether the provisioner design is acceptable. Until tested, assume the credential is powerful on the whole Harbor.
2. The shared Harbor means a Terraform or Harbor admin mistake by another team can still affect Fedlify; the Harbor upgrade drift in day1 may change robot API behaviour.
3. 90-day robot expiry is a guess and can strand a site that never updates its kit.
4. 20 GiB quota and retention of 10 are guesses; the base image size is unmeasured.
5. Two Harbor clients (TypeScript and Python) must stay in step; the contract tests above are the control.
6. The orphan sweeper depends on a CronJob that does not exist yet.
7. Old kits remain valid for their old digest until phase C, so the shared credential persists for existing studies for the whole migration.
8. Certificate revocation is still not done, so the "partial" label stays.
9. Operators must be told robot names contain `$`; a runner or script that interpolates it unquoted will fail to log in.

### 15.15 Implementation notes (2026-11-05, working tree only)

**What exists.** `apps/web/src/lib/harbor-registry.ts` (the only Harbor client, name guard, permission templates), `lib/registry-access.ts` (project ensure, robot mint, rotation, revoke, sweeper), additive migration `20261109090000_registry_projects`, kit route, publish route, `agent.ts` workflow parameters, study archive and site-disable hooks, `POST /api/webhooks/registry-sweep` plus `deploy/k8s/registry-sweeper.yaml`, `fedlify_runtime/harbor.py` (Python twin for the workflow), the publish workflow template, Terraform in `IaC/day1/cicd/fedlify.tf`, and `scripts/release-helper-image.sh`.

**Where it differs from the design above, and why.**
1. **Project creation is in the web app, not the workflow.** The publish route calls `ensureStudyRegistryProject` before it records a version or submits Argo. It writes the `RegistryProject` row first and then calls Harbor, so a crash cannot leave a project that Fedlify does not recognise as its own; a 409 for a project with no record fails closed and removes the row it just wrote. The workflow only mints and deletes robots. Result: the workflow no longer needs project-create logic and a conflict stops the publish before anything is built.
2. **Revocation response keeps `revocation: "partial"` and adds `revocationDetail: { token, registry, certificate }`** instead of replacing the string, so nothing that reads the old field breaks. The label stays "partial" because `certificate` is `not_reissued`; `registry` is `revoked`, `pending` (Harbor delete failed, sweeper retries) or `not_applicable` (legacy study).
3. **The `active` tag moves at build time**, as a second kaniko destination. Harbor tagging after success needs a tag permission the provisioner deliberately lacks. Consequence: a publish that fails after the push leaves `active` on an unpublished image. The last N pushed tags are still kept, so a running image is not lost unless more than N builds fail in a row.
4. **The provisioner has no `quota` permission.** Add it only if live check 1 shows Harbor refuses `storage_limit` at project creation. Project deletion is not granted either: retired projects are marked `RETIRED`, never deleted, and the 30-day deletion grace is not implemented.
5. **Site removal** has no route in this tree. The hooks are: an administrator setting a site to `DISABLED` (heartbeat route), study archive, kit rotation, and the sweeper. If a removal route is added it must call `revokeSiteRegistryAccess`.
6. **The legacy path keeps one admin reference**, in the template `legacy-push-credential` only, so a flag flip back to `legacy` still works. It is removed at phase C. The per-study templates reference only `harbor-provisioner`.
7. **The sweeper's `registry.robot.unexpected` audit repeats every run** for a robot nobody removes. Delete or rename the robot to stop it.
8. **Workflow-made robots are named `push-<ciRunId>` and `agg-<ciRunId>`.** The mint steps delete a same-named robot first, so a retried run does not hit a duplicate-name error.

**Configuration (web deployment).** `FEDLIFY_REGISTRY_MODE` (ships as `legacy`), `FEDLIFY_STUDY_PROJECT_QUOTA_GIB` 20, `FEDLIFY_STUDY_RETENTION_KEEP` 10, `FEDLIFY_SITE_ROBOT_DAYS` 90, and `FEDLIFY_HARBOR_URL`, `FEDLIFY_HARBOR_PROVISIONER_USERNAME`, `FEDLIFY_HARBOR_PROVISIONER_PASSWORD` from secret `harbor-provisioner` with `optional: true`, so web starts before Terraform is applied.

**Deploy order.** Each step is safe to stop after.
1. Terraform, targeted (15.10): plan with the same `-target` list first and stop if it lists anything beyond the four new resources and their already-applied dependencies. Then apply the same list.
2. Run the live checks in 15.9 against a throwaway project `fedlify-s-zz-test`, by hand. Do not continue if the escalation check (3) shows the credential can mint robots for projects it cannot read.
3. Build and push a new base image that contains `fedlify_runtime/harbor.py` (the CronJob and per-study workflow use it), then set the template's `base-image` and the CronJob `image` to that tag. Until then keep the mode `legacy`.
4. Build and deploy the web image (the `migrate` initContainer applies the additive migration), apply `deploy/k8s` (workflow template, web deployment, sweeper). Behaviour is unchanged in `legacy` mode.
5. Publish a throwaway study with `FEDLIFY_REGISTRY_MODE=per-study`, create a kit, pull with the robot, check anonymous pull fails and that a kit rotation deletes the old robot.
6. Run `scripts/release-helper-image.sh`, put the printed reference in `FEDLIFY_HELPER_IMAGE`, redeploy web.
7. Phase B and C as in 15.8.

**Rollback.** Set `FEDLIFY_REGISTRY_MODE=legacy` (new publishes return to `fedlify-studies`); studies already in their own project keep minting robots for new kits because the kit route follows the image path. Suspend the sweeper with `kubectl -n fedlify patch cronjob registry-sweeper -p '{"spec":{"suspend":true}}'`. Terraform resources can be removed with the same targets under `terraform destroy`. The migration is additive and needs no revert.

**Tests.** `tests/harbor-registry.test.ts`, `registry-access.test.ts`, `join-package-registry.test.ts`, `publish-registry.test.ts`, `registry-sweep-route.test.ts`, `registry-model-static.test.ts` (workflow, Terraform, migration, deployment and release-script checks), and `deploy/images/tests/test_harbor.py`. Harbor itself is faked in all of them: they prove our request shapes, ordering and failure handling, not Harbor's behaviour.


### 15.13 Review follow-ups (what changed and what is still open)

Fixed: robot lists follow pages (TS and Python); the sweeper deletes expired robots and, for a RETIRED project, every leftover `agg-`/`push-`/`site-` robot; the sweeper reads live rows after the Harbor list (closes the just-minted race); project creation keeps its record on a timeout or 5xx and survives a concurrent first publish; archive then reactivate re-activates the project (kit creation works again; the study still needs a republish for a new aggregator robot); the aggregator pull secret is written to `harbor-registry-study`, so the existing `harbor-registry` secret is never replaced and a failed publish does not break a running legacy aggregator; workflow `when` values are quoted; the kaniko push config is removed by a shell trap even when the build fails.

Open, not fixable from this tree:
- The provisioner's project permissions are on namespace `*` (every project on the shared Harbor). Escalation behaviour is unconfirmed until 15.9 item 3.
- Retention keeps the newest K pushed tags per repository. A kit pins a digest; a site that keeps an old kit while the study is republished K or more times can lose its image. Raise `FEDLIFY_STUDY_RETENTION_KEEP` for long-lived sites, or issue the site a new kit. Quota and retention are applied at project creation only; changing the variables does not reach existing projects.
- Expiry: site robots last 90 days, aggregator robots 365. Nothing warns or renews. The sweeper only cleans up expired robots; a site must download a new kit.
- A study's `<Dockerfile>` build can read the push config while the build runs (limited to one project, 1-day expiry, deleted at exit).

### 15.16 Provisioner result from the live check (supersedes the provisioner robot above)

Live result on Harbor v2.15.2: a robot cannot create a robot with more rights than it holds. The provisioner robot could not mint pull or push robots, and giving it those rights would have meant image pull and push on every project on the shared Harbor, including hivelab and lab-sites.

Decision: the provisioner is a plain non-admin Harbor user, `fedlify-provisioner`. Harbor already has `project_creation_restriction = everyone` and self-registration off, so no shared setting changes. Terraform does not manage those settings; if someone restricts project creation to admins, publishing in per-study mode stops with a Harbor error. Where earlier sections of section 15 describe a provisioner robot, read this user instead.


## 16. Assistant threads, plan mode and changes timeline (WP5, 2026-11-06)

**Switch.** `AGENT_THREADS_ENABLED` (read in `src/lib/runtime-config.ts`) is set to `"true"` in `deploy/k8s/web-deployment.yaml`. Unset or false restores today's behaviour: every `agent/threads/**` route and `agent/timeline` answers 404 `threads_disabled`; `agent/messages` and `agent/proposals` take the old stateless path (the new optional `threadId`, `planId`, `clientTurnId` fields are ignored); the panel's thread probe fails and it shows Ask and Edit only.

**Decisions.** Chat is kept until the project is deleted (threads can be archived; the panel shows a notice). The author and a user with manage rights can read a thread, the manager read-only; the audit role sees metadata only (titles redacted). The direct "Propose change" path stays, renamed "Edit".

**Data.** Threads, turns (MESSAGE, QUESTIONS, PLAN, NOTICE, PROPOSAL kinds) and plans; proposals gain `threadId`, `turnId`, `rejectedById`, `rejectedAt`. Existing proposals are linked by `scripts/backfill-agent-threads.ts` (`--dry-run`, idempotent, needs `tsx`).

**Routes** (under `/api/v1/studies/{studyId}/pipeline-projects/{projectId}/agent/`):
- `threads` GET list, POST create (`message`, `mode`); `threads/{tid}` GET, PATCH (`title`, `status`).
- `threads/{tid}/turns` POST `{message, mode: ask|plan, clientTurnId, filePath?, selection?, diagnostics?}`. Ask streams SSE; plan returns JSON, or SSE with `Accept: text/event-stream`. SSE events: the usual `fedlify.context`, `response.output_text.delta`, `fedlify.notice`, `fedlify.error`, `fedlify.done`, plus `fedlify.turn`, `fedlify.questions`, `fedlify.plan`.
- `threads/{tid}/answers` POST; `threads/{tid}/plans/{pid}/decision` POST (author only); `threads/{tid}/plans/{pid}/code` POST.
- `timeline` GET `?cursor&kind=all|agent|manual|published&limit`, or `?commit=<sha>` for one commit's before/after files.

**Rules.** Nothing is written to the repository by planning. Code is only written after plan approval, and accepting the diff stays a separate step. A thread in plan or agent mode refuses a proposal without an approved `planId` (409 `plan_not_approved`). Audit metadata never contains message text. Accepted commits carry the `Fedlify-Agent-Proposal: <id>` trailer, which the timeline uses to match commits to proposals.

**Known gaps.** Manual commits have no read-only compare view in the UI yet; "Save to study requirements" is not wired; selections sent from the editor use placeholder line numbers; nothing was run against a live Gitea, database or browser, so the Gitea `stats`/`files` fields are assumed.

**Tests.** `agent-plan`, `agent-threads-route`, `agent-thread-turns-route`, `agent-plan-routes`, `agent-timeline`, `agent-backfill`, `gitea-commits`, `agent-thread-client`.

## Plain-language vocabulary and enforcement

Readers are clinical PIs and hospital staff. One plain term per concept, sentence case. Technical values (commit hash, image digest, NVFLARE names, ids, storage keys, raw action keys) appear only inside a Details disclosure or a tooltip/title, never as the main label.

| Concept | Use | Never show as primary text |
|---|---|---|
| NVFLARE aggregator / deployment | Study server | aggregator, NVFLARE deployment, Compose project |
| SiteJoinPackage | Site kit | startup kit, join package, kit release |
| PipelineProject | Pipeline ("New pipeline") | project, source workspace |
| PipelineVersion | Pipeline version (v3) | commit hash in a button or headline |
| Save to the repo | Save | Save to main, commit to main |
| Site software | Runner: Connected / Not connected / Not reporting | agent, heartbeat, NVFLARE client |
| StudySite | Site | participant site, participating site, client |
| NVFLARE client name | Site ID (inside Details only) | NVFLARE client |
| Automatic facts from the runner | Site checks | readiness check, machine evidence |
| Human confirmation by the site | Site sign-off | attestation, activation |
| The 29 requirements | Study questions | requirements chat |
| Image the sites run | Code version (Up to date / Needs update) | study image, digest, sha256 |
| NvflareJob | Run | job, federated run |
| ModelRelease | Model release | release for anything else |
| Gitea | repository ("Open repository") | Gitea |

Shared code: `apps/web/src/lib/terms.ts` (`TERMS`, `statusLabel`, `roleLabel`, `auditActionLabel`) and `apps/web/src/components/Details.tsx`. Status enums, roles and audit keys are never shown raw.

Enforcement tests:
- `tests/terms.test.ts`: every status enum value, role and audit action key has a label; no label contains a banned word.
- `tests/terms-lint.test.ts`: scans user-visible strings in the covered files and fails if a banned term is used more often than `tests/terms-allowlist.json` allows. The list can only shrink; after removing terms run `npm run terms:allowlist` in `apps/web`.

## Pre-flight checks and the next step (2026-11-10)

Two shared computations keep the Summary page and the Code & run page saying the same thing.

**Pre-flight** (`src/lib/preflight.ts`, `evaluatePreflight(kind, snapshot)`): for `publish` or `run` it returns a list of plain-language items, each ticked or not, with a detail sentence, an owner (study team, the site, automatic) and a "Fix" link. Publish checks the ethics decision (including its expiry date), study questions, sites, saved code and that no publish or run is in progress. Run checks ethics, sites, the published pipeline, the study server, and for each site its sign-off, connection and code version. `src/lib/preflight-data.ts` loads the data; `GET /api/v1/studies/{id}/preflight?kind=publish|run` serves it. The Publish and Start run routes use the same function and return the items in `error.details.items` on a 409, so a late failure shows the same checklist.

**Next step** (`src/lib/next-step.ts`, `resolveStudySteps`): maps the study onto the six phases (Authorize, Prepare, Approve, Deploy, Execute, Validate), gives each a status phrase and tone, picks the current one, and attaches the failing pre-flight items as blockers and one permission-aware action. `GET /api/v1/studies/{id}/next-step` serves it.

**Where shown:** the Summary page ("Next step" card and six-step list) and the Publish and Start run panels of Code & run ("Before you publish", "Before you start", and the "N things to fix" rail text). Both render items with `components/PreflightChecklist.tsx`.

## Site invitations, My site and plain roles (2026-11-12)

Problem: hospital staff could not get into their own site. Nothing assigned a site role, the study list showed only studies the person belonged to, and buttons led to "forbidden".

**Site invitations.** A study lead (study permission `manageSites`) invites one person to ONE site: Team or Sites tab, "Invite site contact" (POST `/api/v1/studies/[studyId]/invitations` with `studySiteId`). The invitation stores `studySiteId` and `siteRoles` (default SITE_ADMIN + SITE_PI, shown as "Site contact"). Accepting it creates only SiteMember rows for that site: no study membership and no organisation membership, so there is no path from a site role to study access. Study-role invitations still go through `assertCanGrantRoles`.

**My site.** `GET /api/v1/me` returns `sites` and `landing` (`landingFor` in `lib/landing.ts`). A person with a site and no real study (an untouched default study is ignored) lands on `/my-site`. One site redirects straight to the site page; several show a list. The sidebar shows only "My site" for such people, study URLs redirect to `/my-site`, and an unaccepted site invitation sends them to `/my-site` where the invitation card is shown. The site page has four tabs: Get site kit, Your data, Sign-off, Activity, plus a collapsed "Having problems?" area.

**Plain roles.** `lib/plain-roles.ts`: Study lead, Researcher, Approver, Site contact, Observer, mapped onto the detailed roles, which stay under "Advanced". Site contact is SiteMember SITE_ADMIN + SITE_PI with no StudyMember row.

**Permissions hook.** `lib/use-permissions.ts`: `useStudyPermissions(studyId)` and `useSitePermissions(siteId)` read `GET /api/v1/studies/[id]/permissions` and `GET /api/v1/sites/[id]/permissions` (never 403; `can` is empty while loading, so buttons start disabled). The site answer also gives `backHref`. Screens show a button only when `can.x` is true. The Refine access control provider is now default-deny.

**Known limits.** No invitation revoke and no study-member remove routes yet. Activity shows other actors as "Someone on the study team" until the site route includes actor names. Role grants a coordinator cannot make are rejected by the server rather than disabled up front.
