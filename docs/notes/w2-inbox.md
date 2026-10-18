# Notes from branch `w2-inbox` (wave 2, group "Inbox")

Base: cd15c59. One commit per step. Nothing here needs wave 1 unless marked "needs wave 1".

## For CLAUDE.md (Decisions)

- **Needs you lets go (Check 10 P1, 2026-10-17):** migration (additive) `threads.needs_owner_since`.
  One rule, `openNeedsOwnerSql()` in `src/server/needs-owner.ts`: `needs_owner` AND NOT
  `lastOutSql() > needs_owner_since` (`lastOutSql` already counts "I called them", ignores unsent
  drafts and side emails). Older rows with no time fall back to `classified_at`; an older manual
  mark with no time never lets go on its own. The sorter sets the time to **the email's own time**
  (not the sort time) when the flag goes up, keeps it while it stays up and nulls it when it goes
  down, so an owner reply sent between the email and the sort still answers it. "This one needs
  me" and Move it → complaint set it to now. `clearAnsweredNeedsOwner(mailboxId)` runs once per
  `incrementalSync` and in `finishBackfill`: one UPDATE clears `needs_owner`,
  `needs_owner_manual`, `needs_owner_reason`, `needs_owner_since` and logs one
  `needs_owner_cleared` `{ by: "gmail_reply" }` per thread. `markAnsweredByPhone` clears it too
  (`{ by: "phone" }`). Inbox: `listInboxThreads` selects `needsOwner` as the open rule and orders by
  it; the needs_me chip uses it. `CalledThem` (with `back="inbox"`, its action returns to /inbox)
  on every non-junk card that is "Waiting on you" (inverted on black cards); "Take it off my list"
  (outline) on needs-you cards where the customer isn't waiting → `takeOffListAction`
  (requireOwner, workspace-scoped, read-only refused, `gmailWrite` rate limit, logs
  `{ by: "owner" }`). Auto-drafting rules are unchanged (it still needs the customer to have
  written last, and complaints / injection / municipal / gas / payment change stay owner-only).
  - "Open" deliberately does not also say `not answeredByPhoneSql()`: a call after the flag is
    already in `lastOutSql`, and the extra test would hide an owner's "This one needs me" set
    after a call.
  - Known: the customer writing again after "I called them" brings the card back only if the
    sorter flags the new email (the old flag was cleared by the call).
- **Quotes closed another way / Not a quote (Check 11 P8):** migration (same step)
  `threads.quote_dismissed_at`. Open "Waiting on you" quote cards get "I sent the price another
  way" (`markQuoteSentAnotherWay` → `markAnsweredByPhone(…, { via: "other", amountCents })`,
  activity `answered_by_phone` with `via: "other"` and `amountTyped` yes/no; the typed price goes
  in `quote_amount_cents` and, like a typed Won amount, never into price memory). Open cards get
  "Not a quote" (one confirmation) → `quote_dismissed_at`; `quoteThreadSql` / `isQuoteThread` /
  `quoteRequestSql` leave such threads out unless the owner marks an outcome after it
  (`quoteNotDismissedSql`, never NULL). "Not quotes (N)" at the end of Quotes with Put back.
  Follow-ups skip a dismissed `quote_request` thread. Activity `quote_dismissed` /
  `quote_restored` (content-free). Both never draft or send. Without Check 11 P6 both "sent
  another way" cases read "Quoted".

- **Emergencies first (Check 10 P3):** `listInboxThreads` selects `extracted->>'urgency'` and
  orders by a tier (`tierSql`, twin of the pure `inboxTier` / `inboxRank` / `compareInbox` in
  `inbox-rules.ts`): emergency from the last 24 h that the customer wrote last on (4) + open
  needs-you (2) + priority high in the last 24 h (1), then newest (no time last), then id. Cards
  lead with "Emergency" (urgency) or "Urgent" (priority high) in font-black, on every card,
  black ones included. `listInboxThreads`' third argument is now `{ limit?, now? }`.

- **Inbox paging (Check 10 P2):** `inboxPage()` (inbox.ts): keyset paging in the same order
  (tier, time, id — row comparison), cursor in the URL as `?before=<ISO>&after_id=<uuid>`
  (Zod-checked, bad values ignored). The anchor row is looked up inside the workspace (its tier and
  exact stored time), so a cursor can't cross workspaces; a missing anchor falls back to the URL
  time. On All the page is 100 non-junk rows; junk is a count plus the 50 newest (first page
  only). "Show older emails" (full-width outline) when the page was full, "Back to newest" on
  older pages, "Searching the N emails on this page." under the search box, and "Show older
  emails" next to "No emails match that." The tier uses the 24-hour window at request time, so a
  row crossing it between page loads can move pages (rare, harmless).

