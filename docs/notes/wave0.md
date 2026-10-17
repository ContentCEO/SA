# Notes from wave 0 (branch `wave0`)

For the integrator to fold into `CLAUDE.md` / `docs/BUILD-ORDER.md`, then delete.

## Reserved columns (Check 50 P3, migration `0035_reserved_columns`)

Check 38 P2, 44 P1, 45 P2: use `business_profile.state`, add no migration. Check 20 P4, 21 P1: use
`messages.auto_reply` and `messages.ack_only`, add no migration. Check 22 P10 and 41 P6: use
`business_profile.crew_addresses` (max 30), not `team_addresses`.

The validation rule for the crew list is `crewAddressesSchema` in `src/server/profile.ts` (emails,
lowercased, de-duplicated, max 30). Nothing reads or writes the four columns yet.
`tests/unit/migrations-columns.test.ts` fails when two migrations add the same table.column.
