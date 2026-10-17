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

## Integration notes

- `src/app/(app)/quotes/page.tsx`, `quotes/actions.ts`, `src/server/quotes.ts`,
  `quote-rules.ts`, `thread-sql.ts` (quoteThreadSql) are also the Quotes and Money group's files.
- `src/server/followups.ts` gained one WHERE line (Follow-ups group).
- `src/server/first-week.ts` `markAnsweredByPhone` gained an optional 4th argument.
- `src/app/(app)/queue/called-them.tsx` gained an optional `back` prop (Queue screen group).

## Questions for Davi

- A quote marked "I sent the price another way" counts like "I called them", so it gets **no
  follow-up nudge** (same as a phone answer). Should a price sent from QuickBooks or Jobber still
  get the usual nudge after a few quiet days?
