"""Frozen six-hospital eICU protocol and aggregate-only validation."""

from __future__ import annotations

import csv
import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any

TARGET = "hospitaldischargestatus"
SITE = "hospitalid"
TRAINING_HOSPITALS = [420, 243, 73, 188, 122]
VALIDATION_HOSPITAL = 252
EXPECTED_COUNTS = {420: 3600, 243: 2700, 73: 2431, 188: 2299, 122: 2186, 252: 1930}
FORBIDDEN_COLUMNS = {"patientunitstayid", "patienthealthsystemstayid", "uniquepid"}
EXPECTED_COLUMNS = [
    "hospitaldischargestatus", "hospitalid", "gender", "age", "ethnicity", "admissionheight",
    "admissionweight", "creatinine", "chloride", "glucose", "hct", "hgb", "platelets_x_1000",
    "ptt", "pt", "sodium", "bun", "wbc_x_1000", "mchc", "rbc", "rdw", "heartrate",
    "o2_saturation", "respiratory_rate", "sao2_periodic", "temperature_periodic", "diabetes",
    "sepsis", "hypertension", "chronic_kidney_disease", "copd"
]
CATEGORICAL_FEATURES = ["gender", "ethnicity", "diabetes", "sepsis", "hypertension", "chronic_kidney_disease", "copd"]
# Excluded from training despite being present in the raw dataset (EXPECTED_COLUMNS is left
# unchanged so schema validation still matches the actual file): both fields are missing for
# most stays (97.3% and 34.2%), and the missingness itself leaks the outcome rather than being
# random -- temperature_periodic is recorded for only 2.7% of patients, and that 2.7% has a
# 59.4% mortality rate versus 11.0% when absent, consistent with periodic vitals being captured
# during closer, later-stay monitoring rather than at admission. A model can exploit "was this
# ever recorded" as a proxy for "this patient was already deteriorating," which a real
# admission-time triage tool could not observe.
LEAKAGE_EXCLUDED_FEATURES = ["sao2_periodic", "temperature_periodic"]
CONTINUOUS_FEATURES = [column for column in EXPECTED_COLUMNS if column not in {TARGET, SITE, *CATEGORICAL_FEATURES, *LEAKAGE_EXCLUDED_FEATURES}]
ALGORITHMS = ["fedavg_mlp", "fedprox_mlp", "dpsgd_mlp", "federated_logistic_regression", "federated_xgboost"]
SEED = 20260806


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def normalize_outcome(value: str) -> int | None:
    normalized = value.strip().lower()
    if not normalized:
        return None
    if normalized in {"expired", "dead", "1", "true"}:
        return 1
    if normalized in {"alive", "0", "false"}:
        return 0
    raise ValueError(f"Unexpected hospital discharge status: {value!r}")


def validate_dataset(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"Dataset not found: {path}")
    counts: Counter[int] = Counter()
    deaths: Counter[int] = Counter()
    missing_outcome = 0
    total_rows = 0
    with path.open(newline="", encoding="utf-8-sig") as source:
        reader = csv.DictReader(source)
        columns = reader.fieldnames or []
        if columns != EXPECTED_COLUMNS:
            raise ValueError(f"Dataset schema mismatch. Expected {EXPECTED_COLUMNS}, found {columns}")
        if FORBIDDEN_COLUMNS.intersection(columns):
            raise ValueError("Patient identifiers are forbidden in the prepared case-study input")
        for row in reader:
            total_rows += 1
            outcome = normalize_outcome(row[TARGET])
            if outcome is None:
                missing_outcome += 1
                continue
            hospital = int(float(row[SITE]))
            if hospital in EXPECTED_COUNTS:
                counts[hospital] += 1
                deaths[hospital] += outcome
    if dict(counts) != EXPECTED_COUNTS:
        raise ValueError(f"Frozen cohort count mismatch. Expected {EXPECTED_COUNTS}, found {dict(counts)}")
    if sum(counts[hospital] for hospital in TRAINING_HOSPITALS) != 13216:
        raise ValueError("Training cohort must contain exactly 13,216 stays")
    return {
        "dataset_sha256": sha256_file(path),
        "source_rows": total_rows,
        "rows_excluded_missing_outcome": missing_outcome,
        "training_rows": 13216,
        "external_validation_rows": counts[VALIDATION_HOSPITAL],
        "sites": {
            str(hospital): {
                "role": "external_validation" if hospital == VALIDATION_HOSPITAL else "training",
                "stays": counts[hospital],
                "deaths": deaths[hospital],
                "mortality_rate": deaths[hospital] / counts[hospital]
            }
            for hospital in EXPECTED_COUNTS
        }
    }


