# Fedlify — Agentic Federated Learning for Health AI

## Who we are
A research group at the **Institute of Health Policy, Management & Evaluation (Dalla Lana School of Public Health), University of Toronto**, working at the intersection of health informatics, machine learning systems, and AI governance. Collaboration with the University of Calgary (software engineering).

## Field
Applied health AI and federated learning (FL). We focus on the **operational and governance** side of multi-institution health AI — the parts that keep FL from being used in practice — rather than on new training algorithms.

## The problem we work on
Generalizable health AI needs data from many institutions (EHR, medical imaging, genomics, biosignals), but privacy law, governance requirements, and institutional silos block raw-data sharing. Federated learning lets sites train a shared model while data stay local, yet adoption is tiny: in a review of ~3,100 patient-level AI studies (2018–2025) only ~5% of multicenter studies used FL, and only ~5.2% of healthcare FL studies describe real-world use. The bottleneck is **operational, not algorithmic** — workflow orchestration, governance integration, reproducibility, and deployment.

## Current project: Fedlify
A platform that treats a federated study as a **governed workflow**, supporting the full lifecycle: study intake → data-readiness & federation design → governance/privacy review → template-bound configuration & site-kit generation → local training → aggregation → monitoring → reproducibility package & reporting.

A key component is a **bounded LLM coordination agent** built as versioned "skill cards" (each with explicit trigger, inputs, allowed tools, output schema, validation tests, stop conditions, and a human-approval gate). Design principle is **controlled agency**: the agent can gather metadata, draft plans, and generate config from approved templates, but it *cannot* approve collaborations, access patient data, execute studies, release kits, or override governance.

## Methods & stack
- **Application layer:** Next.js 14 (app router), Prisma + PostgreSQL, role-based access control (study / site / platform roles), audit logging on all mutations, approval gates.
- **Federated runtime:** NVIDIA NVFlare, with Gitea (self-hosted Git) + MinIO/S3 for site-kit distribution; containerized services for heterogeneous environments.
- **Agent:** LLM-driven plan → act → check → revise loop over bounded platform tools; schema/permission validation on every generated artifact.
- **Evaluation:** comparison of 13 FL frameworks across 9 technical/operational/governance dimensions using a 5-submetric rubric, cross-checked with a blinded, evidence-locked LLM review (GPT-5.5 + Claude Sonnet) and human adjudication; plus a simulated multi-site study for end-to-end system validation and reproducibility.

## Status & next steps
System-level validation done in a simulated multi-site environment (consistent, reproducible runs; reduced coordination overhead). Next: full agent skill-card implementation, real-world multi-hospital deployment, clinical-system integration, and expanded privacy/security options (secure aggregation, differential privacy).

## Publications (in preparation)
- *Fedlify: An Agentic Federated Learning Platform for Health AI* — target: npj Digital Medicine.
- Scoping review of federated learning in patient-level health AI (~3,100 studies, 2018–2025).