- **Draft ready / reason on the face (Check 10 P4, P5):** `listInboxThreads` selects
  `pendingDraftId` (newest pending draft that isn't in its undo window or claimed for sending).
  The tag line adds " · Draft ready" and the open card shows "See the draft" (link to
  `/queue?t=<uuid>#t-<uuid>`, the draft card's existing id) instead of "Draft a reply";
  `createDraftForThread`'s own check is unchanged. Needs-you cards show the reason under the tag
  line (font-semibold, one line), and keep "Why: …" inside.

- **Open in Gmail and the customer (Check 10 P6):** `listInboxThreads` selects `gmailThreadId`
  and `mailboxEmail`; the open card has a full-width "Open in Gmail" (`gmailThreadLink`, new tab,
  rel noreferrer) and "From <name>" linking to `/customers/<key>`, where key is the opaque id of
  the customer's newest non-side email (`notesForThreads`, the same key the sender sheets post;
  `customerByKey` resolves any inbound id in the workspace). Not shown for lead websites / phone
  services. No customer address in any URL or log.

- **Unsorted older mail, failed sorts (Check 10 P7):** a model failure (twice) stores
  `extracted.unreadable = true` (category stays the placeholder `customer_question`); the card's
  kind word is then "Couldn't sort" (`kindWord`, inbox-rules.ts). Never-sorted threads whose
  latest customer email is older than `CLASSIFY_LOOKBACK_DAYS` (`isOlderUnsorted` / SQL twin)
  fold on All into "N older emails, from before Squared Away started sorting" (count + 50 newest,
  first page), read "Not sorted", say "This came in before Squared Away started sorting your
  email. It's safe in Gmail." and are listed under a new "Not sorted" chip that only shows when
  any unsorted mail exists. Newer unsorted rows keep "Not sorted yet" plus "We'll sort this
  within a few minutes. It's safe in Gmail." The 14-day look-back itself is unchanged.
  Also fixed here: step 3's junk filter was NULL for unsorted threads, which hid them from All.

- **Search (Check 10 P8):** `searchText` also takes the work, the address, the invoice number and
  the permit number (from `extracted`, passed by the page); `foldForSearch` (NFD, combining marks
  stripped, lowercased) is applied to the row text and the query; every word must still match.
  Search stays on the phone.

- **Chips and words (Check 10 P9):** `inbox/chip-row.tsx`: from `sm` up the chips wrap (no
  sideways scroll); on phones one scroll row with a right-edge fade (`from-background`, theme
  token) and the active chip centred in the row on load (only the row scrolls). The card tag
  says " · Needs me" (matches the chip and "This one needs me"); the Queue keeps "Needs you".
- **Plain reasons (Check 10 P10):** new wording, no dashes: `COMPLAINT_REASON` "A complaint.
  You'll want to answer this one yourself.", `LOW_CONFIDENCE_REASON` "Not sure what this one is.
  Have a look.", `UNREADABLE_REASON` "Couldn't sort this one. Have a look.", `MODEL_FLAG_REASON`
  "The assistant thinks you should see this one.", `INJECTION_REASON` "Careful: this email has
  hidden instructions aimed at our AI. We won't write a reply. Check who sent it before you click
  anything.", `LEGAL_REASON` "Mentions a lawyer, a lien or a claim." Also de-dashed: voicemail /
  text / lead-site reasons and `EMERGENCY_REASON`. `DISPUTE_REASONS` keeps `OLD_LEGAL_REASON`
  ("Mentions something legal.") so stored rows still count as disputes. Gas and payment-change
  reasons unchanged. classify.v4 is untouched.

## For the Prompt versions group (not written here)

- classify.v6 (Check 10 P10): the needs_owner_reason example "Mentions a $14,000 remodel — you'll
  want to price this yourself." becomes "Mentions a $14,000 remodel. You'll want to price this
  yourself." and add the line: "Write needs_owner_reason in one or two short sentences with no
  dashes." (model reasons still show on Inbox cards). Extend tests/evals/cases.ts accordingly.

## Integration notes

- `src/app/(app)/quotes/page.tsx`, `quotes/actions.ts`, `src/server/quotes.ts`,
  `quote-rules.ts`, `thread-sql.ts` (quoteThreadSql) are also the Quotes and Money group's files.
- `src/server/followups.ts` gained one WHERE line (Follow-ups group).
- `src/server/first-week.ts` `markAnsweredByPhone` gained an optional 4th argument.
- `src/app/(app)/queue/called-them.tsx` gained an optional `back` prop (Queue screen group).
- `src/ai/classify.ts` (reason constants, `extracted.unreadable`), `src/ai/guards.ts`
  (`INJECTION_REASON` text only) and `src/server/emergency-rules.ts` (`EMERGENCY_REASON` text):
  wave 1 Safety guards also edits these; the changes are string constants, easy to re-apply.
- `listInboxThreads(ws, filter, opts)` — the third argument changed from `limit` to an options
  object; new `inboxPage()` is what the screen uses.

## Questions for Davi

- Unsorted mail from 15 to 30 days ago is now folded and labelled "from before Squared Away
  started sorting". Do you want the sorter to look back the full 30 days instead of 14 (more AI
  calls on the first day)?

- A quote marked "I sent the price another way" counts like "I called them", so it gets **no
  follow-up nudge** (same as a phone answer). Should a price sent from QuickBooks or Jobber still
  get the usual nudge after a few quiet days?
