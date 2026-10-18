# w2-autopilot: Autopilot rules (wave 2)

For CLAUDE.md (Decisions, under Autopilot), one bullet:

- **Autopilot rules (wave 2, branch `w2-autopilot`; Checks 20 P2 P13 P3 P8 P7 P6).** Only stricter or
  clearer; no new send path; the three layers, the 10-minute window and the claim are unchanged.
  - **Unsynced mail (20 P2):** `MailboxWriter.threadMessageLabels` (threads.get format=minimal,
    `fields=messages(id,labelIds)`, ids and labels only) replaces autopilot's
    `threadDraftMessageIds` call: one Gmail call gives the owner's own drafts and the thread's mail.
    `unsyncedMessageIds` (pure): ids Gmail lists after the newest one we store (drafts aside) →
    "There's newer mail in this conversation." and the result carries `syncMailboxId`; the
    `autopilot-send` job then sends `mailbox/sync.requested`. Unknown ids before a stored one are
    older mail the 30-day backfill never read and don't count. `threadDraftMessageIds` stays for
    other callers.
  - **Daily cap (20 P13):** the cap check, the countdown and its `autopilot_scheduled` row are one
    transaction under `pg_advisory_xact_lock(hashtext('autopilot-cap:<workspace>'))`; the update
    needs `auto_send_at is null`, so a draft already counting down or no longer pending takes no
    slot. The count stays a **rolling 24 hours** of countdowns started (`countdownsStartedLast24h`,
    held ones included) — not the owner's local day, which would allow 20 before midnight and 20
    after. Settings says "At most 20 in any 24 hours." `MIN_CONFIDENCE_PCT` and
    `DAILY_AUTOPILOT_CAP` moved to `src/config/rules.ts` (re-exported from autopilot.ts).
  - **Other languages (20 P3):** `looksNonEnglish` (`src/ai/language.ts`, pure: Spanish/Portuguese
    marker words, accented words capped at 3, ¿ ¡, or ≥4 small function words at ≥15%; one name like
    José / Peña / João or "café" is no alarm). On the draft body and on the newest part of the
    customer's newest email (`prepareBody`) → "Not in English, so it waits for you."
  - **New person copied (20 P8):** `newPersonCopied` (pure): anyone on the customer's newest email's
    To/Cc, other than the workspace's own Gmail addresses, never seen (from/To/Cc) on an earlier
    email of the thread → "Someone new is on this conversation, so it waits for you."
    `business_profile.crew_addresses` aren't exempt (a crew member newly copied also waits).
  - **Why it waited (20 P7, migration `0044_autopilot_skip`, additive):** every reason has a
    content-free code (`src/server/autopilot-reasons.ts`: `GUARDRAIL_CODES` for layer 3,
    `RUN_CODES` for account_locked / mailbox_paused / autopilot_off / daily_cap / newer_mail /
    writing_in_gmail / stale_timing / cant_send). `guardrailCodes` + `guardrailReasons` (same order
    as before). `drafts.autopilot_skip` (jsonb codes, null = never refused) is set when a draft in a
    **switched-on** kind is refused (`autopilot_skipped` {draftId, codes}) and when a run stands down
    (`autopilot_stood_down` {draftId, reasonCount, codes}); cleared when a countdown starts. Queue
    card (only while that kind is on, `autopilotOnKinds`): "Autopilot is on for scheduling, but this
    one waits: you haven't written to this address before." Activity: "Autopilot didn't send the
    reply to Dana: new mail came in on the conversation" / "Autopilot left the reply to Dana for
    you: …" (older rows keep "something changed"). Unknown codes are dropped before display.
  - **Settings → Autopilot (20 P6):** the 76-word paragraph is gone; two lists, "It sends on its own
    only when all of these are true:" (`AUTOPILOT_WHEN_LINES`) and "It never sends:"
    (`AUTOPILOT_NEVER_LINES`), each line naming the codes it covers. A unit test fails when a
    guardrail code has no line (or two). No longer claims it never sends "anything about money":
    "No price or amount anywhere in the reply." + "For Invoices & payments: only when the email has
    no amount, like "Did you get my check?"".
  - **Not built (need Davi's yes):** 20 P9 (never agree to a day or time), 20 P10 (earn only from
    replies sent one at a time; note `drafts.sent_via` already exists from Check 14 P1 with app /
    autopilot / gmail / own_words, so P10 would add "batch" to it rather than a new column), 48 P6
    (assistant note on autopilot replies).

For docs/LAUNCH.md (Still open / your calls), plain words:

- Should autopilot never send a reply that names a day or time ("Thursday at 10 works")? It can't
  see your calendar. (Check 20 P9; ready to build.)
- Should autopilot only be earned from replies you sent one at a time with the whole text on screen
  (not from "Review all ready" or from autopilot's own sends), and show "10 sent as drafted, 3
  edited, 2 discarded in the last 60 days"? (Check 20 P10.)
- Should replies autopilot sends end with a line saying your email assistant wrote and sent them?
  (Check 48 P6, option B.)

No privacy-policy or terms lines: no new data leaves, and the new column holds fixed codes only.
