"""NVFLARE Client API training script (runs at every hospital site).

Fedlify bakes this repository into the study image at /opt/fedlify/code, and the job launches
`python3 -u /opt/fedlify/code/client.py`. Site data is mounted read-only at FEDLIFY_DATA_PATH.
"""

import json
import os
from pathlib import Path

import nvflare.client as flare
from nvflare.app_common.np.constants import NPConstants

from model import LogisticModel, prepare_features, read_site_frame, split

CODE_DIR = Path(os.environ.get("FEDLIFY_CODE_DIR", Path(__file__).resolve().parent))


def main() -> None:
    config = json.loads((CODE_DIR / "fedlify-pipeline.json").read_text())
    contract, hyper = config["dataContract"], config.get("hyperparameters", {})

    x, y = prepare_features(read_site_frame(os.environ.get("FEDLIFY_DATA_PATH", "/data")), contract)
    x_train, y_train, x_valid, y_valid = split(x, y, hyper.get("validationFraction", 0.2), hyper.get("seed", 42))
    model = LogisticModel(n_features=x.shape[1], **hyper)

    flare.init()
    site = flare.get_site_name()
    print(f"[{site}] {len(y_train)} training rows, {len(y_valid)} validation rows, {x.shape[1]} features", flush=True)

    while flare.is_running():
        global_model = flare.receive()
        model.set_weights(global_model.params[NPConstants.NUMPY_KEY])

        # Metrics of the received global model on this site's validation split (used for model selection).
        global_metrics = model.evaluate(x_valid, y_valid)
        model.fit(x_train, y_train)
        print(f"[{site}] round {global_model.current_round}: global {global_metrics}", flush=True)

        flare.send(
            flare.FLModel(
                params={NPConstants.NUMPY_KEY: model.get_weights()},
                metrics=global_metrics,
                meta={"NUM_STEPS_CURRENT_ROUND": len(y_train)},
            )
        )


if __name__ == "__main__":
    main()
