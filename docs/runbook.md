# Fedlify Runbook

## Local Startup

```sh
cp .env.example .env
docker compose up -d postgres minio mailpit agent-orchestrator
pnpm install
pnpm prisma:generate
pnpm --filter @fedlify/web prisma:migrate
pnpm dev
```

Set unique values for `FEDLIFY_CONTROL_SIGNING_SECRET` and `FEDLIFY_ORCHESTRATOR_TOKEN`. Do not reuse `NEXTAUTH_SECRET`. State-changing v3 API calls require `Idempotency-Key` and `If-Match-Version` headers.

Before evaluating, verify that the exact pinned profiles are reachable. A 503 is an access/configuration failure and must not trigger fallback:

```sh
curl -fsS http://localhost:3020/ready
curl -fsS -X POST http://localhost:3020/v1/providers/preflight \
  -H "Authorization: Bearer $FEDLIFY_ORCHESTRATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profile":"hosted"}'
```

## Probe Suite

Validate the frozen suite without invoking models:

```sh
pnpm probes:validate
```

Run the real authenticated executor. It submits each case once through the production intake API and does not load expected outcomes:

```sh
LIVE_PROBE_LIFECYCLE_E2E=1 \
BLIND_PROBE_PROFILE=hosted \
LIVE_PROBE_OBSERVATIONS=../../probe-results/authoritative-hosted-r1/observations.json \
pnpm --filter @fedlify/web exec playwright test e2e/live-probe-lifecycle.spec.ts

python3 evaluation/probes/run_probes.py \
  --observations probe-results/authoritative-hosted-r1/observations.json \
  --output probe-results/authoritative-hosted-r1-scored
```

Repeat three times for `hosted` and three times for `local`, always using new output directories. Do not run the hosted benchmark unless the preflight identifies `gpt-5.6-sol` as available. Do not describe results from the earlier model-directed lifecycle simulator as authoritative E2E results.

For a deterministic case-study-bound contract replay (a harness/control-plane
conformance test, not a live model robustness claim), start:

```sh
python3 evaluation/probes/case_study_executor.py \
  --suite ../probs \
  --case-study-manifest .fedlify-evaluation/eicu-case-study/results/run_manifest.json \
  --audit-output .fedlify-evaluation/probe-contract-replay/audit.jsonl \
  --token "$FEDLIFY_PROBE_EXECUTOR_TOKEN"
```

`CONTRACT_REPLAY` results must remain labelled as such. A manuscript-grade P8
run additionally requires reachable pinned hosted and local model profiles and
a production scenario adapter; contract replay cannot substitute for it.

Never point the runner at a production study. Results are written to a new immutable directory and include `run.json`, `results.csv`, and `summary.json`.

## eICU Case Study

Validate the read-only cohort and generate the draft protocol:

```sh
mkdir -p .fedlify-evaluation/eicu-run-001
pnpm eicu:prepare -- \
  --dataset ../eicu/GenAI-Multi-Site-Collaborative-Learning-2/data/eICU/heart_failure_data_v2.csv \
  --output .fedlify-evaluation/eicu-run-001
```

The protocol must report 13,216 training stays and 1,930 external-validation stays. It remains `DRAFT_REQUIRES_EXPERT_APPROVAL`; approve its exact hash through the case-study API before creating the five NVFLARE jobs. Never mount the source CSV read-write or upload it to Fedlify.

After a six-organization E2E run emits an explicitly labelled synthetic
approval manifest, run the local horizontal-federation evaluation container:

```sh
docker build -t fedlify-eicu-case-study:dev evaluation/eicu
docker run --rm \
  -v "$EICU_DATASET_PATH:/data/heart_failure_data_v2.csv:ro" \
  -v "$PWD/.fedlify-evaluation/eicu-case-study:/outputs" \
  fedlify-eicu-case-study:dev python run_case_study.py \
    --dataset /data/heart_failure_data_v2.csv \
    --protocol /outputs/protocol/protocol.json \
    --approvals /outputs/synthetic-approvals.json \
    --output /outputs/results
```

This runner is an aggregate-only horizontal-FL simulation. Its result files
set `simulation_not_production_nvflare=true`; do not describe them as a
production multi-institutional NVFLARE execution.

## First User Flow

1. Register with email and password at `/register`.
2. Sign in at `/signin`.
3. Open `/studies`; a default study exists automatically.
4. Register participant sites.
5. Upload requirements or ethics PDFs only, not raw datasets.
6. Record ethics approval.
7. Start an agent run.
8. Approve the generated draft release.
9. Download approved artifacts from the release tab.

## Production Notes

- Store `DATABASE_URL`, Auth.js secrets, OAuth credentials, SMTP credentials, S3 credentials, `ARGO_WEBHOOK_SECRET`, `FEDLIFY_CONTROL_SIGNING_SECRET`, `FEDLIFY_ORCHESTRATOR_TOKEN`, and provider credentials in Vault.
- Set `FEDLIFY_REQUIRE_NVFLARE=true` for the agent WorkflowTemplate.
- Configure Argo artifact repository for generated kits.
- Replace `app.fedlify.local` and Harbor image names in `deploy/k8s` with the production domain and registry.
