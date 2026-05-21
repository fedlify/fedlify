# Fedlify

Fedlify is a regulated health AI collaboration control plane for multi-institution federated learning studies. It keeps raw clinical data at hospital sites, manages study governance and ethics approval, and generates human-approved NVFLARE participant kits.

## What is Fedlify?

Fedlify enables teams and institutions to collaboratively train machine learning models without sharing raw data. By simplifying federated learning operations, Fedlify supports privacy-preserving AI development that is scalable, reproducible, and governed.

## Who is Fedlify for?

- Researchers working with sensitive or distributed datasets, especially in healthcare and education.
- Organizations that want to collaborate across data silos while maintaining control over their data.
- Developers building privacy-focused AI applications.
- Institutions adopting secure, decentralized model training workflows.

## Local Development

```sh
cp .env.example .env
docker compose up -d postgres minio mailpit
pnpm install
pnpm prisma:generate
pnpm --filter @fedlify/web prisma:migrate
pnpm dev
```

Open `http://localhost:3000`.

## Workspace

- `apps/web`: Next.js, refine, Ant Design, Auth.js, Prisma, RBAC, audit, and API routes.
- `services/agent-worker`: Python NVFLARE kit-generation worker and deterministic local fallback.
- `deploy/k8s`: Kubernetes and Argo Workflow manifests for GitOps deployment.
- `IaC`: existing Compute Canada/OpenStack/Kubernetes/GitOps infrastructure.

## Tutorials

- [Two-site Fedlify study tutorial](docs/two-site-study-tutorial.md): coordinator plus two site operators, from protocol setup through a completed federated run and log review.
