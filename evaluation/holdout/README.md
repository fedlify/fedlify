# Sealed holdout protocol

The publication holdout must be authored independently after the implementation commit is frozen. Do not copy or transform the 144 development probes and do not expose expected outcomes to the executor.

The independent evaluator supplies a JSON case file and fixture directory outside the repository. Seal them once with:

```sh
python3 evaluation/probes/seal_holdout.py \
  --cases /external/holdout/cases.json \
  --fixtures /external/holdout/fixtures \
  --output .fedlify-evaluation/holdout/manifest.json
```

Keep the case oracle with the scorer. The live executor receives only actor, study context, request text, fixture name, content and hashes. Preserve the manifest and raw observations without overwriting them.
