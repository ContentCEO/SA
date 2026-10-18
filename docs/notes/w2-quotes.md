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
