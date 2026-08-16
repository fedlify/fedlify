# AI4PH Scholarship Application Responses - Fedlify

Prepared for the AI4PH 2026-2027 Scholarship Application form.

Verified sources on June 25, 2026:
- Scholarship page: https://ai4ph-hrtp.ca/scholarships/
- Application form: https://airtable.com/app4uBLt1DLQmqv8a/pag4HVRX2iyNlUUIS/form
- General application guidance: https://ai4ph-hrtp.ca/wp-content/uploads/2023/06/AI4PH-Guidance-for-Scholarship-Application-Questions.pdf
- EDI, sex and gender-based analysis, and community engagement resources: https://ai4ph-hrtp.ca/wp-content/uploads/2024/05/EDI-Resources-for-Applicants.pdf

Important deadline note: the scholarship page says applications are due by 11:59 PM PT on June 30, 2026, while the Airtable form says 11:59 PM ET on June 30, 2026. Submit by the earlier time, 11:59 PM ET on June 30, 2026, to avoid risk. Reference forms are due July 10, 2026.

## Pre-Submission Checklist

- [ ] Confirm eligibility: Canadian citizen, permanent resident, or valid work/student visa.
- [ ] Confirm scholarship type: Masters, Doctoral, or Postdoctoral.
- [ ] Confirm program year in Fall 2026. Applicants entering fourth year are not eligible.
- [ ] Confirm whether you currently hold a Tri-Council stipend.
- [ ] Prepare applicant CIHR Biosketch CCV upload.
- [ ] Confirm primary supervisor and whether they are an AI4PH mentor.
- [ ] Prepare primary supervisor CIHR Biosketch CCV upload.
- [ ] Confirm co-supervisor name. AI4PH requires supervision or co-supervision by an AI4PH mentor.
- [ ] Ask two referees to submit the structured reference form by July 10, 2026.
- [ ] Make sure referees are not your supervisor or co-supervisor.
- [ ] Prepare one-page project references/citations upload.
- [ ] Complete the self-declaration section or choose the non-response option.

## Applicant Information

### Are you a Canadian Citizen, Permanent Resident or have a valid work or student visa? *

Response:

`[Select the accurate option in the form.]`

Note: If none of these apply, the form states that the applicant is not eligible.

### Given Name *

Response:

`[Your legal/preferred given name used for the application]`

### Family Name *

Response:

`[Your family name]`

### Email *

Response:

`[Your application email. Use the same email you give to referees.]`

### Phone Number

Response:

`[Your phone number]`

### Primary Organization *

Response:

`University of Toronto`

Confirm if a different institution should hold the award.

### Location *

Response:

`Toronto, Ontario, Canada`

### Scholarship Type *

Response:

`[Select: Masters / Doctoral / Postdoctoral. Verify against your Fall 2026 registration status.]`

### Do you currently have a Tri-Council stipend? *

Response:

`[Yes/No. If yes, specify CIHR, NSERC, or SSHRC if the form asks.]`

### CCV *

Upload:

`Applicant CIHR Biosketch CCV`

### Referral Point

Draft response:

`AI4PH website, University of Toronto research network, and supervisor/mentor recommendation.`

Edit this to match how you actually heard about the scholarship.

## Supervisors

### Primary Supervisor Name *

Response:

`[Primary supervisor name - verify before submit]`

Possible project-context option to verify:

`Zahra Shakeri`

### Primary Supervisor - AI4PH Mentor *

Response:

`[Yes/No - verify from the AI4PH mentor list before submit]`

AI4PH mentor list:

https://ai4ph-hrtp.ca/about/

### Primary Supervisor CCV - CIHR Biosketch *

Upload:

`Primary supervisor CIHR Biosketch CCV`

### Co-supervisor Name *

Response:

`[AI4PH mentor co-supervisor name - required if primary supervisor is not an AI4PH mentor]`

Note: AI4PH states that successful applicants must work with an AI4PH mentor. Confirm the mentor has agreed before listing them.

## References

Reference form:

https://airtable.com/app4uBLt1DLQmqv8a/pageds7G7ZffAuPhF/form

Reference deadline:

`July 10, 2026`

Important:

`Your supervisor(s), including AI4PH or non-AI4PH supervisors, cannot submit a reference for this application.`

### Referee #1: Name *

Response:

`[Referee 1 name]`

### Referee #1: Email *

Response:

`[Referee 1 email]`

### Referee #2: Name *

Response:

`[Referee 2 name]`

### Referee #2: Email *

Response:

`[Referee 2 email]`

Suggested note to send referees:

> I am applying for the AI4PH Scholarship Program. The application uses my email address, `[your application email]`, to match reference forms to my file. Please complete the structured reference form by July 10, 2026: https://airtable.com/app4uBLt1DLQmqv8a/pageds7G7ZffAuPhF/form

