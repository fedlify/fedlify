# Guidance for coding agents

- Keep the NVFLARE Client API loop in `client.py`: `flare.init()`, then `while flare.is_running(): receive → train → send`.
- Send weights as `{NPConstants.NUMPY_KEY: <numpy array>}` and metrics as a flat dict of floats; include
  `NUM_STEPS_CURRENT_ROUND` in `meta` so aggregation is weighted by site size.
- Read site data only from `FEDLIFY_DATA_PATH`. Never add data files, credentials, or network calls.
- Keep `fedlify-pipeline.json` in sync with the code (label, features, hyperparameters).
- Extra packages go in `requirements.txt`, pinned with `==`.
- Do not change `job/app/config/config_fed_client.conf`'s launcher script path (`/opt/fedlify/code/client.py`).
- Update or add tests under `tests/`; they run on synthetic rows at publish time.
