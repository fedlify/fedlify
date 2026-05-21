# Two-Site Fedlify Study Tutorial

This tutorial walks through a simple three-person Fedlify workflow:

- Study coordinator: creates the study, invites sites, approves the pipeline version, starts the aggregator, submits the federated run, and reviews logs.
- Site operator 1: joins the study for Site 1 and starts the local site runner.
- Site operator 2: joins the study for Site 2 and starts the local site runner.

The goal is to run a governed two-site NVFLARE smoke experiment without raw clinical data leaving the sites.

## What You Will Produce

By the end, Fedlify should show:

- One active governed study.
- Two participant sites with readiness `Passed`.
- One approved pipeline version backed by a Gitea commit and draft PR.
- One active NVFLARE aggregator address, for example `localhost:18000`.
- One completed federated run with runtime events and Docker logs.

## Local Prerequisites

Run these from the Fedlify repository:

```sh
pnpm install
pnpm fresh:start
```

Open Fedlify at:

```text
http://localhost:3000
```

For a live local NVFLARE run, also start the FLARE API adapter:

```sh
/opt/homebrew/opt/python@3.9/bin/python3.9 services/flare-api-adapter/fedlify_flare_api_adapter.py
```

The app expects the local NVFLARE Docker image:

```sh
docker image inspect fedlify-nvflare:2.6.2
```

## Fresh Reset Before Testing

Use this command when you want a clean app state but want the base Docker services available for the next test:

```sh
pnpm fresh:test
```

It performs a local test cleanup:

- Stops the Next.js dev server on port `3000`.
- Stops the local FLARE API adapter on port `3010`.
- Stops Fedlify runtime Docker Compose projects, including aggregator and site runner projects.
- Deletes generated per-study Gitea orgs that start with `fedlify-study-`.
- Removes local runtime/output folders.
- Resets the Prisma database with migrations.
- Keeps base Docker services such as Postgres, MinIO, Mailpit, and Gitea running.

Use this command when you want to clean the data and stop the full base Docker stack too:

```sh
pnpm fresh:down
```

After `pnpm fresh:down`, start services again before testing:

```sh
pnpm fresh:start
```

## Roles

Use three people or three test accounts:

| Person | Fedlify responsibility | Suggested role |
| --- | --- | --- |
| Study coordinator | Owns study setup, approvals, and run submission | Principal Investigator or Study Coordinator |
| Site operator 1 | Runs Site 1 local kit and accepts local readiness | Site Admin or Site Engineer |
| Site operator 2 | Runs Site 2 local kit and accepts local readiness | Site Admin or Site Engineer |

For a local smoke test, one browser login can do all steps. For a realistic demo, use separate accounts and invitations.

## Step 1: Coordinator Creates the Study

1. Open `http://localhost:3000/register`.
2. Create the coordinator account.
3. Sign in and open the study workspace.
4. Go to `Protocol`.
5. Fill the protocol metadata:
   - Study title.
   - Goal.
   - Research question.
   - Clinical use case, such as `Risk prediction`.
   - Population.
   - Data modalities, such as `Structured EHR` and `Labs`.
   - Primary outcome.
   - Risk level.
   - Intended use, such as `Research only`.
6. Add an ethics record:
   - Status: `Approved` or `Not required`.
   - Approval number or local review reference.
   - Approving body.
7. Save and activate the study after the protocol gate passes.

The study should now show protocol status as approved or ready for runtime provisioning.

## Step 2: Coordinator Adds Two Sites

1. Go to `Sites & Data`.
2. Create Site 1:
   - Site name, for example `Site 1`.
   - Institution, for example `Hospital A`.
   - Site PI.
   - Data profile with cohort-level metadata only.
   - Resource profile, such as CPU, RAM, storage, and Docker/runtime notes.
3. Create Site 2 with the same fields.
4. Confirm both site cards appear in the list.

Do not upload raw patient data, extracts, CSV files, parquet files, or identifiers. Fedlify should only store governance and cohort-level metadata.

## Step 3: Coordinator Invites the Site Operators

1. Go to `Team & Access`.
2. Add or invite Site Operator 1.
3. Add or invite Site Operator 2.
4. Assign site-scoped responsibilities from each site detail page when available:
   - `SITE_ADMIN` for operational ownership.
   - `SITE_ENGINEER` for running the local kit.
   - `SITE_DATA_STEWARD` for data profile and local policy.

If a person has multiple roles, keep them as one person with multiple role chips rather than duplicate cards.

## Step 4: Coordinator Creates a Pipeline Version

1. Go to `Pipeline`.
2. Open `Template sources`.
3. Choose an approved public or study template, for example `NVFLARE Cross-silo FedAvg`.
4. Review the template source if needed.
5. Select `Create pipeline version`.
6. Provide a short request, for example:

```text
Create a two-site synthetic NVFLARE smoke pipeline. Keep site count configurable from selected sites, set one federated round for the smoke run, preserve site-local data boundaries, and include README/tests for reviewer inspection.
```

7. Submit the request.
8. Fedlify creates:
   - A Gitea repository in the study Gitea org.
   - A proposal branch.
   - A draft PR.
   - An immutable pipeline version record tied to a Git commit.
   - A validation record.

## Step 5: Coordinator Reviews and Approves the Pipeline Version

