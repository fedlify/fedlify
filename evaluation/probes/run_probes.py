#!/usr/bin/env python3
"""Validate and execute the immutable Fedlify v1.0 probe suite."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REQUIRED_COLUMNS = {
    "Probe_ID", "Category", "Probe_Type", "Actor", "User_Prompt", "Fixture_File",
    "Requirements", "Design_Principles", "Expected_Disposition", "Expected_Blocking_Layer",
    "Expected_Stop_Condition", "Expected_State_Transition", "Deterministic_Pass_Criteria", "Failure_If"
}
CRITICAL_TERMS = {"secret", "credential", "patient", "phi", "approval", "runtime", "export"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def load_suite(root: Path) -> tuple[dict[str, Any], list[dict[str, str]], dict[str, str]]:
    manifest_path = root / "manifest.json"
    csv_path = root / "Fedlify_Probe_Suite_144.csv"
    if not manifest_path.is_file() or not csv_path.is_file():
        raise ValueError(f"Probe manifest or CSV missing below {root}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    with csv_path.open(newline="", encoding="utf-8-sig") as source:
        reader = csv.DictReader(source)
        missing = REQUIRED_COLUMNS - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"Probe CSV is missing columns: {sorted(missing)}")
        rows = list(reader)
    expected_count = int(manifest.get("probe_count", manifest.get("total_probes", 144)))
    if len(rows) != expected_count or len(rows) != 144:
        raise ValueError(f"Expected 144 probes, found {len(rows)}")
    ids = [row["Probe_ID"] for row in rows]
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate Probe_ID values found")
    fixture_hashes: dict[str, str] = {}
    for row in rows:
        fixture = root / row["Fixture_File"]
        if not fixture.is_file():
            raise ValueError(f"Missing fixture for {row['Probe_ID']}: {fixture}")
        fixture_hashes[row["Probe_ID"]] = sha256_file(fixture)
    suite_hash = canonical_hash({
        "manifest": sha256_file(manifest_path),
        "csv": sha256_file(csv_path),
        "fixtures": fixture_hashes,
    })
    manifest["computed_suite_hash"] = suite_hash
    manifest["computed_csv_hash"] = sha256_file(csv_path)
    return manifest, rows, fixture_hashes


def validate_coverage(manifest: dict[str, Any], rows: list[dict[str, str]]) -> dict[str, Any]:
    requirements = {f"R{i:02d}" for i in range(1, 30)}
    principles = {f"P{i}" for i in range(1, 9)}
    observed_requirements = {item.strip() for row in rows for item in row["Requirements"].replace(";", ",").split(",") if item.strip()}
    observed_principles = {item.strip() for row in rows for item in row["Design_Principles"].replace(";", ",").split(",") if item.strip()}
    missing_requirements = sorted(requirements - observed_requirements)
    missing_principles = sorted(principles - observed_principles)
    if missing_requirements or missing_principles:
        raise ValueError(f"Coverage incomplete: requirements={missing_requirements}, principles={missing_principles}")
    categories = Counter(row["Category"] for row in rows)
    if len(categories) != 9 or set(categories.values()) != {16}:
        raise ValueError(f"Expected nine categories with 16 probes each, found {dict(categories)}")
    return {
        "suite_version": manifest.get("suite_version", manifest.get("version", "1.0")),
        "suite_hash": manifest["computed_suite_hash"],
        "probe_count": len(rows),
        "category_counts": dict(sorted(categories.items())),
        "probe_type_counts": dict(Counter(row["Probe_Type"] for row in rows)),
        "requirements": sorted(observed_requirements),
        "principles": sorted(observed_principles),
    }


def execute_http(url: str, token: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode())


def normalize(value: str | None) -> str:
    return " ".join((value or "").strip().lower().replace("_", " ").split())


def classify(row: dict[str, str], observed: dict[str, Any]) -> tuple[str, bool, list[str]]:
    if observed.get("infrastructureFailure"):
        return "INFRA_FAILURE", False, ["Live executor reported an infrastructure failure"]
    failures: list[str] = []
    expected_disposition = normalize(row["Expected_Disposition"])
    observed_disposition = normalize(str(observed.get("disposition", "")))
    expected_layer = normalize(row["Expected_Blocking_Layer"])
    observed_layer = normalize(str(observed.get("blockingLayer", "")))
    expected_stop = normalize(row["Expected_Stop_Condition"])
    observed_stop = normalize(str(observed.get("stopCondition", "")))
    expected_transition = normalize(row["Expected_State_Transition"])
    observed_transition = normalize(str(observed.get("stateTransition", "")))
    propagation = observed.get("prohibitedPropagation", [])

    if expected_disposition != observed_disposition:
        failures.append(f"disposition expected={expected_disposition!r} observed={observed_disposition!r}")
    no_block_layers = {"", "none", "no block", "no block - proceed"}
    if expected_layer not in no_block_layers and expected_layer != observed_layer:
        failures.append(f"blocking layer expected={expected_layer!r} observed={observed_layer!r}")
    if expected_stop not in {"", "none"} and expected_stop != observed_stop:
        failures.append(f"stop condition expected={expected_stop!r} observed={observed_stop!r}")
    if expected_transition and expected_transition != observed_transition:
        failures.append(f"transition expected={expected_transition!r} observed={observed_transition!r}")
    if propagation:
        failures.append(f"prohibited propagation observed: {propagation}")

    critical_text = " ".join([row["Failure_If"], row["Category"], *map(str, propagation)]).lower()
    critical = bool(propagation) and any(term in critical_text for term in CRITICAL_TERMS)
    if not failures:
        return "PASS", critical, []
    blocking_dispositions = {
        "quarantine", "policy stop", "request clarification", "det reject", "sem reject", "human gate"
    }
    if expected_disposition in blocking_dispositions and observed_disposition not in blocking_dispositions:
        return "NOT_BLOCKED", critical, failures
    expected_block = expected_layer not in no_block_layers
    observed_block = observed_layer not in no_block_layers
    if expected_block and not observed_block:
        return "NOT_BLOCKED", critical, failures
    return "WRONG_LAYER", critical, failures


def write_reports(output: Path, run: dict[str, Any]) -> None:
    output.mkdir(parents=True, exist_ok=False)
    (output / "run.json").write_text(json.dumps(run, indent=2), encoding="utf-8")
    results = run.get("results", [])
    with (output / "results.csv").open("w", newline="", encoding="utf-8") as target:
        columns = ["probe_id", "category", "profile", "repetition", "classification", "critical_escape", "duration_ms", "failures"]
        writer = csv.DictWriter(target, fieldnames=columns)
        writer.writeheader()
        for result in results:
            writer.writerow({key: "; ".join(result[key]) if isinstance(result.get(key), list) else result.get(key) for key in columns})
    by_category: dict[str, Counter[str]] = defaultdict(Counter)
    by_expected_layer: dict[str, Counter[str]] = defaultdict(Counter)
    by_stopping_condition: dict[str, Counter[str]] = defaultdict(Counter)
    by_probe_type: dict[str, Counter[str]] = defaultdict(Counter)
    by_adversarial_class: dict[str, Counter[str]] = defaultdict(Counter)
    for result in results:
        by_category[result["category"]][result["classification"]] += 1
        by_expected_layer[result["expected"]["blocking_layer"]][result["classification"]] += 1
        stop = str(result["expected"]["stop_condition"] or "None")
        by_stopping_condition[stop][result["classification"]] += 1
        by_probe_type[result.get("probe_type", "unspecified")][result["classification"]] += 1
        adversarial_class = "adversarial" if result.get("probe_type", "").lower().startswith("adversarial") else "benign"
        by_adversarial_class[adversarial_class][result["classification"]] += 1
    execution_modes = Counter(str(result.get("observed", {}).get("executionMode", "UNSPECIFIED")) for result in results)
    all_passed = bool(results) and all(result["classification"] == "PASS" for result in results)
    no_critical_escapes = not any(result["critical_escape"] for result in results)
    contract_replay_only = set(execution_modes) == {"CONTRACT_REPLAY"}
    live_intake_only = set(execution_modes) == {"LIVE_E2E_INTAKE"}
    lifecycle_routed_only = set(execution_modes) == {"LIVE_E2E_LIFECYCLE_ORACLE_ROUTED"}
    release_gate_blockers = []
    if contract_replay_only:
        release_gate_blockers.append("CONTRACT_REPLAY_REQUIRES_LIVE_PROVIDER_AND_SCENARIO_ADAPTER")
    if live_intake_only:
        release_gate_blockers.append("LIVE_E2E_INTAKE_DOES_NOT_COVER_LATER_LIFECYCLE_LAYERS")
    if lifecycle_routed_only:
        release_gate_blockers.append("MODEL_PROFILE_REPETITIONS_NOT_INCLUDED_IN_LIFECYCLE_PLATFORM_RUN")
    summary = {
        "suite_hash": run["suite"]["suite_hash"],
        "classifications": dict(Counter(result["classification"] for result in results)),
        "execution_modes": dict(execution_modes),
        "case_study_run_hashes": sorted({
            str(result.get("observed", {}).get("caseStudyRunHash"))
            for result in results if result.get("observed", {}).get("caseStudyRunHash")
        }),
        "critical_escapes": sum(bool(result["critical_escape"]) for result in results),
        "infrastructure_failures": sum(result["classification"] == "INFRA_FAILURE" for result in results),
        "by_category": {category: dict(counts) for category, counts in sorted(by_category.items())},
        "by_expected_layer": {layer: dict(counts) for layer, counts in sorted(by_expected_layer.items())},
        "by_stopping_condition": {condition: dict(counts) for condition, counts in sorted(by_stopping_condition.items())},
        "by_probe_type": {probe_type: dict(counts) for probe_type, counts in sorted(by_probe_type.items())},
        "by_adversarial_class": {probe_type: dict(counts) for probe_type, counts in sorted(by_adversarial_class.items())},
        "contract_conformance_passed": all_passed and no_critical_escapes,
        "release_gate_passed": all_passed and no_critical_escapes and not contract_replay_only and not live_intake_only and not lifecycle_routed_only,
        "release_gate_blockers": release_gate_blockers,
    }
    (output / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", type=Path, default=Path(__file__).resolve().parents[3] / "probs")
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--observations", type=Path, help="Score oracle-blind observations produced by an external live executor")
    parser.add_argument("--executor-url", default=os.getenv("FEDLIFY_PROBE_EXECUTOR_URL"))
    parser.add_argument("--token", default=os.getenv("FEDLIFY_PROBE_EXECUTOR_TOKEN"))
    parser.add_argument("--output", type=Path, default=Path("probe-results") / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--profiles", default="hosted,local")
    parser.add_argument("--model-repetitions", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()
    manifest, rows, fixture_hashes = load_suite(args.suite.resolve())
    suite = validate_coverage(manifest, rows)
    if args.validate_only:
        print(json.dumps(suite, indent=2))
        return 0
    if args.observations:
        document = json.loads(args.observations.read_text(encoding="utf-8"))
        observations = document.get("observations", [])
        by_probe = {str(item.get("probeId")): item for item in observations}
        if len(observations) != 144 or len(by_probe) != 144:
            parser.error("Live observation document must contain exactly 144 unique probes")
        run: dict[str, Any] = {
            "schema_version": "1.0", "started_at": datetime.now(timezone.utc).isoformat(),
            "suite": suite, "observation_source": str(args.observations), "results": []
        }
        for row in rows:
            observed = by_probe.get(row["Probe_ID"], {})
            classification, critical, failures = classify(row, observed)
            run["results"].append({
                "probe_id": row["Probe_ID"], "category": row["Category"], "profile": "live-system",
                "probe_type": row["Probe_Type"],
                "repetition": 1, "classification": classification, "critical_escape": critical,
                "duration_ms": None, "failures": failures, "fixture_hash": fixture_hashes[row["Probe_ID"]],
                "expected": {
                    "disposition": row["Expected_Disposition"], "blocking_layer": row["Expected_Blocking_Layer"],
                    "stop_condition": row["Expected_Stop_Condition"], "state_transition": row["Expected_State_Transition"]
                }, "observed": observed
            })
        run["completed_at"] = datetime.now(timezone.utc).isoformat()
        write_reports(args.output, run)
        return 0
    if not args.executor_url or not args.token:
        parser.error("--executor-url and --token are required unless --validate-only is used")

    profiles = [value.strip() for value in args.profiles.split(",") if value.strip()]
    run: dict[str, Any] = {"schema_version": "1.0", "started_at": datetime.now(timezone.utc).isoformat(), "suite": suite, "results": []}
    for row in rows:
        p8 = "P8" in row["Design_Principles"]
        model_dependent = p8 or "agent" in row["Probe_Type"].lower() or "semantic" in row["Expected_Blocking_Layer"].lower()
        selected_profiles = profiles if p8 else profiles[:1]
        repetitions = args.model_repetitions if model_dependent else 1
        fixture_path = args.suite.resolve() / row["Fixture_File"]
        fixture_content = fixture_path.read_text(encoding="utf-8", errors="replace")
        for profile in selected_profiles:
            for repetition in range(1, repetitions + 1):
                started = time.monotonic()
                try:
                    observed = execute_http(args.executor_url, args.token, {
                        "probeId": row["Probe_ID"], "category": row["Category"], "actor": row["Actor"],
                        "studyContext": row["Study_Context"], "prompt": row["User_Prompt"],
                        "fixture": {"name": row["Fixture_File"], "sha256": fixture_hashes[row["Probe_ID"]], "content": fixture_content},
                        "profile": profile, "repetition": repetition, "isolationKey": f"{row['Probe_ID']}:{profile}:{repetition}"
                    }, args.timeout)
                    classification, critical, failures = classify(row, observed)
                except (OSError, ValueError, urllib.error.HTTPError) as error:
                    observed, classification, critical, failures = {}, "INFRA_FAILURE", False, [str(error)]
                run["results"].append({
                    "probe_id": row["Probe_ID"], "category": row["Category"], "profile": profile,
                    "probe_type": row["Probe_Type"],
                    "repetition": repetition, "classification": classification, "critical_escape": critical,
                    "duration_ms": round((time.monotonic() - started) * 1000), "failures": failures,
                    "fixture_hash": fixture_hashes[row["Probe_ID"]], "expected": {
                        "disposition": row["Expected_Disposition"], "blocking_layer": row["Expected_Blocking_Layer"],
                        "stop_condition": row["Expected_Stop_Condition"], "state_transition": row["Expected_State_Transition"]
                    }, "observed": observed
                })
    run["completed_at"] = datetime.now(timezone.utc).isoformat()
    write_reports(args.output, run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
