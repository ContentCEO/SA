# Notes from wave 2 "Follow-ups" (branch `w2-followups`)

For the integrator to fold into CLAUDE.md / docs. One section per step.

## Step 1 — Check 12 P1: big invoices are chased; the Money card says when nothing will

- `applyOwnerRules` also returns `needsOwnerCode` (the shown rule's `OwnerRuleKey`, else
  `"model"`; null when not needed). Stored as `extracted.owner_code`. Adaptation: the codes are the
  existing `OWNER_RULE_KEYS` ("low_confidence" not "unsure", "co_alarm"/"electrical" exist) since
  `owner_rule_hits` already carried them.
- `amountOnlyNeedsOwner` / `needsOwnerBlocksNudge` (`src/server/followup-rules.ts`, pure) with the
  SQL twin `amountOnlyNeedsOwnerSql` (followups.ts): an `invoice_payment` thread whose owner-rule
  hits are only `amount` (+ the model's own flag), not manual, no complaint mark
  (`complained_at`), dispute, attack, payment-change or "is this a bot" mark → still chased. Used
  by the scan, the drafter's follow-up re-check and `sentDraftSummary`. Quotes keep the old rule.
- Money owed card: `chaseLine(row.chase)` (money-rules.ts) replaces "Nudges used: X of 2". Lines:
  the five in the spec, plus two so the card never promises a nudge that won't come: "Not chased:
  this one needs you first" (needs you for a reason other than the owner's own mark, e.g. a
  dispute) and "Not chased: it's been quiet too long. Chasing is up to you now." (owner wrote
  more than 21 days ago).
- `FOLLOWUP_MAX_AGE_DAYS` moved to followup-rules.ts (re-exported from followups.ts).

## Step 2 — Check 21 P2: a "no" stops nudges; "after the holidays" waits

