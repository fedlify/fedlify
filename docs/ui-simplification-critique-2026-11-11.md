CRITIQUE OF THE PLAN

Checked against the code. I ran a few greps and did not view the screenshots again.

(1) Complete-process gaps that remain

Study lead first run:
- Phase 4 renames the auto-created study "My first study" and adds an inline "Name your study" step. Phase 2 also makes Create study a modal that ends in Study setup > Details. Two onboarding paths now exist. Pick one: the first sign-in opens the Create study modal, or the auto study exists and Summary shows "Name your study".
- `ensureUserDefaults` is called on every sign-in (`src/lib/auth-options.ts:28`, `:104`). The plan says "no Default Study for invited users" but never says how `ensureUserDefaults` tells invitees from leads. Site-only users are also fixed in two phases: Phase 3 handles sidebar mode and Phase 4 handles the default study. Merge them.
- The five conditions include "one site", but the lead must be told how to add the first site. The Add site window is cut to a name plus an optional email (Phase 4), yet no Summary step says "Add your first hospital".
- The plan's one-checklist model leaves Archived or expired-ethics studies undefined. If ethics expires after the study auto-starts, does the study stop? It should say so on Summary.

Site contact onboarding:
- "Wrong email? Sign out" covers a mismatched invite email. It does not cover an expired or already-used token, which leaves the invitee at a dead end. Add "This invitation has expired. Ask <lead name> to resend", shown on Register.
- Phase 5 step 4 ("Describe your data") is pre-filled from what the runner finds. A new contact has no runner yet, so the pre-fill never applies in the normal order. Say it is optional or comes later.
- Phase 5 says "if feasible, fold the access code into the kit". Decide it now, because it changes step 2 and the setup sheet.

Site proposes a change:
- Study details (design) proposals have no storage decision. The plan offers a pseudo-row `D00` or an audit event, and then adds "validate that this fits". `RequirementResponse` has `@@unique([studyId, requirementId])` (`prisma/schema.prisma:807`), so a single `D00` row can hold only one proposal at a time. Two sites, or two proposals from one site, would collide. Cut proposals on Study details from v1. After the cuts it is about 6 fields and the lead can discuss changes by email or through a question. Alternatively, store a free-text "Suggestion" as an audit event plus a notice, with no accept button.
- A site that suggests a change on a question where it is one of several sites overwrites the single `proposedAnswer`. The plan has three nullable columns, which means one proposal per question. A second site's suggestion either overwrites the first or is rejected. Say "one open suggestion per question" and show "Hospital A already suggested a change, add your note" to later sites.
- "We cannot take part yet" is described two ways, as a CANNOT_MEET proposal and as sign-off Blocked. The lead's answer to it is undefined: Accept would "change the answer", which makes no sense for a refusal. Define the lead's actions as "Acknowledge" and "Contact site", and when the lead dismisses it, set the sign-off back to Waiting so the site is not stuck at Blocked.
- The outcome email goes to which person, only the proposer? Say so. No in-app notification is planned; the site only sees the outcome on its own page.

(2) Complexity in the plan that is not needed
- Phase 1 builds `.fl-step`, `.fl-notice`, `.fl-empty` through `renderEmpty`, `RoleTag`, a state-to-tone map and the full token set before any user-visible fix. Do the grid gap and the date formatter first and ship. Create tokens only for what the first three phases use.
- Optional `proposalKind` plus the "Edit and accept" action. Accept or Decline is enough for v1. The lead can edit the answer in the normal way afterwards.
- A site-facing "Your suggestions" list beside About this study. The email plus the status on the question is enough. Show a small badge on the question and drop the extra panel.
- "Grouping into You / Study team / System" for site activity. "Show more" alone is enough.
- The Get ready "What do you need?" choice list on top of the OS picker. The OS picker alone is enough. Hashes and systemd under "For IT staff" are right.
- "Download setup sheet", "Have you saved it?" and Copy-all together. Keep download plus the Copy-all card. The confirm is a third guard.
- A per-phase Playwright smoke suite covering six phases. Keep two: the site-proposes-change loop and the invite-to-site-page journey.
- Phase 6 is mostly a redesign of Pipeline, Run and Results and is large. It is not tied to any owner complaint. Time-box it or cut the Activity export menu, the "About" summary line and the item-name search.
- Both an automatic start and a Summary button are specified in places. Choose the single button (recommended): the lead should see the moment the study goes live, and an automatic start can trigger site notices unexpectedly.

