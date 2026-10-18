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
  _already_ archived still sends (the owner saw the archived line and chose to send); an archive
  _after_ the tap un-queues it. needs wave 1: the send path group may prefer a check inside
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

## Step 4 · Check 25 P3: re-read the whole gap when Gmail's history expired

- Migration `0040_resync_cursor`: `mailboxes.resync_since`, `mailboxes.resync_page_token`.
- On a history 404, `incrementalSync` takes a fresh cursor with getProfile, **stores it at once**
  (adapted: the spec stores it at the end; storing it first is equivalent — mail after it comes
  through history, mail before it through the re-read — and needs no third column), sets
  `resync_since = now − clamp(ceil(gap days) + 1, 7, 30)` and returns
  `{ status: "resync_needed", since }`. The window is a fixed `after:<epoch seconds>`.
- `resyncPage(mailboxId)` reads one page (50, inbox pass first) from the saved token; when done it
  clears the re-read and sets `last_synced_at`. Every sync continues an unfinished re-read before
  using history. The `sync-mailbox` job loops `resync-page-N` steps, at most 300 per run.
- A gap longer than 30 days writes one `mail_gap` activity row `{ mailboxId, fromDay, toDay }`
  (dates only; hidden on Activity until a screen uses it — idea E4).
- `runIncrementalSync` = sync + whole re-read in one go (tests and the e2e hook).

## Step 5 · Check 20 P4 + Check 21 P1: automatic replies, bounces, acknowledgements

No migration: uses wave 0's reserved `messages.auto_reply` and `messages.ack_only`.

