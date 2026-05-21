# Fedlify Runbook

## Local Startup

```sh
cp .env.example .env
docker compose up -d postgres minio mailpit
pnpm install
pnpm prisma:generate
pnpm --filter @fedlify/web prisma:migrate
pnpm dev
```

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

- Store `DATABASE_URL`, Auth.js secrets, OAuth credentials, SMTP credentials, S3 credentials, and `ARGO_WEBHOOK_SECRET` in Vault.
- Set `FEDLIFY_REQUIRE_NVFLARE=true` for the agent WorkflowTemplate.
- Configure Argo artifact repository for generated kits.
- Replace `app.fedlify.local` and Harbor image names in `deploy/k8s` with the production domain and registry.
