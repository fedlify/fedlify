# Fedlify UI simplification plan (final, 2026-11-11)

Sources: six reviewers (133 findings, 35 high) in `ui-simplification-review-2026-11-11.md`, the critique in
`ui-simplification-critique-2026-11-11.md`, and the owner's decisions below. Where the review and this file disagree,
this file wins.

## Owner decisions

| Topic | Decision |
|---|---|
| Starting a study | One **Start the study** button on Summary, shown when the checklist is complete |
| What a site contact sees | A read-only **About this study** card on their site page |
| Removed | The 12 long design fields, the risk level field, the advanced roles in invite and role windows |
| Kept | The assistant modes (Ask, Plan, Agent, Edit) |
| First study | No study is created automatically. A person with no study sees **Create your first study** (title + one-line summary). Invited people never get an extra study |

## Resolutions of the critique

- **One onboarding path.** `ensureUserDefaults` keeps the profile and workspace but never creates a study.
- **Start gate** (the same function in all three callers: create study, study PATCH, publish/deploy route): title,
  objective, ethics cleared, at least one site, all 29 study questions answered or assumed. The six kept Study details
  fields are shown and encouraged, not required. Summary shows "Add your first site" when there is none.
- **Ethics expiry after start**: Summary shows it as a problem; publish and run stay blocked (already enforced).
- **Site suggestions** exist on study questions only (not on Study details) in this version. One open suggestion per
  question. The question keeps its status and its counted answer; a suggestion is a separate flag, so counts never drop.
  A later site sees "Hospital A suggested a change. Waiting for the study lead." The lead chooses **Accept** (the
  suggestion becomes the answer; confirmation resets) or **Decline** (one-line reason). Only site contacts may suggest.
- **"We cannot take part yet"** is a sign-off choice with a required reason. It shows as **Blocked** on the Sites table
  and on Summary. The lead's actions are **Contact the site** (email link) and **Mark as resolved** (sign-off back to
  Waiting).
- **Notifications**: in-app first (Summary counter, a badge on the question, the outcome on the site page). Email is sent
  only when the mailer is configured.
- **Pre-fill R04 from ethics**: dropped. **Risk level**: deleted.
- **Words**: "Open code" instead of "Open repository". Flag names in commands (`--aggregator`) stay inside the
  "For IT staff" part.

## Phases (each built, tested, deployed and checked on the live site)

1. **Visual foundation.** Spacing/radius tokens; `.fl-grid` (cards fill the row; fixes the Study management gap);
   one card style; page header consistency; tab content aligned with the header; one date format (`lib/format.ts`);
   StatusTag as the only status tag with one colour per meaning; table and empty-state consistency. Only build what
   phases 1-3 use.
2. **One model for study information.** Create study = small window (title, summary; institution only when there is a
   choice). Study details = 6 short fields. 12 design fields and risk level removed from forms and gate (old values
   readable under Details). Protocol becomes **Study setup** with tabs Details, Ethics and documents, Questions; the
   Progress tab is deleted. Summary is the one checklist and holds **Start the study**. No automatic studies; empty state
   "Create your first study".
3. **Sites have a voice.** About this study card; **Suggest a change** on questions for site contacts; lead review
   (Accept / Decline) on the question and a counter on Summary; sign-off with three choices (Ready, Ready with
   conditions, We cannot take part yet); site-only people see My site only.
4. **Invites, sites and sign-up.** One invite window (email only when the site is fixed); five plain roles only; Add
   site = name + optional first contact email; Sites table: Site, Status, People, Open; Team shows study-wide people;
   register from an invite signs in and lands on the site; expired invite says who to ask; Profile simplified.
5. **Site page for non-technical IT staff.** One numbered checklist instead of tabs; Windows / macOS / Linux switch;
   both codes in one "Save these codes" card with a download; Get ready with an OS picker first.
6. **Results and Activity (time-boxed).** Audit renamed Activity; one model-state label; plain run names and settings;
   Stop run; remove the Results Code column; run detail tabs reduced.

Acceptance checks per phase are in the review document.
