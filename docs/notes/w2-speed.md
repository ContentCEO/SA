# Notes from w2-speed (wave 2, "Data and speed")

For the integrator to fold into CLAUDE.md (Decisions) and the other shared docs.

## Step 1: Check 30 P1 + Check 29 P6 + Check 30 P4 — indexes (migration `0044_data_speed_indexes`)

- One additive migration with eight `CREATE INDEX IF NOT EXISTS`: `drafts_thread_created_idx`
  (thread_id, created_at; the spec's P1 called it `drafts_thread_idx`, P6 `drafts_thread_created_idx`
  — one index serves both), `drafts_reply_to_message_idx`, `messages_mailbox_from_sent_idx`
  (first-time-sender count), `messages_mailbox_reply_address_idx` (mailbox_id + the reply-address
  expression, `WHERE direction = 'in'`), `threads_mailbox_classified_idx`, `activity_digest_sent_idx`
  (partial, `action = 'digest_sent'`), and, found by the new FK test, `customer_notes_mailbox_idx`
  and `push_subscriptions_workspace_idx`.
- **Not CONCURRENTLY:** drizzle's migrators (postgres-js in `scripts/migrate.ts`, neon-http) run all
  pending migrations in one transaction, and `CREATE INDEX CONCURRENTLY` can't run inside one. A
  plain build blocks writes to that table (reads go on) for the build's length: well under a second
  at today's sizes. **Before merging, check the shared DB sizes** (query in the migration's top
  comment). If `messages` is ever in the millions, build the indexes by hand with CONCURRENTLY first
  (same names); the migration's `IF NOT EXISTS` then skips them.
- The reply-address expression has one source: `replyAddressExpr` in `src/db/schema.ts`, used by the
  index, `messageReplyAddress` and `replyAddressSql` (thread-sql.ts). Changing its text means a new
  index, or the planner stops using it (`tests/unit/query-plans.test.ts` fails).
- `/admin`'s "last sorted" / "last morning email" are now per-mailbox / per-workspace scalar
  subqueries (`lastSortedQuery` / `lastDigestQuery` in admin.ts) so each is an index-end lookup.
- New fence `tests/unit/fk-indexes.test.ts`: every foreign key must lead some non-partial index, or be
  in its allow-list with a reason (the four referral columns).
- Measured on local Postgres 16 (5 shops × 10k threads × 5 emails): deleting one account's user row
  0.47 s; customer lookup 0.1 ms (Bitmap Index Scan on the new index).

Proposed CLAUDE.md Decisions line:
"- **Indexes (2026-10-18, Check 30 P1/P4, Check 29 P6):** every foreign key leads an index
(`tests/unit/fk-indexes.test.ts`; allow-list with reasons). Index migrations are plain
`CREATE INDEX IF NOT EXISTS` (drizzle runs migrations in one transaction, so no CONCURRENTLY);
check table sizes first and pre-build big ones by hand with CONCURRENTLY. The reply-address
expression lives once in `replyAddressExpr` (schema.ts) so the planner matches its index."

## Step 2: Check 30 P3 — forms keep values they don't recognize

- `SelectField` renders a stored value missing from its options as one extra selected option,
  "Current: <value>", so saving posts it back instead of the browser's first option.
- Server: `orStored` (`src/server/stored-value-rules.ts`) lets exactly the stored value through a
  select's validation; any other unknown value is refused as before. Used for the business form's
  trade and state (`businessProfileInputFor`) and the voice form's formality (`voiceEditInputFor`).
  Extra trades (checkboxes, no box for an unknown value) keep stored unknown values on save
  (`unknownStored`).

**CLAUDE.md, add to Conventions (exact text):**
"- Readers and forms keep values they don't recognize; new list values may arrive in the database
before the code that knows them. (`SelectField` shows them as \"Current: …\"; `orStored` accepts
the stored value back, nothing else.)"

## Step 3: Check 30 P6 — prompt version on each conversation's facts (migration `0045_thread_prompt_version`)

