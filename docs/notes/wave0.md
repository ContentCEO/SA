# Notes from wave 0 (branch `wave0`)

For the integrator to fold into `CLAUDE.md` / `docs/BUILD-ORDER.md`, then delete.

## Reserved columns (Check 50 P3, migration `0035_reserved_columns`)

Check 38 P2, 44 P1, 45 P2: use `business_profile.state`, add no migration. Check 20 P4, 21 P1: use
`messages.auto_reply` and `messages.ack_only`, add no migration. Check 22 P10 and 41 P6: use
`business_profile.crew_addresses` (max 30), not `team_addresses`.

The validation rule for the crew list is `crewAddressesSchema` in `src/server/profile.ts` (emails,
lowercased, de-duplicated, max 30). Nothing reads or writes the four columns yet.
`tests/unit/migrations-columns.test.ts` fails when two migrations add the same table.column.

## Prompt versions (Check 50 P2, `src/ai/prompts/registry.ts`)

For `docs/BUILD-ORDER.md`, so each next version is written once. `draft.v7` (warm first replies)
and `purpose.v2` (the paid-invoice thank-you) are taken by branches built alongside wave 0, so the
review bundle the review pages call "draft.v7" is **draft.v8** here:

- **draft.v8** = Check 23 P11 + 43 P1 + 44 P1 (and 45 P2) + the prompt parts of 40 P1 and 41 P1.
- Then the trade files of Check 36 P8, 37 P4 and 39 P6, in draft.v8 or the next version
  (**draft.v9**).
- **classify.v5** = Check 12 P2 + 12 P3 + 22 P9 + 38 P5 + 45 P7, plus the classify parts of 21 P1,
  21 P2, 22 P4, 37 P3 and 39 P5.
- **followup.v5** = Check 12 P7 + 21 P7.
- **voice.v3** = Check 24 P5 + 24 P9.
- Any later purpose prompt starts at **purpose.v3**.

A new version is a new `<kind>.v<N>.ts` file plus one line in `ACTIVE`;
`tests/unit/prompt-versions.test.ts` fails on two files with the same version, a gap, an `ACTIVE`
that isn't the newest file, or code that records a version imported from an older file.
