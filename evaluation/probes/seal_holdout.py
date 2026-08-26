#!/usr/bin/env python3
"""Validate and checksum an independently authored probe holdout after code freeze."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


REQUIRED = {
    "case_id", "actor", "study_context", "request_text", "fixture_file",
    "expected_disposition", "expected_blocking_layer", "expected_stop_condition"
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", required=True, type=Path, help="JSON array authored outside the implementation team")
    parser.add_argument("--fixtures", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit("Refusing to overwrite an existing sealed holdout manifest")
    cases = json.loads(args.cases.read_text(encoding="utf-8"))
    if not isinstance(cases, list) or not cases:
        raise SystemExit("Holdout must contain a non-empty JSON array")
    ids: set[str] = set()
    fixture_hashes: dict[str, str] = {}
    for index, case in enumerate(cases):
        if not isinstance(case, dict) or REQUIRED - set(case):
            raise SystemExit(f"Holdout case {index} is missing fields: {sorted(REQUIRED - set(case or {}))}")
        case_id = str(case["case_id"])
        if case_id in ids:
            raise SystemExit(f"Duplicate holdout case_id: {case_id}")
        ids.add(case_id)
        fixture = (args.fixtures / str(case["fixture_file"])).resolve()
        if not fixture.is_file() or args.fixtures.resolve() not in fixture.parents:
            raise SystemExit(f"Missing or out-of-root fixture for {case_id}")
        fixture_hashes[case_id] = sha256(fixture)
    manifest = {
        "schema_version": "1.0",
        "sealed_at": datetime.now(timezone.utc).isoformat(),
        "case_count": len(cases),
        "cases_sha256": sha256(args.cases),
        "fixture_hashes": fixture_hashes,
        "oracle_access_policy": "SCORER_ONLY_AFTER_EXECUTION"
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
