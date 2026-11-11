# Fedlify simplification and consistency plan

## Part 1. For the owner

### What the six reviewers found

Three root causes explain almost every complaint.

1. **The same information is asked in several places.**
   - Create study repeats 10 of the 20 fields in Study details.
   - Study details then repeats much of what the 29 study questions ask.
   - The Summary page, the Protocol "Progress" tab and the Code & run stage bar are three different checklists. They count differently, and the Summary can say "done" while Activate is still blocked.
   - Sites appear in three places, and invites in three windows.
2. **Sites have no voice.** A site contact can read the answers or sign off. They cannot say "we can't do this" or "please change this". A site-only contact also never sees what the study is about.
3. **There is no visual system.**
   - Nine card-grid recipes.
   - Twelve card styles.
   - Five page-header builds.
   - Two tag systems.
   - Five modal widths.
   - Six date formats.

   Your big-gap screenshot comes from one rule: the grid makes two wide columns, but each card is capped at 370px and pinned left.

### The one model for study information

| Where | What it holds | Who edits |
|---|---|---|
| **Create study** (small window) | Study title, one-line summary. The institution only appears if you belong to more than one. | Study lead |
| **Study details** (one short card) | Objective, research question, what the model will be used for (one choice, merging "clinical use case" and "intended use"), population, data types, main outcome. | Study lead |
| **Ethics** | The ethics decision plus supporting documents. Question R04 is filled from it, not retyped. | Study lead |
| **The 29 study questions** | Everything about how the study is run: analysis, data handling, fairness, human-AI workflow, reporting, evaluation. | Study lead, with suggestions from sites |

- The 12 long design text boxes are removed from the form and from the activation gate. Old values stay visible, read-only, under "Details".
- Risk level moves into question R06.
- Starting a study then needs only five things: a title, an objective, an ethics decision, one site and 29 answers.
- There is one checklist, on Summary. The Protocol "Progress" tab is deleted.

### The site "propose a change" process

1. On any study question, and on Study details, a site contact sees **Suggest a change**. They write what should change, or choose "We cannot meet this".
2. The study lead sees "N suggestions to review" on Summary and a badge on the questions.
3. The lead chooses **Accept**, **Edit and accept**, or **Decline** (a one-line reason is required).
4. The site sees the outcome on its page and gets an email.
5. If the site declines to take part, the sign-off becomes "We cannot take part yet", with a reason. That reason is also a suggestion the lead must answer.

This reuses the existing question rows, notices and audit trail. It adds only three nullable columns and one list window.

### Before and after of the main flows

| Flow | Today | After |
|---|---|---|
| Create a study | Full page, fake 2-step stepper, 8 required fields | Small window, 2 fields; details are added once in Study details |
| Know what to do next | Summary and Progress tab disagree; Activate is hidden in Protocol | One checklist on Summary; the study starts itself when the five conditions are met |
| Invite a hospital contact | 3 windows, 5 role cards, "Advanced roles" | One window: email only; site is fixed |
| Site contact accepts an invite | Register, sign in again, My site, site page, 5 tabs | Email link, one form, site checklist |
| Site disagrees | Cannot, except by not signing | Suggest a change; "We cannot take part" |
| Study management | Two cards with a 200px gap | Cards fill the row |
| Pipeline page | 4 assistant modes, 4 rail buttons, 3 side panels | One input; status-only rail; one primary button per step |

### Decisions I need from you (5)

1. **Starting a study.** Should it start automatically when the five conditions are met (my recommendation), or should the lead press one "Start the study" button on Summary?
2. **Site contacts' view of the study.** My recommendation is to show a limited read-only "About this study" card with purpose (R01), design summary, ethics status, lead contact and what is asked of the site (R08, R12-R15). Is that acceptable for privacy? The current invite text promises "they will not see the rest of the study", so the wording changes too.
3. **Risk level.** Move it into question R06 (my recommendation) or delete it?
4. **Detailed roles.** Remove the nine "Advanced" roles from the invite and change-role windows. Existing holders stay shown read-only. Confirm that no real users depend on them.
5. **Assistant modes.** Remove Ask / Plan / Agent / Edit so there is one input. Confirm that nothing relies on "Agent" auto-coding after plan approval. If it does, the assistant would offer "Plan then write" as a single flow.