## Project Information

### Project Title

Draft response:

`Fedlify: Agentic Federated Learning Infrastructure for Privacy-Preserving and Equity-Aware Health AI`

Alternative shorter title:

`Fedlify: Agent-Guided Federated Learning for Equitable Health AI`

### Project Summary * 

Limit in form: maximum 150 words and 1,200 characters.

Draft response:

Health AI tools are often built from data at one hospital, so they may not work well for patients in other communities. Sharing patient records across institutions can improve model quality, but it is difficult because health data are sensitive and governed by local rules. Fedlify is a software platform that helps research teams train AI models across multiple sites while each site keeps its patient data locally. My project will design and evaluate an agent-guided version of Fedlify that helps teams describe their study, check privacy and governance requirements, prepare federated learning configurations, and keep an audit trail. The work will be tested using simulated multi-site health data workflows and stakeholder-informed requirements. The expected impact is practical infrastructure that makes privacy-preserving, reproducible, and equity-aware public health AI studies easier to run across Canadian health systems.

### Project Description *

Limit in form: maximum 1,000 words, not including citations, and 9,000 characters.

Draft response:

Health AI research increasingly depends on data from more than one institution. Models trained at a single hospital can fail when they are used with patients from different regions, health systems, data systems, and social contexts. This is a public health problem because technical limitations in data access can reinforce inequities: institutions with fewer resources, smaller datasets, rural catchment areas, or under-represented populations may be excluded from model development, and the resulting AI tools may not represent the communities they are meant to serve.

Federated learning offers one way to address this problem. Instead of transferring patient-level records to a central database, participating sites train models locally and share only approved model updates or outputs. This can make multi-site health AI research more feasible when raw data sharing is restricted. However, the main barrier to real-world use is no longer only the learning algorithm. Research teams also need support for study intake, site coordination, privacy and governance review, reproducible configuration, execution monitoring, and auditable reporting. Without this operational layer, federated learning studies remain difficult to start, repeat, and govern across health institutions.

My project focuses on Fedlify, an agentic federated learning platform for health AI. Fedlify is designed as a regulated collaboration control plane for multi-institution federated learning studies. It keeps raw clinical data at local sites, supports governance and ethics approval workflows, and generates human-approved execution kits for participating sites. My individual contribution is the agent-guided coordination layer: a chatbot and skill-based workflow that helps research teams convert a study idea into structured, reviewable, and reproducible platform artifacts.

The project has three objectives.

First, I will define the minimum information that a health federated learning study must capture before configuration and execution. This includes the collaboration setting, data distribution, data modality, system topology, privacy and security plan, training strategy, clinical application, disease category, and practical challenge profile. These fields will be treated as required study metadata, not informal notes, so that the platform can identify missing requirements before a study proceeds.

Second, I will implement agentic skills in Fedlify for requirement extraction, data-readiness review, governance and privacy planning, workflow planning, template-bound code and configuration generation, monitoring, failure triage, reproducibility, and reporting. Each skill will have explicit inputs, instructions, outputs, validation checks, and guardrails. The agent will be allowed to draft and check artifacts, but it will not access patient-level data, approve institutional requirements, make clinical decisions, invent new federated learning algorithms, or release execution kits without human approval.

Third, I will evaluate the approach using simulated multi-site health AI workflows. The evaluation will examine whether the agent-guided workflow improves completeness of study intake, identifies missing governance or data-readiness requirements, generates valid configuration artifacts, preserves audit records, and supports reproducible reporting. I will use realistic study scenarios that reflect common public health and health-system challenges, such as heterogeneous electronic health record data, imbalanced site populations, privacy constraints, and the need for transparent model-development records.

The expected impact is practical infrastructure for equitable and privacy-preserving public health AI. Fedlify does not replace community engagement, ethics review, clinical judgment, or institutional governance. Instead, it makes those requirements more visible and operational by embedding them in the workflow. This can help research teams include more sites without requiring raw data transfer, reduce avoidable coordination burden, and create a reproducible record of how a federated study was designed, approved, configured, and run. In the long term, this work can support Canadian public health and health-system partners who want to collaborate on AI while protecting local data control and improving representation across populations.

### Project References/Citations *

Upload requirement:

`Maximum 1 page document`

Draft one-page reference list:

