// Mirrors probs/requirements.json (the same 29 requirements the probe suite scores against),
// inlined here so the app doesn't reach outside its own tree at runtime.

export type RequirementId =
  "R01" | "R02" | "R03" | "R04" | "R05" | "R06" | "R07" | "R08" | "R09" | "R10" | "R11" | "R12" | "R13" | "R14" | "R15" | "R16" | "R17" | "R18" | "R19" | "R20" | "R21" | "R22" | "R23" | "R24" | "R25" | "R26" | "R27" | "R28" | "R29";

export type RequirementDefinition = {
  id: RequirementId;
  title: string;
  definition: string;
};

export const REQUIREMENT_ORDER: RequirementId[] = ["R01", "R02", "R03", "R04", "R05", "R06", "R07", "R08", "R09", "R10", "R11", "R12", "R13", "R14", "R15", "R16", "R17", "R18", "R19", "R20", "R21", "R22", "R23", "R24", "R25", "R26", "R27", "R28", "R29"];

export const REQUIREMENTS: Record<RequirementId, RequirementDefinition> = {
  R01: { id: "R01", title: "Clinical purpose and FL suitability", definition: "Define the intended clinical or research use, target population, decision context, expected collaborative benefit, and why FL is preferable to feasible alternatives before selecting a platform." },
  R02: { id: "R02", title: "Consortium, site-readiness, and contribution planning", definition: "Select sites that can contribute clinically relevant data and sustained local capability, and assess each site's data, infrastructure, staff, constraints, incentives, and expected contribution." },
  R03: { id: "R03", title: "Multidisciplinary roles, coordination, and shared vocabulary", definition: "Create a working structure that connects clinical, data-science, engineering, IT, security, privacy, ethics, legal, project-management, and patient or public perspectives across institutions." },
  R04: { id: "R04", title: "Legal basis, ethics, and cross-site agreements", definition: "Establish the lawful and ethical basis for local data use, distributed computation, exchange of model artifacts, and cross-institutional collaboration in every participating jurisdiction." },
  R05: { id: "R05", title: "Accountability, ownership, and decision rights", definition: "Specify who owns or controls data, code, configurations, models, logs, and outputs, and who may approve, pause, release, modify, or retire them." },
  R06: { id: "R06", title: "Risk-proportionate oversight and approval gates", definition: "Match governance, privacy, security, validation, and release review to the sensitivity of the data, model capability, intended use, and potential clinical impact." },
  R07: { id: "R07", title: "Participation lifecycle, synchronized change control, and withdrawal", definition: "Define how sites join, approve tasks, request changes, pause, leave, or are removed while preserving safety, reproducibility, and consortium continuity." },
  R08: { id: "R08", title: "Common data specification and semantic interoperability", definition: "Create a shared, machine-actionable definition of variables, labels, units, coding systems, metadata, and allowable mappings across sites." },
  R09: { id: "R09", title: "Harmonized preprocessing, acquisition, and annotation", definition: "Ensure that local extraction, cohort construction, preprocessing, missing-data handling, acquisition, and labeling follow agreed protocols, or that deviations are measured and documented." },
  R10: { id: "R10", title: "Data quality and training-readiness validation", definition: "Run local checks to establish whether each site's data, metadata, labels, and references are complete, valid, correctly linked, and processable before federated execution." },
  R11: { id: "R11", title: "Representativeness, heterogeneity, and partition plan", definition: "Characterize clinical, demographic, temporal, acquisition, label, and site-level differences and design train, validation, test, and external-evaluation partitions accordingly." },
  R12: { id: "R12", title: "Compute, storage, network, and availability readiness", definition: "Verify that each site and coordinating service can meet agreed compute, storage, bandwidth, firewall, uptime, maintenance, and support requirements without disrupting clinical operations." },
  R13: { id: "R13", title: "Reproducible runtime and cross-site version compatibility", definition: "Standardize and version operating systems, libraries, drivers, containers or virtual environments, configurations, and update procedures so the same task executes consistently at every node." },
  R14: { id: "R14", title: "Clinical-system integration and secure local data access", definition: "Connect each FL node to approved local sources and third-party systems through least-privilege interfaces while preventing raw patient data from leaving the institution." },
  R15: { id: "R15", title: "Site onboarding, dry-run, and readiness gates", definition: "Use repeatable onboarding and non-sensitive or synthetic dry-runs to confirm connectivity, configuration, security, workflow, observability, and staffing before real training begins." },
  R16: { id: "R16", title: "Threat model and risk-tiered privacy/security controls", definition: "Identify credible threats to data, model updates, code, nodes, the aggregator, users, and outputs, then select controls in proportion to likelihood, impact, and intended use." },
  R17: { id: "R17", title: "Identity, authentication, authorization, and secrets management", definition: "Ensure that people, services, and sites are authenticated and receive only the permissions required for their approved roles, with controlled credential and key lifecycles." },
  R18: { id: "R18", title: "Secure communication and update confidentiality", definition: "Protect model artifacts and control traffic in transit and, where justified, during aggregation, while specifying what information crosses institutional boundaries." },
  R19: { id: "R19", title: "Code, model, and update integrity with incident response", definition: "Prevent, detect, contain, and recover from malicious or erroneous code, poisoned updates, compromised nodes, unauthorized changes, and security or privacy incidents." },
  R20: { id: "R20", title: "Explicit and reproducible federated protocol", definition: "Specify the complete study protocol so another authorized team can reproduce how clients, server, data processing, training, validation, and stopping decisions interact." },
  R21: { id: "R21", title: "Resource-aware orchestration and heterogeneity handling", definition: "Schedule and coordinate jobs around unequal data distributions, hardware, bandwidth, uptime, time zones, and clinical workloads without allowing resource-rich sites to dominate silently." },
  R22: { id: "R22", title: "Fault tolerance, checkpointing, and recoverability", definition: "Continue safely or recover predictably when clients disconnect, nodes fail, configurations mismatch, jobs crash, or maintenance interrupts training." },
  R23: { id: "R23", title: "Execution observability, audit trail, and local approval", definition: "Give authorized central and local actors enough visibility to understand, approve, monitor, diagnose, and audit each job without exposing patient-level data." },
  R24: { id: "R24", title: "Multidimensional local, external, and subgroup evaluation", definition: "Evaluate more than global accuracy by measuring site-level and external performance, calibration, robustness, subgroup fairness, privacy and security, communication, resource use, and scalability against relevant alternatives." },
  R25: { id: "R25", title: "Independent validation and controlled release gate", definition: "Require independent or site-local validation and multidisciplinary approval before a final model, code package, or result is distributed, deployed, or used for a new purpose." },
  R26: { id: "R26", title: "Reproducibility, reporting, provenance, and registry package", definition: "Package the information and artifacts needed to understand, reproduce, audit, compare, and govern the study and every released model version without revealing protected data." },
  R27: { id: "R27", title: "Workflow integration, usability, and stakeholder capability", definition: "Fit the model and operational process into clinical or research workflows and ensure users, data stewards, IT teams, and oversight actors can perform and understand their responsibilities." },
  R28: { id: "R28", title: "Continuous performance, drift, fairness, security, and compliance monitoring", definition: "Monitor the deployed or reused system and its federation for degradation, distribution shift, subgroup harm, misuse, access violations, security events, and regulatory or contextual change." },
  R29: { id: "R29", title: "Update, retraining, rollback, retirement, and sustainability ownership", definition: "Assign durable organizational and financial ownership for maintenance, updates, retraining, rollback, incident recovery, site withdrawal, transfer, and retirement after the initial study or funding period." }
};