- `threads.classified_prompt_version` (text, nullable, additive), set to `ACTIVE.classify` on every
  classification write of `extracted` (rule-only sorts too: they write that version's shape).
  Null = written before the column.
- `readExtracted(extracted, version?)` in `src/server/extracted.ts`: a Zod schema per classify
  version (v1 job facts → v2 permit/invoice → v3 acceptance signals → v4+ bill direction /
  payment said), every field loose (odd value = missing), unknown keys passed through, non-object
  = null. `invoiceOf`, `isInvoiceThread`, `paymentSaid` (money-rules) and quotes' `decidedAt` /
  `serviceOf` read through it. Other readers still cast by hand; move them as they're touched.
- Signature note: the spec said `readExtracted(row)`; it takes `(extracted, version?)` so the pure
  money rules can call it with the value they already have.

Proposed CLAUDE.md Decisions line:
"- **Extracted facts (2026-10-18, Check 30 P6):** `threads.classified_prompt_version` records the
classify version that wrote `extracted`; read `extracted` with `readExtracted`
(src/server/extracted.ts), not casts. A new classify version that adds keys adds its schema there."

## Step 4: Check 29 P7 — read each thing once per screen; no writes on Quotes / Customers

- `getWorkspaceForUser`, `listMailboxes`, `getBusinessProfile` and `termsAccepted` are wrapped in
  React `cache()` (one query per request; a plain call in jobs and tests). requireOwner's checks
  are unchanged. Nothing in src/server calls them after a write in the same request (checked).
- Queue page: one `Promise.all` for everything that doesn't need the queue (profile, first look,
  practice count, device prefs, sent summaries, late sends, answered link, batch count, away
  state), then one for what does (price memory, notes, not-answered rows → lead cards).
  Inbox: rows + mailboxes + profile, then offers + price memory + notes.
- `listQuotes` (and so `listCustomers`) no longer writes. `quoteUpkeepForMailbox` (quotes.ts) runs
  `captureQuoteAmounts` + `guessNoAnswers` for the mailbox's shop as step `quote-upkeep` of the draft
  job, which runs after every sync; the daily jobs still run both. It never fails the draft job
  (logs `quote_upkeep_failed` with ids and the error name).
- Visible difference: a "no answer" guess now appears within one sync (about 5 minutes) or the daily
  scan after it becomes due, instead of the moment Quotes opens.

Proposed CLAUDE.md Decisions line:
"- **Screens read, jobs write (2026-10-18, Check 29 P7):** opening a screen never writes; quote
amounts and no-answer guesses are refreshed by the draft job after every sync
(`quoteUpkeepForMailbox`) and the daily jobs. Shared per-request reads use React `cache()`."

## Step 5: Check 29 P4 + Check 29 P5 — the daily AI limit (no migration)

- `reserveAiCall(workspaceId, now, purpose)`; `callStructured` takes `purpose` ("sort" from
  classify.ts, "draft" from drafts.ts (new drafts and revisions), "voice" from voice.ts, "other"
  from edit-learning.ts; default "other").
- **Sort share:** a "sort" call is refused once the day's total count passes
  `sortCallLimit(cap)` = max(1, floor(cap × `SORT_SHARE` 0.8)) (src/config/models.ts). Built on the
  one existing counter (no per-purpose column, so no migration): sorting can use at most 80%, and
  whatever drafts/voice used earlier in the day counts toward it too. Every purpose stops at the
  full cap; the 80% alert is unchanged (80% of the full cap).
