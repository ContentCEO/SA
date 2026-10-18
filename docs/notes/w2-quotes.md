# Notes from branch `w2-quotes` (wave 2, group "Quotes and Money")

For the integrator to fold into CLAUDE.md (Decisions) and the other shared files.

## Decisions

- **Check 11 P1 (one quote rule):** `quoteThreadSql` (thread-sql.ts) and `isQuoteThread`
  (quote-rules.ts) are twins: a quote thread is `category = quote_request` OR the sticky
  `quote_requested_at` mark OR any outcome / outcome source — but a thread now sorted `noise`
  or with `extracted.injection = true` is left out unless the owner marked it (source `owner`,
  or a legacy outcome with no source). `quoteRequestSql` is now the same rule, so Quotes,
  Customers, follow-ups, the scorecard, the monthly summary, lead pay and leads at risk all
  count the same threads (injection / noise threads no longer count as quote requests
  anywhere). A twin test checks the two agree on 144 combinations.
- **Check 11 P2 + Check 39 P3 (the quote amount):** `readOwnerAmount` (quote-rules.ts) replaces
  "largest $ figure". `stripForAmounts` first cuts a "--" signature, an Outlook header block
  ("From:" + "Sent:"/"Date:" within 4 lines, no Subject needed), a Gmail "On …" line wrapped
  onto two lines, and "Sent from my iPhone" — amounts only; the classifier's `prepareBody` is
  unchanged (evals can't be run here). A figure needs digits right after "$"/"$ ", no inner
  spaces, proper thousands commas ("$ 3 200", "$1,2k" → no figure). Each figure's window is its
  own sentence and never crosses another figure. Dropped: hourly / monthly rates, deposit, trip
  charge, guarantee, warranty, tax (24 chars after); normally / was / not / save / costs me /
  budget / over (14 chars before); program words both sides within 30 chars (rebate, incentive,
  tax credit, credit, loan, financing, 0%, per ton, a month, monthly, up to, Mass Save, HEAT
  Loan, after rebate, out of pocket) — the saved price is before incentives. Then: the last
  figure marked as the price (total, all in, comes to, price is, for the job) → 'total'; the
  only figure → 'total'; two or more "Option …" figures → none; else the LAST figure →
  'picked'. New column `threads.quote_amount_note` ('total' | 'picked'; null for typed / old
  rows). 'picked' shows "Check amount" on the card and never goes into price memory
  (captureQuoteAmounts and backfillPriceMemory). The lead-pay footnote now says "the price in
  your own reply". `ownerGavePrice` / acceptance use the same reader, so an hourly rate alone
  ("$95 per hour") no longer counts as a price given.
- Migration (step 2): `threads.quote_amount_note text` (additive).
- **Check 11 P3 (a corrected price replaces the first):** new columns `threads.quote_amount_from`
  ('reply' | 'owner') and `threads.quote_amount_at` (when the price went out: the owner email's
  sent time, or when the owner typed it). `captureQuoteAmounts` re-reads open quotes (no
  outcome) whose amount came from a reply and moves the amount, note, time and that thread's
  `price_history` row (upsert; a 'picked' correction deletes the row). A typed amount
  (`setQuoteOutcome` writes 'owner') and a decided quote are never touched; the UPDATE
  re-checks both. Rows from before the column (from = null) are left as they are.
  `backfillPriceMemory` also skips `quote_amount_from = 'owner'`.
- Migration (step 3): `threads.quote_amount_from text`, `threads.quote_amount_at timestamptz`
  (additive, one file).
- **Check 11 P4 (daily capture reaches old quotes):** `captureQuoteAmounts` only selects quote
  threads that still have an owner email (out, not an unsent draft) with `body_text`, so purged
  or never-answered threads leave the pool. Called with no workspace (the daily purge job) it
  pages through every match by `threads.id` (500 a page); the Quotes screen's per-workspace call
  keeps one newest-first page.
- **Check 11 P5 (30-day totals by date):** `quoteTotals` (quotes.ts) in SQL, not capped by the
  list: "Asked for" = quote threads by `requestAtSql` (Activity's date); "Priced" = amounts whose
  price went out in the window (`quote_amount_at`, else the owner's last email), any stage, never
  a typed amount on a quote that isn't won; "Won" and the win rate = outcomes by
  `quote_outcome_at`, exactly `closeRateBetween`'s rows. Labels "Asked for / Priced / Won" with
  "Last 30 days. Won counts the day you marked it (or we guessed it). Amounts come from the price
  in your reply, or what you type." The filter chips say "All time" above them.
- **Check 11 P6 (a site visit isn't a quote):** `QuoteFacts.priced` (amount known, or an owner
  email — not a purpose note, not a draft — with a dollar figure via `ownerQuotedCents`). Owner
  wrote last without a price → new stage `replied`, "Replied, no price yet", in Open; it never
  goes quiet. `guessNoAnswer` needs `priced`; `guessNoAnswers` pre-filters in SQL (an amount, or
  an owner email containing "$") and decides with `ownerQuotedCents`. Existing guesses are left
  alone. "I called them" with no price reads "Replied, no price yet". The /quotes help is now a
  list, one line per stage. The homepage's stage list (home-copy.ts `stageWords`) switches to
  semicolons because the new label has a comma: "waiting on you; replied, no price yet; quoted;
  gone quiet; won; lost; or no answer" (public-site copy; Homepage words group may want to look).
- **Check 11 P7 (amount only on Won):** the open card's "Mark how it ended" now holds a "Mark
  won" step ("What you'll charge (optional)", prefilled with the amount we found, then "Save as
  won") and two one-tap buttons, "Mark lost" and "Mark no answer". `setQuoteOutcome` ignores an
  amount unless the outcome is won; `markQuoteAction` refuses one with any other outcome
  (error=amount). A won card has "Change amount" → `changeAmountAction` → `setQuoteAmount`
  (owner-scoped, read-only refused, only while won, `quote_amount_from = 'owner'`; activity
  `quote_amount_changed` with `{ amountTyped: true }`, Activity line "You changed the amount on
  Dana's won quote"). Decided cards say the day in the owner's zone: "Won Oct 14"
  (`decidedLabel`). Same words on both cards: Mark won / Mark lost / Mark no answer / Reopen.
- **Check 11 P9 (filters and stage help):** the chips wrap (`flex-wrap gap-2`, no sideways
  scroll), in the order Open, Waiting on you, Quoted (new, stage `talking`), Gone quiet, Won,
  Lost, No answer, under an "All time" line. Every stage has a one-line explanation under the
  list. Card time reads "Last email 41 minutes ago". Priced / Won show "None yet" instead of $0.
- **Check 12 P4 (supplier-bill gaps):** `billOwedByOwner` (money-rules.ts, pure) + its SQL twin
  `billOwedByOwnerSql` (thread-sql.ts): a thread is a bill the business owes when the sorter
  said `owed_by_business`, or the direction is unknown / missing and the newest sender has
  another thread in the workspace sorted `supplier_vendor` or marked "Not owed to me". "Same
  sender" = same domain, or the same full address on public webmail (`PUBLIC_WEBMAIL_DOMAINS`:
  one gmail.com supplier must not hide every gmail.com customer). A clear `owed_to_business`
  and the owner's own mark on the thread (paid / put back) win. Used in `moneyThreads` (so Money
  owed, the totals, the morning email's money lines and receipt matching) and in
  `threadsToFollowUp`. Addresses are only compared inside SQL, never selected or logged.
  Receipts (`afterClassified`): a receipt sorted `owed_by_business` never marks anything, and a
  receipt with no amount never marks anything.
  **Adapted:** (a) no new "not owed domains" table — the domain is read from the owner's own
  "Not owed to me" threads at query time, so nothing new is stored and no migration was needed
  in a non-[M] step; (b) no one-off backfill job — the rule runs at read time on every thread,
  old (classify.v1–v3, no direction stored) or new, and never touches an owner's mark, so a
  backfill would change nothing the screens show; (c) `pnpm eval` not run (no
  `ANTHROPIC_API_KEY` here), so `tests/evals/baseline.json` is still empty. Two eval cases added
  (`i-subcontractor-invoice`, `i-quickbooks-supplier-receipt`).
- **Check 12 P5 (invoices with no amount):** `holdsOwedInvoice` no longer needs an amount, so an
  unpaid / partly paid invoice thread with none is on Money owed as "Amount not stated", left
  out of the dollar total; the summary says "3 invoices, 1 with no amount yet". (The morning
  email's owed line already handles a count with no amounts.) New `captureInvoiceAmounts`
  (money.ts; on view, and daily before the purge as step `capture-invoice-amounts` in
  `purge-expired-bodies`, paging every match by id): an owed, unmarked invoice thread with no
  amount and no `earlier_open` takes the figure from the owner's own newest email on the thread
  (not an unsent draft, not a purpose note, not a forward to the crew; quoted text stripped) —
  read with `readOwnerAmount`, not "largest figure" (Check 11 P2's reasons apply to invoices
  too) — stored as `extracted.invoice.amount` with `amount_source: "your_email"`; the card says
  "From your email". Never from an inbound email. `carryInvoiceFacts` keeps the label while the
  amount is carried. Logs nothing. Empty text: "No invoices found in your email yet. When you
  send one or a customer writes about one, it shows up here."
- **Check 12 P6 (net terms):** `dueDay` reads payment terms before dates: "net 30" / "Net30",
  "within N days", "N days from/after …". With a date in the text, due = that date + N (unless
  the date follows "due"/"by": "Due Nov 15 (net 30)" is Nov 15); without one, the day the email
  was written + N. "Upon receipt" / "due on receipt" = the day it was written. Terms counted from
  something we can't know ("within 10 days of completion") → "No due date". `dueLabel` also
  returns `day`: "Due Oct 31" / "Was due Oct 10" (local calendar date), shown under the label on
  the Money card.
- **Check 12 P8 (reminder / reply waiting on the Money card):** `MoneyRow` gains
  `pendingDraftId`, `customerWroteLast` and `canDraftReminder`. A card with a pending draft says
  "A reply to Linda is waiting in your Queue." with a 44px "See it" link to `/queue#t-<thread>`;
  otherwise, when the owner wrote last, a nudge is left and the thread is an invoice thread that
  doesn't need the owner, "Draft a reminder" → `draftReminderAction` (draft rate limit) →
  `draftInvoiceReminder` (money.ts; owner-scoped, read-only refused, only a row Money owed lists
  as owed) → `/queue?done=drafted`. Read-only accounts see neither.
  **Adapted:** the spec says the owner draft action with trigger "owner", but that path refuses
  when the owner wrote last (`owner_replied_last`) and doesn't re-check paid / not owed. So the
  reminder is written by the follow-up drafter (`trigger: "followup"`), which re-checks paid,
  not owed, a bill the owner owes, a decided quote, needs-you, the two-nudge cap, a waiting
  draft and away mode. It is a nudge: it counts toward the two per thread, ever. Nothing sends
  without Send reply. (A Davi question below.)
- **Check 12 P9 (no big $0):** with no owed rows the box says "No open invoices found" and "We
  look at invoice emails from the last two weeks of sorting and everything new." (from
  `CLASSIFY_LOOKBACK_DAYS`); the dollar total shows only with at least one owed row, with
  "Counted from your email, not your books." under it.

## Questions for Davi

- **Reminders count as nudges (Check 12 P8):** "Draft a reminder" on Money uses the follow-up
  writer, so it counts toward the two nudges per thread, ever, and the button hides once both are
  used. Built that way so the "max 2 nudges" promise holds. Is that what you want, or should an
  owner-tapped reminder not count?
- **Several prices in one reply (Check 11 P2):** when the owner's reply has more than one price
  and none is marked as the total, we take the last one and show "Check amount" on the card (and
  keep it out of price memory). Two "Option A / Option B" prices give no amount (the owner types
  it on Won). OK?
- **Supplier lookalikes (Check 12 P4):** a bill with no clear direction is kept off Money owed
  when the same business domain has a supplier thread or a "Not owed to me" tap. On Gmail/Yahoo
  addresses only the exact same address counts. OK?

- **"Not owed to me" remembers the sender (Check 12 P4, as the spec asks):** after the owner taps
  "Not owed to me" on one bill, later bills from the same business domain (or the same Gmail /
  Yahoo address) whose direction the sorter couldn't tell stay off Money owed. If an owner taps
  it on a customer's thread (say a duplicate), that customer's later unclear invoices would be
  hidden too, until the owner taps Put back on one. Keep it, or limit it to domains that also
  have a supplier thread?

## Integration notes

- Migrations: `0044_quote_amount_note` (step 2) and `0045_quote_amount_from` (step 3), both
  additive; renumber at merge.
- No prompt files changed. No classify-prompt lines needed for the Prompt versions group.
- Two eval cases added in `tests/evals/cases.ts` (Prompt versions group also edits it).
- `src/server/followups.ts` (Follow-ups group) — one line: the `bill_direction` filter became
  `not ${billOwedByOwnerSql()}`.
- `src/server/thread-sql.ts`: `quoteThreadSql` rewritten (raw SQL now), `quoteRequestSql` is an
  alias of it; new `billOwedByOwnerSql` / `senderHasSupplierThreadSql` /
  `senderMarkedNotOwedSql`. Customers group reads `listQuotes`.
- `src/components/marketing/home-copy.ts` (Homepage words): `stageWords` uses semicolons.
- `src/jobs/functions.ts`: one new step in `purge-expired-bodies`.
- `src/server/activity.ts`: one new `describeActivity` case (`quote_amount_changed`).
- `tests/unit/leads-at-risk.test.ts`: one expectation now "replied" (Check 11 P6).

## Review fixes (after the steps)

- **Check 11 P7:** "Save as won" with the prefilled amount sent back unchanged is not a typed
  amount: it stays the reply's price (`quote_amount_from = 'reply'`, still in price memory,
  still correctable). Only a different figure is the owner's.
- **Check 12 P4:** `tests/unit/money-so-far.test.ts` (Replies package) used one sender for every
  thread, including its supplier and "Not owed to me" rows; those rows now come from a supplier
  address, since a supplier thread or a "Not owed to me" tap now keeps that sender's unclear
  bills off Money owed.
