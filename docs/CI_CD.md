# CI/CD

`.github/workflows/ci-cd.yml` verifies pull requests and, for `main`, builds
and publishes immutable image tags before changing GitOps image references.

## Required repository configuration

Set these GitHub Actions variables:

| Variable | Example |
| --- | --- |
| `HARBOR_REGISTRY` | `harbor.fedlify.com` |
| `HARBOR_PROJECT` | `fedlify` |
| `FEDLIFY_GITOPS_REPOSITORY` | `HIVE-UofT/hivelab-dynamic-gitops` |
| `FEDLIFY_GITOPS_BRANCH` | `gitops` |
| `FEDLIFY_GITOPS_PATH` | `fedlify` |

Set these Actions secrets:

| Secret | Purpose |
| --- | --- |
| `HARBOR_USERNAME` | Harbor robot-account username |
| `HARBOR_PASSWORD` | Harbor robot-account token |
| `GITOPS_TOKEN` | Fine-grained GitHub token with Contents read/write access to the GitOps repository |

The pipeline never stores credentials in Git. Images are tagged with the full
commit SHA and GitOps is updated only after every image is published. The
`branch-main` tag is retained only as a convenience tag; deployments always use
the immutable SHA tag.

## First deployment

Create the target directory in the GitOps repository from `deploy/k8s`, update
the placeholder `harbor.fedlify.local` image names, and configure Argo CD to
watch that directory and branch. After those one-time settings are in place,
pushing to `main` performs the complete CI/CD release.