---

## Part 2. Engineering detail

### Merged conflicts and decisions

- **Progress tab.** Delete it (Study-setup reviewer and Navigation reviewer agree). Protocol is renamed to **Study setup**, with tabs **Details, Ethics, Questions**. Documents fold into Ethics as "Ethics and documents". Add `studySetup` to `lib/terms.ts`.
- **Sites views.** The Sites page is the only full site table. Code & run keeps a one-line "1 of 2 sites connected" that links there. Summary phase 4 links there too.
- **Site invites.** One `InvitePersonModal`. When `presetSiteId` is set it shows only the email and the fixed text "Site contact for X". Team lists study-wide people only. Site contacts appear under their site, with "N invited" on the site row.
- **Activation.** `activationGate` becomes: title, objective, ethics cleared, at least one site, and answered questions. The answered count uses `countsAsAnswered` everywhere (fixes the mismatched counts). Error messages use `STUDY_PROTOCOL_FIELD_LABELS`, never raw keys.
- **Back arrows.** Top-level sidebar pages have none. Child pages only: run detail goes to Results; a site page goes to Sites for leads, with no arrow for a one-site contact.
- **Sidebar "Audit" and Activity.** Rename the sidebar item to **Activity** (matches the page title and the site tab). The run detail "Activity" tab is removed and replaced by a short timeline inside Summary.
- **Version vocabulary.** "Pipeline version" is the published unit. Sites show "Pipeline version: up to date / needs update". Retire the words "code version", "commit", "project" and "repository" in the UI. The Results "Code" column is removed.

### Visual system (Phase 1 builds it)

Tokens in `:root` of `globals.css`:

- **Spacing:** `--space-1..8` = 4, 8, 12, 16, 24, 32, plus 40 and 48 as needed.
- **Radii:** `--radius-card: 12px`, `--radius-input: 8px`, `--radius-pill: 999px`.
- **Colour:** declare `--fedlify-border` and `--fedlify-primary-border` (currently undefined, 20 usages). Add semantic `--fl-{success,warn,danger,info}-{fg,bg,border}`. Make `client-providers.tsx` read the same constants.
- **Type:** page title 24/600, section 16/600, body 14/400, small 13/400, tag 12. Drop the 10 and 11px sizes and the uppercase "STATE" labels.

Primitives:

- `.fl-page`: max-width 1200, `padding: var(--space-6)`, no 100vh min-height.
- `PageHeader` (extend `AppPageHeader`): optional back arrow, h1, one-line subtitle, actions slot top-right. The primary action always lives here.
- `.fl-section`.
- `.fl-card` with `--link` (hover only) and `--tint`.
- `.fl-grid { display:grid; gap:var(--space-4); grid-template-columns:repeat(auto-fill,minmax(var(--grid-min,320px),1fr)) }`, with `--grid-min` of 180 (stat), 320 (card), 480 (wide).
- `.fl-table`: global Ant table theme through ConfigProvider.
- `.fl-notice`: one callout, 3 tones.
- `.fl-empty`: one pattern, set as the ConfigProvider `renderEmpty`.
- `.fl-step`: number, title, status tag, body.
- `FormModal`: widths `MODAL_WIDTH.form = 560` and `.wide = 840` from one constants file. Footer is Cancel (left) and one primary (right). Scroll inside the modal is kept.
- `StatusTag` is the only tag, with 4 tones (done, in progress, attention, problem) plus neutral, and a state-to-tone map in `terms.ts`. PENDING becomes neutral. Add `RoleTag` (grey). Replace every raw `<Tag color>`.
- Buttons: primary (filled pill, one per view), default (outlined pill), link (row actions). Small buttons get the pill radius and 28px height. One weight (600). Delete the weight-700 `.fedlify-dark-action` styling.
- `lib/format.ts`: `formatDate` and `formatDateTime` ("Nov 5, 2026, 11:03 AM"), replacing every `toLocale*` call.
- Control height is 36px everywhere (ConfigProvider `controlHeight`). Remove `size="large"` overrides.

---

### Phase 1. Visual foundation and the gap fix (low risk, immediate)

**Goal:** fix the cards gap and give all later phases the tokens and primitives.

**Changes**

