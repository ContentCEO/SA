# Notes for the integrator: branch `wave1-break` (wave 1, "When things break")

## CLAUDE.md decisions to add

- **Check 18 P1 (alert emails can't stop jobs):** `sendAccessLostAlerts` and `sendCostAlerts`
  catch each row (log `access_alert_failed` / `cost_alert_failed` with ids + `err.name`; nothing
  marked, so the next run retries) and return `failed`. `workspace-lifecycle` and
  `purge-expired-bodies` call `reportAlertFailures` (`AlertFailuresError`, counts only) after
  their last step, like `reportSummaryFailures`.
- **Check 16 P1 (one stuck inbox shows on /admin):** `mailboxTrouble()` in `src/server/admin.ts`
  (watched = mailbox on + account's jobs allowed; stale = backfilled and last check older than
  `STALE_SYNC_MS`, the owner's own 30 minutes; stuck first read = no backfill
  `FIRST_READ_STUCK_MS` (2h) after `createdAt`). `systemHealth` adds `staleMailboxes` /
  `stuckFirstReads`; the System box inverts with "An inbox looks stuck" (unless jobs look
  stopped). `AdminRow.mailboxes` adds `stale`, `oldestStaleSyncAt`, `stuckFirstRead`,
  `errorCode` (fixed code). Card phrases in `src/server/admin-mailbox-rules.ts` (pure); "healthy"
  only when nothing applies; an inverted "Stuck" line tops the card.
- **Check 17 P1 (pause/resume):** migration `0039_paused_from` (additive):
  `workspaces.paused_from` (workspace_status, nullable). Pause stores `effectiveStatus`; Resume
  goes to `resumeTarget` (paused_from; a run-out evaluation → expired) and clears it. While
  paused, `applySubscription` and `applyCheckoutCompleted` keep status `paused` and write Stripe's
  answer into `paused_from` (log `subscription_changed` with `pausedFrom: {before, after}`).
  `resumeTarget` never returns setup_paid / active for `setup_paid_via = 'stripe'` with no
  subscription id (→ canceled), with or without paused_from; the house account is unchanged.
  (The checkout-while-paused case is an extension of the spec: a checkout started before the
  pause and paid after it used to un-pause the account.)
