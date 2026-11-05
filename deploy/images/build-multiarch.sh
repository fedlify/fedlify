#!/usr/bin/env bash
# Multi-architecture build and verification for the Fedlify base image. NOT RUN: written without a builder, a registry or an
# arm64 machine, so nothing here is evidence that the image works on arm64.
#
#   deploy/images/build-multiarch.sh build  IMAGE_REF [--push]   buildx, linux/amd64 + linux/arm64, from the repository root
#   deploy/images/build-multiarch.sh verify IMAGE_REF            manifest lists both platforms; each one imports nvflare/sklearn/pandas
#
# Build-time cost (an estimate, not a measurement): the arm64 half doubles the work. On an amd64 builder it runs under QEMU, where
# the emulated apt-get and pip steps are commonly several times slower than native, so expect the base image to go from a few
# minutes to tens of minutes. A native arm64 builder (a second buildx node, or a CI runner) avoids the emulation penalty. Every study
# image built FROM the base also needs both platforms, so each publish pays this again unless the study build is also multi-platform
# and cached. The k8s publish workflow (deploy/k8s/publish-workflow-template.yaml) builds amd64 only and is deliberately not edited here.
# The unlock scripts are already arm64-aware (alpine index digest and per-arch age checksums), and pip wheels exist for arm64 for
# numpy, pandas and scikit-learn on Python 3.10, but whether the full nvflare dependency tree installs on arm64 is UNVERIFIED.
set -euo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
die() { echo "build-multiarch: $*" >&2; exit 1; }
PLATFORMS="linux/amd64,linux/arm64"
cmd="${1:-}"; ref="${2:-}"
[ -n "$cmd" ] && [ -n "$ref" ] || die "usage: $0 build|verify IMAGE_REF [--push]"
command -v docker >/dev/null 2>&1 || die "Docker is required."

case "$cmd" in
  build)
    docker buildx version >/dev/null 2>&1 || die "docker buildx is required (docker buildx create --use for a multi-platform builder)."
    [ "${3:-}" = "--push" ] || die "a multi-platform image cannot be loaded into the local engine; pass --push to a registry you control."
    docker buildx build --platform "$PLATFORMS" -f deploy/images/nvflare/Dockerfile -t "$ref" --push .
    echo "Pushed $ref. Now run: $0 verify $ref" ;;
  verify)
    listing="$(docker buildx imagetools inspect "$ref")"
    for p in linux/amd64 linux/arm64; do
      printf '%s' "$listing" | grep -q "Platform: *$p" || die "$ref does not list $p."
    done
    for p in linux/amd64 linux/arm64; do
      echo "smoke test on $p (emulated unless this host is $p)..."
      docker run --rm --platform "$p" --entrypoint python "$ref" -c "import nvflare, sklearn, pandas, numpy; print('ok', nvflare.__version__)"
    done
    echo "Both platforms listed and import-checked. Only then set the study image architectures to amd64,arm64 (FEDLIFY_STUDY_IMAGE_ARCHES)." ;;
  *) die "unknown command: $cmd" ;;
esac
