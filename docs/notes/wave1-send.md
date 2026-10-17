# Notes from branch `wave1-send` (wave 1, group "Send path")

For the integrator to fold into `CLAUDE.md` (Decisions), `docs/LAUNCH.md` and the legal drafts.

## Decisions (CLAUDE.md)

- **Check 9 P1 (seen text):** every Send reply (card, Edit box) posts `seen` = `bodyHash` of the
  text the card showed; the review page posts `seen:<draftId>` / `seenTo:<draftId>` per row.
  `queueSend({ seenHash })` returns `changed_since_seen` when the stored text differs, and the
  queue write itself only lands while `drafts.body` is still the text that was checked. The
  server action refuses a tap with no fingerprint (an old page) the same way; the JSON route
  takes an optional `seen` for online sends (409 `changed_since_seen`). Notice:
  "That draft changed since you opened it, so nothing was sent. Here's the latest version. Read
  it, then tap Send reply again."
- **Check 42 P1 (answered from Gmail):** `answeredSince(threadId, since, mailboxEmail)`
  (`src/server/drafts.ts`): an email from the shop on the thread after the draft was written,
  not an unsent Gmail draft, not a practice copy (To/Cc only the mailbox's own address) and
  **not a side conversation** (`sideEmailSql`: a forward to the crew is no answer; the spec
  didn't say, but without it a forward to the crew would set the reply aside). queueSend and
  sendDraft return `answered_elsewhere` (with when) before any Gmail call; the Queue shows "This
  was already answered from Gmail at 2:14pm. Nothing was sent." with "Open the conversation in
  Gmail" (no Send anyway). reconcileDrafts sets a waiting reply aside (expired, Gmail draft
  deleted, note "Someone answered this from Gmail, so this reply was set aside.") after the
  customer-wrote-again and the Gmail-draft-gone branches. A send in its undo window is closed
  the same way by deliverQueuedSend, which logs `send_stood_down` {draftId, reason} (Activity:
  "Didn't send the reply to Dana: someone had already answered from Gmail") instead of
  `send_stopped`. Autopilot unchanged (its own newer-mail check runs first).
- **Check 14 P1 (`drafts.sent_via`, migration `0039_send_path_sent_via`, additive):** app /
  autopilot / gmail / own_words; null = older rows, counted as before. Reconcile with our Gmail
  draft gone and a newer shop email: our message id or the same text (`prepareBody` +
  `sameText`) → `gmail` (`edited_and_sent` when the id matched but the text differs); otherwise
  `own_words` with status still `sent` (two-nudge cap unchanged), Activity
  `owner_wrote_own_reply` "You answered Dana yourself in Gmail" (no See record). decidedAt =
  that email's time. own_words is left out of monthSummary, the weekly scorecard's sent count,
  monthMoney's "paid after a follow-up" and the digest's "sent yesterday".
- **Check 9 P2 (honest Hold it; migration `0040_send_path_autopilot_claim`, additive):**
  `drafts.auto_send_claimed_at`. `runAutopilotSend` claims the draft in one conditional UPDATE
  (pending, countdown due, unclaimed or claim older than `AUTOPILOT_CLAIM_LEASE_MS` = 2 min)
  before any Gmail call; only the claimer goes on, and the claim is released when it stands
  down, fails or throws. `sendDraft(by: "autopilot")` sends only a draft that is still counting
  down **and** claimed (an edit, hold or plan change that cleared the countdown wins);
  `queueSend` answers `already_sending` while a live autopilot claim holds it.
  `holdAutopilot` → `{status: "held"} | {status: "too_late", sent} | {status: "not_found"}`;
  "Held." only for a draft that did not go; too late → "Too late, autopilot already sent it.
  See it on Activity." (+ See record) or "Too late to hold: autopilot is sending it right now."
  The card shows a live countdown (`autopilot-countdown.tsx`: "Sends in 6 min", seconds in the
  last minute; the clock time once for screen readers) and refreshes every 4 s for a minute at
  zero.
- **Check 42 P2 (never overwrite Gmail's text):** `saveDraftEdit` and `reviseDraft` read the
  Gmail draft first (reviseDraft before the model is called, and again before it writes): a
  different text there becomes the draft's (`takeGmailText`, countdown and queued send
  cleared) and they return `changed_in_gmail` without writing to Gmail. Both take an
  `openedHash` (the Edit box posts `opened`, the quick-change forms post `seen`): a stored text
  that moved on since → `changed_since_opened`, no Gmail call, no model call. The Edit box is
  now `draft-editor.tsx` with `editorAction` (useActionState; `saveDraftEditAction` is gone):
  it answers inside the card, puts the newest text in the box and keeps what was typed in a
  read-only "Your text" box. Quick changes redirect to `?error=changed_editing`.
- **Check 8 P1 (no signal):** `NoSignalGuard` (`src/components/app/no-signal-guard.tsx`, once in
  the (app) layout) stops any form submit while `navigator.onLine` is false — a capture
  listener on `window`, ahead of React's own on `document` — unless the form is inside
  `[data-offline-ok]` (only the card's Send reply, and only with offline okays on). Strip above
  the tab bar: "No signal. Nothing was sent or changed. Try again when you have a bar."
  (role=alert, inverted), and a quieter "No signal right now." whenever offline. New
  `src/app/(app)/error.tsx` keeps the header and tab bar; offline or a failed request (a
  `TypeError`) says "We couldn't reach Squared Away. If this was a reply, open the Queue when
  you have signal: if the card is still there, it wasn't sent." Send reply shows "Still trying.
  Weak signal. Don't close the app." after 12 s (`send-button.tsx`, words only). Typed text is
  kept per tab in sessionStorage (`src/lib/kept-text.ts`, fingerprinted by what the screen
  showed so a stale copy is dropped once the save went through): the Edit box (key per draft;
  the card reopens the editor on reload) and the business profile form (`use-kept-form.ts`).
- **Check 9 P3 (Gmail hiccups):** queueSend, saveDraftEdit, reviseDraft and discardDraft return
  `gmail_busy` (MailboxRateLimitError) or `gmail_failed` (anything else Gmail threw) instead of
  throwing; logged as `<where>_gmail_failed` {draftId, kind, error name}. Queue notices:
  `gmail_failed` "Gmail didn't answer, so nothing was sent. Try again in a minute.", and every
  notice a Send reply tap can reach now says whether anything was sent (unit test pins it).
  The Queue's notice words moved to `src/app/(app)/queue/queue-messages.ts`.
- **Check 9 P4 (Edit box keeps the text):** the Edit box's Save changes and Send reply both go
  through `editorAction` (useActionState, `intent` = save | send); refusals answer inside the
  card (role=alert) and the editor stays open. Gaps show as words ([time], [job address]) with
  "Replace each [ ] before sending."; Send reply is replaced by "Fill in [time] first" while one
  is left; the text goes back with tokens (`toEditorText` / `fromEditorText` /
  `editorGapsLeft` in `src/ai/gaps.ts`), so the server's gap gate is unchanged.
- **Check 43 P7 (stale "tomorrow"):** pure `staleTiming(body, createdAt, now, timeZone)` in
  `src/server/draft-timing.ts`: day words (today, tonight, tomorrow, this morning / afternoon /
  evening, this week / weekend, next week, later today; hoy, mañana, esta tarde; hoje, amanhã)
  when the draft's local day (owner's zone) is before today's; minute/hour words (in a few
  minutes, in an hour, shortly, right away) also when it's over 2 hours old. `sendDraft` and
  `queueSend` return `timing_check` {words, writtenOn, meant} before any Gmail call unless
  `confirmedTiming`; the queued send (`deliverQueuedSend`) passes it (the tap was checked
  seconds before); autopilot stands down with the note and can never confirm; batch counts it
  refused. The card shows "Written Friday. It says “tomorrow”, which meant Saturday. Check the
  timing." and Send reply becomes "Send reply anyway" (posts `confirmedTiming=1`), Edit stays.
  The JSON route takes `confirmedTiming: true` (else 409 `timing_check`); offline okays are
  refused with "its time words … may be out of date". **Wording differs from the spec** ("which
  now means Saturday" was wrong for a draft read days later): it says what "tomorrow" meant
  when written.
- **Check 43 P9 (dispute caution; prompt `dispute-caution.v1`, new kind in the registry):** on a
  thread with `extracted.disputed` or the needs-owner reason LEGAL_REASON / DISPUTE_REASON,
  every draft (the owner's tap; jobs never draft these) and every quick change gets the fixed
  flag first ("This is about a dispute or something legal. What you write can be used later.
  Keep it short and factual; many owners call their lawyer or insurer first."), confidence
  capped at 40 (never Ready), and the fixed task line appended to the conversation's task.
  Stored prompt version `draft.v7+dispute-caution.v1` (or `revise.v2+…`). Eval cases
  `d-lawyer-reply`, `d-refund-dispute` (field `disputeCaution`); evals not run.
