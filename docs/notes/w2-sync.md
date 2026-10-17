# Wave 2 · Sync and Gmail connect (branch `w2-sync`)

Notes for the integrator: decisions to fold into CLAUDE.md, Davi to-dos, privacy lines, and
prompt lines for the Prompt versions group. One section per step.

## Step 1 · Check 25 P1: Gmail unit budget

- Migration `0039_gmail_units` (renumber at merge): table `gmail_units (mailbox_id, minute,
  units)`, PK (mailbox_id, minute), FK cascade; `mailboxes.gmail_cool_until`.
- `src/mailbox/gmail/quota.ts`: `GMAIL_UNITS` (Google's per-method units),
  `GMAIL_UNITS_PER_MINUTE = 5_400` (90% of Google's 6,000 per user per minute, per
  developers.google.com/workspace/gmail/api/reference/quota, updated 2026-09-10).
- `createGmailReader({ mailboxId, budget })`: every request (retries included) reserves its units
  first; a spent minute throws `MailboxRateLimitError(retryAt = next minute)` before any fetch, so
  `politely()` pauses the step. Gmail's own "Retry after …" is stored on
  `mailboxes.gmail_cool_until` (only ever moved later) and every client for that inbox stops
  before fetching until then (a client re-reads the column at most every 15 s).
- `src/server/gmail-units.ts`: `gmailBudgetFor`, `gmailClientFor(m)` (sync, drafts, voice and
  everything built on `defaultReaderFor` / `defaultWriter` use it), `purgeGmailUnits` (daily, in
  the existing purge-rate-limits step), `logGmailUnits(job, mailboxId, client)` →
  `console.info("gmail_units", { job, mailboxId, gmailUnits })` (counts only).
- Ingest reads each inbox email once in full: a window is listed inbox first
  (`in:inbox …`, page token `inbox:<t>` / `rest:<t>`), history's `messagesAdded` labels are used
  as a hint, and an email in a conversation already in the inbox is read in full directly.
  Everything else is a metadata read, re-read in full only if it turns out to be inbox mail.
  A full read past retention still keeps no body.

CLAUDE.md line (Decisions): "**Gmail quota (wave 2, C25 P1):** per-mailbox unit budget in
`gmail_units` (5,400 of Google's 6,000 units a minute); every Gmail request reserves first; a
spent minute or Gmail's own retry time (`mailboxes.gmail_cool_until`) stops calls before any
fetch and `politely()` pauses. Inbox emails are read once (full); others as metadata."