1. Stay in `Pipeline`.
2. Open the new pipeline version.
3. Review:
   - Source template.
   - Gitea PR.
   - Git commit.
   - Validation status.
   - Runtime parameters such as `min_clients` and `num_rounds`.
4. If changes are needed, use code review or AI-assisted review to create another draft PR.
5. When validation passes, approve the pipeline version for study use.

Approval means the commit is runnable for this study. It does not publish a reusable public template.

## Step 6: Coordinator Provisions and Starts the Aggregator

1. Go to `Run`.
2. Open the `Aggregator` tab.
3. Select `Provision deployment`.
4. Fedlify runs NVFLARE provisioning and records:
   - Server startup kit.
   - Admin startup kit.
   - Site startup kit paths.
   - Aggregator address.
5. Select `Start aggregator`.
6. Confirm the deployment is `Active`.

The run page should show an address like:

```text
localhost:18000
```

This address is included in each site startup kit.

## Step 7: Each Site Operator Downloads and Starts the Site Kit

Each site operator performs these steps for their own site.

1. Open the site detail page from `Sites & Data`.
2. Open the `Startup kit` tab.
3. Select `Download startup kit`.
4. Copy the one-time enrollment token shown in Fedlify.
5. Extract the downloaded zip on the site machine.
6. From the extracted folder, run:

```sh
chmod +x fedlify-runner.sh
FEDLIFY_SITE_TOKEN=<token-from-fedlify> ./fedlify-runner.sh start --safe
```

The runner:

- Writes the token into `.env`.
- Checks Docker and Docker Compose.
- Starts the Fedlify heartbeat sidecar.
- Starts the NVFLARE client from the site-specific startup kit.

Useful site commands:

```sh
./fedlify-runner.sh doctor
./fedlify-runner.sh logs
./fedlify-runner.sh stop
```

Site operators should not place raw clinical data inside the startup kit directory. Local data connectors or local paths should remain site-local.

## Step 8: Coordinator Confirms Site Readiness

Back in Fedlify, the coordinator checks `Run` or each site detail page:

1. Confirm both sites have recent heartbeat status `Connected`.
2. Confirm each site has:
   - Kit downloaded.
   - Kit installed.
   - Dependencies verified.
   - Local policy accepted.
3. Mark readiness as passed only after the site operator confirms the runner and local policy.

The run readiness checklist should show:

```text
2/2 ready
2 connected
```

## Step 9: Coordinator Submits the Federated Run

1. Go to `Run`.
2. Open `Federated runs`.
3. Select `Submit federated run`.
4. Choose the approved pipeline version.
5. Select Site 1 and Site 2.
6. Set runtime parameters:
   - `minClients`: `2`
   - `numRounds`: `1` for a smoke test.
7. Submit.

Fedlify creates an NVFLARE job and records runtime events.

## Step 10: Coordinator Reviews Logs and State

1. Open the federated run detail page.
2. Review state in this order:
   - Fedlify status.
   - NVFLARE status.
   - Selected sites.
   - Pipeline version and Git commit.
   - Runtime events.
   - Live Docker logs.
   - Training output.
3. Expected smoke-test events:

```text
SUBMITTED
STARTED
COMPLETED
```

If the run completes, the detail page should show NVFLARE status similar to:

```text
FINISHED:COMPLETED
```

## Step 11: Results and Model Release

After the run is completed:

1. Open the run detail page.
2. Select `Sync result` if a result bundle is available.
3. Confirm the aggregated model artifact, metrics, logs, and manifest are recorded.
4. Promote the synced result to a model release only if the result is ready for review.
5. Go to `Results & Releases`.
6. Review trained model releases separately from code and kit artifacts.

Pipeline versions and model releases are different:

- Pipeline version: approved code commit used to run the study.
- Model release: trained aggregate artifact produced by a completed run.

## Troubleshooting

### Gitea Repository Creation Fails

Check these environment variables:

```text
GITEA_BASE_URL
GITEA_TOKEN
GITEA_ORG
GITEA_PUBLIC_TEMPLATE_ORG
GITEA_STUDY_ORG_PREFIX
```

Per-study Gitea org names must be short enough for Gitea username rules.

### Aggregator Does Not Start

Check Docker and the NVFLARE image:

```sh
docker info
docker image inspect fedlify-nvflare:2.6.2
docker compose ps
```

Check the deployment workspace path shown in the `Run` page.

### Site Does Not Connect

On the site machine:

```sh
./fedlify-runner.sh doctor
./fedlify-runner.sh logs
```

Common causes:

- Missing or expired `FEDLIFY_SITE_TOKEN`.
- Docker is not running.
- The aggregator is not active.
- The startup kit was generated before the aggregator was provisioned.

### Run Is Blocked

Open `Run` and inspect the readiness checklist. The run requires:

- Active protocol and ethics gate.
- Approved pipeline version.
- Active aggregator.
- Selected sites with readiness passed.

### Logs Are Empty

Open the run detail page and refresh. Fedlify shows:

- Runtime events from the database.
- Live Docker logs from local containers.
- External log artifacts if a storage-backed artifact exists.

For local smoke tests, runtime events and Docker logs are usually the first visible evidence.

## Cleanup

When the demo is finished and you want to reset for another test:

```sh
pnpm fresh:test
```

To clean data and stop the base Docker services:

```sh
pnpm fresh:down
```
