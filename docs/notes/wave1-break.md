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
- **Check 16 P2:** `ADMIN_MOVES.extend_evaluation` = evaluating / evaluation_expired only (not
  invited: the clock starts on the first Gmail connect). docs/google-verification.md's
  "Give 3 more days" line still holds (it's about trial accounts).
- **Check 29 P1 (broken AI answers):** `src/ai/client.ts` calls `messages.create` with the same
  parameters `messages.parse` sent and parses the first text block itself
  (`parseStructuredText`: JSON.parse + Zod; any failure → `parsed: null` with the real usage).
  Every returned answer is recorded in `usage` with its cost. `isProviderFault` = APIError with no
  status / 408 / 429 / ≥500, or APIConnectionError (timeouts included); only those are refunded,
  our own errors are not. maxTokens: drafts and rewrites 4096, voice 8192 (Sonnet thinks inside
  max_tokens). `data-paths.test.ts` now checks for `messages.create` (was `messages.parse`).
- **Check 48 P3 (missing / overloaded model):** `ModelUnavailableError(role, model)` in
  `src/ai/client.ts` for a 404 or a 400 saying the model isn't available: refunded, logged
  `ai_model_unavailable {role, model, promptVersion}`, `recordModelDown` (`src/server/model-alerts.ts`)
  writes `app_settings` `model_down:<model>:<UTC day>` (first time seen) and emails Davi once per
  model per day through the new `notifyAdminOnce` (`src/server/admin-notify.ts`, marker
  `admin_notice:<key>` written only after Resend took it; purged after 3 days in the daily purge
  job). Jobs wrap model steps in `stopIfModelMissing` → `NonRetriableError` (classify, draft,
  follow-ups, voice, voice ideas, found money); `captureEditSignals` keeps the counts without the
  tone so the purge job still runs. Stand-ins in `modelFallbacks` (`src/config/models.ts`):
  classify → `claude-haiku-5-5`, draft / voice → `claude-sonnet-5-5`, all
  `fallbackApproved: false`; used only for a missing model or a 529 after the SDK retries, once
  per call; migration `0040_fallback_calls` (`usage.fallback_calls`, additive) and
  `fallbackUsed: true` on the `ai_call` line. /admin's System box: "Sorting stopped since <time>:
  model not available (<model>)." and the heading "Sorting is stopped".
- **Check 48 P4 (model time limits):** `aiTimeouts = { interactiveMs: 45000, jobMs: 90000 }`,
  `aiMaxRetries = 1` in `src/config/models.ts`. The client is built with them (e2e mode still
  overrides with `maxRetries: 0`); `callStructured({ mode })` ("job" by default) passes the time
  left as the SDK's per-request `timeout` and also races its own deadline (one deadline for the
  whole call, stand-in included), so a call that never answers ends as
  `APIConnectionTimeoutError`: refunded, logged `ai_call_failed { error: "timeout" }`. Draft a
  reply, tweak chips / Change it / Other ways to reply and the Inbox offers pass
  `aiMode: "interactive"`; a slow, down or missing model (`isTemporaryAiFailure`) redirects to
  `?error=ai_busy` "Writing is slow right now, so nothing changed. Try again in a moment."
