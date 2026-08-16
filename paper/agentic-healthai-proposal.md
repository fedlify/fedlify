# Proposal: Agentic HealthAI for Governed Federated Learning

## Core idea

Agentic HealthAI is a governance-aware multi-agent layer for health federated learning. It sits above Fedlify and NVFLARE: Fedlify provides the regulated collaboration control plane, NVFLARE provides the federated runtime, and Agentic HealthAI plans, checks, generates, monitors, and documents the study workflow through specialized agents, tools, memory, and human approval gates.

Based on the recent Agentic AI definition, the system is not only a chatbot. It decomposes a high-level study objective into sub-goals, chooses tools, executes multi-step workflows, verifies outputs, remembers prior decisions, and asks humans to approve safety-critical steps.

## Proposed thesis framing

Current health FL platforms can run decentralized training, but clinical teams still struggle to translate protocols into governed, privacy-preserving, reproducible FL workflows. Agentic HealthAI addresses this gap by adding an agentic orchestration layer that understands clinical study context, data modality, privacy/security constraints, site readiness, FL algorithm choices, deployment constraints, runtime events, and audit/reporting requirements.

The contribution is a governed agentic framework for health AI federated learning that:

- Converts protocol and site metadata into an executable FL study plan.
- Selects or recommends FL topology, training strategy, privacy controls, and NVFLARE workflow type.
- Generates and reviews Fedlify/NVFLARE pipeline artifacts without accessing raw clinical data.
- Monitors federated execution and triages failures using logs, readiness signals, and policy constraints.
- Produces reproducible evidence packages for ethics, governance, audit, and scientific reporting.

## Four-layer framework

The framework can be presented as four layers. Each layer has a public-facing purpose, concrete stages, and supporting components. The important message is that the user sees a simple governed health AI workflow, while the lower layers translate it into agentic planning, Fedlify/NVFLARE execution, and distributed infrastructure.

| Layer | Public-facing role | Main stages | Supporting components |
| --- | --- | --- | --- |
| **L1. Health AI applications** | Defines why the collaboration exists clinically. | Create study, define objective and outcome, select clinical application, describe modality and sites, review result. | Study protocol, population, outcome, disease category, multimodal data description, human researchers. |
| **L2. Agentic workflow and governance** | Turns the study goal into a safe, governed FL plan. | Intake, eligibility, FL design, privacy review, orchestration, code generation, monitoring, audit reporting. | Planner, memory, RAG, reflection, policy checker, Fedlify APIs, RBAC, ethics gates, Gitea review, audit log, human approval gates. |
| **L3. Federated execution** | Runs the approved study without moving raw data. | Provision, configure aggregator, generate startup kits, start sites, train/evaluate, collect metrics, release model evidence. | NVFLARE controller, server/aggregator, admin client, site clients, FedAvg/FedOpt/FedProx/Scaffold, secure aggregation, differential privacy, runtime events. |
| **L4. Distributed infrastructure** | Provides the deployment substrate across institutions. | Build, deploy, store artifacts, send messages, observe runtime, recover failures. | Docker, Kubernetes, Argo Workflows, Argo CD, Gitea, PostgreSQL, MinIO/S3, Vault, Harbor, networking, hospital on-prem or cloud environments. |

Raw clinical data remains outside Fedlify and outside the agent memory. The system should only use approved metadata, schemas, aggregate summaries, synthetic fixtures, logs, manifests, and signed artifacts.

## Agent skills

| Skill | Goal | Main tools | Human gate |
| --- | --- | --- | --- |
| Study intake and eligibility | Convert protocol text into structured FL requirements | RAG over protocol, Fedlify study API, policy checker | PI/coordinator confirms study objective and intended use |
| Data readiness and federation design | Classify collaboration setting, data distribution, modality, topology, and training strategy | Site metadata API, schema summarizer, FL design rules | Data steward confirms site-local contract |
| Governance, privacy, and safety review | Check ethics status, privacy constraints, RBAC, release conditions, and data-boundary risks | Ethics API, RBAC/audit API, privacy checklist, PII/raw-file detector | Privacy officer or study owner approval |
| Workflow planning and orchestration | Produce ordered tasks for provisioning, site readiness, training, evaluation, and release | Planner, scheduler, Fedlify workflow state, Argo/GitOps | Coordinator approves run plan |
| Template-bound code generation | Generate NVFLARE project files, tests, manifests, and documentation from approved templates | Gitea, template library, code generator, test runner | Code review and pipeline approval |
| Runtime monitoring and failure triage | Interpret readiness, heartbeats, NVFLARE status, logs, and failed rounds | NVFLARE adapter, log search, run-event API | Site operator confirms local remediation |
| Reproducibility, audit, and reporting | Create evidence package for methods, parameters, versions, approvals, and outputs | Audit log, checksum/signature records, model release metadata | Study owner approves release/report |