- Add the tokens and primitives above to `globals.css`.
- `.fedlify-manage-study-card`: remove `justify-self` and the 370px width cap, and remove the resting primary border and big shadow. `.fedlify-study-card-grid` becomes `.fl-grid`.
- Migrate `CardGrid` / `CardGridSkeleton` in `DataCards.tsx` to `.fl-grid`.
- Remove the horizontal padding on tab panes so content aligns with the header edge.
- Fix the profile card tag overflow with `min-width:0` and `flex-wrap`.
- Make Summary tiles a 3x2 `.fl-grid`. The whole tile is a link, with no "Open" text.
- Make `StatusTag` the only tag. Add `RoleTag`. Change the Profile role tags to `RoleTag`.
- Add `lib/format.ts` and replace every date call.
- Apply the global `.fl-table` theme and the `.fl-empty` pattern.
- Switch the auth shell to `var(--fedlify-bg)` and convert `get-ready` inline styles to `.fl-page` and `.fl-notice`.

**Removed**

- `.fedlify-study-card` (unused).
- The capped grids at 2332 and 2725.
- The duplicate card selectors at 985-994, 2344-2346, 2380, 2564, 4600, 6123, 6653 and 6673.
- `--fedlify-text-counter`.
- Uppercase micro-labels.

**Browser acceptance checks**

- Study management with 2 cards: the cards fill the row, the gap is 16px, and the right edge is flush.
- Resize the window: cards wrap with no empty space.
- Profile, Protocol and Summary content aligns with the header edge.
- The same state ("Ready", "Needs update") has the same colour and shape on every page.
- No `Tag color` or `toLocale*` remains (`grep`).

### Phase 2. One model for study information, and one checklist

**Goal:** remove the duplicated fields and the competing checklists.

**Changes**

- `studies/manage/page.tsx`: Create study becomes a `FormModal` (Institution only if more than one, Title, Summary). Delete `IntakeSteps`, the "Governance" paragraph and the Edit study page. The card menu's "Edit" opens the Study details modal. After create, go to Study setup > Details.
- `StudyFormModals.tsx` (`StudyDesignModal`): keep objective, research question, use (one merged choice), population, data modalities and primary outcome. Remove the other 12 fields, `RichTextEditor` for the kept short fields, and the three titles ("Edit study design", "Edit study details", "Save study design"). Use **Study details** with a **Save** button. Show legacy values read-only under Details if they are non-empty.
- `lib/governance.ts` / `shared.tsx` / `api/v1/studies/[studyId]/route.ts`: reduce `REQUIRED_PROTOCOL_FIELDS`. `protocolStatus` uses the shared answered counter. Activation is automatic when the conditions are met (or a single Summary button, depending on decision 1). Messages use labels. The POST/PATCH schema still tolerates old fields.
- `ProtocolSection.tsx`: delete the Progress tab. Rename to Study setup with tabs Details, Ethics (with documents), Questions. The default tab is the first incomplete one. Details is a small card with Edit in the header row, not an action card. Ethics and Documents use a header button plus a list. Add the line "Needed before the pipeline can be published. Status: Approved / Pending / Expired".
- Tab label "Questions" with a `29/29` badge.
- Move risk level into R06 per decision 3, and pre-fill R04 from the ethics record.
- `next-step.ts` and `SummarySection.tsx`: phase 2 counts "Study details complete". The Summary is the only checklist. Show "Steps 1-3 done" collapsed. When a problem exists the hero says "Needs attention" and "model released" becomes a small badge.
- Archive asks for confirmation (the dialog explains that runs stop and sites cannot sign off). The dots menu is hidden for people without permission.
- Study card content: title in ink colour, one-line summary, and three labelled facts (Phase from next-step, Sites n, Ethics status). A status tag appears only for Archived or Needs you. Show the workspace name only if the lead belongs to more than one.
- Copy: use "study" only. Subtitle "Your studies. Open one to continue." Make Create study the only primary button, with an Active/Archived tab beside the heading.
- Rename the nav item Protocol to **Study setup** in `STUDY_NAV_ITEMS` and `STUDY_WORKSPACE_SECTIONS`. Page title equals label for Summary, Study setup and Team. Add the terms to `terms.ts`.

**Removed**

