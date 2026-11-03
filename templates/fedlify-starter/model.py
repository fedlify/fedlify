"""Site-local data loading and a numpy logistic-regression model for FedAvg.

Everything in this file runs inside the hospital's container; raw rows never leave the site.
Only the weight vector returned by `get_weights()` is sent to the aggregator.
"""

from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score


def read_site_frame(data_path: str) -> pd.DataFrame:
    path = Path(data_path)
    files = sorted(path.glob("*.csv")) if path.is_dir() else [path]
    if not files or not all(item.exists() for item in files):
        raise FileNotFoundError(f"No CSV data found at {data_path}. Mount the site extract at FEDLIFY_DATA_PATH.")
    return pd.concat([pd.read_csv(item) for item in files], ignore_index=True)


def prepare_features(frame: pd.DataFrame, contract: dict):
    missing = [column for column in [contract["label"], *contract["features"]] if column not in frame.columns]
    if missing:
        raise ValueError(f"Site data is missing contract columns: {missing}")
    if len(frame) < contract.get("minimumRows", 1):
        raise ValueError(f"Site has {len(frame)} rows; the data contract requires at least {contract['minimumRows']}.")

    features = frame[contract["features"]].apply(pd.to_numeric, errors="coerce")
    # Site-local imputation and scaling: statistics never leave the site.
    features = features.fillna(features.median()).fillna(0.0)
    std = features.std().replace(0, 1.0).fillna(1.0)
    features = (features - features.mean()) / std
    labels = (frame[contract["label"]].astype(str) == str(contract["positiveValue"])).astype(float)
    return features.to_numpy(dtype=np.float64), labels.to_numpy(dtype=np.float64)


def split(x, y, validation_fraction: float, seed: int):
    order = np.random.default_rng(seed).permutation(len(y))
    cut = max(1, int(len(y) * (1 - validation_fraction)))
    train, valid = order[:cut], order[cut:]
    return x[train], y[train], x[valid], y[valid]


class LogisticModel:
    def __init__(self, n_features: int, learningRate: float = 0.1, localEpochs: int = 5, l2: float = 0.0, **_):
        self.n_features = n_features
        self.learning_rate = learningRate
        self.local_epochs = localEpochs
        self.l2 = l2
        self.weights = np.zeros(n_features + 1)

    def set_weights(self, weights) -> None:
        weights = np.asarray(weights, dtype=np.float64).reshape(-1)
        # The aggregator's initial model has no shape for this study yet; start from zeros.
        self.weights = weights.copy() if weights.shape == (self.n_features + 1,) else np.zeros(self.n_features + 1)

    def get_weights(self) -> np.ndarray:
        return self.weights.copy()

    def predict_proba(self, x: np.ndarray) -> np.ndarray:
        logits = x @ self.weights[:-1] + self.weights[-1]
        return 1.0 / (1.0 + np.exp(-np.clip(logits, -30, 30)))

    def fit(self, x: np.ndarray, y: np.ndarray) -> None:
        for _ in range(self.local_epochs):
            error = self.predict_proba(x) - y
            gradient_w = x.T @ error / len(y) + self.l2 * self.weights[:-1]
            gradient_b = error.mean()
            self.weights[:-1] -= self.learning_rate * gradient_w
            self.weights[-1] -= self.learning_rate * gradient_b

    def evaluate(self, x: np.ndarray, y: np.ndarray) -> dict:
        probabilities = self.predict_proba(x)
        eps = 1e-12
        loss = -np.mean(y * np.log(probabilities + eps) + (1 - y) * np.log(1 - probabilities + eps))
        metrics = {"accuracy": float(((probabilities >= 0.5) == y).mean()), "loss": float(loss)}
        if len(np.unique(y)) == 2:
            metrics["auroc"] = float(roc_auc_score(y, probabilities))
        return metrics
