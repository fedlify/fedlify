#!/usr/bin/env bash
# Publish templates/fedlify-starter as the main template repository in Gitea
# (<GITEA_PUBLIC_TEMPLATE_ORG>/fedlify-starter). New study projects are cloned from it.
#
# usage: GITEA_BASE_URL=https://git.fedlify.com GITEA_TOKEN=... scripts/seed-starter-template.sh
# Re-running pushes the current template as a new commit (never force-pushes).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base="${GITEA_BASE_URL:?set GITEA_BASE_URL}"
base="${base%/}"
token="${GITEA_TOKEN:?set GITEA_TOKEN}"
org="${GITEA_PUBLIC_TEMPLATE_ORG:-fedlify-templates}"
repo="${FEDLIFY_STARTER_REPO:-fedlify-starter}"
source_dir="${root}/templates/fedlify-starter"

api() { curl -fsS -H "Authorization: token ${token}" -H "content-type: application/json" "$@"; }

python3 "${root}/deploy/images/study/validate_repo.py" "${source_dir}"

if ! api "${base}/api/v1/orgs/${org}" >/dev/null 2>&1; then
  api -X POST "${base}/api/v1/orgs" -d "{\"username\":\"${org}\",\"full_name\":\"Fedlify Templates\",\"visibility\":\"limited\"}" >/dev/null
  echo "Created organization ${org}"
fi
if ! api "${base}/api/v1/repos/${org}/${repo}" >/dev/null 2>&1; then
  api -X POST "${base}/api/v1/orgs/${org}/repos" \
    -d "{\"name\":\"${repo}\",\"description\":\"Fedlify starter: FedAvg logistic regression (NVFLARE Client API)\",\"private\":true,\"auto_init\":true,\"default_branch\":\"main\"}" >/dev/null
  echo "Created repository ${org}/${repo}"
fi

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
git -c "http.extraHeader=Authorization: token ${token}" clone --quiet "${base}/${org}/${repo}.git" "${work}/repo"
cd "${work}/repo"
git checkout --quiet main 2>/dev/null || git checkout --quiet -b main
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "${source_dir}/." .
git add -A
if git diff --cached --quiet; then
  echo "${org}/${repo} is already up to date."
  exit 0
fi
git -c user.name="Fedlify" -c user.email="noreply@fedlify.com" commit --quiet -m "Update Fedlify starter template"
git -c "http.extraHeader=Authorization: token ${token}" push --quiet origin main
echo "Pushed $(git rev-parse --short HEAD) to ${base}/${org}/${repo}"
