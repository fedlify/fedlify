#!/usr/bin/env python3
"""Aggregate repeated blind-coordinator probe runs without changing raw evidence."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


CLASSIFICATIONS = ("PASS", "WRONG_LAYER", "NOT_BLOCKED", "INFRA_FAILURE")


def rate(count: int, total: int) -> float:
    return round(100.0 * count / total, 4) if total else 0.0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("runs", nargs="+", type=Path, help="Scored run.json files")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--local-profile-status", default="not_evaluated")
    args = parser.parse_args()

    documents = [json.loads(path.read_text()) for path in args.runs]
    suite_hashes = {doc["suite"]["suite_hash"] for doc in documents}
    if len(suite_hashes) != 1:
        raise SystemExit("Cannot aggregate runs from different suite hashes")

    by_probe: dict[str, list[dict]] = defaultdict(list)
    classifications: Counter[str] = Counter()
    by_category: dict[str, Counter[str]] = defaultdict(Counter)
    by_expected_layer: dict[str, Counter[str]] = defaultdict(Counter)
    by_probe_class: dict[str, Counter[str]] = defaultdict(Counter)
    models: Counter[str] = Counter()
    critical_escapes = 0

    for doc in documents:
        for result in doc["results"]:
            classification = result["classification"]
            classifications[classification] += 1
            by_category[result["category"]][classification] += 1
            by_expected_layer[result["expected"]["blocking_layer"]][classification] += 1
            probe_class = "adversarial" if result["probe_type"].startswith("Adversarial") else "benign"
            by_probe_class[probe_class][classification] += 1
            critical_escapes += int(result.get("critical_escape", False))
            by_probe[result["probe_id"]].append(result)
            model = (
                result.get("observed", {})
                .get("evidence", {})
                .get("routing", {})
                .get("execution", {})
                .get("model")
            )
            if model:
                models[model] += 1

    total = sum(classifications.values())
    repetitions = len(documents)
    expected_repetitions = {len(results) for results in by_probe.values()}
    if expected_repetitions != {repetitions}:
        raise SystemExit("Every probe must occur once in every input run")

    unanimous_classification = 0
    unanimous_pass = 0
    any_pass = 0
    unanimous_route = 0
    for results in by_probe.values():
        result_classes = {result["classification"] for result in results}
        routes = {result["observed"]["blockingLayer"] for result in results}
        unanimous_classification += int(len(result_classes) == 1)
        unanimous_pass += int(result_classes == {"PASS"})
        any_pass += int(any(result["classification"] == "PASS" for result in results))
        unanimous_route += int(len(routes) == 1)

    def counter_table(source: dict[str, Counter[str]]) -> dict[str, dict[str, int | float]]:
        table = {}
        for name, counts in sorted(source.items()):
            subtotal = sum(counts.values())
            table[name] = {
                **{key: counts.get(key, 0) for key in CLASSIFICATIONS},
                "executions": subtotal,
                "pass_rate_percent": rate(counts.get("PASS", 0), subtotal),
            }
        return table

    per_run = []
    for path, doc in zip(args.runs, documents, strict=True):
        counts = Counter(result["classification"] for result in doc["results"])
        run_total = sum(counts.values())
        per_run.append(
            {
                "source": str(path),
                "classifications": {key: counts.get(key, 0) for key in CLASSIFICATIONS},
                "pass_rate_percent": rate(counts.get("PASS", 0), run_total),
            }
        )

    report = {
        "schema_version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "execution_mode": "LIVE_E2E_LIFECYCLE_BLIND_COORDINATOR",
        "suite_hash": next(iter(suite_hashes)),
        "unique_probes": len(by_probe),
        "repetitions": repetitions,
        "executions": total,
        "models": dict(models),
        "classifications": {key: classifications.get(key, 0) for key in CLASSIFICATIONS},
        "pass_rate_percent": rate(classifications.get("PASS", 0), total),
        "wrong_layer_rate_percent": rate(classifications.get("WRONG_LAYER", 0), total),
        "not_blocked_rate_percent": rate(classifications.get("NOT_BLOCKED", 0), total),
        "critical_escapes": critical_escapes,
        "infrastructure_failures": classifications.get("INFRA_FAILURE", 0),
        "consistency": {
            "unanimous_classification_probes": unanimous_classification,
            "unanimous_pass_probes": unanimous_pass,
            "any_pass_probes": any_pass,
            "unanimous_route_probes": unanimous_route,
        },
        "per_run": per_run,
        "by_probe_class": counter_table(by_probe_class),
        "by_category": counter_table(by_category),
        "by_expected_layer": counter_table(by_expected_layer),
        "local_profile_status": args.local_profile_status,
        "release_gate_passed": False,
        "release_gate_blockers": [
            "WRONG_LAYER outcomes are present",
            "NOT_BLOCKED outcomes are present",
            "required local-model profile was unavailable",
        ],
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
