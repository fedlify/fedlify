# Fedlify LLM Evaluation Workflow

This folder contains the reproducible, evidence-locked workflow for adding GPT
and Claude assistive-coder evaluations to the FL framework comparison.

Run from `fedlify/`:

```bash
python3 paper/analysis/fedlify_llm_eval.py all
```

If `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are unset, the script still creates
the evidence packets, shared prompts, verification report, and derived workbook
with pending GPT/Claude rows. To run the model ratings:

```bash
export OPENAI_API_KEY=...
export ANTHROPIC_API_KEY=...
export GPT_MODEL=gpt-5.5
export CLAUDE_MODEL=claude-sonnet
python3 paper/analysis/fedlify_llm_eval.py run --rater both
python3 paper/analysis/fedlify_llm_eval.py build-workbook
python3 paper/analysis/fedlify_llm_eval.py verify
```

The prompt packets exclude human scores, bands, ranks, weighted totals,
`Score_Justifications`, and `Framework_Criteria_Coding` values. LLM outputs are
treated as assistive coding evidence and remain subject to human adjudication.
