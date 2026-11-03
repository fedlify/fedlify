"""Runs at publish time in CI (python -m unittest discover -s tests). Uses synthetic rows only."""

import json
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from model import LogisticModel, prepare_features, split

CONFIG = json.loads((Path(__file__).resolve().parents[1] / "fedlify-pipeline.json").read_text())


def synthetic_frame(rows: int = 200) -> pd.DataFrame:
    rng = np.random.default_rng(0)
    contract = CONFIG["dataContract"]
    frame = pd.DataFrame({name: rng.normal(size=rows) for name in contract["features"]})
    risk = frame[contract["features"][0]] + 0.5 * frame[contract["features"][1]]
    frame[contract["label"]] = np.where(risk > 0.5, contract["positiveValue"], "Alive")
    return frame


class ModelTest(unittest.TestCase):
    def test_contract_columns_and_training_improve_loss(self):
        x, y = prepare_features(synthetic_frame(), CONFIG["dataContract"])
        x_train, y_train, x_valid, y_valid = split(x, y, 0.2, 1)
        model = LogisticModel(n_features=x.shape[1], **CONFIG["hyperparameters"])
        model.set_weights(np.zeros((3, 3)))  # aggregator's placeholder initial model
        before = model.evaluate(x_valid, y_valid)["loss"]
        for _ in range(5):
            model.fit(x_train, y_train)
        self.assertLess(model.evaluate(x_valid, y_valid)["loss"], before)
        self.assertEqual(model.get_weights().shape, (x.shape[1] + 1,))

    def test_missing_contract_column_is_rejected(self):
        frame = synthetic_frame().drop(columns=[CONFIG["dataContract"]["features"][0]])
        with self.assertRaises(ValueError):
            prepare_features(frame, CONFIG["dataContract"])


if __name__ == "__main__":
    unittest.main()
