# Fedlify Application Architecture

Fedlify is implemented as a governance control plane for regulated federated learning studies.

## Runtime Components

- `apps/web`: Next.js application using refine and Ant Design. It owns identity, RBAC, study workflows, ethics gates, document metadata, release approval, site onboarding, and audit.
- `services/agent-worker`: Python worker that generates NVFLARE-oriented project files and participant kits. Production can require the real `nvflare` CLI.
- PostgreSQL: System-of-record database for Auth.js users, RBAC, studies, releases, and audit events.
- S3-compatible object storage: Documents, logs, generated artifacts, manifests, and signed releases.
- Argo Workflows: Container-native generation and CI jobs.
- Harbor, Vault, Argo CD, cert-manager, external-dns: Reused from the existing GitOps infrastructure.

## Data Boundary

Raw clinical datasets stay inside participating hospitals. Fedlify accepts requirements, ethics approvals, agreements, site policies, generated code, signed kit artifacts, logs, and audit metadata. Upload APIs block common dataset file types and flag possible sensitive identifiers in extracted document text.

## Release Gate

Generated NVFLARE artifacts are not downloadable as approved releases until:

1. The study has ethics status `APPROVED` or `NOT_REQUIRED`.
2. The agent run is `DRAFT_READY` or `VALIDATED`.
3. A user with `STUDY_OWNER` release permission approves the run.
4. Fedlify writes an immutable `KitRelease`, checksum, signature, artifact rows, and audit event.

## Local Development

Use `docker compose up -d postgres minio mailpit`, then run Prisma migration and `pnpm dev`.
