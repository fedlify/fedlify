# Fedlify web: Next.js standalone output. Build context = repo root.
#   docker buildx build --platform linux/amd64 -f apps/web/Dockerfile .
# Runtime layout: /app/apps/web/server.js (standalone) + /opt/migrate (prisma CLI for the migrate initContainer).
ARG NODE_IMAGE=node:22-alpine

# ---- deps: install from the lockfile; only manifests are copied so this layer caches ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY services/agent-orchestrator/package.json services/agent-orchestrator/package.json
# No BuildKit cache mount: kaniko (in-cluster build) does not support RUN --mount; layer caching covers it.
RUN pnpm install --filter @fedlify/web... --frozen-lockfile

# ---- builder ----
FROM deps AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY apps/web apps/web
RUN pnpm --filter @fedlify/web prisma:generate
RUN pnpm --filter @fedlify/web build

# ---- migrate tooling: standalone Prisma CLI (the traced standalone bundle does not include it) ----
FROM ${NODE_IMAGE} AS migrate
RUN apk add --no-cache openssl
WORKDIR /opt/migrate
RUN npm init -y >/dev/null && npm install --no-audit --no-fund --omit=dev prisma@6.19.3

# ---- runner ----
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN apk add --no-cache libc6-compat openssl && addgroup -S -g 1001 app && adduser -S -u 1001 -G app app
COPY --from=builder --chown=1001:1001 /app/apps/web/.next/standalone ./
COPY --from=builder --chown=1001:1001 /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=1001:1001 /app/apps/web/prisma ./apps/web/prisma
COPY --from=migrate --chown=1001:1001 /opt/migrate /opt/migrate
USER 1001
EXPOSE 3000
# Migrations: node /opt/migrate/node_modules/prisma/build/index.js migrate deploy --schema apps/web/prisma/schema.prisma
CMD ["node", "apps/web/server.js"]
