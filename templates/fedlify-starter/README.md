# Fedlify study pipeline

Federated logistic regression (FedAvg) on tabular site data, using the NVFLARE Client API.
This is the Fedlify starter repository: new projects are cloned from it, and every **Save** in
Fedlify commits to the project's copy.

| File | Purpose |
|---|---|
| `client.py` | Training loop run at every hospital (`flare.receive` → train → `flare.send`). |
| `model.py` | Site-local data loading and the model. Raw rows never leave the site. |
| `fedlify-pipeline.json` | Data contract (label, features), hyperparameters, run defaults. |
| `requirements.txt` | Extra pinned Python packages baked into the study image. |
| `job/` | NVFLARE job (FedAvg server + Client API launcher). Rounds and min clients are set at run time. |
| `tests/` | Unit tests run on synthetic data when the project is published. |

## What happens on Publish
1. CI checks the repository (layout, no data files, no secrets, `python -m unittest`).
2. CI builds `harbor.fedlify.com/fedlify-studies/<study>:v<N>` from the Fedlify NVFLARE base image with this code at `/opt/fedlify/code`.
3. Fedlify provisions the study aggregator at `<study>.fedlify.com:443`.
4. Each site downloads its kit, mounts its data at `FEDLIFY_DATA_PATH`, and runs the same image.

## Run locally (no data leaves your machine)
```sh
python -m unittest discover -s tests
```
