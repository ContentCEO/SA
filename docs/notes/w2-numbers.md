# w2-numbers (wave 2, Numbers and Activity)

No migrations. No prompt changes. No new fetch hosts, send paths or logged content.

## For CLAUDE.md (Decisions)

- **Numbers and Activity (wave 2, Check 14 P2–P11 + Check 42 P5):**
  - Learning screen: the read step says "Read your last 30 days of email." with no number; the
    "Your last 30 days" section (`firstLookCounts().counts.read`) is the only read count.
  - Time saved: one rule sentence, `timeSavedRule()` in `scorecard-rules.ts` ("Our estimate: 3
    minutes for each drafted reply or follow-up that went out, from the app, from Gmail or by
    autopilot."), said once per box on Activity and once in the Monday email.
    `timeSavedPhrase(0)` = "none yet"; `timeSavedLine(0)` = "Time saved: none, as nothing went
    out." `scorecardLines(..., { rule: false })` drops the rule where the box already says it.
  - Autopilot sends are kept apart: `autopilotSentSql()` (`scorecard.ts`) = `sent_via =
    'autopilot'`, or for rows from before `sent_via`, a `reply_sent` row with `autopilot: true`.
    `ScorecardNumbers.repliesSent` / `followupsSent` are the owner's own (app or Gmail);
    `autopilotSent` is separate; minutes = 3 × all three. `MonthSummary.autopilotSent`; Activity's
    "Replies you sent" = sent − follow-ups − autopilot, plus an "Autopilot sent" tile when > 0.
    The subquery spells `"drafts"."id"` on purpose: Drizzle leaves a column unqualified in a
    select list, which inside the subquery meant the activity row's own id.
  - "Quotes out" is now "Quote requests answered" (tile and counts line); the field is still
    `quotesOut`. The response sentence names its own group ("Of this week's quote requests: none
    answered yet. 1 is still waiting.").
  - Response time shown to owners is the median (`medianMinutes`, `response.typicalMinutes`);
    `avgMinutes` stays in the data. "Your typical first answer to this week's quote requests: 20
    min, the middle of 3 (last week: 1 h)."; one answered: "1 of this week's quote requests
    answered, in 2 h 10 min." Footnote: "Clock time, nights and weekends included."
  - Activity log: `DESCRIBED_ACTIONS` / `HIDDEN_ON_PURPOSE` (`send_approved`,
    `checklist_dismissed`, `quote_lost_reason`) next to `describeActivity`. `listActivityPage`
    filters on the described list in SQL before the limit (and drops a `test_payment_reset` that
    didn't clear the setup payment), pages by `(date_trunc('milliseconds', created_at), id)`
    with `?before=<iso>_<uuid>` (zod-checked in `activity-rules.ts`), 100 per page, "Show
    older" link. Heading "What happened, newest first". `listActivity` keeps its old return
    shape for callers. Guard test `tests/unit/activity-list.test.ts`: every literal `action:
    "x"` (or either side of a ternary) under `src/` must be described or hidden on purpose.
  - New Activity lines: answered_by_phone, found_money_drafts_requested,
    first_drafts_ready_sent, seasonal_note_added, never_say_saved, plus nine the guard found
    (complaint_fixed, complaint_checkin_closed, owner_cleared_injection, sender_rule_removed,
    service_town_added, trial_email_sent, trial_emails_stopped, mailbox_plan_swap,
    mailboxes_fit_plan). Content-free.
  - Found money counts are the true totals (`foundMoneyCounts`, same where-clause, no limit);
    one tap still drafts at most 10 of each kind. Over the cap: "Draft the newest 10?" (one
    kind) / "Draft up to 10 of each, newest first?" (both).
  - Activity during the trial (`!canSend` and status invited / evaluating / evaluation_expired):
    one "Your three days so far" box (sorted, drafts written, drafts you changed, practice
    copies) from `trialActivityCounts` (`first-week.ts`), no time-saved figure; week and month
    boxes only once sending can be on.
  - `firstNameOf` (`src/lib/first-name.ts`): Activity, the queue and the customer page. Null for
    addresses, business words, > 4 words; "Last, First" → First; drops Mr/Mrs/Ms/Miss/Dr.
  - Labels: "Conversations sorted", "Drafts written", trial banner "sorted N conversations",
    morning email "In the last day: N conversations sorted, M replies and follow-ups sent." (the
    24 hours before the email, kept as before; the word "Yesterday" is gone).
  - Send record (Check 42 P5): "Who okayed it" = "Your sign-in (email)" / "Sent from Gmail,
    outside the app" / autopilot as before; closing line "This is the record of the tap made
    while signed in as …. Anyone who uses this sign-in can okay replies." Reconcile's note and
    Activity's `reply_sent_from_gmail` say "sent from Gmail, outside the app". Settings → Account
    shows "Signed in as … (Google)" from the session.

## Spec note

- Check 14 P3's test numbers don't add up: "14 replies, 2 follow-ups and 3 autopilot sends" with
  "Replies you sent 11" means 16 sends, so 48 minutes, not 57. Built and tested as 11 + 3 + 2 =
  16 → 48 (the tiles × 3 equal the figure, which is the step's "Done when").
- Check 14 P5's "(half were faster)" isn't exactly true for an odd count (10, 20, 3 days: one of
  three was faster), so the sentence says "the middle of 3" instead.

## Questions for Davi

- The record no longer says "Nothing leaves your inbox without your okay — this is the proof".
  It now names the Google sign-in and says anyone using it can okay replies. Fine as worded?
- The morning email kept the 24-hour window and now says "In the last day" instead of
  "Yesterday". Would you rather it count your local calendar day and keep "Yesterday"?