- **Per inbox:** `dailyAiCallCap(workspaceId)` (src/ai/usage.ts, React-cached) =
  `AI_DAILY_CALL_CAP` (now per inbox, default 500) × max(1, running inboxes), capped at
  `AI_DAILY_CALL_CAP_MAX` (default 3000). Running = status active and not paused on the plan
  (`mailboxRunning`). `dailyAiCallCapSql` is the SQL twin for lists (admin costs' "busiest day N
  of cap", the unsorted sweep). The owner's "limit used up" note reads the same number via
  `aiCallsToday`.
- The unsorted sweep (15-minute job) skips shops past sorting's share (it used to skip only at the
  full cap, which would now re-run sorting that can't proceed).
- Owner note (assistant-status-rules): at sorting's share the top note says "Most of today's
  assistant limit is used." / "New email waits until 8pm to be sorted, so the rest is kept for your
  replies. It's safe in Gmail and catches up on its own." It now comes before "N new emails aren't
  sorted yet" (whose "we try again every 15 minutes" isn't true once sorting waits for tomorrow).
- `.env.example` and docs/SETUP.md list `AI_DAILY_CALL_CAP_MAX`.

**docs/LAUNCH.md** (env table row for `AI_DAILY_CALL_CAP`): add `AI_DAILY_CALL_CAP_MAX` next to it,
same advice ("Leave unset").

Proposed CLAUDE.md Decisions line:
"- **AI limit (2026-10-18, Check 29 P4/P5):** a shop's daily limit is `AI_DAILY_CALL_CAP` (500)
per running inbox, at least one, up to `AI_DAILY_CALL_CAP_MAX` (3000) (`dailyAiCallCap`). Sorting
may use 80% of it (`SORT_SHARE`, `reserveAiCall(..., "sort")`); drafts and voice keep the rest.
Prices and plan inbox limits unchanged."

## Step 6: Check 29 P3 — the homepage from the CDN

- `src/app/page.tsx` reads no session and no search params (a plain, non-async page), so "/" is
  prerendered (`.next/prerender-manifest.json` lists it; e2e checks).
- Signed-in redirect moved to the proxy: "/" is in `src/proxy.ts`'s matcher; on a GET/HEAD with an
  Auth.js session cookie (`authjs.session-token` / `__Secure-…`, chunks `.0` …) it redirects to
  **/start** (the spec said /queue; the tip already sends signed-in owners to /start, which forwards
  to /queue unless they're a Growth client). Rule in `src/lib/home-redirect.ts`. No path header on
  "/"; other paths unchanged. A waitlist POST to "/" is never redirected.
- A stale cookie (deleted account, rotated secret) lands on /signin (tested); Sign out clears the
  cookie and "/" shows the homepage again (tested). A visitor holding an unreadable cookie can't see
  "/" until they sign in or the cookie expires — the price of not reading the cookie at the CDN.
- Referral codes: the waitlist form reads `?ref=` in the browser (`ReferralField`, `useSearchParams`
  inside `Suspense`), only when the server page passed `referrals` (= `referralsVisible()` at build
  time; switching referrals on needs a redeploy anyway). The server action still validates the code
  and the switch. `isReferralCode` moved to `src/lib/referral-code.ts` (re-exported by
  referral-rules) so the browser doesn't load the server's rules.
- Not checked live: "x-vercel-cache: HIT" needs a deploy (no pushes from this branch).

Privacy policy: nothing new (no new data, no new host).

## Follow-up fixes found by the full runs

- `notesForThreads` (customer-notes.ts) now orders ties by id: with the new indexes Postgres
  returned two same-second emails in a different order, and the first row per thread won. The
  control test's extra emails are now older than Dana's.
- `security-surface.test.ts` lists the proxy's "/" redirect as a reviewed redirect (target is the
  fixed "/start").
- The e2e test hooks run `quoteUpkeepForMailbox` in the "draft" step (same order as the job) and
  as their own "quote-upkeep" step; the Quotes e2e calls it after seeding.

## Integration notes (expected overlaps with other groups)

- Migrations: `0044_data_speed_indexes` (eight CREATE INDEX IF NOT EXISTS) and
  `0045_thread_prompt_version` (one ADD COLUMN), to be renumbered.
- `src/db/schema.ts`: new indexes on threads / messages / activity_log / drafts / customer_notes /
  push_subscriptions, `threads.classified_prompt_version`, and `replyAddressExpr` at the top.
- `src/server/thread-sql.ts`: `messageReplyAddress` / `replyAddressSql` now build from
  `replyAddressExpr` (same SQL text). Anyone changing that expression must change the index too.
- `callStructured` callers gained a `purpose` line (classify.ts, drafts.ts ×2, voice.ts,
  edit-learning.ts): small conflicts with Prompt versions / Voice groups.
- `src/app/(app)/queue/page.tsx` and `inbox/page.tsx` data loading was restructured into two
  `Promise.all` waits: the Queue screen and Inbox groups will conflict; keep the two-wait shape.
- `src/server/quotes.ts`: `listQuotes` no longer writes; Quotes and Money group code that expects
  fresh amounts on open should call `quoteUpkeepForMailbox` from a job instead.
- `src/components/forms/field.tsx` (SelectField) — Phone look group may touch it.
- `src/proxy.ts` matcher gained "/"; `src/app/page.tsx` is no longer async and takes no props.
- `src/server/assistant-status-rules.ts`: the 80% warning became the "sorting waits" note.

## Questions for Davi

1. The daily AI limit is now 500 calls per connected inbox, at most 3,000 a day for any one shop,
   and sorting can use 80% of it. Are 500 and 3,000 the numbers you want? (They change no price.)
2. When sorting has used its 80%, the top of every screen says: "Most of today's assistant limit
   is used. New email waits until 8pm to be sorted, so the rest is kept for your replies. It's
   safe in Gmail and catches up on its own." Is that wording okay?
3. The homepage now comes from the CDN. Someone whose sign-in cookie is broken (for example after
   their account was deleted on another device) is sent to the sign-in page from "/" until they
   sign in again or the cookie runs out. Okay?
4. Before the index migration merges, someone should check the shared database's table sizes
   (query in the migration's top comment). Fine to merge as is while it's a handful of shops.
