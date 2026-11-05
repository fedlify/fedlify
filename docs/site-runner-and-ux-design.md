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