- Two required-field systems.
- The Progress tab.
- 8 create fields.
- 12 design fields from the gate.
- `IntakeSteps`.
- The Edit study page.
- The `.fedlify-intake-*` and `inline-create-card` styles.

**Browser acceptance checks**

- Create study takes about 20 seconds with two fields.
- Study details has about 8 fields and one name everywhere.
- Summary and Study setup never disagree: edit a question to UNKNOWN and both counts drop together.
- Meeting the five conditions starts the study with no hidden blocker.
- Archive shows a confirmation.

### Phase 3. Site "propose a change", sign-off and site-contact journey

**Goal:** give sites a voice and give them the facts.

**Schema (one migration, nullable columns)** on `RequirementResponse`:

- `proposedAnswer String?`
- `proposedBySiteId String?`
- `proposedNote String?`
- Optionally `proposalKind` ("CHANGE" or "CANNOT_MEET").

A proposal sets the status to CONFLICT and keeps the existing `answer`, so an ANSWERED value is never silently overwritten. For Study details there is no new table. A proposal is stored as a pseudo-question row for target `study.details` (or a single audit event with the note). Reusing `RequirementResponse` for it needs a nullable `requirementId` convention such as `D00`, so validate that this fits the unique key.

**Routes**

- `POST /api/v1/studies/[id]/requirements/[rid]/propose`. Site contacts and read-only roles may call it, scoped by `siteId` membership.
- Extend the existing `accept` action with `accept-proposal` (copy `proposedAnswer` into `answer`, status ANSWERED, clear the specification confirmation) and `decline-proposal` (a reason is required).
- Audit events: `study_question.site_proposed`, `.accepted` and `.declined`.
- Email through the existing invitation mailer.

**Screens**

- `StudyQuestionsSection.tsx`: read-only viewers see the answer as plain text (not a disabled input) with a **Suggest a change** button in place of the dead-end banner. Small window with "What should change?" and a choice of "Suggest different wording" or "We cannot meet this". Leads see the current answer, the proposal and the note, with Accept / Edit and accept / Decline. The filter is renamed "Needs you" to "Open". When saving after confirmation, the toast says "This will need confirming again", with a **Confirm again** button in place.
- Summary: "N site suggestions to review" in the next-step logic.
- **Site page:** add a read-only **About this study** card (title, purpose R01, design summary, ethics status, what is asked of this site from R08, R12-R15, and "Study lead: name, email"). A "Your suggestions: accepted / declined, reason" list sits beside it. "Ask your study team" becomes a mailto link with the lead's name.
- **Sign-off form:** replace the two checkboxes with three choices: Ready, Ready with conditions (a note is required), and We cannot take part yet (a reason is required). The last one creates a CANNOT_MEET proposal and sets the site sign-off to Blocked with the reason, so the lead sees it in the Sites table. Show About this study directly above. A lead viewing a site sees a read-only summary ("Signed off by X on date" or "Waiting for the site contact"), not a disabled form.
- Site-only users: sidebar mode depends on the role, not on invitation state. A person whose only role is site contact sees My site only and never gets a Default Study. `/` resolves the destination on the server, so the sidebar and landing no longer flip.
- My site empty state: show the pending invitation or the lead's contact, plus "Wrong email? Sign out". The card shows one overall status tag and an Open site button.
- Results for site scope: hide the AUROC and Model columns and add the sentence "You see runs that include your site. Performance is shared with the study team."

**Removed**

- The dead-end banners, the disabled-form messages and the lead-held site access code banner.

**Browser acceptance checks**

- As Hospital B: suggest a change on R14, and see "pending" on the site page.
- As lead: see "1 suggestion" on Summary, accept it, and see the answer change and the confirmation reset.
- As Hospital B: see "accepted" and receive an email.
- Choose "We cannot take part yet": the Sites table shows Blocked with the reason.
- A site-only contact never sees the study sidebar.

### Phase 4. Invites, sites and the sign-up path

**Goal:** make the person-to-site path short.

**Changes**

