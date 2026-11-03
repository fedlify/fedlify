#!/usr/bin/env bash
# Mirror the publish/build helper images into Harbor (linux/amd64 only, pinned by digest) so pods pull from the
# in-cluster-reachable registry instead of Docker Hub / gcr.io / quay.io.
#
# Usage:  scripts/mirror-helper-images.sh [--dry-run]
# Env:    HARBOR_REGISTRY (default harbor.fedlify.com)   MIRROR_PROJECT (default fedlify-mirror)
#         ARGO_VERSION    (default v4.1.2; must equal the controller's --executor-image tag:
#                          kubectl -n argo get deploy argo-workflows-workflow-controller \
#                            -o jsonpath='{.spec.template.spec.containers[0].args}')
#         HARBOR_USERNAME / HARBOR_PASSWORD (optional; otherwise rely on an existing `docker login`/crane login)
# Needs:  `crane` (preferred) or docker buildx + jq. Pushes need a Harbor identity with push on the project.
#
# The Harbor project must exist first. Either `terraform apply` the harbor_project.fedlify_mirror in
# IaC/day1/cicd/fedlify.tf, or create it once by hand (public, so no pull secret is needed to read these
# public upstream images):
#   curl -u "$ADMIN:$PASS" -H 'Content-Type: application/json' -X POST https://harbor.fedlify.com/api/v2.0/projects \
#     -d '{"project_name":"fedlify-mirror","metadata":{"public":"true"}}'
#
# Mirrored names (keep in sync with deploy/k8s/publish-workflow-template.yaml, platform-build-workflow-template.yaml,
# image-prepuller.yaml):
#   alpine/k8s:1.31.13                          -> $REG/$PROJ/alpine-k8s:1.31.13
#   gcr.io/kaniko-project/executor:v1.23.2-debug -> $REG/$PROJ/kaniko-executor:v1.23.2-debug
#   amazon/aws-cli:2.17.0                       -> $REG/$PROJ/aws-cli:2.17.0
#   quay.io/argoproj/argoexec:$ARGO_VERSION     -> $REG/$PROJ/argoexec:$ARGO_VERSION
set -euo pipefail

DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
REG="${HARBOR_REGISTRY:-harbor.fedlify.com}"
PROJ="${MIRROR_PROJECT:-fedlify-mirror}"
ARGO_VERSION="${ARGO_VERSION:-v4.1.2}"
PLATFORM="linux/amd64"

IMAGES=(
  "alpine/k8s:1.31.13|alpine-k8s:1.31.13"
  "gcr.io/kaniko-project/executor:v1.23.2-debug|kaniko-executor:v1.23.2-debug"
  "amazon/aws-cli:2.17.0|aws-cli:2.17.0"
  "quay.io/argoproj/argoexec:${ARGO_VERSION}|argoexec:${ARGO_VERSION}"
)

if command -v crane >/dev/null 2>&1; then TOOL=crane
elif docker buildx version >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then TOOL=docker
else echo "need crane, or docker buildx + jq" >&2; exit 1; fi

if [ -n "${HARBOR_USERNAME:-}" ] && [ -n "${HARBOR_PASSWORD:-}" ] && [ "$DRY" = 0 ]; then
  if [ "$TOOL" = crane ]; then printf '%s' "$HARBOR_PASSWORD" | crane auth login "$REG" -u "$HARBOR_USERNAME" --password-stdin
  else printf '%s' "$HARBOR_PASSWORD" | docker login "$REG" -u "$HARBOR_USERNAME" --password-stdin; fi
fi

# Digest of the linux/amd64 image manifest behind a (possibly multi-arch) tag.
amd64_digest() {
  local src="$1"
  if [ "$TOOL" = crane ]; then crane digest --platform "$PLATFORM" "$src"; return; fi
  local raw; raw="$(docker buildx imagetools inspect --raw "$src")"
  if jq -e '.manifests' >/dev/null 2>&1 <<<"$raw"; then
    jq -r '.manifests[] | select(.platform.os=="linux" and .platform.architecture=="amd64") | .digest' <<<"$raw" | head -n1
  else
    docker buildx imagetools inspect "$src" --format '{{.Manifest.Digest}}'   # single-arch image
  fi
}

for entry in "${IMAGES[@]}"; do
  src="${entry%%|*}"; dst="$REG/$PROJ/${entry##*|}"
  digest="$(amd64_digest "$src")"
  [ -n "$digest" ] || { echo "no $PLATFORM manifest for $src" >&2; exit 1; }
  repo="${src%:*}"
  echo "$src@$digest -> $dst"
  [ "$DRY" = 1 ] && continue
  if [ "$TOOL" = crane ]; then crane copy "$repo@$digest" "$dst"
  else docker buildx imagetools create --tag "$dst" "$repo@$digest"; fi
  echo "  mirrored; pin as ${dst%:*}@${digest}"
done
echo "Done. Verify from a node-equivalent: docker manifest inspect $REG/$PROJ/alpine-k8s:1.31.13"
