# Save → Publish → Run: setup and test runbook

How a study goes from code to a real federated run, how to set it up on the cluster once, and how to test it.

```
Template repo (fedlify-templates/fedlify-starter)
   │  "New project" clones it into the study's Gitea org
   ▼
Project repo ──Save──► one commit per save (author = researcher)
   │
Publish (approvePipeline + ethics + 29 requirements)
   │  tag v<N> → Argo "fedlify-study-publish":
   │    validate + unit tests → kaniko build harbor.fedlify.com/fedlify-studies/<slug>@sha256
   │    → NVFLARE kits for <slug>.fedlify.com (server/admin → Secret, clients → S3)
   │    → studies/<slug>/ in fedlify-gitops → Argo CD (ApplicationSet fedlify-studies)
   ▼
Aggregator pod in study-<slug>: nvflare-server + flare-adapter sidecar
   ▲  Ingress ssl-passthrough, routed by SNI; DNS <slug>.fedlify.com → 206.12.103.4 (not proxied)
   │
Hospitals: site kit = client certs + compose pinned to the image digest + data mounted read-only
   ./fedlify-runner.sh start  → outbound TLS to <slug>.fedlify.com:443
   ▼
Start run (rounds, min sites) → live per-round metrics → Save model → model release
```

The web page for all of this is **Study → Code, publish & run** (`/studies/<id>/projects`).

## 1. Local end-to-end test (no cluster)

```sh
pnpm publish:local-e2e        # or: deploy/local-e2e/run.sh [study-repo-dir] [rounds]
pnpm publish:local-e2e:down
```

This runs the production topology in Docker:
- an nginx SNI router standing in for ingress-nginx passthrough;
- the aggregator and adapter on an internal network;
- two hospitals that only know `hf-mortality.fedlify.test:443`, each with its own eICU partition.

It uses the same base image, validator, Dockerfile and provisioner as the publish workflow. Expected result: `FINISHED:COMPLETED`, with validation AUROC rising from 0.50 to about 0.96 (site_a) and 0.89 (site_b) after 3 rounds.

## 2. Cluster setup (install order: day0 → day1 → day2)

Credentials are created at install time, so no stage needs secrets typed by hand. Everything runs through `IaC/tools/deploy-fedlify.sh`, and every Terraform step shows its plan and waits for `yes`.

| Layer | What it sets up for Fedlify | Where |
|---|---|---|
| day0 | ingress-nginx `--enable-ssl-passthrough` (`<slug>.fedlify.com:443` → aggregator, routed by SNI) | `day0/prod/kubespray/.../extra-vars.yml` |
| day1 | Namespace `fedlify`, the Gitea automation token, and generated credentials: webhook, orchestrator, control signing, adapter signing, NextAuth, Postgres, MinIO. Also the Harbor `fedlify-studies` project and read-only robot, and all Secrets in `fedlify`. | `day1/cicd/fedlify.tf` |
| day2 | GitOps `platform` path ← `fedlify/deploy/k8s` (web, orchestrator, PostgreSQL, MinIO, publish workflow), plus the `fedlify-studies` ApplicationSet. It reads the Gitea token from day1's Secret. | `day2/github-fedlify` |

```sh
cd IaC
tools/migrate-fedlify-to-day1.sh      # existing clusters only, once: moves namespace + 3 Secrets from day2 to day1 state
tools/deploy-fedlify.sh day1          # scoped to fedlify.tf
tools/deploy-fedlify.sh images        # if the release images are not in Harbor yet
tools/deploy-fedlify.sh day2
tools/deploy-fedlify.sh status
tools/deploy-fedlify.sh seed          # starter template repo in Gitea
tools/deploy-fedlify.sh passthrough   # until day0 kubespray is re-run with the new extra-vars
```

- **OpenAI key.** The day1 apply generates fresh values for the orchestrator Secret. Set `fedlify_openai_api_key` in `day1/cicd/terraform.tfvars` first, or the agent runs without an OpenAI key.
- **Unrelated day1 drift.** A full (non-targeted) day1 plan currently also shows changes that have nothing to do with Fedlify: it would create the cert-manager Helm release and update external-dns and the Harbor and Argo Helm values. Review those separately.