- One `InvitePersonModal`; delete the inline modal and state in `sites/[siteId]/page.tsx`. Remove the ADVANCED_ROLES list from both `InvitePersonModal` and `TeamSection` (decision 4). Show disabled-role reasons inline only, with a link "Add a site" when none exist.
- Copy: "They will only see Hospital A: its setup, data description and sign-off, plus a summary of the study." Unified success state ("Done"), a **Resend** action and **Copy link** on pending rows, with "Expires in 6 days". Remove the Status column and hide the section when it is empty.
- Team page: title "Team"; remove the "People" sub-header; put Invite someone in the page header; show only study-wide people (site contacts move to the Sites table). Add a Site column only if any contact remains.
- Add site window: "Hospital or clinic name" and an optional "First contact email" (sends the invite in the same step). Drop Site PI, Note, the institution-name duplicate and the access-code banner.
- **Sites table:** columns Site, Status (one tag with the next step), People (n, "1 invited"), Open. The site name is the link. Move Add site into the page header. Show the internal code only under Details. Sign-off reads "Waiting" until someone has actually confirmed.
- **Auth:**
  - Register reads the invitation token server-side and shows the invited email read-only.
  - After registering it signs in automatically, accepts the invitation and lands on the destination.
  - The Google sign-in callback keeps the invite token.
  - Copy is one plain line ("Sign in to run studies across hospitals without moving patient data.") with the Fedlify logo, theme-coloured links and a "Forgot password? Ask your study lead" hint.
  - Add the "At least 12 characters" hint.
  - No Default Study is created for invited users.
  - New leads: the auto-created study is renamed "My first study" and Summary opens with an inline "Name your study" step.
- Profile: delete the stat row, the Account details card and the Organizations section. Show a card (name, email, institution) with an Edit window (name, institution, password) and a table "Your studies" (study, role, Open). Remove the "Study management" button. Study switcher: header "Your studies", footer "+ New study" and "All studies", and remove the duplicate user-menu entry.
- Sidebar: icons Team to TeamOutlined, Results to BarChartOutlined, Code to CodeOutlined. Every collapsed item gets a tooltip, and click-to-expand is removed. Show a skeleton menu while the mode loads.

**Removed**

- Two invite windows, the Advanced roles, the Status column, lead-held access codes and the register-then-sign-in detour.

**Browser acceptance checks**

- Invite a contact from the Sites row: the window has only an email field.
- Open the emailed link: it needs one form and lands on the site page.
- Resend and Copy link work.
- The Team page shows only study people.

### Phase 5. Site page and get-ready, for non-technical IT staff on all systems

**Goal:** one ordered checklist per site, and instructions that work on Windows.

**Changes**

- Replace the 5-tab strip and 4-chip rail with a vertical numbered `.fl-step` list: 1 Check this computer, 2 Create the site kit, 3 Start the runner, 4 Describe your data, 5 Sign-off. People and Activity go under a "More" link. Keep one Next step notice. Drop the Connection chip. Header subtitle without "(test)".
- Step 1 links to Get ready. Step 3 has a Windows / macOS / Linux switch, preselected from `navigator.platform`. Windows shows the PowerShell and WSL 2 steps. The visible text no longer mentions `age`; the unlock script picks Docker or age itself.
- Secrets: show the passphrase and access code in one "Save these two codes" card with Copy-all and a **Download setup sheet** (text file). Ask "Have you saved it?" before hiding. If feasible, fold the access code into the kit. Plain advice ("Store it in your hospital password manager. Do not email it with the kit file."). Remove the "give this page to IT" advice; invite IT as a site contact instead. The password re-entry modal says what each secret is for.
- "Your data" form: 4 fields (data types, approximate records, short description, "anything the assistant must know"). Residency and de-identification move to the study questions. Pre-fill from what the runner finds.
- Hide actions a person cannot use, or show one visible line saying who can act. Remove the disabled buttons with tooltips.
- Site activity: "Show more", grouping into You / Study team / System, and proposal and decision events.
- **Get ready page:** add the Fedlify logo and a "Back to my site" link. An OS picker comes first, showing only that system's steps in the order Install Docker, Run the check, Return to your site page. Add "What do you need?" choices (check this computer / install Docker / server without a screen). Hashes, GPU, architecture and systemd go under "For IT staff". Rename the user-menu "Help" item to "Get your computer ready".
- Use the shared `.fl-step` and `.fl-notice` classes and remove inline styles.

**Removed**

- Tab-name mismatch, status chips, the Connection panel and the bash-only commands.