1. McMahan B, Moore E, Ramage D, Hampson S, Arcas BA. Communication-efficient learning of deep networks from decentralized data. AISTATS. 2017.
2. Rieke N, Hancox J, Li W, et al. The future of digital health with federated learning. NPJ Digital Medicine. 2020.
3. Kairouz P, McMahan HB, Avent B, et al. Advances and open problems in federated learning. Foundations and Trends in Machine Learning. 2021.
4. Kaissis GA, Makowski MR, Rückert D, Braren RF. Secure, privacy-preserving and federated machine learning in medical imaging. Nature Machine Intelligence. 2020.
5. Teo ZL, Jin L, Liu N, Li S, Miao D, Zhang X, Ng WY, Tan TF, Lee DM, Chua KJ, et al. Federated machine learning in healthcare: a systematic review on clinical applications and technical architecture. Cell Reports Medicine. 2024;5(2).
6. Eden R, Burton-Jones A, Scott I, Staib A, Sullivan C. A scoping review of the governance of federated learning in healthcare. NPJ Digital Medicine. 2025.
7. World Health Organization. Ethics and governance of artificial intelligence for health. 2021.
8. National Institute of Standards and Technology. Artificial Intelligence Risk Management Framework. 2023.

Before upload:

- [ ] Convert to PDF if the form requires a document.
- [ ] Match citations exactly to the final project description and supervisor preference.
- [ ] Keep to one page.

### Training Environment *

Limit in form: maximum 350 words and 2,800 characters.

Draft response:

The project will take place in an interdisciplinary health AI environment at the University of Toronto, anchored in the Dalla Lana School of Public Health and connected to expertise in health informatics, public health systems, software engineering, AI governance, and responsible health data use. The project is well suited to this environment because Fedlify sits at the intersection of public health, machine learning, privacy-preserving computation, and implementation in real health-system settings.

My supervisor, `[primary supervisor name]`, will support the scientific direction of the project, including the framing of the public health problem, the design of the evaluation, and the interpretation of findings for health AI implementation. `[Add one sentence about the supervisor's specific expertise and how it supports Fedlify.]` I will also work with `[AI4PH mentor or co-supervisor name]` to ensure alignment with AI4PH priorities in equitable AI, public health relevance, ethics, and training. `[Add one sentence confirming the mentor's role once agreed.]`

The project also has a concrete software environment. Fedlify already includes a web application, role-based access control, audit functions, workflow templates, and infrastructure for generating federated learning site kits. This allows the scholarship period to focus on a feasible and measurable contribution: implementing and evaluating the agent-guided coordination layer rather than building the entire platform from scratch.

The training environment will support cross-disciplinary development. I will receive training in federated learning methods, health AI governance, reproducible software engineering, and equity-oriented public health research. The project will also benefit from feedback from health data researchers, technical collaborators, and, where feasible, patient or public partners who can comment on trust, transparency, and governance expectations.

### Alignment with AI4PH *

Limit in form: maximum 350 words and 2,800 characters.

Draft response:

Fedlify aligns directly with AI4PH because it addresses a practical barrier to using AI for public health and health equity: the difficulty of building models across institutions without moving sensitive health data. Public health AI needs evidence from diverse settings, but many health datasets remain separated by institutional, legal, technical, and governance boundaries. When only large or well-resourced centres can contribute data, resulting models may fail to represent smaller sites, rural communities, and populations who are already under-served.

The project applies AI and machine learning methods through federated learning, a privacy-preserving approach in which sites collaborate while keeping patient-level data under local control. However, the project is not only about algorithms. Its main contribution is the operational and governance layer needed to make federated learning usable in real public health and health-system research. The Fedlify agent will help teams gather study requirements, identify missing governance or data-readiness information, generate bounded configuration artifacts, and preserve audit records.

This aligns with AI4PH's focus on building capacity to apply AI methods to real public health issues while critically examining their impact on inequities. Fedlify is designed to make equity and governance visible in the workflow. For example, the platform records data modality, participating sites, disease area, data-distribution assumptions, privacy controls, and challenge profiles such as small sample sizes, imbalanced cohorts, non-representative data, or fairness risks. These are not treated as afterthoughts; they become required inputs before workflow planning and code generation.

The expected contribution is a reproducible and human-governed infrastructure model for health AI collaboration. By reducing the operational burden of privacy-preserving multi-site studies, Fedlify can help more institutions participate in AI development while maintaining local accountability, transparency, and public trust.

### EDIA Commitment *

Limit in form: maximum 300 words and 2,400 characters.

Draft response:

My commitment to equity, diversity, inclusion, and accessibility is reflected in the way I frame health AI as a socio-technical system rather than only a technical modelling problem. AI systems can reproduce inequity when training data, design decisions, evaluation metrics, and deployment contexts do not reflect the populations affected by the tool. In my research, I therefore focus on infrastructure that makes equity-relevant assumptions visible: who is represented, which sites are included, what data are missing, how governance decisions are recorded, and where uncertainty or bias risks remain.