def job_specifications() -> list[dict[str, Any]]:
    common = {
        "seed": SEED,
        "rounds": 12,
        "local_epochs": 5,
        "batch_size": 64,
        "training_hospitals": TRAINING_HOSPITALS,
        "external_validation_hospital": VALIDATION_HOSPITAL,
        "preprocessing": "fold-and-site-local",
        "class_imbalance": "balanced_class_weights",
        "threshold": "maximum_f1_from_training_cross_validation_only"
    }
    return [
        {**common, "algorithm": "fedavg_mlp", "model": {"hidden_layers": [64, 32], "activation": "relu", "optimizer": "adam", "learning_rate": 0.001}},
        {**common, "algorithm": "fedprox_mlp", "model": {"hidden_layers": [64, 32], "activation": "relu", "optimizer": "adam", "learning_rate": 0.001, "proximal_mu": 0.01}},
        {**common, "algorithm": "dpsgd_mlp", "model": {"hidden_layers": [64, 32], "activation": "relu", "optimizer": "dpsgd", "learning_rate": 0.001, "max_grad_norm": 1.0, "noise_multiplier": 0.08, "delta": 0.00001}},
        {**common, "algorithm": "federated_logistic_regression", "model": {"penalty": "l2", "optimizer": "sgd", "learning_rate": 0.01}},
        {**common, "algorithm": "federated_xgboost", "model": {"booster": "hist", "n_estimators": 200, "max_depth": 6, "learning_rate": 0.05, "max_bin": 256}}
    ]


def build_protocol(dataset_summary: dict[str, Any]) -> dict[str, Any]:
    protocol = {
        "schema_version": "1.0",
        "status": "DRAFT_REQUIRES_EXPERT_APPROVAL",
        "dataset": {"sha256": dataset_summary["dataset_sha256"], "read_only_external_mount": True},
        "cohort": {"training_hospitals": TRAINING_HOSPITALS, "external_validation_hospital": VALIDATION_HOSPITAL, "expected_counts": EXPECTED_COUNTS, "exclude_missing_outcome": True},
        "feature_contract": {"target": TARGET, "site_column": SITE, "continuous": CONTINUOUS_FEATURES, "categorical": CATEGORICAL_FEATURES, "forbidden": sorted(FORBIDDEN_COLUMNS), "expert_approval_required": True},
        "preprocessing": {
            "continuous_imputation": "training_partition_median", "categorical_imputation": "training_partition_most_frequent",
            "continuous_scaling": "training_partition_standard_scaler", "categorical_encoding": "training_partition_one_hot_ignore_unknown",
            "cross_validation": "stratified_5_fold_within_training_hospitals", "imbalance": "class_weights_only", "smote": False,
            "external_validation_fit": False
        },
        "evaluation": {
            "metrics": ["auroc", "auprc", "precision", "recall", "f1", "brier", "calibration_slope", "calibration_intercept"],
            "confidence_intervals": {"method": "stratified_bootstrap", "level": 0.95, "resamples": 2000, "seed": SEED},
            "baseline_role": "comparison_only"
        },
        "jobs": job_specifications(),
        "privacy": {"patient_rows_in_control_plane": False, "patient_rows_in_git": False, "patient_rows_in_agent_prompts": False, "aggregate_outputs_only": True}
    }
    protocol["protocol_hash"] = canonical_hash(protocol)
    return protocol
