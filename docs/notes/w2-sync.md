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

## Step 2 · Check 25 P2: archive, Trash, Spam and Not spam from Gmail

- `HistoryPage` gains `labelChanges` and `deleted`; `listHistory` asks for messageAdded,
  labelAdded, labelRemoved and messageDeleted (the `added` list is unchanged).
- `applyLabelChanges` (sync.ts) runs after each history page: stored labels follow Gmail; a
  message that gains INBOX with no body is read in full (within retention) and re-sorted
  (`classified_at` cleared on the message and thread); a Not-spam email never stored is stored;
  `threads.in_inbox` is recomputed for touched threads (some message with INBOX, not in
  Trash/Spam). A message deleted for good keeps its row (drafts may point at it) as INBOX
  removed + TRASH added.
- Whole conversation in Trash / Spam / deleted → pending drafts expire with "You deleted this in
  Gmail." / "You marked this as spam in Gmail.", countdown and send dropped. Nothing is deleted
  in the owner's Gmail (our Gmail draft stays there).
- Archive only → the draft stays in the Queue with the line "You archived this in Gmail."
  (`QueueItem.archivedInGmail`), its autopilot countdown is cleared, and a send still in its undo
  window is un-queued (activity `send_stopped` why `archived_in_gmail`: "Didn't send the reply …
  — you archived the conversation in Gmail. It's back in your queue").
- `runAutopilotSend` stands down when `threads.in_inbox` is false ("This conversation left your
  inbox in Gmail."). `deliverQueuedSend` stops (why `left_inbox`) when every email of the
  conversation is in Trash/Spam. **Adapted:** a tap on Send for a draft whose conversation was
  *already* archived still sends (the owner saw the archived line and chose to send); an archive
  *after* the tap un-queues it. needs wave 1: the send path group may prefer a check inside
  `queueSend` / `sendDraft`.

## Step 3 · Check 47 P1: refuse a Google account that has no Gmail

- `exchangeCode` calls Gmail's `/profile` with the new access token after the scope check. A 400
  `failedPrecondition` (or "Mail service not enabled") → the refresh token is revoked and
  `NoGmailError` (src/mailbox/connector.ts) is thrown; any other non-OK answer is a plain error.
- The callback maps it to `/connect?error=no_gmail` (log `gmail_connect_no_mailbox
  { name: "NoGmailError" }` only). Nothing is saved, so the trial clock never starts.
- Connect screen wording (phone from `siteConfig.phone`): "This Google account doesn't have
  Gmail, so there's nothing for Squared Away to read. It works with Gmail and Google Workspace
  for now. If your business email is on Outlook, call or text Davi at 978-201-9763; Outlook is on
  the list."
- e2e fake Google: `registerScenario(…, { noGmail: true })` makes the profile answer 400
  failedPrecondition.
- Every connect now makes one extra Gmail call (profile, 1 unit) before userinfo.
