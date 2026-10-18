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