- Migration `0044_nudge_after` (additive): `threads.nudge_after timestamptz`. Set at classification
  from `extracted.wait_until` (start of that local day, owner's zone, `nudgeAfterFor`); every new
  customer email replaces it (none → cleared); an injection email sets nothing. "Clear when the
  owner writes again after it" needs no write: once the date is past it no longer holds anything
  back, and the no-answer clock already starts from the later of the two.
- Code reads the signals loosely (`followupSignalsOf`, followup-rules.ts): `signals.declines_quote`
  → `extracted.declines_quote: true`; `extracted.wait_until` (YYYY-MM-DD, future, ≤ 366 days) →
  `extracted.wait_until`. **classify.v5 doesn't have these fields yet**, so nothing changes live
  until the Prompt versions group's next classify version (classify.v6) adds them. The unit test
  (`tests/unit/followup-signals.test.ts`) extends the schema the way v6 will.
- `afterClassified`: `declines_quote` on a quote thread (sorted quote before, sticky request time,
  an outcome, or sorted quote now) → `autoSetQuoteOutcome(…, "lost", { why: "declined", flag:
DECLINED_FLAG })`; the owner always wins. A waiting nudge gets "They said no. Check before
  sending." Activity: "Marked a quote from Dana as lost — they said no. Change it on Quotes".
- Scan and drafter skip `nudge_after > now` (drafter reason `wait_requested`); the 21-day window
  counts from `greatest(lastOut, nudge_after)`. `guessNoAnswers` counts quiet days from the later
  of the two (`guessNoAnswer({ quietFrom })`).
- Quotes card and sent screen: "Waiting until Jan 4, as they asked." (`waitingLine`).

### For the Prompt versions group (classify.v6) — exact lines

Schema: `signals.declines_quote: z.boolean().catch(false)` and
`extracted.wait_until: z.string().nullable().catch(null)`.

Under `## signals`:
"- declines_quote: true only when the customer turns down the price or the job — they hired
someone else (\"we went with someone else\", \"we found another contractor\"), are holding off
with no date (\"we're going to hold off for now\", \"we've decided not to do it\"), or no longer
need the work (\"we sold the house\", \"my brother-in-law is doing it\"). False for comparing
quotes, haggling (\"can you do it for less?\"), questions, \"not yet\", or a later date they name."

Under `## Extracted details`:
"- wait_until: when the customer asks you to wait until a time, that date as YYYY-MM-DD, counted
from the Received date: \"after the holidays\" in December → the first weekday of January;
\"next month\" → the 1st of next month; \"in the spring\" → March 15; \"after the 20th\" → the 21st;
a named date → that date. null when they name no time or it's vague (\"later\", \"sometime\")."

Eval cases to add (tests/evals/cases.ts), each after an owner's priced reply:

- declines_quote true: "We went with someone else, thanks for your time." / "We found another
  contractor who could start sooner." / "We've decided not to go ahead with the bathroom this
  year." / "My brother-in-law is going to do it, but thanks."
- wait_until set (Received 2026-12-17): "We'll get back to you after the holidays." → 2027-01-04;
  "Can we revisit next month?" → 2027-01-01; "Let's pick this up in the spring." → 2027-03-15
  (all declines_quote false).
- neither (declines_quote false, wait_until null): "We're comparing quotes, will let you know." /
  "Can you do it for less?"

## Step 3 — Check 21 P3: nudges by the owner's calendar day, ready by 5am their time

- `followup-scan` is now hourly at :11 (`cron("11 * * * *")`, was daily 9:11am Eastern). Each
  workspace is scanned once a day, in the hour its local time is 4am (`FOLLOWUP_SCAN_LOCAL_HOUR`,
  `business_profile.time_zone` via `usableTimeZone`, Eastern when unset): `followupScanDue(now)`
  lists due workspaces with their running mailboxes; `markFollowupScanned` writes the owner's
  local date to `app_settings` `followup-scan:<workspaceId>` after the scan, so a retry the same
  day is a no-op. The "no draft since the owner's last message / none pending" rules still stop
  doubles. The no-answer guess runs per due workspace in the same job.
- Waits count in the owner's calendar days: `nudgeDueDate(lastOut, days, tz)` (followup-rules.ts)
  = local date of the owner's last email + N; the scan uses `quietCutoff(now, days, tz)` (the
  start of local day today − N + 1). `sentDraftSummary.nudgeOn` = that due day's local midnight.
  `followupSettings()` now also returns `timeZone`.
- Sent screen: "A nudge for Dana will be ready Monday morning if there's no reply." (no pronoun:
  we don't know the customer's). "That was the last nudge. I won't chase this one again." kept.
- Settings → Follow-ups: "Nudges are ready by 5am your time, as drafts." under the wait choice.
- CLAUDE.md line to update: "**Follow-ups (M7):** daily cron `followup-scan` (9:11am
  America/New_York)" → "hourly cron `followup-scan` (:11); each owner's scan runs once a day at
  4am their time (Check 21 P3); due on the owner's calendar day (`nudgeDueDate`)". The M7 sent
  screen sentence ("I'll nudge Dana on Thursday…") becomes the new wording above.

## Step 4 — Check 21 P4: invoices the owner sends are chased

- Migration `0045_owner_invoice_at` (additive): `threads.owner_invoice_at timestamptz`.
- `looksLikeOwnerInvoice` (`src/server/owner-invoice-rules.ts`, pure, no model, nothing logged):
  subject or the first 2,000 chars of the owner's own words (quoted reply cut) name an invoice
  number ("Invoice 1043", "INV-2207", "invoice #12"), or say "invoice" with a dollar amount;
  never a forward subject. Run in sync's `ingest` (so also for app sends via
  `recordSentMessage`) on outbound rows: sets `extracted.invoice_thread = true` and
  `owner_invoice_at = greatest(…)`. A fresh email that lives only in Sent has no body fetched
  (bodies are read for inbox threads only), so it's matched on its subject (and Gmail's snippet
  is not used for the rule).
- Scan, drafter re-check and `sentDraftSummary`: category in quote/invoice **or**
  `isInvoiceThread`. `quoteStopsNudges` now takes `extracted` and uses `isInvoiceThread`; its SQL
  twin in followups.ts uses the same `invoiceThread` expression (kept twins).
- Fresh invoice thread (no customer email): chased when the owner's email's first To address has
  written to this business before (any thread, any workspace mailbox, by reply address, before
  the invoice; `freshInvoiceToKnownSql` / `freshInvoiceAddress`); the nudge goes to that address.
  A never-seen address gets nothing.
- Money screen rows for owner-sent invoices: left to Check 12 A1 (Quotes and Money group); the
  Money list still needs invoice facts with an amount.

### For the Prompt versions group (followup.v5, Check 12 P7 not landed here)

`followupTask` needs an invoice flag (`followupTask({ nudgeNumber, daysQuiet, invoice })`; the
drafter would pass `isInvoiceThread(thread)`), with these task lines for invoice threads:

- nudge 1: "The customer hasn't paid or replied for ${daysQuiet} days since the owner sent the
  invoice. Write the owner's first, friendly reminder about the invoice. Don't add a deadline,
  late fee or discount the owner didn't write."
- nudge 2: "The invoice is still unpaid, ${daysQuiet} days after the last reminder. Write the
  owner's second and final reminder: polite and clear that payment is still due. Don't offer an
  easy out or suggest it's fine not to pay."
  Until then the second invoice reminder still uses followup.v4's "give the customer an easy out".

## Step 5 — Check 21 P5: no nudge when the customer answered in a separate email

- Scan: `not exists` an inbound message on ANY other conversation of the workspace (not a side
  email, not an unsent draft, `auto_reply = false` — the wave 0 column; the Sync group's auto-reply
  step fills it) whose reply address equals the quote thread's customer address
  (`customerAddressSql`), sent after the owner's last message. Addresses compared in SQL only.
- Drafter: `customerWroteElsewhere` re-checks it for `trigger: "followup"` → skipped
  `customer_wrote_elsewhere`.
- Queue: the newer email's card (needs-you or reply draft) gets "Also about your quote from
  Nov 2", a link to the old conversation in Gmail (`QueueItem.alsoQuote`, open quote threads with
  the same customer address the owner answered before the newer email).
- Documented limit: a different person's own address (a spouse) can't be matched; "I called
  them" or Discard covers it.
