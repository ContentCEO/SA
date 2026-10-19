# Notes from branch `w3-legal` (wave 3, "Legal text, one release")

What `CLAUDE.md`, `docs/LAUNCH.md` and `docs/BUILD-ORDER.md` should say. Legal sentences are in
`docs/notes/legal-w3-legal.md` (kept until the legal release); this file is folded in at the merge.

## For `docs/BUILD-ORDER.md`

- Tick: Wave 3, Legal text, one release, 1) C50 P5.
- Add the "Legal text" section (the text is in `docs/notes/legal-w3-legal.md`, Check 50 P5).

## For `CLAUDE.md` (Decisions)

- **Legal text, one release (Check 50 P5, 2026-10-18):** `docs/terms.md`, `docs/privacy-policy.md`
  and `TERMS_VERSION` change only on a `claude/legal-<date>` branch (or the integrator's
  `integrate-*`), as one release, so owners agree again once. `tests/unit/legal-freeze.test.ts`
  diffs every other branch against its merge-base with `claude/squared-away-mvp-ddxl7s` and fails
  on a change to either document or to the `TERMS_VERSION` line; it skips, with a message, when git
  can't name the branch (detached HEAD without `GITHUB_HEAD_REF`) or find the base (shallow
  checkout). Builders put the wording in `docs/notes/legal-<branch>.md`. The steps are in
  `docs/LEGAL-RELEASE.md`.

## For `docs/LAUNCH.md`

- Step 13 "Terms: the three [To confirm] items": add "The wording for each option, ready to paste,
  is in `docs/notes/legal-w3-legal.md` (Check 27 P1) until the legal release applies it."

## CI

- `tests/unit/legal-freeze.test.ts` skips in GitHub Actions today: `actions/checkout@v4` makes a
  shallow clone with no base branch, so there is no merge-base. To make it bite in CI, give the
  unit-test job `with: fetch-depth: 0` (or fetch `origin/claude/squared-away-mvp-ddxl7s` before
  `pnpm test`). Locally it runs for real on every branch.

## Check 27 P6: text alerts (for `CLAUDE.md` Decisions and `docs/LAUNCH.md` step 10)

- **No migration.** The spec's `sms_opted_out_at` column was not added: `business_profile.sms_stopped_reason`
  (Check 19 P6) already records `opted_out`, the screen already reads it, and `setSmsAlerts(true)`
  already clears it. The send path now sets it too (Twilio's 21610 on a send, and on the code
  text). The migration lane was not taken.
- `sendLeadAlerts` wraps each owner in try/catch (`alertOne`): a refusal for one owner is logged
  (`sms_alert_failed` with the Twilio status and the error's name only), that owner's slot is handed
  back, and the next owner is still texted. `not_configured` still stops the run.
- `sendSms` parses Twilio's error JSON for the numeric `code` only; 21610 → `"opted_out"`.
- LAUNCH step 10: the Text alerts screen now carries the A2P 10DLC words (frequency, "Msg & data
  rates may apply", HELP/STOP, consent to the Terms and Privacy Policy under the button). When
  registering the campaign with Twilio, the opt-in screenshot is `/settings/texts` (phone form
  step). The legal sentences wait for the release (`docs/notes/legal-w3-legal.md`).
