#!/usr/bin/env python3
"""Compute aggregate case-study metrics from site-local prediction files."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path

import numpy as np
from sklearn.calibration import calibration_curve
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, f1_score, precision_score, recall_score, roc_auc_score

BASELINES = {
    "federated_xgboost": {"auroc": .97, "auprc": .93, "precision": .96, "recall": .64, "f1": .76, "brier": .05},
    "fedavg_mlp": {"auroc": .96, "auprc": .91, "precision": .91, "recall": .78, "f1": .84, "brier": .04},
    "fedprox_mlp": {"auroc": .95, "auprc": .90, "precision": .88, "recall": .76, "f1": .82, "brier": .04},
    "federated_logistic_regression": {"auroc": .94, "auprc": .87, "precision": .90, "recall": .67, "f1": .77, "brier": .05},
    "dpsgd_mlp": {"auroc": .93, "auprc": .83, "precision": .51, "recall": .88, "f1": .64, "brier": .19},
}


def read_predictions(path: Path) -> tuple[np.ndarray, np.ndarray]:
    labels, scores = [], []
    with path.open(newline="", encoding="utf-8-sig") as source:
        reader = csv.DictReader(source)
        if set(reader.fieldnames or []) != {"label", "probability"}:
            raise ValueError("Prediction input must contain only label and probability columns")
        for row in reader:
            labels.append(int(row["label"]))
            scores.append(float(row["probability"]))
    y, probability = np.asarray(labels), np.asarray(scores)
    if len(y) == 0 or set(np.unique(y)) != {0, 1} or np.any((probability < 0) | (probability > 1)):
        raise ValueError("Predictions require both classes and probabilities between zero and one")
    return y, probability


def bootstrap_ci(y: np.ndarray, p: np.ndarray, seed: int, resamples: int = 2000) -> tuple[float, float]:
    rng = np.random.default_rng(seed)
    positive, negative = np.flatnonzero(y == 1), np.flatnonzero(y == 0)
    estimates = []
    for _ in range(resamples):
        indexes = np.concatenate([rng.choice(positive, len(positive), replace=True), rng.choice(negative, len(negative), replace=True)])
        estimates.append(roc_auc_score(y[indexes], p[indexes]))
    return tuple(np.quantile(estimates, [.025, .975]))


def metrics(y: np.ndarray, p: np.ndarray, threshold: float, seed: int) -> dict[str, float | list[float]]:
    prediction = (p >= threshold).astype(int)
    calibration = LogisticRegression().fit(np.log(np.clip(p, 1e-6, 1 - 1e-6) / np.clip(1 - p, 1e-6, 1)), y)
    return {
        "auroc": roc_auc_score(y, p), "auroc_ci95": list(bootstrap_ci(y, p, seed)),
        "auprc": average_precision_score(y, p), "precision": precision_score(y, prediction, zero_division=0),
        "recall": recall_score(y, prediction, zero_division=0), "f1": f1_score(y, prediction, zero_division=0),
        "brier": brier_score_loss(y, p), "calibration_slope": float(calibration.coef_[0][0]),
        "calibration_intercept": float(calibration.intercept_[0])
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--algorithm", choices=sorted(BASELINES), required=True)
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--threshold", type=float, required=True, help="Frozen threshold selected using training CV only")
    parser.add_argument("--seed", type=int, default=20260806)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not 0 <= args.threshold <= 1:
        parser.error("threshold must be between zero and one")
    y, p = read_predictions(args.predictions)
    result = metrics(y, p, args.threshold, args.seed)
    baseline = BASELINES[args.algorithm]
    output = {
        "schema_version": "1.0", "algorithm": args.algorithm, "records": len(y), "threshold": args.threshold,
        "predictions_sha256": hashlib.sha256(args.predictions.read_bytes()).hexdigest(), "metrics": result,
        "paper_baseline": baseline, "difference_from_baseline": {key: result[key] - value for key, value in baseline.items()}
    }
    if args.output.exists():
        parser.error("Output already exists; result packages are immutable")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