In Fedlify, this commitment is operationalized through required intake fields and guardrails. The platform asks teams to document data modality, disease area, collaboration setting, participating sites, data-readiness constraints, privacy controls, and challenge profiles such as imbalanced cohorts, non-IID data, limited compute, or fairness concerns. These fields help prevent a study from moving directly from a technical idea to executable code without first considering representation, governance, and public health relevance.

`[Add 2-3 sentences with a concrete personal example: e.g., mentoring students from under-represented groups, designing accessible documentation, supporting community-informed research, teaching, translation, open-source contribution, or committee/service work.]`

My goal is to build health AI infrastructure that broadens participation rather than concentrating AI development in institutions with the easiest access to data and computing resources.

### Community Engagement *

Limit in form: maximum 300 words and 2,400 characters.

Draft response:

Fedlify is an infrastructure project, so engagement with people with lived or living experience is different from engagement in a disease-specific intervention trial. The people most affected by this work include patients and communities whose health data may be used in AI research, especially groups who have experienced under-representation, surveillance, discrimination, or loss of trust in data-intensive health systems.

The main opportunity is to involve patient and public partners in shaping what transparency, consent, local control, and accountability should look like in federated health AI workflows. For example, partners could review the language used in study intake, comment on what information should appear in audit summaries, identify concerns about secondary data use, and advise on how study teams should explain federated learning in accessible terms. This would help ensure that Fedlify does not treat privacy as only a technical control, but also as a matter of trust, governance, and meaningful communication.

The main challenge is that early-stage platform work can feel abstract to people outside technical or governance roles. I plan to address this by using concrete study scenarios, plain-language diagrams, and short walkthroughs that show what happens to data, who approves each step, what the agent can and cannot do, and how audit records are preserved. If direct engagement is not feasible for every phase, I will document the limitation and seek feedback from public/patient engagement resources, health data governance experts, and community-facing research staff.

The expected benefit is a platform design that better reflects public expectations around responsible AI, data protection, transparency, and equitable participation in health research.

### Sex and Gender Based Analysis *

Limit in form: maximum 300 words and 2,400 characters.

Draft response:

Fedlify is not a disease-specific model, but sex and gender are still important because the platform shapes how health AI studies are designed, documented, evaluated, and reported. I will account for sex and gender by building them into the study-intake and data-readiness workflow rather than treating them as optional analysis details at the end of a project.

At the study-design stage, Fedlify can prompt teams to specify whether sex assigned at birth, gender identity, both, or neither are relevant to the research question, data source, and planned analysis. It can also ask teams to document how these variables are defined, whether categories are self-reported or administratively recorded, how missingness is handled, and whether sample sizes support subgroup analysis. This is important because sex and gender variables are often incomplete, inconsistently measured, or collapsed into binary categories that may not reflect participants' identities.

At the analysis and reporting stage, Fedlify can require study teams to record whether model performance will be assessed across sex or gender groups where appropriate and ethically justified. It can also flag risks such as small subgroup counts, privacy concerns, or analyses that could increase stigma. The platform will not force collection of unnecessary personal information; instead, it will support data minimization and context-specific decisions.

This approach aligns sex and gender-based analysis with responsible AI practice: define the variables carefully, evaluate when they matter for health equity and validity, protect privacy, and report limitations transparently.

## Diversity Self-Declaration

This section is confidential and should be completed only by the applicant.

### Diversity Form Opt-Out

Response:

`[Leave blank if completing the self-declaration section. If choosing not to complete it, select the appropriate non-response reason in the form.]`

### Do you identify as Indigenous, that is, First Nation, Métis or Inuk?

Response:

`[Applicant self-response]`

### Do you identify as a "racialized" person?

Response:

`[Applicant self-response]`

### Do you identify as a person with a disability(s)?

Response:

`[Applicant self-response]`

### Gender Identity

Response:

`[Applicant self-response]`

### Sexual Identity

Response:

`[Applicant self-response]`

## Administrative

### Application Type *

Response:

`Scholarship Application 2026`

## Final Review Before Copying Into Airtable

- [ ] Replace every bracketed placeholder.
- [ ] Verify legal name, email, phone, citizenship/visa status, scholarship type, Tri-Council status, and organization.
- [ ] Confirm AI4PH mentor/co-supervisor agreement before listing them.
- [ ] Verify references are not supervisors or co-supervisors.
- [ ] Check that the Project Summary remains under 150 words and 1,200 characters after edits.
- [ ] Check that Project Description remains under 1,000 words and 9,000 characters after edits.
- [ ] Check all 300/350-word response limits after adding personal examples.
- [ ] Upload applicant CCV, supervisor CCV, and project references/citations.
- [ ] Submit before June 30, 2026 at 11:59 PM ET to be safe.