## 3. End-to-end test on the cluster

| Step | Action | Expected |
|---|---|---|
| 1 | Study with ethics approved, the 29 requirements answered, and 2 sites. Open **Code, publish & run** → **New project**. | A repo appears in the study's Gitea org with the starter files. |
| 2 | Edit `fedlify-pipeline.json` (e.g. `localEpochs`) in the editor → Save. | A new commit in Gitea, authored by you. A second tab saving from the old commit gets "reload before saving" (409). |
| 3 | **Publish**. | v1 shows QUEUED → RUNNING → PASSED. The Argo workflow `fedlify-publish-<slug>-*` is green. `studies/<slug>/` appears in fedlify-gitops. Argo CD app `study-<slug>` is Healthy. |
| 4 | `dig +short <slug>.fedlify.com`; `openssl s_client -connect <slug>.fedlify.com:443 -servername <slug>.fedlify.com </dev/null \| openssl x509 -noout -subject -issuer` | `206.12.103.4`. The certificate subject is `CN=<slug>.fedlify.com`, **issued by the study's NVFLARE root CA**, not Let's Encrypt. That proves passthrough. |
| 5 | On each site page: **Release kit**. On two machines outside the cluster: unzip, put the site's CSV in `data/` (`deploy/local-e2e/data/site_*/extract.csv` works), run `FEDLIFY_SITE_TOKEN=<token> ./fedlify-runner.sh start`. | Within about a minute the Sites table shows both as **connected**. The aggregator reports this itself; it isn't based on site heartbeats. |
| 6 | **Start run** with 3 rounds. | Status goes SUBMITTED → RUNNING → COMPLETED. The Round table fills in per-site and weighted AUROC. |
| 7 | **Save model**. | The model is saved and the existing model-release flow is available. |
| 8 | Edit and save again → **Publish** (v2). On a site, run `./fedlify-runner.sh update`. | The aggregator restarts on the v2 digest. The Kit column shows "update available" until the site updates. Kits and tokens stay valid. |

## 4. Troubleshooting

| Symptom | Check |
|---|---|
| Publish fails at `clone-validate` | The workflow log lists each problem: data files, credentials, unpinned requirements, launcher path or failing tests. |
| `wait-ready` keeps retrying | `kubectl -n argocd get app study-<slug>`; `kubectl -n study-<slug> describe pod -l app.kubernetes.io/name=fedlify-aggregator` (image pull secret, PVC). |
| openssl shows a Let's Encrypt or default certificate | ssl-passthrough isn't enabled on the controller (step 2.1), or the record is proxied by Cloudflare. |
| Site logs `Failed to get engine` / cannot connect | `nslookup <slug>.fedlify.com` from the site, and check that the site firewall allows outbound 443. |
| "site joined after the last publish" | Republish. Kits are re-issued when the site list changes, and existing sites need a new kit too. |
| Run fails with `EXECUTION_EXCEPTION` | `./fedlify-runner.sh logs` at a site shows the `client.py` traceback (for example, contract columns missing from that site's extract). |

## 5. Known limits and next steps

- **Coding agent.** The chat agent doesn't yet write into project repos. It should edit files and use the same Save route, so its changes become commits.
- **Kit re-issue.** Adding or removing a site re-provisions the kits, and every site must download a new kit.
- **Registry access.** One read-only robot pulls all study images. A per-study robot would stop a site from pulling another study's image, though images contain code only.
- **Publisher permissions.** The `fedlify-study-publisher` ClusterRole can create Secrets in any namespace. Tighten it with an admission policy limited to `study-*`.
- **Windows sites.** The published-kit runner is bash only; Windows sites use WSL.
- **Old paths.** The legacy agent page (`/studies/[id]/pipeline-agent`) now redirects to the study's Projects page, and `POST pipeline/quick-deploy` returns 410. The old local-docker deployment, the template catalog and authoring routes, the control-plane, the probe and evaluation code, and the old DB models are kept: probe specs and the paper evaluation use them. They are no longer reachable from the study UI, and they still use the synthetic smoke job.
