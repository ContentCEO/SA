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