(3) Reviewer findings the plan dropped that should be kept
- Study management: the empty state "Create your first study to start." and hiding Create study when the user has no institution to create under (study-setup, medium). The plan only hides the Institution field.
- Create/edit forms: control height 36 and `controlHeight` are in, but the "labels above, single column, asterisk for required only" form rule is not.
- Study questions: the "Needs you" filter is renamed "Open", yes. The reviewer's point that read-only roles should see the answer as plain text is in, but the "Confirm again" button in the toast is only half-specified (no action for the lead who is not the confirmer).
- Study details: "One name everywhere: 'Study details'" is kept, but the Ethics and Documents tabs should use a page-level button ("Record ethics decision" / "Upload document"), not action cards (study-setup, medium). The plan says "header button plus a list" for Ethics but not for documents once folded in.
- Invitations: the single name "Invitations waiting" and the rule "hide the section when empty" are partly in. The plan loses "Use 'Person' not 'Actor'" and the "Item" search label on the activity page.
- Team: "Sort study lead first, then site contacts grouped by site" is dropped because site contacts leave Team. Fine, but then the plan should say what happens for a study member who is also a site contact.
- Sites: "Make sign-off 'Waiting' when nobody has confirmed rather than 'Passed'" is kept. "Put Invite site contact and Release site kit inside the site page or one row menu" is lost; the Sites table still ends up with several row actions.
- Code and run: "Remove 'baked-in', 'Pinned', 'Python syntax' wording", the file-tree count fix, and the layout fix that stops three columns squeezing the centre are all missing or reduced to one line.
- Permission-blocked buttons: "show one visible line under the button with the first reason" is in for Run, but not for the other pages that currently use tooltips.
- Navigation: root route chain ("resolve the destination on the server and redirect once", remove the dashboard page) is in Phase 3 only for site users. The study lead path still goes through the blank hop.
- "Step 4 of 6" tag beside the Summary title and a "Next:" link at the bottom were dropped. They are cheap and helpful.
- Profile: "add the only editable things a user needs" is in. The user-menu "Help" rename is in.
- Visual: the vocabulary for `.fedlify-notice` and tabs rule (underline for sections, segmented for 2-3 filters, delete the chip variant) is dropped. So is replacing the 96 inline style objects on the site page with utility classes.

(4) Plan items that are wrong or risky given the code
- "Starting a study then needs only five things: title, objective, ethics decision, one site and 29 answers" and `activationGate` change: the current required list is 13 fields (`src/lib/governance.ts:53-67`), including `clinicalUseCase`, `intendedUse`, `population`, `dataModalities`, `primaryOutcome`, `researchQuestion`. The plan keeps these six in Study details but drops them from the gate. That conflicts with "Study details complete" in the Phase 2 next-step logic. Say clearly whether the gate requires them. Also `activationGate` is called in three routes: `src/app/api/v1/studies/route.ts:150`, `src/app/api/v1/studies/[studyId]/route.ts:178` and `src/app/api/v1/studies/[studyId]/nvflare/deployments/route.ts`. All three must change together or the deploy route still blocks on the old fields.
- `meaningfulProtocolText` (`governance.ts:70`) strips HTML. Removing `RichTextEditor` for the kept fields means old rich-text values still contain HTML. Keep the stripper, and render legacy text through it.
- "Reuses the existing question rows" and "a proposal sets status CONFLICT": the CONFLICT status already has meaning (an assistant or evidence conflict; see `src/lib/study-questions.ts:173` and `:209-216`, which sorts CONFLICT first and counts it as unanswered). A site proposal on an answered question would make the question count as unanswered and could block activation. Use a separate flag (`proposedAnswer != null`) and keep `status` ANSWERED. The plan says "keeps the existing answer", but the count must not drop. This contradicts the browser acceptance check "edit a question to UNKNOWN and both counts drop together" only if the proposal changes the status.
- "Pre-fill R04 from the ethics record": R04 is "Legal basis, ethics, and cross-site agreements" (`src/lib/requirements-catalog.ts:19`), which is broader than the ethics decision. A pre-fill would imply the question is answered. Pre-fill as a suggestion (status SUGGESTED) that the lead confirms.
- "Move risk level into R06": R06 is "Risk-proportionate oversight and approval gates" (`:21`), a free-text oversight question, not a risk level. Putting the level there loses a structured value. Either delete it (decision 3 option B) or keep a single select.
- "Remove ADVANCED_ROLES from InvitePersonModal and TeamSection": confirmed there are two separate constants (`TeamSection.tsx:24`, `InvitePersonModal.tsx:10`), so one shared component is a real simplification. But Team also has its own inline invite markup (`TeamSection.tsx:326`), so the "One InvitePersonModal" change must also delete that block, not just the site-page one.
- "Email through the existing invitation mailer": `src/lib/email.ts` is an invitation mailer. Check it has a generic send function; a proposal outcome email needs a new template, not only a call.
- Phase 3 says "Site contacts and read-only roles may call it, scoped by siteId membership". Read-only roles (Observer) have no site membership, so the scope rule has no meaning for them. Limit the endpoint to site contacts for v1.
- Phase 5 "the visible text no longer mentions `age`": `src/app/get-ready/page.tsx:28` also uses the words "aggregator" and "registry". The plan covers the replacement in its removed-terms `rg` check, but those words are inside flag names (`--aggregator`, `--registry`) so they must stay in command text and be hidden in the "For IT staff" section instead.
- Retire the word "repository" in the UI while keeping "Open repository" under Details (Phase 6) is a contradiction. Rename to "Open code".
- Deploy note "Phase 3 is the only migration". If you drop required fields from the gate (Phase 2) with no migration, fine. But a "single stored Study details proposal" or `proposalKind` would add more. Settle the schema before Phase 3 starts.

Highest priority fixes before building: decide how Study details proposals are stored (or cut them), do not reuse CONFLICT status for proposals, and define the lead's action on "We cannot take part".