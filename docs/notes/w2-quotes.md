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