**Browser acceptance checks**

- A fresh site contact follows 1 to 5 without leaving the page, except for Get ready.
- The Windows view shows PowerShell commands.
- The setup sheet downloads and contains both codes.
- No disabled button needs a hover to be understood.

### Phase 6. Pipeline, run and results

**Goal:** match the pages to phases 3, 5 and 6.

**Changes**

- Rename Code & run to **Pipeline** (Write and Publish only). The Sites stage panel is deleted, replaced by the one-line "1 of 2 sites connected" link. Run gets its own page; Summary phases link to it. The rail becomes status-only: no buttons, and `setup_run` is removed in `pipeline-stage.ts`. Each stage panel has one primary button. Derive state from published versions first. Show a skeleton until the files and commit have loaded, and fix the "Loading..." stage text.
- Header: use `PageHeader`, no extra outer card, no back arrow, no refresh button. One Pipelines menu only when more than one exists. Files and Checks collapse into "View code" (researchers). Merge repo checks into one plain-word "Before you publish" list showing failed items only. The file tree has a fixed height with internal scroll.
- **Assistant:** remove the Ask / Plan / Agent / Edit switch (decision 5). One input, one-line intro ("Ask the assistant to write or explain your pipeline. You approve every change."), retention text behind an "About chats" link, and the "Proposes only" tag removed. At most 3 chips chosen by state, using site names, not codes. The failure notice moves to the Run panel only; "Propose fix" is offered only for code errors.
- Publish: the button reads "Publish". Remove "Open repository" (kept under Details for researchers). Replace the table with a card ("v1 live since 11 Nov" with Details). The confirm dialog is one sentence. After publishing, say "Hospitals A and B need to update their runner; we have sent them a notice."
- Review flow: "Accept changes" is the only save action and says "Accepted. Next: Publish." Manual editing is hidden for non-researchers. The conflict dialog offers "Reload the latest" and "Keep mine".
- Run panel: Rounds and Min sites go under "Run settings" (defaults 5 rounds, all connected sites). Start run sits after the checklist, with the first blocker shown as visible text. Fix the checklist row layout (stack text and button). It shows only the current run's progress.
- Empty pipeline: the default is a big prompt box seeded "Write the pipeline from my study questions", with a small "Start from a template / import" link.
- **Results:**
  - Remove the Code column.
  - A single "no value" dash in the AUROC column, with the explanation under an info icon.
  - Runs named "Run 12 - Nov 5, 2026 11:03", newest first, with a status filter.
  - One `modelStateLabel` helper returns Not saved / Saved / Released v3, used in the list and in the Model tab.
  - Remove the back arrow on Results.
  - Run detail: 4 tabs (Summary, Performance, Model, Logs); the Activity tab is replaced by a Timeline in Summary linking to the Activity page with a run filter.
  - Use site names and plain "Rounds" / "Minimum sites"; remove the Status row; the server rewrites endReason in plain language.
  - Add a **Stop run** button (with confirmation) to the run header and the "A site is not responding" alert. The text points to the site contact, with no shell command.
  - Model tab: a three-step strip (Run finished, Save model, Release). Later steps are greyed with "Waiting for the study lead". The model card is a readable list, with the JSON under Details.
- **Activity (was Audit):** rename the sidebar item. The default filter is "Decisions and results", with a switch "Include assistant messages". Add Clear filters, an item-name search and a single Export menu (CSV default). The range picker has no time. Add a one-line "About" summary built from the metadata, with raw keys kept in Details.

**Removed**

- Assistant modes.
- Rail buttons.
- The Sites stage.
- Two of three places for Save model.
- The Run detail Activity tab.
- The Code column.

**Browser acceptance checks**

- The Pipeline page has no horizontal table scroll at 1440px.
- A failed run: Stop and Explain work from the run header.
- A model goes from saved to released through the three-step strip.
- The assistant chips are at most 3 and read in plain words.

### Cross-phase deploy notes

- Phase 3 is the only migration. It is additive and nullable, so it is safe to deploy alone.
- Each phase ends by removing its unused CSS selectors.
- Use `rg` to verify that retired terms are gone (workspace, code version, commit, repository, aggregator, NVFLARE in UI copy).
- Add a lightweight Playwright smoke test per phase for the acceptance checks above.