#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from protocol import build_protocol, validate_dataset


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the frozen eICU cohort and emit aggregate-only protocol artifacts")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() and any(args.output.iterdir()):
        parser.error("Output directory must be absent or empty; prior runs are immutable")
    args.output.mkdir(parents=True, exist_ok=True)
    summary = validate_dataset(args.dataset.resolve())
    protocol = build_protocol(summary)
    (args.output / "cohort_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (args.output / "protocol.json").write_text(json.dumps(protocol, indent=2), encoding="utf-8")
    jobs = args.output / "jobs"
    jobs.mkdir()
    for job in protocol["jobs"]:
        (jobs / f"{job['algorithm']}.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
    print(json.dumps({"protocol_hash": protocol["protocol_hash"], "dataset_sha256": summary["dataset_sha256"], "status": protocol["status"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
