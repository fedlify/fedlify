#!/usr/bin/env python3
"""Collapse three scored repetitions into the majority-classification result cited in the
manuscript: per probe, take the classification observed in at least two of three repetitions;
if all three repetitions disagree, resolve to the most conservative observed classification
(NOT_BLOCKED > WRONG_LAYER > PASS), matching the disclosed methodology in Main.tex."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

CONSERVATISM_RANK = {"NOT_BLOCKED": 0, "WRONG_LAYER": 1, "PASS": 2}


def most_conservative(classifications: list[str]) -> str:
    return min(classifications, key=lambda c: CONSERVATISM_RANK[c])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("runs", nargs=3, type=Path, help="Three scored run.json files (one per repetition)")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    documents = [json.loads(path.read_text()) for path in args.runs]
    suite_hashes = {doc["suite"]["suite_hash"] for doc in documents}
    if len(suite_hashes) != 1:
        raise SystemExit("Cannot aggregate runs from different suite hashes")

    by_probe: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for doc in documents:
        for result in doc["results"]:
            by_probe[result["probe_id"]].append(result)

    if any(len(results) != 3 for results in by_probe.values()):
        raise SystemExit("Every probe must occur exactly once in each of the three input runs")

    majority_results: dict[str, dict[str, Any]] = {}
    unanimous_count = 0
    non_unanimous: list[tuple[str, list[str]]] = []
    for probe_id, results in by_probe.items():
        classes = [r["classification"] for r in results]
        counts = Counter(classes)
        top_class, top_count = counts.most_common(1)[0]
        if top_count >= 2:
            final = top_class
        else:
            final = most_conservative(classes)
        if len(set(classes)) == 1:
            unanimous_count += 1
        else:
            non_unanimous.append((probe_id, classes))
        majority_results[probe_id] = {
            "classification": final,
            "repetition_classifications": classes,
            "category": results[0]["category"],
            "probe_type": results[0]["probe_type"],
            "critical_escape": any(r.get("critical_escape") for r in results) and final == "NOT_BLOCKED",
            "expected": results[0]["expected"],
            "observed_by_repetition": [r["observed"] for r in results],
        }

    classifications = Counter(r["classification"] for r in majority_results.values())
    by_category: dict[str, Counter[str]] = defaultdict(Counter)
    by_adversarial_class: dict[str, Counter[str]] = defaultdict(Counter)
    for probe_id, r in majority_results.items():
        by_category[r["category"]][r["classification"]] += 1
        cls = "adversarial" if r["probe_type"].startswith("Adversarial") else "benign"
        by_adversarial_class[cls][r["classification"]] += 1

    total = sum(classifications.values())
    critical_escapes = [pid for pid, r in majority_results.items() if r["critical_escape"]]

    report = {
        "schema_version": "1.0",
        "suite_hash": next(iter(suite_hashes)),
        "repetitions": 3,
        "total_probes": total,
        "classifications": dict(classifications),
        "pass_rate_percent": round(100.0 * classifications.get("PASS", 0) / total, 1),
        "boundary_held_percent": round(100.0 * (classifications.get("PASS", 0) + classifications.get("WRONG_LAYER", 0)) / total, 1),
        "unanimous_count": unanimous_count,
        "non_unanimous_probes": [{"probe_id": pid, "repetition_classifications": classes} for pid, classes in non_unanimous],
        "critical_escapes": critical_escapes,
        "by_category": {name: dict(counts) for name, counts in sorted(by_category.items())},
        "by_adversarial_class": {name: dict(counts) for name, counts in by_adversarial_class.items()},
        "majority_results": majority_results,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2))
    print(json.dumps({k: v for k, v in report.items() if k != "majority_results"}, indent=2))


if __name__ == "__main__":
    main()
