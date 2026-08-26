#!/usr/bin/env python3
"""Run the frozen six-hospital eICU horizontal-FL simulation.

The runner keeps row-level data in memory only and writes aggregate metrics.  It
is deliberately independent of the legacy notebooks: those notebooks are a
comparison source, not an executable specification for the v3 protocol.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import platform
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import StratifiedKFold
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from protocol import (
    ALGORITHMS,
    CATEGORICAL_FEATURES,
    CONTINUOUS_FEATURES,
    EXPECTED_COLUMNS,
    EXPECTED_COUNTS,
    SEED,
    TARGET,
    TRAINING_HOSPITALS,
    VALIDATION_HOSPITAL,
    build_protocol,
    canonical_hash,
    normalize_outcome,
    validate_dataset,
)

BASELINES = {
    "federated_xgboost": {"auroc": .97, "auprc": .93, "precision": .96, "recall": .64, "f1": .76, "brier": .05},
    "fedavg_mlp": {"auroc": .96, "auprc": .91, "precision": .91, "recall": .78, "f1": .84, "brier": .04},
    "fedprox_mlp": {"auroc": .95, "auprc": .90, "precision": .88, "recall": .76, "f1": .82, "brier": .04},
    "federated_logistic_regression": {"auroc": .94, "auprc": .87, "precision": .90, "recall": .67, "f1": .77, "brier": .05},
    "dpsgd_mlp": {"auroc": .93, "auprc": .83, "precision": .51, "recall": .88, "f1": .64, "brier": .19},
}

# Per-example L2 clip norm and the corresponding DP-SGD learning rate for this MLP's scale.
# Noise stays calibrated relative to the clip norm (private_mlp_gradients scales noise as
# noise_multiplier * clip / batch_size), so raising the clip proportionally preserves the
# same noise-to-signal ratio rather than just adding more privacy budget.
DP_SGD_CLIP_NORM = 6.0
DP_SGD_NOISE_MULTIPLIER = .08
DP_SGD_LEARNING_RATE = .05


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, value: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True), encoding="utf-8")
    temporary.replace(path)


@dataclass
class SiteRows:
    continuous: np.ndarray
    categorical: np.ndarray
    labels: np.ndarray


class SitePreprocessor:
    """A site/fold-local preprocessor with a fixed semantic output contract."""

    def __init__(self, category_contract: list[list[str]]):
        self.continuous_imputer = SimpleImputer(strategy="median")
        self.continuous_scaler = StandardScaler()
        self.categorical_imputer = SimpleImputer(strategy="most_frequent")
        self.categorical_encoder = OneHotEncoder(
            categories=category_contract,
            handle_unknown="ignore",
            sparse_output=False,
            dtype=np.float64,
        )

    def fit(self, rows: SiteRows) -> "SitePreprocessor":
        continuous = self.continuous_imputer.fit_transform(rows.continuous)
        self.continuous_scaler.fit(continuous)
        categorical = self.categorical_imputer.fit_transform(rows.categorical)
        self.categorical_encoder.fit(categorical)
        return self

    def transform(self, rows: SiteRows) -> np.ndarray:
        continuous = self.continuous_scaler.transform(self.continuous_imputer.transform(rows.continuous))
        categorical = self.categorical_encoder.transform(self.categorical_imputer.transform(rows.categorical))
        return np.concatenate([continuous, categorical], axis=1).astype(np.float64, copy=False)


def subset(rows: SiteRows, indexes: np.ndarray) -> SiteRows:
    return SiteRows(rows.continuous[indexes], rows.categorical[indexes], rows.labels[indexes])


def load_sites(path: Path) -> tuple[dict[int, SiteRows], list[list[str]]]:
    continuous: dict[int, list[list[float]]] = {hospital: [] for hospital in EXPECTED_COUNTS}
    categorical: dict[int, list[list[str]]] = {hospital: [] for hospital in EXPECTED_COUNTS}
    labels: dict[int, list[int]] = {hospital: [] for hospital in EXPECTED_COUNTS}
    categories = [set() for _ in CATEGORICAL_FEATURES]
    with path.open(newline="", encoding="utf-8-sig") as source:
        reader = csv.DictReader(source)
        if reader.fieldnames != EXPECTED_COLUMNS:
            raise ValueError("Dataset schema changed after protocol validation")
        for row in reader:
            outcome = normalize_outcome(row[TARGET])
            if outcome is None:
                continue
            hospital = int(float(row["hospitalid"]))
            if hospital not in EXPECTED_COUNTS:
                continue
            continuous[hospital].append([float(row[name]) if row[name].strip() else math.nan for name in CONTINUOUS_FEATURES])
            values = [row[name].strip() if row[name].strip() else np.nan for name in CATEGORICAL_FEATURES]
            categorical[hospital].append(values)
            labels[hospital].append(outcome)
            if hospital in TRAINING_HOSPITALS:
                for index, value in enumerate(values):
                    if isinstance(value, str):
                        categories[index].add(value)
    sites = {
        hospital: SiteRows(
            np.asarray(continuous[hospital], dtype=np.float64),
            np.asarray(categorical[hospital], dtype=object),
            np.asarray(labels[hospital], dtype=np.int64),
        )
        for hospital in EXPECTED_COUNTS
    }
    return sites, [sorted(values) for values in categories]


def init_linear(dimension: int) -> dict[str, np.ndarray]:
    return {"weight": np.zeros(dimension), "bias": np.zeros(1)}


def init_mlp(dimension: int, rng: np.random.Generator) -> dict[str, np.ndarray]:
    return {
        "w1": rng.normal(0, math.sqrt(2 / dimension), (dimension, 64)), "b1": np.zeros(64),
        "w2": rng.normal(0, math.sqrt(2 / 64), (64, 32)), "b2": np.zeros(32),
        "w3": rng.normal(0, math.sqrt(2 / 32), (32, 1)), "b3": np.zeros(1),
    }


def sigmoid(value: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(value, -35, 35)))


def predict_parameters(parameters: dict[str, np.ndarray], features: np.ndarray) -> np.ndarray:
    if "weight" in parameters:
        return sigmoid(features @ parameters["weight"] + parameters["bias"][0])
    hidden1 = np.maximum(0, features @ parameters["w1"] + parameters["b1"])
    hidden2 = np.maximum(0, hidden1 @ parameters["w2"] + parameters["b2"])
    return sigmoid((hidden2 @ parameters["w3"] + parameters["b3"]).reshape(-1))


def balanced_weights(labels: np.ndarray) -> np.ndarray:
    counts = np.bincount(labels, minlength=2).astype(float)
    return np.asarray([len(labels) / (2 * max(counts[value], 1)) for value in labels])


def linear_gradients(parameters: dict[str, np.ndarray], features: np.ndarray, labels: np.ndarray) -> dict[str, np.ndarray]:
    probabilities = predict_parameters(parameters, features)
    weights = balanced_weights(labels)
    error = (probabilities - labels) * weights / weights.sum()
    return {"weight": features.T @ error, "bias": np.asarray([error.sum()])}


def mlp_gradients(
    parameters: dict[str, np.ndarray],
    features: np.ndarray,
    labels: np.ndarray,
    proximal: dict[str, np.ndarray] | None = None,
    proximal_mu: float = 0.0,
) -> dict[str, np.ndarray]:
    z1 = features @ parameters["w1"] + parameters["b1"]
    a1 = np.maximum(0, z1)
    z2 = a1 @ parameters["w2"] + parameters["b2"]
    a2 = np.maximum(0, z2)
    probabilities = sigmoid((a2 @ parameters["w3"] + parameters["b3"]).reshape(-1))
    weights = balanced_weights(labels)
    dz3 = ((probabilities - labels) * weights / weights.sum())[:, None]
    gradients: dict[str, np.ndarray] = {}
    gradients["w3"] = a2.T @ dz3
    gradients["b3"] = dz3.sum(axis=0)
    dz2 = (dz3 @ parameters["w3"].T) * (z2 > 0)
    gradients["w2"] = a1.T @ dz2
    gradients["b2"] = dz2.sum(axis=0)
    dz1 = (dz2 @ parameters["w2"].T) * (z1 > 0)
    gradients["w1"] = features.T @ dz1
    gradients["b1"] = dz1.sum(axis=0)
    if proximal is not None and proximal_mu:
        for key in gradients:
            gradients[key] += proximal_mu * (parameters[key] - proximal[key])
    return gradients


def private_mlp_gradients(
    parameters: dict[str, np.ndarray],
    features: np.ndarray,
    labels: np.ndarray,
    rng: np.random.Generator,
    clip: float,
    noise_multiplier: float,
) -> dict[str, np.ndarray]:
    z1 = features @ parameters["w1"] + parameters["b1"]
    a1 = np.maximum(0, z1)
    z2 = a1 @ parameters["w2"] + parameters["b2"]
    a2 = np.maximum(0, z2)
    probabilities = sigmoid((a2 @ parameters["w3"] + parameters["b3"]).reshape(-1))
    dz3 = ((probabilities - labels) * balanced_weights(labels))[:, None]
    dz2 = (dz3 @ parameters["w3"].T) * (z2 > 0)
    dz1 = (dz2 @ parameters["w2"].T) * (z1 > 0)
    per_example = {
        "w1": np.einsum("bi,bj->bij", features, dz1), "b1": dz1,
        "w2": np.einsum("bi,bj->bij", a1, dz2), "b2": dz2,
        "w3": np.einsum("bi,bj->bij", a2, dz3), "b3": dz3,
    }
    norm_squared = np.zeros(len(labels))
    for value in per_example.values():
        norm_squared += np.square(value).reshape(len(labels), -1).sum(axis=1)
    factors = np.minimum(1.0, clip / np.sqrt(np.maximum(norm_squared, 1e-24)))
    result = {}
    for key, value in per_example.items():
        factor_shape = (len(labels),) + (1,) * (value.ndim - 1)
        clipped_mean = (value * factors.reshape(factor_shape)).mean(axis=0)
        noise = rng.normal(0, noise_multiplier * clip / len(labels), clipped_mean.shape)
        result[key] = clipped_mean + noise
    return result


def adam_update(
    parameters: dict[str, np.ndarray], gradients: dict[str, np.ndarray],
    first: dict[str, np.ndarray], second: dict[str, np.ndarray], step: int, rate: float,
) -> None:
    for key in parameters:
        first[key] = .9 * first[key] + .1 * gradients[key]
        second[key] = .999 * second[key] + .001 * np.square(gradients[key])
        parameters[key] -= rate * (first[key] / (1 - .9 ** step)) / (np.sqrt(second[key] / (1 - .999 ** step)) + 1e-8)


def local_train(
    algorithm: str,
    global_parameters: dict[str, np.ndarray],
    features: np.ndarray,
    labels: np.ndarray,
    epochs: int,
    batch_size: int,
    seed: int,
    learning_rate: float,
) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    parameters = {key: value.copy() for key, value in global_parameters.items()}
    first = {key: np.zeros_like(value) for key, value in parameters.items()}
    second = {key: np.zeros_like(value) for key, value in parameters.items()}
    step = 0
    for _ in range(epochs):
        indexes = rng.permutation(len(labels))
        for start in range(0, len(labels), batch_size):
            selected = indexes[start:start + batch_size]
            step += 1
            if algorithm == "federated_logistic_regression":
                gradients = linear_gradients(parameters, features[selected], labels[selected])
                for key in parameters:
                    parameters[key] -= learning_rate * gradients[key]
            elif algorithm == "dpsgd_mlp":
                gradients = private_mlp_gradients(
                    parameters, features[selected], labels[selected], rng,
                    DP_SGD_CLIP_NORM, DP_SGD_NOISE_MULTIPLIER,
                )
                for key in parameters:
                    parameters[key] -= learning_rate * gradients[key]
            else:
                gradients = mlp_gradients(
                    parameters, features[selected], labels[selected],
                    global_parameters if algorithm == "fedprox_mlp" else None,
                    .01 if algorithm == "fedprox_mlp" else 0,
                )
                adam_update(parameters, gradients, first, second, step, learning_rate)
    return parameters


def federated_parameters(
    algorithm: str,
    sites: dict[int, tuple[np.ndarray, np.ndarray]],
    rounds: int,
    local_epochs: int,
    batch_size: int,
    seed: int,
) -> dict[str, np.ndarray]:
    dimension = next(iter(sites.values()))[0].shape[1]
    rng = np.random.default_rng(seed)
    parameters = init_linear(dimension) if algorithm == "federated_logistic_regression" else init_mlp(dimension, rng)
    if algorithm == "federated_logistic_regression":
        rate = .01
    elif algorithm == "dpsgd_mlp":
        # Plain SGD (no Adam) on gradients clipped to DP_SGD_CLIP_NORM needs a much larger
        # step than the Adam-driven variants: at the previous clip=1.0 with this MLP's scale,
        # per-example gradient norms average 4.5-6.7, so ~90%+ of examples were clipped on
        # nearly every step, uniformly crushing the signal rather than trimming outliers, and
        # the small unnormalized SGD step made negligible progress on what was left.
        rate = DP_SGD_LEARNING_RATE
    else:
        rate = .001
    total = sum(len(labels) for _, labels in sites.values())
    for round_index in range(rounds):
        clients = []
        for site_index, hospital in enumerate(TRAINING_HOSPITALS):
            features, labels = sites[hospital]
            local = local_train(
                algorithm, parameters, features, labels, local_epochs, batch_size,
                seed + round_index * 1009 + site_index * 9173, rate,
            )
            clients.append((len(labels) / total, local))
        parameters = {
            key: sum(weight * local[key] for weight, local in clients)
            for key in parameters
        }
    return parameters


@dataclass
class HistogramEnsemble:
    models: list[HistGradientBoostingClassifier]

    def predict(self, transformed: list[np.ndarray]) -> np.ndarray:
        return np.mean([model.predict_proba(features)[:, 1] for model, features in zip(self.models, transformed)], axis=0)


def fit_histogram_ensemble(sites: dict[int, tuple[np.ndarray, np.ndarray]], seed: int, iterations: int) -> HistogramEnsemble:
    models = []
    for offset, hospital in enumerate(TRAINING_HOSPITALS):
        features, labels = sites[hospital]
        model = HistGradientBoostingClassifier(
            learning_rate=.05, max_iter=iterations, max_depth=6, max_bins=255,
            class_weight="balanced", random_state=seed + offset,
        )
        model.fit(features, labels)
        models.append(model)
    return HistogramEnsemble(models)


def calibration(labels: np.ndarray, probabilities: np.ndarray) -> tuple[float, float]:
    logits = np.log(np.clip(probabilities, 1e-6, 1 - 1e-6) / np.clip(1 - probabilities, 1e-6, 1))[:, None]
    model = LogisticRegression(C=1e6, solver="lbfgs", max_iter=1000).fit(logits, labels)
    return float(model.coef_[0, 0]), float(model.intercept_[0])


def bootstrap_auc(labels: np.ndarray, probabilities: np.ndarray, seed: int, resamples: int) -> list[float]:
    rng = np.random.default_rng(seed)
    positive = np.flatnonzero(labels == 1)
    negative = np.flatnonzero(labels == 0)
    values = np.empty(resamples)
    for index in range(resamples):
        sample = np.concatenate([
            rng.choice(positive, len(positive), replace=True),
            rng.choice(negative, len(negative), replace=True),
        ])
        values[index] = roc_auc_score(labels[sample], probabilities[sample])
    return [float(value) for value in np.quantile(values, [.025, .975])]


def select_threshold(labels: np.ndarray, probabilities: np.ndarray) -> float:
    candidates = np.unique(np.quantile(probabilities, np.linspace(0, 1, 401)))
    scores = np.asarray([f1_score(labels, probabilities >= value, zero_division=0) for value in candidates])
    return float(candidates[int(np.argmax(scores))])


def metric_set(labels: np.ndarray, probabilities: np.ndarray, threshold: float, seed: int, resamples: int) -> dict[str, Any]:
    predicted = probabilities >= threshold
    slope, intercept = calibration(labels, probabilities)
    return {
        "records": int(len(labels)),
        "outcomes": int(labels.sum()),
        "auroc": float(roc_auc_score(labels, probabilities)),
        "auroc_ci95": bootstrap_auc(labels, probabilities, seed, resamples),
        "auprc": float(average_precision_score(labels, probabilities)),
        "precision": float(precision_score(labels, predicted, zero_division=0)),
        "recall": float(recall_score(labels, predicted, zero_division=0)),
        "f1": float(f1_score(labels, predicted, zero_division=0)),
        "brier": float(brier_score_loss(labels, probabilities)),
        "calibration_slope": slope,
        "calibration_intercept": intercept,
    }


def privacy_accounting(rounds: int, local_epochs: int, batch_size: int) -> dict[str, Any]:
    delta = 1e-5
    noise = DP_SGD_NOISE_MULTIPLIER
    values = {}
    for hospital in TRAINING_HOSPITALS:
        records = EXPECTED_COUNTS[hospital]
        sampling_rate = min(1.0, batch_size / records)
        steps = rounds * local_epochs * math.ceil(records / batch_size)
        # Conservative small-q analytical approximation.  This is explicitly
        # reported as an estimate, not a formal accountant certificate.
        epsilon = sampling_rate * math.sqrt(2 * steps * math.log(1 / delta)) / noise + steps * sampling_rate ** 2 / (noise ** 2)
        values[str(hospital)] = {"records": records, "sampling_rate": sampling_rate, "steps": steps, "epsilon_estimate": epsilon}
    return {
        "accountant": "conservative_small_q_analytical_estimate",
        "formal_certificate": False,
        "max_grad_norm": DP_SGD_CLIP_NORM,
        "noise_multiplier": noise,
        "delta": delta,
        "sites": values,
        "epsilon_max": max(value["epsilon_estimate"] for value in values.values()),
    }


def validate_approvals(path: Path, protocol_hash: str) -> dict[str, Any]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("protocolHash") != protocol_hash:
        raise ValueError("Approval manifest does not bind the exact protocol hash")
    approvals = manifest.get("approvals", [])
    expected = {str(value) for value in [*TRAINING_HOSPITALS, VALIDATION_HOSPITAL]}
    observed = {str(value.get("hospitalId")) for value in approvals if value.get("decision") == "APPROVED"}
    if observed != expected:
        raise ValueError(f"Synthetic approval manifest must approve exactly hospitals {sorted(expected)}")
    if manifest.get("approvalMode") != "SYNTHETIC_E2E":
        raise ValueError("Only explicitly labelled SYNTHETIC_E2E approval manifests are accepted by this simulation runner")
    return manifest


def run_algorithm(
    algorithm: str,
    sites: dict[int, SiteRows],
    categories: list[list[str]],
    rounds: int,
    local_epochs: int,
    batch_size: int,
    histogram_iterations: int,
    folds: int,
    resamples: int,
    seed: int,
) -> dict[str, Any]:
    started = time.monotonic()
    splitters = {
        hospital: list(StratifiedKFold(folds, shuffle=True, random_state=seed + hospital).split(np.zeros(len(sites[hospital].labels)), sites[hospital].labels))
        for hospital in TRAINING_HOSPITALS
    }
    cv_labels: dict[int, list[np.ndarray]] = {hospital: [] for hospital in TRAINING_HOSPITALS}
    cv_probabilities: dict[int, list[np.ndarray]] = {hospital: [] for hospital in TRAINING_HOSPITALS}
    for fold in range(folds):
        train_data: dict[int, tuple[np.ndarray, np.ndarray]] = {}
        preprocessors: dict[int, SitePreprocessor] = {}
        validation_rows: dict[int, SiteRows] = {}
        for hospital in TRAINING_HOSPITALS:
            train_indexes, validation_indexes = splitters[hospital][fold]
            local_train_rows = subset(sites[hospital], train_indexes)
            processor = SitePreprocessor(categories).fit(local_train_rows)
            preprocessors[hospital] = processor
            train_data[hospital] = (processor.transform(local_train_rows), local_train_rows.labels)
            validation_rows[hospital] = subset(sites[hospital], validation_indexes)
        if algorithm == "federated_xgboost":
            model: Any = fit_histogram_ensemble(train_data, seed + fold * 101, histogram_iterations)
        else:
            model = federated_parameters(algorithm, train_data, rounds, local_epochs, batch_size, seed + fold * 101)
        for hospital in TRAINING_HOSPITALS:
            rows = validation_rows[hospital]
            if algorithm == "federated_xgboost":
                transformed = [preprocessors[source].transform(rows) for source in TRAINING_HOSPITALS]
                probabilities = model.predict(transformed)
            else:
                probabilities = predict_parameters(model, preprocessors[hospital].transform(rows))
            cv_labels[hospital].append(rows.labels)
            cv_probabilities[hospital].append(probabilities)

    joined_labels = {hospital: np.concatenate(values) for hospital, values in cv_labels.items()}
    joined_probabilities = {hospital: np.concatenate(values) for hospital, values in cv_probabilities.items()}
    all_labels = np.concatenate([joined_labels[hospital] for hospital in TRAINING_HOSPITALS])
    all_probabilities = np.concatenate([joined_probabilities[hospital] for hospital in TRAINING_HOSPITALS])
    threshold = select_threshold(all_labels, all_probabilities)
    training_metrics = {
        str(hospital): metric_set(joined_labels[hospital], joined_probabilities[hospital], threshold, seed + hospital, resamples)
        for hospital in TRAINING_HOSPITALS
    }

    final_data: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    final_processors: dict[int, SitePreprocessor] = {}
    for hospital in TRAINING_HOSPITALS:
        processor = SitePreprocessor(categories).fit(sites[hospital])
        final_processors[hospital] = processor
        final_data[hospital] = (processor.transform(sites[hospital]), sites[hospital].labels)
    if algorithm == "federated_xgboost":
        final_model: Any = fit_histogram_ensemble(final_data, seed + 9001, histogram_iterations)
        external_probability = final_model.predict([final_processors[hospital].transform(sites[VALIDATION_HOSPITAL]) for hospital in TRAINING_HOSPITALS])
        implementation = "horizontal_site_model_histogram_ensemble"
    else:
        final_model = federated_parameters(algorithm, final_data, rounds, local_epochs, batch_size, seed + 9001)
        external_probability = np.mean([
            predict_parameters(final_model, final_processors[hospital].transform(sites[VALIDATION_HOSPITAL]))
            for hospital in TRAINING_HOSPITALS
        ], axis=0)
        implementation = "horizontal_parameter_averaging_simulation"
    external = metric_set(sites[VALIDATION_HOSPITAL].labels, external_probability, threshold, seed + VALIDATION_HOSPITAL, resamples)
    baseline = BASELINES[algorithm]
    result: dict[str, Any] = {
        "schema_version": "1.0",
        "algorithm": algorithm,
        "implementation": implementation,
        "simulation_not_production_nvflare": True,
        "seed": seed,
        "rounds": rounds,
        "local_epochs": local_epochs,
        "batch_size": batch_size,
        "threshold": {"value": threshold, "selection": "maximum_f1_from_training_cross_validation_only"},
        "training_sites": training_metrics,
        "mean_training_site_auroc": float(np.mean([value["auroc"] for value in training_metrics.values()])),
        "pooled_training_cv": metric_set(all_labels, all_probabilities, threshold, seed + 77, resamples),
        "external_validation_hospital": VALIDATION_HOSPITAL,
        "external_validation": external,
        "paper_baseline": baseline,
        "difference_from_paper_baseline": {key: external[key] - value for key, value in baseline.items()},
        "duration_seconds": time.monotonic() - started,
    }
    if algorithm == "dpsgd_mlp":
        result["privacy"] = privacy_accounting(rounds, local_epochs, batch_size)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the approved six-hospital eICU FL simulation")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--protocol", type=Path, required=True)
    parser.add_argument("--approvals", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--algorithms", default=",".join(ALGORITHMS))
    parser.add_argument("--rounds", type=int)
    parser.add_argument("--local-epochs", type=int)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--bootstrap-resamples", type=int, default=2000)
    parser.add_argument("--histogram-iterations", type=int, default=200)
    args = parser.parse_args()
    if args.output.exists() and any(args.output.iterdir()):
        parser.error("Output directory must be absent or empty; result packages are immutable")
    args.output.mkdir(parents=True, exist_ok=True)

    summary = validate_dataset(args.dataset.resolve())
    protocol = json.loads(args.protocol.read_text(encoding="utf-8"))
    expected_protocol = build_protocol(summary)
    if protocol.get("protocol_hash") != expected_protocol["protocol_hash"]:
        raise ValueError("Protocol does not match the frozen dataset and implementation contract")
    approvals = validate_approvals(args.approvals, protocol["protocol_hash"])
    jobs = {job["algorithm"]: job for job in protocol["jobs"]}
    selected = [value.strip() for value in args.algorithms.split(",") if value.strip()]
    if not selected or set(selected) - set(ALGORITHMS):
        parser.error(f"Algorithms must be selected from {ALGORITHMS}")
    sites, categories = load_sites(args.dataset.resolve())
    manifest = {
        "schema_version": "1.0",
        "status": "RUNNING",
        "dataset_sha256": summary["dataset_sha256"],
        "protocol_hash": protocol["protocol_hash"],
        "approval_manifest_sha256": sha256_file(args.approvals),
        "approval_mode": approvals["approvalMode"],
        "algorithms": selected,
        "python": sys.version,
        "platform": platform.platform(),
        "started_at_epoch": time.time(),
        "results": {},
    }
    atomic_json(args.output / "run_manifest.json", manifest)
    table_rows = []
    for index, algorithm in enumerate(selected):
        specification = jobs[algorithm]
        result = run_algorithm(
            algorithm, sites, categories,
            args.rounds or int(specification["rounds"]),
            args.local_epochs or int(specification["local_epochs"]),
            int(specification["batch_size"]),
            args.histogram_iterations,
            args.folds,
            args.bootstrap_resamples,
            int(specification["seed"]),
        )
        path = args.output / f"{algorithm}.json"
        atomic_json(path, result)
        manifest["results"][algorithm] = {"sha256": sha256_file(path), "duration_seconds": result["duration_seconds"]}
        atomic_json(args.output / "run_manifest.json", manifest)
        external = result["external_validation"]
        table_rows.append({
            "algorithm": algorithm,
            "mean_training_site_auroc": result["mean_training_site_auroc"],
            "external_auroc": external["auroc"],
            "external_auroc_ci_lower": external["auroc_ci95"][0],
            "external_auroc_ci_upper": external["auroc_ci95"][1],
            "external_auprc": external["auprc"],
            "external_precision": external["precision"],
            "external_recall": external["recall"],
            "external_f1": external["f1"],
            "external_brier": external["brier"],
            "baseline_auroc": result["paper_baseline"]["auroc"],
            "auroc_difference": result["difference_from_paper_baseline"]["auroc"],
        })
        print(f"[{index + 1}/{len(selected)}] {algorithm}: external AUROC={external['auroc']:.4f}", flush=True)
    with (args.output / "results_table.csv").open("w", newline="", encoding="utf-8") as target:
        writer = csv.DictWriter(target, fieldnames=list(table_rows[0]))
        writer.writeheader()
        writer.writerows(table_rows)
    manifest["status"] = "COMPLETED"
    manifest["completed_at_epoch"] = time.time()
    manifest["results_table_sha256"] = sha256_file(args.output / "results_table.csv")
    manifest["run_hash"] = canonical_hash({key: value for key, value in manifest.items() if key != "run_hash"})
    atomic_json(args.output / "run_manifest.json", manifest)
    print(json.dumps({"status": manifest["status"], "run_hash": manifest["run_hash"], "output": str(args.output)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
