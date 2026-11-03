#!/usr/bin/env bash
# Local end-to-end test of the Fedlify publish/run topology, no cluster needed:
#   validate repo -> build base + study image -> provision kits for hf-mortality.fedlify.test
#   -> aggregator behind an SNI passthrough router -> 2 hospital clients with their own eICU partition
#   -> submit through the FLARE API adapter -> per-round metrics -> result zip.
#
# usage: deploy/local-e2e/run.sh [study-repo-dir] [rounds]      (defaults: templates/fedlify-starter, 3)
#        deploy/local-e2e/run.sh down
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "${here}/../.." && pwd)"
cd "${here}"

if [ "${1:-}" = "down" ]; then
  docker compose --profile run down -v
  exit 0
fi

repo="$(cd "${1:-${root}/templates/fedlify-starter}" && pwd)"
rounds="${2:-3}"
dataset="${EICU_DATASET_PATH:-${root}/../eicu/GenAI-Multi-Site-Collaborative-Learning-2/data/eICU/heart_failure_data_v2.csv}"
token="${FEDLIFY_ADAPTER_TOKEN:-local-adapter-token}"
export FEDLIFY_ADAPTER_TOKEN="${token}"
export FEDLIFY_STUDY_IMAGE="fedlify-study-hf-mortality:local"

step() { printf '\n==> %s\n' "$*"; }
adapter() { curl -fsS -H "authorization: Bearer ${token}" "$@"; }

step "Build base image"
docker build -q -f "${root}/deploy/images/nvflare/Dockerfile" -t fedlify-nvflare-base:2.6.2 "${root}"

step "Validate and test study repository ${repo} (same checks as the publish workflow)"
docker run --rm -v "${repo}:/opt/fedlify/code:ro" -w /opt/fedlify/code -e PYTHONDONTWRITEBYTECODE=1 \
  fedlify-nvflare-base:2.6.2 sh -c 'python3 /opt/fedlify/runtime/validate_repo.py . && python3 -m unittest discover -s tests'

step "Build study image"
docker build -q -f "${root}/deploy/images/study/Dockerfile" --build-arg BASE_IMAGE=fedlify-nvflare-base:2.6.2 \
  -t "${FEDLIFY_STUDY_IMAGE}" "${repo}"

step "Provision startup kits for hf-mortality.fedlify.test (same provisioner as the publish workflow)"
rm -rf provisioned && mkdir -p provisioned
docker run --rm -v "${here}/provisioned:/out" fedlify-nvflare-base:2.6.2 \
  python3 -m fedlify_runtime.provision --hostname hf-mortality.fedlify.test \
  --sites '[{"name":"site_a"},{"name":"site_b"}]' --out /out/build
mv provisioned/build/* provisioned/ && rmdir provisioned/build
ls provisioned provisioned/clients

step "Split ${dataset} into two hospital partitions (data stays in ./data, mounted read-only)"
python3 - "${dataset}" <<'PY'
import csv, sys, collections, pathlib
rows = list(csv.DictReader(open(sys.argv[1])))
top = [h for h, _ in collections.Counter(r["hospitalid"] for r in rows).most_common(2)]
for site, hospital in zip(["site_a", "site_b"], top):
    out = pathlib.Path("data") / site
    out.mkdir(parents=True, exist_ok=True)
    part = [r for r in rows if r["hospitalid"] == hospital]
    with open(out / "extract.csv", "w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(part)
    print(f"{site}: hospital {hospital}, {len(part)} rows")
PY

step "Start aggregator, adapter, router and both hospitals"
docker compose --profile run down -v >/dev/null 2>&1 || true
docker compose --profile run up -d

step "Wait for both sites to connect through the SNI router"
for _ in $(seq 1 60); do
  connected="$(adapter http://127.0.0.1:3010/system-info 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["clients"]))' 2>/dev/null || echo 0)"
  [ "${connected}" -ge 2 ] && break
  sleep 3
done
adapter http://127.0.0.1:3010/system-info | python3 -m json.tool
[ "${connected}" -ge 2 ] || { echo "Sites did not connect." >&2; exit 1; }

step "Start run: ${rounds} rounds, 2 sites"
job_id="$(adapter -X POST -H 'content-type: application/json' \
  -d "{\"jobName\":\"hf-mortality-local\",\"numRounds\":${rounds},\"minClients\":2}" \
  http://127.0.0.1:3010/jobs | python3 -c 'import json,sys; print(json.load(sys.stdin)["nvflareJobId"])')"
echo "NVFLARE job ${job_id}"

status=""
for _ in $(seq 1 120); do
  status="$(adapter "http://127.0.0.1:3010/jobs/${job_id}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["meta"].get("status",""))')"
  echo "status: ${status}"
  case "${status}" in FINISHED*) break ;; esac
  sleep 5
done

step "Per-round metrics (from the aggregator, no patient data)"
adapter "http://127.0.0.1:3010/jobs/${job_id}/metrics" | python3 -c '
import json, sys
body = json.load(sys.stdin)
for r in body["records"]:
    if r["event"] == "contribution":
        values = "  ".join("%s=%.4f" % item for item in r["metrics"].items())
        print("round %s  %-7s n=%5d  %s" % (r["round"], r["site"], int(r["numSamples"]), values))
print("(%s metrics, %d records)" % (body["source"], len(body["records"])))'

step "Download result"
mkdir -p work
adapter -o "work/${job_id}.zip" "http://127.0.0.1:3010/jobs/${job_id}/result.zip"
ls -l "work/${job_id}.zip"

[ "${status}" = "FINISHED:COMPLETED" ] || { echo "Job ended with ${status}" >&2; exit 1; }
echo "Local end-to-end run completed. Stop everything with: deploy/local-e2e/run.sh down"
