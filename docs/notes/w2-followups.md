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
