#!/usr/bin/env bash
# Build + push the web image inside the cluster (kaniko, Harbor layer cache) instead of on a Mac under emulation.
# Builds a COMMITTED AND PUSHED git ref from GitHub; local uncommitted changes are NOT included.
#
# Usage: scripts/build-web-in-cluster.sh <image-tag> [git-ref=refs/heads/main] [git-commit]
# Env:   KUBECONFIG (required), NAMESPACE (default fedlify), NO_WAIT=1 to return immediately.
# Next:  set images[harbor.fedlify.com/fedlify/web].newTag in deploy/k8s/kustomization.yaml and let Argo CD sync.
set -euo pipefail

TAG="${1:?usage: $0 <image-tag> [git-ref] [git-commit]}"
REF="${2:-refs/heads/main}"
COMMIT="${3:-}"
NS="${NAMESPACE:-fedlify}"
: "${KUBECONFIG:?set KUBECONFIG to the cluster kubeconfig}"

name="$(kubectl -n "$NS" create -o jsonpath='{.metadata.name}' -f - <<YAML
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: fedlify-web-build-
  labels:
    app.kubernetes.io/name: fedlify-platform-image-build
spec:
  workflowTemplateRef:
    name: fedlify-platform-image-build
  arguments:
    parameters:
      - { name: image-tag, value: "${TAG}" }
      - { name: git-ref, value: "${REF}" }
      - { name: git-commit, value: "${COMMIT}" }
YAML
)"
echo "submitted workflow/${name} (tag ${TAG}, ref ${REF}${COMMIT:+@$COMMIT})"

[ "${NO_WAIT:-0}" = 1 ] && exit 0
while :; do
  phase="$(kubectl -n "$NS" get workflow "$name" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  echo "$(date +%T) phase=${phase:-Pending}"
  case "$phase" in
    Succeeded) echo "OK: harbor.fedlify.com/fedlify/web:${TAG}"; exit 0 ;;
    Failed|Error) kubectl -n "$NS" logs -l "workflows.argoproj.io/workflow=${name}" -c main --tail=40 || true; exit 1 ;;
  esac
  sleep 10
done
