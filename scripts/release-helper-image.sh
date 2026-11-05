#!/usr/bin/env bash
# Release the Fedlify site helper image to the public Harbor project fedlify-public and print the digest-pinned reference
# for FEDLIFY_HELPER_IMAGE. NOT RUN while it was written: no Docker build, push or Harbor call was made.
#
#   scripts/release-helper-image.sh [--dry-run] [TAG]
#
# Credentials (never printed, never put on a command line): the fedlify-helper-push robot from Terraform, by environment
#   HARBOR_PUSH_USERNAME  HARBOR_PUSH_PASSWORD
# e.g.  eval "$(terraform -chdir=IaC/day1/cicd output -json fedlify_helper_push_robot | python3 -c \
#   'import json,sys,shlex; d=json.load(sys.stdin); print("export HARBOR_PUSH_USERNAME=%s HARBOR_PUSH_PASSWORD=%s" % (shlex.quote(d["username"]), shlex.quote(d["password"])))')"
# The username contains a "$" (robot$...): it is only ever used inside double quotes here.
#
# Optional environment: HARBOR_REGISTRY (default harbor.fedlify.com), HELPER_PROJECT (default fedlify-public),
#   PLATFORMS (default linux/amd64; the arm64 build has never been built or tested, so it is opt-in: PLATFORMS=linux/amd64,linux/arm64),
#   NODE_IMAGE (pin the base by digest for a release, see deploy/images/helper/Dockerfile).
# TAG defaults to the UTC date plus short git SHA when git is available, else the UTC timestamp. Tags are for humans: the printed
# reference is by digest, which is what FEDLIFY_HELPER_IMAGE must hold. Only this image may ever be pushed to fedlify-public.
#
# After it succeeds: set FEDLIFY_HELPER_IMAGE in the web deployment to the printed line (kustomize/secret as you do today),
# redeploy, and the next kit includes the helper scripts. Verify anonymous pull yourself: `docker logout harbor.fedlify.com`
# then `docker pull <printed reference>`; this script does that check with an unauthenticated manifest request.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"
die() { echo "release-helper-image: $*" >&2; exit 1; }

dry=0
if [ "${1:-}" = "--dry-run" ]; then dry=1; shift; fi
registry="${HARBOR_REGISTRY:-harbor.fedlify.com}"
project="${HELPER_PROJECT:-fedlify-public}"
platforms="${PLATFORMS:-linux/amd64}"
[ "$project" = "fedlify-public" ] || die "refusing to push to project '$project': only fedlify-public holds the helper image."
tag="${1:-$(date -u +%Y%m%d)-$(git rev-parse --short HEAD 2>/dev/null || date -u +%H%M%S)}"
case "$tag" in *[!A-Za-z0-9._-]*|"") die "tag may contain only letters, digits, dot, dash and underscore." ;; esac
repo="$registry/$project/fedlify-helper"

if [ "$dry" = 1 ]; then
  echo "would: docker login $registry (robot from HARBOR_PUSH_USERNAME/PASSWORD)"
  echo "would: docker buildx build --platform $platforms -f deploy/images/helper/Dockerfile -t $repo:$tag --push --metadata-file <tmp> ."
  echo "would: read containerimage.digest from the metadata, then check an anonymous manifest request"
  echo "would print: FEDLIFY_HELPER_IMAGE=$repo@sha256:<digest>"
  exit 0
fi

command -v docker >/dev/null 2>&1 || die "Docker is required."
docker buildx version >/dev/null 2>&1 || die "docker buildx is required."
[ -n "${HARBOR_PUSH_USERNAME:-}" ] && [ -n "${HARBOR_PUSH_PASSWORD:-}" ] || die "set HARBOR_PUSH_USERNAME and HARBOR_PUSH_PASSWORD (Terraform output fedlify_helper_push_robot)."

work="$(mktemp -d)"
trap 'rm -rf "$work"; docker logout "$registry" >/dev/null 2>&1 || true' EXIT
printf '%s' "$HARBOR_PUSH_PASSWORD" | docker login "$registry" --username "$HARBOR_PUSH_USERNAME" --password-stdin >/dev/null

node_arg=()
[ -z "${NODE_IMAGE:-}" ] || node_arg=(--build-arg "NODE_IMAGE=$NODE_IMAGE")
docker buildx build --platform "$platforms" -f deploy/images/helper/Dockerfile ${node_arg[@]+"${node_arg[@]}"} -t "$repo:$tag" --push --metadata-file "$work/meta.json" . >&2

digest="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["containerimage.digest"])' "$work/meta.json")"
case "$digest" in sha256:[0-9a-f][0-9a-f]*) ;; *) die "no digest in the build metadata; nothing is printed." ;; esac
[ "${#digest}" -eq 71 ] || die "unexpected digest length; nothing is printed."

# Anonymous check: a registry request with no credentials always starts with a 401 and a token challenge, so ask Harbor for an
# anonymous pull token (no login) and use it. A private project gets no token for this scope, so the manifest request fails.
# This proves the helper is reachable before the kit (which holds the registry login) is unlocked.
token="$(curl -s "https://$registry/service/token?service=harbor-registry&scope=repository:$project/fedlify-helper:pull" \
  | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("token",""))
except Exception: print("")' || true)"
code=000
if [ -n "$token" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://$registry/v2/$project/fedlify-helper/manifests/$digest" || true)"
fi
[ "$code" = 200 ] || die "anonymous pull of $repo@$digest did not work (HTTP $code): is $project public? Do not use this reference until 'docker logout $registry && docker pull $repo@$digest' succeeds."
echo "FEDLIFY_HELPER_IMAGE=$repo@$digest"
