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

## Check 27 P9 + Check 27 P10

- P9 built: the connect screen's "What it won't do" list now reads "Share your email. It's stored
  on our own servers in the US, and the only outside company that reads it is Anthropic's AI, to
  sort and draft. It's never used to train AI." (the same places the privacy policy names).
- P10 **skipped: already done at the tip** (wave 2 merge C, `src/server/send-record-rules.ts`):
  an autopilot record closes with "Autopilot sent this on its own, under the rules you switched
  on." and a tapped record names the sign-in. The built wording wins; LAUNCH step 13 already asks
  Davi "Fine as worded?". Tick both in BUILD-ORDER: Wave 3, Legal text, 7) C27 P9 + C27 P10.

## Check 7 P1 + Check 7 P8 (for `CLAUDE.md` Decisions)

- The Markdown renderer (`src/lib/markdown.tsx`) joins a paragraph's lines before running the
  inline pass, so a bold phrase or link Prettier wrapped across two lines renders as bold instead
  of `**stars**`; hard breaks (a line ending in `\`) still split segments. `Markdown` takes
  `skipFirstH1`; `LegalPage` takes `serif` / `heavy` and opens with `<Headline>` ("the fine print,"
  over "privacy policy." / "terms of service."), so /privacy and /terms have one h1 like every other
  screen. The `.md` files are unchanged (their `# Title` line stays for readers of the repo). The
  freeze and hash tests don't trip: no document changed.
