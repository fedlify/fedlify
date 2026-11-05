# Fedlify site helper image (optional local UI, compose profile "ui"). Build from the repository root:
#   docker build -f deploy/images/helper/Dockerfile -t <registry>/fedlify-site-helper:0.1.0 .
# Pin the base by digest when you build for release:
#   docker buildx imagetools inspect node:22-alpine   (then --build-arg NODE_IMAGE=node:22-alpine@sha256:...)
# The image must be pullable WITHOUT a login: it is needed before the kit (which holds the registry login) is unlocked.
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}
WORKDIR /app
COPY deploy/images/helper/package.json deploy/images/helper/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY deploy/images/helper/*.mjs ./
COPY deploy/images/helper/public ./public
ENV NODE_ENV=production FEDLIFY_HELPER_CONTAINER=1
EXPOSE 8765
# No Docker socket mount, and no outbound network code (the compose network does not block egress, so this rests on the code). The compose file runs it read-only, as the host user, with all capabilities dropped.
USER node
ENTRYPOINT ["node"]
CMD ["server.mjs"]
