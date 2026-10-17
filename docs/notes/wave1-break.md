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
- **Check 1 P4 (deep health check):** `/api/health/deep` (`HEALTH_TOKEN` as `x-health-token` or
  `?token=`, else 404): `select 1`, the newest active mailbox check, and
  `app_settings` `jobs:workspace-lifecycle:last-run` (written by a new last step `record-run` of
  the 15-minute job; before the first one, the newest mail check stands in). Answers
  `{db, jobs: ok|stale, minutesSinceJobs, minutesSinceMailCheck}` (no ids); 503 when stale
  (> 30 min) or the database is down, and then "Background jobs look stopped" to Davi at most once
  per UTC hour (`notifyAdminOnce`, key `jobs_stopped:<hour>`). `/api/cron/jobs-check` does the
  same for Vercel Cron (`Authorization: Bearer <CRON_SECRET>`, else 404) but is **not
  scheduled**: no `vercel.json` was added (see Questions). `reserveAiCall` also emails "An
  account used 80% of today's AI limit" once per account per UTC day (no account named; link
  /admin; 5 s timeout, never fails the call). security-surface's route table has the new
  "shared-secret" guard. SETUP.md §6g + two env rows; `.env.example` has both names.
- **Check 50 P6 ("Ready for paying owners" on /admin):** pure `launchChecks(env, facts)` in
  `src/server/launch-ready.ts` (7 automatic rows from env names and safe facts: APP_URL not
  *.vercel.app, EMAIL_FROM not resend.dev, SUPPORT_EMAIL set, Stripe key live / test / no key,
  a webhook secret in env or stored by Connect Stripe, INNGEST_SIGNING_KEY set, VERCEL_ENV
  production; 10 hand rows ticked by Davi). Ticks = `app_settings` `launch_tick:<key>` (ISO date)
  via `tickLaunchAction` (requireAdmin; logs `launch_ticked {key}` only); `loadLaunchFacts` never
  selects the webhook secret. Box (`src/app/(app)/admin/launch-ready.tsx`) sits under the System
  box: "N of M done", Done / Not yet (inverted) / Check by hand (outlined), a 44px Done button on
  un-ticked hand rows. No gate reads the ticks; there is no Undo (a mistaken tick is fixed by
  deleting the app_settings row).
- **docs/LAUNCH.md (intended text, for the integrator):** under "Check the background jobs after
  the merge" add: "Optional but recommended: point a free uptime monitor at /api/health/deep
  (docs/SETUP.md §6g). It emails you 'Background jobs look stopped' at most once an hour, even
  when Inngest itself is down." And near the top: "/admin → Ready for paying owners lists what's
  left; tick the hand rows there as you finish them."

## Fence tests changed on purpose (say so in the merge)

- `tests/unit/data-paths.test.ts`: the client check now looks for `messages.create` (Check 29 P1
  replaced `messages.parse` with `create` + our own parse; same single request, same data path).
- `tests/unit/e2e-mode.test.ts`: the one `new Anthropic(...)` now spreads
  `...anthropicClientOptions()` last after our `maxRetries` / `timeout` (e2e mode still wins).
- `tests/unit/security-surface.test.ts`: two route rows with a new guard, "shared-secret".

## Migrations and prompt versions

- `0039_paused_from` (workspaces.paused_from) and `0040_fallback_calls` (usage.fallback_calls),
  both additive. The integrator renumbers them.
- No prompt changed (no new prompt versions; evals not needed, not run).

## Questions for Davi

1. Should pausing an account in /admin also pause its Stripe billing? Today Stripe keeps charging
   a paused account; only Resume's destination changed. (Not built.)
2. The 30-minute "jobs look stopped" check through Vercel Cron needs Vercel Pro (Hobby allows a
   daily cron only, and a more frequent one can stop the deploy). Until then, a free uptime monitor
   pointed at /api/health/deep (SETUP.md §6g) does the same job. Want the `vercel.json` added once
   you're on Pro?
3. Stand-in models (all off): sorting → Claude Haiku 5.5, drafting and voice → Claude Sonnet 5.5.
   Turn one on (`fallbackApproved: true` in src/config/models.ts) only after `pnpm eval` passes on
   it. Haiku 5.5 thinks by default; check the sorter's 1,024-token answer limit holds there.
4. The missing-model email says "Sorting is stopped" (the wording asked for) even when it's the
   drafting model; okay, or "Drafting is stopped" for that one?
