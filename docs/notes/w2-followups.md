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