## Tool registry

Agentic HealthAI should expose tools with strict scopes:

- `study_protocol_reader`: extracts study goal, population, outcome, intended use, and exclusions.
- `fl_design_classifier`: maps the study to cross-silo/cross-device/hybrid, horizontal/vertical/partial overlap, centralized/decentralized/hierarchical, and sync/async/personalized FL.
- `privacy_policy_checker`: checks differential privacy, secure aggregation, encryption, trusted execution, and prohibited data movement.
- `fedlify_study_api`: reads/writes governed study metadata, never raw patient data.
- `site_readiness_api`: reads site participation, heartbeat, resource, and readiness status.
- `pipeline_template_selector`: recommends approved templates such as NVFLARE FedAvg, evaluation-only, preprocessing, or personalized FL.
- `nvflare_kit_generator`: requests participant kit generation through Fedlify worker and records artifacts.
- `gitea_code_review_tool`: opens draft PRs, validates generated code, and records review status.
- `runtime_monitor`: reads aggregator/site runner status, logs, and NVFLARE job events.
- `audit_report_builder`: produces reproducibility manifests, approval traces, and publication-ready methods summaries.

## Memory design

The agent should keep three memory stores:

- **Study memory:** protocol objective, cohort metadata, outcome definition, sites, modality, topology, privacy plan, approved pipeline versions.
- **Operational memory:** prior run failures, site readiness patterns, validated templates, environment constraints, runtime parameters.
- **Evidence memory:** retrieved guideline passages, relevant FL papers, design rationales, approvals, checksums, audit events.

Memory must be scoped by study and role. Site-local secrets, identifiers, raw paths, raw datasets, and patient-level data should never be stored.

## Workflow

1. Researcher submits a clinical FL objective and protocol metadata.
2. Intake agent structures the objective and identifies missing governance fields.
3. Design agent classifies the collaboration setting, data distribution, data modality, topology, privacy/security controls, and training strategy.
4. Governance agent checks ethics status, role permissions, release conditions, and data-boundary risks.
5. Planning agent creates a runbook: site onboarding, readiness checks, template selection, code generation, validation, provisioning, run submission, and reporting.
6. Code agent generates a template-bound NVFLARE pipeline in Gitea and opens a draft review path.
7. Human reviewers approve the pipeline version and release gates.
8. Runtime agent monitors aggregator and site runners, diagnoses failures, and proposes bounded remediation.
9. Reporting agent produces an audit-ready evidence package and method summary.

## Evaluation plan

Evaluate the framework on both agentic performance and health-FL governance performance:

- **Task success:** percentage of complete study plans, runnable NVFLARE templates, passed validation checks, completed smoke runs.
- **Design correctness:** agreement with expert labels for topology, modality, data distribution, privacy controls, and training strategy.
- **Governance safety:** blocked raw-data uploads, correct ethics/release gating, RBAC compliance, audit completeness.
- **Runtime usefulness:** time to diagnose failed runs, accuracy of triage recommendations, reduction in coordinator/site-operator effort.
- **Reproducibility:** completeness of manifests, checksums, parameter capture, code versioning, and report traceability.
- **Human trust:** reviewer acceptance rate, number of prompt/code revisions, perceived workload, and explainability of decisions.

## Suggested figure caption

**Figure X. Four-layer Agentic HealthAI framework for governed federated learning.** The top layer represents health AI research goals and clinical study objectives. The second layer introduces an agentic workflow and governance layer that performs intake, FL design, privacy review, orchestration, code generation, monitoring, and reporting through bounded tools and human approval gates. The third layer maps the approved plan to NVFLARE-based federated execution, including provisioning, startup kits, aggregator/site clients, training, evaluation, and model evidence. The fourth layer provides the distributed infrastructure such as Docker, Kubernetes, GitOps, Gitea, object storage, databases, and secure deployment environments. Raw clinical data remains inside hospital sites.
