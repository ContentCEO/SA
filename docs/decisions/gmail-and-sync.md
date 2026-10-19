# Gmail and sync: connecting, reading mail, drafts in Gmail, inbox and customers

Moved unchanged from `CLAUDE.md`'s "Decisions" section on 2026-10-19 (Check 49 P5), in their
original order. Rules that a test or gate depends on are also stated in `CLAUDE.md`.

- **Sign-in and Gmail are two separate OAuth consents.** Auth.js asks only `openid email profile`;
  Gmail scopes are requested by our own flow after the explainer screen. Same Google client, two
  redirect URIs. Gives us full control of the refresh token and the "missing scope" handling.
- If Google's granular consent returns fewer than both Gmail scopes (`gmail.readonly` +
  `gmail.compose`), we revoke and save nothing. A grant with more than we asked for (an older
  connection's `gmail.send`, which `include_granted_scopes=true` brings back) is accepted.
- Connect uses `prompt=consent` + `access_type=offline` so a refresh token always comes back.
- OAuth `state`: random 32 bytes in an httpOnly, SameSite=Lax cookie scoped to `/api/gmail`,
  10-minute TTL, compared in constant time.
- Mailbox limit before a plan is chosen (evaluation) = 1. Reconnecting the same address doesn't count.
- Disconnect revokes at Google, then deletes the mailbox even if revoke fails (logged
  `revokedAtProvider: false`). Deleting is what the owner asked for.
- `activity_log` created early (M1) to record connect/reconnect/disconnect; detail is content-free.
- **Sync (M2):** `MailboxReader` interface in `src/mailbox/connector.ts`; Gmail impl in
  `src/mailbox/gmail/api.ts` is plain `fetch` (no googleapis SDK) with token refresh, 401 re-refresh
  once, 429/5xx/rate-limit-403 exponential backoff with full jitter + Retry-After, and
  `MailboxAuthError` on invalid_grant / repeated 401 / permanent 403.
- Engine in `src/server/sync.ts`: backfill = record `historyId` first, then page `newer_than:30d`
  (100/page, one Inngest step per page), metadata for all, `format=full` only for inbox threads and
  only within retention. Incremental = History API from cursor; on 404 re-read last 7 days and take
  a fresh cursor. Everything idempotent (unique gmail ids, onConflictDoNothing).
- `MailboxAuthError` anywhere → `status = reconnect_needed` + one `mailbox_access_lost` log; every
  job skips non-active mailboxes before touching Google. Banner on every signed-in screen.
- Retention purge nulls `body_text` AND `snippet` (Gmail snippets are body text) past
  `RETENTION_BODY_DAYS`; runs daily. Bodies capped at 20k chars. **M11 (S3):** it also empties
  `drafts.flags` (they quote draft text) with the draft body / original text, clears `send_after`,
  `send_claimed_at` and `auto_send_at` on the pending drafts it expires, and strips `address`,
  `dates` and `permit.corrections` from `threads.extracted` once the thread's newest email is past
  the window (content-free facts stay: invoice number/amount/due date/status, permit number /
  issuing body / inspection time / result, service, dollar figures, our true/false marks).
  `tests/unit/data-lifecycle.test.ts` is the gate.
- Jobs (Inngest v4, `triggers` in options): backfill (singleton per mailbox), sync (concurrency 1 +
  20s debounce per mailbox), poll every 5 min (also starts missed backfills), watch renewal daily
  (only if `GMAIL_PUBSUB_TOPIC`), purge daily. `enqueue()` swallows send failures; the poll recovers.
- Gmail pacing: 4 concurrent reads, 50 messages per backfill step. A rate limit that outlasts the
  client's retries throws `MailboxRateLimitError`; jobs wrap Gmail steps in `politely()` which turns
  it into Inngest `RetryAfterError("2m")` — pause and resume, not fail. (First live backfill on
  2026-10-03 kept tripping `rateLimitExceeded` at 8 concurrent / 100 per page.)
- **#44 Your Gmail health (2026-10-09):** `mailboxHealth()` (`src/server/mailbox-health.ts`, pure)
  → three plain lines (Google access / Last checked / New mail). `mailboxes.last_sync_error_code`
  (`access_lost` | `rate_limited` | `sync_failed`, never message text) set in `guarded()`, cleared on
  the next ok sync and on reconnect. Reconnect button only for lost access (the only thing the owner
  can fix); stale sync (>30 min) says "We keep trying on our own, and your email is safe in Gmail"
  (round 2: "we're looking into it" wasn't true). Settings heading is "Your Gmail".
- **Milestone 2 re-check (2026-10-10, Davi's M2 prompt, branch `claude/milestone-2-sync`):** brief scope
  (backfill, History API, Pub/Sub watch + 5-min poll, reconnect, revoked-token tests) was already
  built; plan M2 has only #44 (done) and **no R-numbered items exist** in `docs/FEATURE-PLAN.md`.
  Added the missing tests (`tests/unit/push-poll.test.ts`: watch renewal, poll selection, push
  endpoint) and fixed two things they found: a garbled Pub/Sub payload made `/api/gmail/push` throw
  (→ endless Pub/Sub retries; now acknowledged with 204), and `renewWatches` renewed watches for
  read-only accounts (now skipped via `jobsAllowed`).
- **Gmail drafts are not mail (2026-10-13, M8 review):** a Gmail draft is a message with the
  DRAFT label and no SENT. Sync used to store every draft (ours included) as owner mail ('out'),
  so an unsent draft read as "the owner answered". Sync now skips DRAFT-without-SENT
  (`isUnsentDraft`; no row, no thread, no `last_message_at` move). Google's drafts guide says a
  sent draft becomes a new message; not checked live, so the code is also right if Gmail kept
  the id: `listHistory` asks for `messageAdded` **and** `labelAdded` (ids that gain SENT);
  `ingest` re-fetches a stored row that is still an unsent draft and updates it in place
  (`setWhere`), never other stored rows; `sendDraft` stores its own sent message
  (`recordSentMessage`, best effort, **after** the `reply_sent` row, only when the writer can
  read). Thread `participants` are merged in SQL on upsert (an app send can run alongside a
  sync). "The owner wrote" reads ignore unsent drafts with one predicate (`notDraftSql` /
  `notDraftMessage` in `thread-sql.ts`, same rule as `isUnsentDraft`: DRAFT+SENT is mail):
  lastOutSql (so leads at risk, digest waits, no-answer guesses, price memory), follow-ups,
  scorecard, reconcile, knownCustomer, createDraftForThread / revise conversation,
  classification's ownerWroteBefore, ownerQuotedCents, Quotes' stage, the closing-question
  timing. **A stored draft never answers a lead** (alert even before the cleanup). The
  exceptions are on purpose and only matter for rows old sync stored: whatever could send on
  its own treats an unchecked row as a possible answer — `threadsToAutoDraft` still counts it
  as the owner's last write, autopilot layer 3 refuses a thread with one after the customer's
  email ("You might already have answered this in Gmail."), and `runAutopilotSend`'s
  newer-mail check counts it; sms-alerts' newest-direction check doesn't filter them either.
  **Autopilot asks Gmail before sending** (`MailboxWriter.threadDraftMessageIds`,
  threads.get format=minimal, ids only): any unsent draft on the thread other than ours →
  stood down "You're writing a reply in Gmail." (the owner's autosaved reply is no longer
  synced). Only asked when `canSend` and the mailbox is active (no Google call when blocked).
  One-shot `runDraftMessagesCleanup` (`src/server/draft-message-cleanup.ts`, 15-min job after
  `m7-backfill`): rows an app send recorded (`sent_gmail_message_id`) become SENT without Gmail;
  every other stored draft is looked up in Gmail (100 per mailbox per run) — sent → updated, gone
  or still a draft → deleted; pending drafts threaded to a deleted row are re-pointed to the
  newest real message; a quote amount / price-memory row taken from a deleted draft's text is
  cleared (unless the figure is in real sent mail, the owner typed it, or any real owner email
  on the thread has lost its text to the purge) so `captureQuoteAmounts` redoes it;
  `last_message_at` recomputed. **Done per mailbox** (`app_settings`
  `cleanup:draft-messages-v1:<mailboxId>`): a mailbox we can't read (lost access, read-only
  account) keeps its rows and no marker, and is checked again every run (one query) until it
  can be read; the run-wide key `cleanup:draft-messages-v1` is written only when every mailbox is
  done (nothing failed, skipped or left over). Not repaired: `extracted.quote_accepted` /
  auto-Won outcomes decided while a draft counted (the owner can change them). Ingest sets
  `last_message_at` = greatest(new messages, stored messages' max) so a stale read can't put a
  deleted draft's time back.
- **Side conversations (2026-10-13, M8 review):** Gmail keeps the owner's forward of a lead to
  the crew (and the crew's reply) in the customer's conversation, so "the owner wrote" counted a
  forward as an answer. `sideEmailSql` (`thread-sql.ts`) now leaves out side emails everywhere
  "who wrote last" is asked: `lastInSql` / `lastOutSql` / `waitingSinceSql` (leads at risk,
  Quotes' stages, digest waits, no-answer guesses, follow-ups), the scorecard's first answer,
  the `quote_requested_at` timing, and `createDraftForThread` for nudges / closing questions
  (`last`, the addressee, the threading and the model's conversation). Decided by **who the
  owner wrote to**, never by one "customer" address: the customer's side = anyone on the
  thread's inbound mail (sender, To or Cc). An owner email is side when it goes to someone,
  none of its recipients is on the customer's side (crew replies don't count as that), and it
  is a forward the owner started (subject `Fwd:` / `Re: Fwd:` on a thread whose lead didn't
  itself arrive as a forward) **or** every recipient is on the mailbox's own business domain
  (crew@shop.com; never on public webmail, `PUBLIC_WEBMAIL_DOMAINS` in `sender-rules.ts`).
  An inbound email is side when its sender got the lead from the owner (a recipient of such an
  owner email, or of any owner email when on the owner's business domain: "Dana, meet Mike")
  and had never been on the thread's inbound mail before. Since 2026-10-16 (review B1) the
  customer's side also includes each inbound email's stored Reply-To (`involvedSql`), so an
  owner "Fwd:" to a form lead's own address answers them and their later reply isn't a crew
  reply. Still not a strict "To/Cc holds the customer" rule: rows outside the Reply-To backfill
  (older than 30 days / not inbox) have none stored, and a lead forwarded by a friend or
  property manager has the customer on no header. **Known gaps:** a plain "Re:" sent only to
  an outside address answers the lead; on a lead that arrived as a forward (a friend, an office
  or a property manager), the owner's forward to an outside crew counts as an answer.
  **Known limitation (A11):** `quote_requested_at` is sticky, so a returning customer asking for
  a new job on their old, already decided quote thread keeps the first request's time: the
  scorecard, the monthly count and the repeat-customer check miss the new request (no history of
  requests is kept). Re-stamping it when the outcome is decided would also need the outcome and
  Quotes' stage to move with it — not built.
  **A10 in every unit test:** `createTestDb` calls `refuseDateParams`
  (`tests/support/no-date-params.ts`), so PGlite refuses a JS `Date` bound into raw SQL as
  postgres.js does.
- **Google demo video: option B (Davi, 2026-10-15: "just do b"):** a separate demo account
  invited from `/admin`, paid with Stripe's test card while production Stripe is in test mode; an
  engineer's dry run on production first; delete it before step 7 or Reset test payments clears it
  in 7c. LAUNCH.md 0d / step 13 and google-verification.md updated (the demo script's sign-in step
  now ticks the box). Dropping `gmail.send` was still open then (decided yes later that day, see
  "Gmail scopes: two" below): Davi asked whether it is what keeps
  replies from going out by accident; answered in LAUNCH.md step 13 (no: the approval is the app's
  own Send reply rule; `gmail.compose` already sends approved replies; `gmail.send` only carries
  trial practice copies today).
- **Gmail scopes: two (Davi, 2026-10-15: "remove the gmail.send permission"):** Connect asks
  for exactly `gmail.readonly` + `gmail.compose` (`src/mailbox/gmail/scopes.ts`). Google's API
  reference (discovery doc revision 20261012, read 2026-10-15): `users.drafts.send` and
  `users.messages.send` both accept `gmail.compose`; `gmail.send` alone can't send a draft;
  `gmail.readonly` and `gmail.compose` are restricted (CASA still required). Owners who connected
  before keep their grant (it carries `gmail.send`, and `include_granted_scopes=true` brings it
  back on a reconnect): nothing reads `mailboxes.scopes` after connect, so they keep working and
  nobody reconnects. `missingScopes` only refuses a missing scope, never an extra one (unit tests
  in `gmail-connector.test.ts`; the callback in `gmail-connect-callback.test.ts`: either one
  unticked → revoke, no row, no trial clock; a reconnect leaves the saved row untouched).
  Copy uses Google's consent wording: "View your email messages and settings" (readonly),
  "Manage drafts and send emails" (compose); the `/connect` explainer adds that a reply still goes
  out only on **Send reply**, or by autopilot if the owner switches it on for a kind of email (the
  same promise as the privacy policy's compose row; the older "Send a reply only when you tap Send
  reply" bullet now says so too). The privacy policy says older connections may still show "Send
  email on your behalf" at Google until they disconnect. **The e2e Gmail fake enforces scopes**
  (`GMAIL_METHOD_SCOPES` in `tests/e2e/fakes/server.ts`, copied from the discovery doc): the
  token carries what the consent page allowed (`registerScenario(..., { untick, earlier })`),
  each call needs one accepted scope or gets Google's 403 `insufficientPermissions` (recorded as
  `insufficientScope`), a code needs a consent first, and a revoke ends the grant. full-flow
  asserts the consent asked for exactly the two, the token carried exactly those and nothing was
  refused, so the reply (`drafts.send`) and the practice copy (`messages.send`) are proven with
  the two scopes. Not yet tried live: checked on production right after it ships. **That live
  check clears the demo Gmail's old grant first** (2026-10-15 review): a grant given while we
  still asked for `gmail.send` keeps it, a reconnect brings it back, and `messages.send` accepts
  it, so the practice copy would pass without testing `gmail.compose`. Before the check: Disconnect
  Gmail on every account holding the demo Gmail (revokes at Google; removing it only at
  myaccount.google.com while an account is connected puts that account in `reconnect_needed`),
  confirm at myaccount.google.com/permissions that Squared Away has no Gmail access, reconnect,
  and confirm that mailbox's `mailboxes.scopes` has no `gmail.send`. The demo video's "Before
  recording" note repeats the clear-out (filming comes after the check).
- **Inbox (wave 2, `w2-inbox`):**
  - **Needs you lets go (Check 10 P1):** `threads.needs_owner_since`; one rule,
    `openNeedsOwnerSql()` (`src/server/needs-owner.ts`): `needs_owner` and the owner hasn't written
    since `needs_owner_since` (`lastOutSql`; older rows fall back to `classified_at`; an old manual mark with no time
    never lets go). The sorter sets the time to the email's own time when the flag goes up, keeps
    it while it stays up, nulls it when it goes down; "This one needs me" and Move it → complaint
    set it to now. `clearAnsweredNeedsOwner(mailboxId)` runs once per `incrementalSync`, in
    `finishBackfill` and when a re-read finishes: clears the flag, manual mark, reason and time
    and logs `needs_owner_cleared {by: "gmail_reply"}`; a dispute / legal reason stays on the row.
    `markAnsweredByPhone` clears it too (`{by: "phone"}`). Inbox: `CalledThem` (back="inbox") on
    "Waiting on you" cards; "Take it off my list" → `takeOffListAction` (`{by: "owner"}`).
  - **Quotes closed another way / Not a quote (Check 11 P8):** `threads.quote_dismissed_at`. "I
    sent the price another way" → `markAnsweredByPhone(…, { via: "other", amountCents })` (typed
    price into `quote_amount_cents`, never price memory). "Not a quote" (one confirmation) →
    `quote_dismissed_at`; `quoteNotDismissedSql` keeps such threads out of quote rules unless an
    outcome comes after it. "Not quotes (N)" with Put back. Follow-ups skip a dismissed quote.
  - **Emergencies first (Check 10 P3):** tier order (`tierSql`, twin of `inboxTier` / `inboxRank`
    / `compareInbox` in `inbox-rules.ts`): emergency in 24 h with the customer last (4) + open
    needs-you (2) + priority high in 24 h (1), then newest, then id. "Emergency" / "Urgent" lead
    the card in font-black.
  - **Paging (Check 10 P2):** `inboxPage()` keyset paging (`?before=<ISO>&after_id=<uuid>`,
    Zod-checked, anchor looked up inside the workspace); 100 non-junk rows per page; junk and
    older unsorted mail folded (count + 50 newest, first page).
  - **Draft ready / reason (Check 10 P4, P5):** `pendingDraftId` → " · Draft ready" and "See the
    draft" (`/queue?t=<uuid>#t-<uuid>`); the needs-you reason under the tag line.
  - **Open in Gmail and the customer (Check 10 P6):** "Open in Gmail" and "From <name>" →
    `/customers/<opaque key>` (never for lead sites / phone services); no address in a URL.
  - **Unsorted mail (Check 10 P7):** a model failure stores `extracted.unreadable` ("Couldn't
    sort"); never-sorted mail older than `CLASSIFY_LOOKBACK_DAYS` folds into "N older emails, from
    before Squared Away started sorting" with a "Not sorted" chip.
  - **Search (Check 10 P8):** also the work, address, invoice and permit numbers; accents folded
    (`foldForSearch`). **Chips (Check 10 P9):** wrap from `sm`, one scroll row with a fade on
    phones; the tag says " · Needs me". **Plain reasons (Check 10 P10):** no dashes
    (`COMPLAINT_REASON`, `LOW_CONFIDENCE_REASON`, `UNREADABLE_REASON`, `MODEL_FLAG_REASON`,
    `INJECTION_REASON`, `LEGAL_REASON` "Mentions a lawyer, a lien or a claim.").
- **Sync and Gmail connect (wave 2, `w2-sync`):**
  - **Gmail quota (C25 P1):** per-mailbox unit budget in `gmail_units` (5,400 of Google's 6,000
    units a minute; `src/mailbox/gmail/quota.ts`); every Gmail request reserves first; a spent
    minute or Gmail's own retry time (`mailboxes.gmail_cool_until`) stops calls before any fetch
    and `politely()` pauses. Inbox emails are read once (full); others as metadata.
    `logGmailUnits` → `console.info("gmail_units", {job, mailboxId, gmailUnits})`. Purged daily.
  - **Archive, Trash, Spam, Not spam (C25 P2):** `listHistory` asks for label changes and
    deletions; `applyLabelChanges` keeps stored labels in step and recomputes `threads.in_inbox`.
    Whole conversation in Trash / Spam / deleted → pending drafts expire ("You deleted this in
    Gmail." / "You marked this as spam in Gmail."); nothing is deleted in the owner's Gmail.
    Archive only → the draft stays with "You archived this in Gmail.", its autopilot countdown
    cleared and a send in its undo window un-queued (`send_stopped` `archived_in_gmail`). A tap on
    Send for an already-archived conversation still sends.
  - **No Gmail (C47 P1):** `exchangeCode` calls `/profile`; `failedPrecondition` → revoke,
    `NoGmailError`, `/connect?error=no_gmail`; nothing saved, no trial clock.
  - **Expired history (C25 P3):** `mailboxes.resync_since` / `resync_page_token`: a fresh cursor
    is stored at once and the gap (7–30 days) re-read one page per step; a gap over 30 days logs
    `mail_gap` (dates only, hidden on Activity).
  - **Automatic replies (C20 P4 + C21 P1):** only real automatic responses mark
    `messages.auto_reply` (Auto-Submitted `auto-replied`, Precedence `auto_reply`, X-Autoreply /
    X-Autorespond, out-of-office subjects, mailer-daemon / postmaster bounces; header values never
    stored). They're set aside with no model call, never supersede the customer's own email,
    never expire a draft, never get a reply; autopilot guardrail `autoReply`. Bounces set
    `extracted.bounced` ("Your email to this customer bounced. Check the address."), no nudge.
    Acknowledgements (`messages.ack_only`, inert until the prompt signal): `lastAnswerInSql`,
    `ballInTheirCourtSql`, `quietSinceSql`; nudges count from the acknowledgement.
  - **Attachments (C40 P2):** `messages.attachment_images` / `_pdfs` / `_other` (counts only, no
    names); `AttachmentLine` "3 photos attached · open in Gmail" on Inbox and Queue cards.
  - **Fewer executions (C25 P4):** `job_runs` (runs + steps per function per UTC day, middleware
    `CountJobRuns`); /admin "Background work this month: N steps". `afterSync` sends a draft job
    only with new mail or something pending. Lifecycle job grouped (above). `reply-to-backfill`
    daily at 4:43 UTC, re-sending itself 15 minutes later while unfinished. With
    `GMAIL_PUBSUB_TOPIC`, the watch covers INBOX + SENT and the poll skips a mailbox with a live
    watch synced under 15 minutes ago (`pollDue`).
  - **Big first read resumes (C25 P5):** `backfill_page_token` / `backfill_pages_done` /
    `backfill_since`; at most 300 pages a run, the poll continues; a refused token restarts the
    listing; a reconnect starts fresh. Sync uses `after:` windows only.
  - **Plain "mail is behind" line (C25 P6):** `StaleMailLine` on every signed-in screen when an
    active inbox's last check is over 30 minutes old; `mailboxHealth` and the learning screen show
    first-read progress ("Reading your last 30 days: 1,250 emails so far, started 2:10 PM.").
  - **One Gmail in one account (C25 P7):** `saveConnectedMailbox` refuses an address held by
    another workspace (`MailboxInUseError`, `/connect?error=in_use`, activity
    `mailbox_in_use_refused`); the new token is **not** revoked (a revoke could cut off the other
    account). Plain index on `lower(mailboxes.email)`, not unique yet.
  - **Right account on Connect another / Reconnect (C42 P3):** `/connect?reconnect=<id>` /
    `?add=1`; `login_hint` or `prompt=consent select_account`; state cookie
    `<state>~<mode>~<mailbox id>`; `already_connected` / `wrong_account` errors save nothing and
    revoke nothing.
  - **One provider switch (C47 P2):** `mailboxClientFor` (`src/mailbox/clients.ts`) is the only
    `createGmailReader` caller outside src/mailbox/gmail; `serverMailboxClient` adds the unit
    budget and saves a rotated refresh token (`saveRotatedRefreshToken`, encrypted, never logged).
  - **Labels and search words in one place (C47 P4):** `MAIL_LABELS`;
    `listMessages({ newerThanDays?, after?, inbox?, sentOnly?, pageToken?, maxResults? })`
    replaces raw queries; a guard test bans Gmail query words and label names outside
    src/mailbox/.
  - **Test Gmail (C25 P8):** `tests/support/fake-mailbox.ts` keeps a typed history log, lists by
    window, counts units per fake minute; vitest `hookTimeout` 30 s / `testTimeout` 60 s.
- **Customers and senders (wave 2, `w2-customers`):**
  - **Crew (Check 13 P1 + 22 P10 + 41 P6):** `business_profile.crew_addresses` (wave 0's column;
    Settings → Your business "Your crew's email addresses", max 30; `crew_list_saved {count}`).
    Crew = on that list or one of the workspace's own Gmail addresses (`isCrewAddress` /
    `crewSql`, parity-tested); the owner's business domain only files a Customers row. A
    crew-only thread is stored as scheduling, low, needs nobody, `extracted.crew = true`, "From
    your crew: …", with **no model call** unless a safety check fires. Jobs never draft for the
    crew (thread mark or a crew To, read live); the owner's tap still drafts. Customers rows have
    `kind` (town → crew → supplier → customer) with 44px group links (`?group=`). Quotes, found
    money, leads at risk and the scorecard leave crew out.
  - **Robots (Check 13 P2 + 41 P7):** `MACHINE_SENDER_DOMAINS` (indeed, ziprecruiter, glassdoor,
    snagajob) in `isNoReplyAddress` / `noReplySql`; `customerRobotSql` / `isCustomerRobot`
    (parity-tested); a robot or junk email's key is a 404.
  - **First-time sender "unknown" (Check 22 P7):** a no-reply / lead-platform From with no usable
    Reply-To → `"unknown"` (counts as first time); voicemail-by-email compares the number named.
  - **Every customer (Check 13 P3):** no 500 cap (`CUSTOMERS_CEILING` 10,000, `customers_ceiling_hit`
    logged), 50 at a time, `quoteFactsByAddress` (read-only; Customers never runs the Quotes
    screen's work).
  - **Names and the page (Check 13 P4–P8):** `newestNameSql`; `bigJobReason(historyDays)` ("…hasn't
    written in the mail we've read so far." under a year of mail); the customer page's facts
    line, job addresses and stage per card; `wroteWords`, `headlineName`, `listStartsOn`.
  - **Names link to the page (Check 13 P9):** `customerKeySql` (opaque uuid) on Queue, Quotes and
    Money; `CustomerName` (44px). No address in any URL.