- Sync asks for Auto-Submitted, X-Autoreply, X-Autorespond, Precedence and
  X-Auto-Response-Suppress, and sets `messages.auto_reply` (inbound only) per
  `src/server/auto-reply-rules.ts`: Auto-Submitted present and not "no"; any X-Autoreply /
  X-Autorespond; Precedence auto_reply / bulk / junk / list; subject starting "Automatic reply:",
  "Auto:", "Out of Office", "Autoreply"; or a mailer-daemon / postmaster sender. The body is never
  read for this. Header values are never stored or logged. (X-Auto-Response-Suppress is read but
  doesn't mark on its own: plenty of ordinary bulk mail carries it.)
- Classification: auto-replies are set aside with no model call (message `classified_at` set);
  they never supersede the customer's own newest email. A conversation with nothing else becomes
  noise ("Automatic reply."); otherwise its kind is untouched.
- `lastInSql`, `waitingSinceSql` (+ sender / reply twins), `threadsToAutoDraft` and reconcile's
  "new inbound expires the draft" ignore auto-replies.
- `createDraftForThread`: jobs skip a newest-inbound auto-reply (`auto_reply`) or ack_only
  (`acknowledgement`, auto trigger); auto-replies aren't part of a job's conversation; the owner's
  tap sees everything. Autopilot guardrail `autoReply`: "That was an automatic reply, so it waits
  for you."
- Bounces: a bounce after the owner's newest email with no real customer email since sets
  `threads.extracted.bounced` (recomputed on each sync of the thread; cleared when the owner
  writes again or the customer answers). No nudge (`bounced`); Inbox and Queue cards say "Your
  email to this customer bounced. Check the address." Known gap: a later classification of an
  older customer email can overwrite `extracted` and drop the mark until the next sync of that
  thread.
- Acknowledgements: new `thread-sql.ts` helpers `lastAnswerInSql` (not auto, not ack),
  `ballInTheirCourtSql`, `quietSinceSql` (= greatest(last out, last in)). The follow-up scan and
  `guessNoAnswers` use "ball in their court" and count the wait from the acknowledgement; a nudge
  after an acknowledgement is threaded to it (`In-Reply-To` = her email, To = her). No reply is
  auto-drafted to an ack_only email.
- `messages.ack_only` is written at classification from `extracted.acknowledgment_only`, which
  `src/ai/classify.ts` maps from the model's `signals.acknowledgment_only`. **Inert until the
  Prompt versions group adds that signal** (classify.v4's zod schema strips unknown keys).

### For the Prompt versions group (Check 21 P1)

- classify (next version): add to `signals`:
  `acknowledgment_only: z.boolean()` with the instruction line:
  "acknowledgment_only: true only when the email just thanks or acknowledges (\"Thanks, got it.
  We'll look it over and get back to you.\"), says they will decide or get back to you, asks no
  question and needs no answer. False if it asks anything, changes anything or needs a reply."
- followup (next version): when the customer's newest email is an acknowledgement, add to the task:
  "The customer said they'd look it over on <weekday, Month D>." (`drafts.ts` knows it: `last`
  is the acknowledgement when `onlyAcksSince` is true; pass `last.sentAt` in the owner's zone.)
- Eval cases to add (tests/evals/cases.ts), scored on `acknowledgment_only`:
  - true: "Thanks, got it. We'll look it over and get back to you." / "Thanks! We'll talk it
    over this weekend and let you know." / "Got the estimate, appreciate it. Will be in touch."
  - false: "Thanks — does that include the permit?" / "Got it. Can you start before the 15th?"

## Step 6 · Check 40 P2: photos and files that came with an email (counts only)

- Migration `0041_attachment_counts`: `messages.attachment_images`, `attachment_pdfs`,
  `attachment_other` (int, default 0). No file name or content is stored anywhere (a test greps
  the schema).
- `countAttachments(payload)` (src/mailbox/gmail/parse.ts): parts with a filename or an
  attachment Content-Disposition, by kind; an inline image under 10 KB (signature logo) doesn't
  count. Only full reads carry counts (`MailMessage.attachments`).
- Inbox and Queue cards: "3 photos attached · open in Gmail" (`AttachmentLine`, 44px link to the
  Gmail thread), summed over the customer's emails on the conversation (auto-replies left out).
- **Adapted (needs the Prompt versions group):** parts 3 and 5 are prompt changes, so no prompt
  file was written here. The plain words come from `attachmentWords()` in
  `src/server/attachment-rules.ts` ("3 photos, 1 PDF"). Lines to add:
  - classify `emailBlock` and draft conversation block, one line per email with attachments:
    `Attached: ${attachmentWords(counts)} (the assistant can't see them)`.
  - draft rule: "If the customer attached photos, don't ask for photos again; ask only for an
    angle that's missing, or say you'll look at them."
  - Part 5: an email whose only content is attachments should be classified with that line as
    its text instead of being treated as having no text (the `Attached:` line makes the body
    non-empty). The drafts test "the draft prompt carries 'Attached: 3 photos'" goes with that
    change.

### Privacy policy line (for Davi to approve; don't bump TERMS_VERSION)

Under "What we store": "How many photos or files an email had (never the files or their names)."

## Step 7 · Check 25 P4: fewer background executions

- Migration `0042_job_runs`: `job_runs (function_id, day, runs, steps)`, PK (function_id, day).
  Middleware `CountJobRuns` (src/jobs/client.ts) counts `onRunStart` and executed steps
  (`onStepComplete` / `onStepError`; memoized steps aren't counted); /admin System box: "Background
  work this month: N steps" (runs + steps, what Inngest meters). Purged after ~120 days.
- `incrementalSync` returns `hasPending` (a pending draft, queued sends included); `afterSync`
  sends draft.requested only with new mail (→ classify) or something pending. Null otherwise.
- `workspace-lifecycle`: four `step.run`s — clock, backstops (then one `step.sendEvent` for all
  backstop events, only if any), housekeeping, alerts. Housekeeping runs before alerts so the
  lead-at-risk pushes still follow the M7 backfill (A29). Each check runs on its own in
  `runChecks` (try/catch, `Sentry.captureException` with job + check tags, no content); the run
  throws `LifecycleChecksFailedError` at the end if any failed.
- `reply-to-backfill`: daily cron `43 4 * * *`; while unfinished each run sends
  `reply-to-backfill/continue` with `ts` = now + 15 min (Inngest can't change a cron at runtime).
  **Integrator:** if production's backfill isn't finished yet, the first rerun comes at 4:43 UTC
  after deploy.
- With `GMAIL_PUBSUB_TOPIC`: the watch asks for `["INBOX", "SENT"]`, and the 5-minute poll skips a
  mailbox whose watch is live and that synced under 15 minutes ago (`pollDue`;
  `listSyncableMailboxes(now, { forPoll: true })` — the follow-up scan still sees every mailbox).
  Without a topic nothing changes. Note: /admin's "jobs look stopped" fires after 20 minutes
  without a sync; with push on and a quiet inbox the worst case is close to that (15 min + one
  poll), so consider 25 minutes when Davi turns push on.
- Count (same method as the check): fixed ≈ 864 (poll) + 480 (lifecycle: run + 4) + 72 (digest)
  + ~17 (daily/weekly + reply-to) ≈ 1,433 a day ≈ 43,000 a month; a quiet inbox adds sync-mailbox
  run + sync = 576 a day ≈ 17,300 a month (the draft job no longer follows a quiet check).
