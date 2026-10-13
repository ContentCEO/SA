@AGENTS.md

# Squared Away — project memory

**Read this first. The full original brief is `docs/BRIEF.md` — read it when starting a new milestone.**

## Product in one paragraph

An AI inbox operator for small trade contractors (carpentry, plumbing, electrical; 1–15 people, US).
Owner connects Gmail. We triage each inbound email (quote request, customer question, scheduling,
invoice/payment, complaint, supplier/vendor, noise), draft replies in the owner's own voice as
**real Gmail drafts**, and hold every draft in an approval queue (Send reply / Edit / Discard).
We chase quiet quotes/invoices (max 2 nudges per thread, ever), send a morning digest, and later
offer opt-in autopilot for low-risk categories. **Core promise: nothing leaves the inbox without the
owner's okay.** When slick and trustworthy conflict, pick trustworthy.

Users are non-technical, on a phone, one-handed, in sunlight, maybe wearing gloves:
mobile first (375px), 44px tap targets, plain words, fast.

## Commercial flow (gates real behavior — enforce server-side)

`invited` → `evaluating` (3 days, **sending blocked in code → 403**) → `evaluation_expired`
(read-only) → `setup_paid` ($499 once, **paid through Stripe**; sending unblocked; setup call
pending) → `active`
→ `past_due` / `canceled` / `paused`. Plans: Solo $99 (1 mailbox), Crew $199 (3, autopilot),
Company $299 (10, priority support). All prices live in `src/config/pricing.ts`.
**Never change pricing or the commercial flow without asking Davi.**

## Stack

Next.js 16 (App Router, TS strict) · Tailwind v4 + shadcn/ui (base-ui primitives) · Postgres on
Neon with Drizzle (migrations in `/drizzle`) · Auth.js Google provider (offline access) · Inngest
(every job idempotent) · Anthropic SDK (model IDs only in `src/config/models.ts`; prompt caching on
business + voice profile) · Resend · Stripe · Sentry · Vercel · Vitest + Playwright. pnpm.

> Next 16 has breaking changes vs. older training data — check `node_modules/next/dist/docs/`
> before using an unfamiliar API (see AGENTS.md).

## Layout

```
src/app/            routes (App Router)
src/components/ui/  shadcn components (edited: all button sizes ≥44px, no red destructive)
src/components/brand/  Headline (signature serif-over-heavy), Wordmark (placeholder)
src/auth.ts         Auth.js (sign-in = openid/email/profile only; JWT sessions; invite-only)
src/app/(app)/      signed-in screens: queue, inbox, connect (pre-OAuth explainer), settings, admin
src/ai/             model client (cap, usage, logging), classify, prompts/ (versioned)
src/jobs/           Inngest client, events, functions (served at /api/inngest)
src/app/api/gmail/  Gmail OAuth callback (connect is a server action in (app)/connect/actions.ts)
src/mailbox/        connector interface + gmail/ implementation (scopes, OAuth, state)
src/server/         domain logic: accounts, mailboxes, session (requireOwner/requireAdmin), sync,
                    classification, inbox, profile, voice, drafts, lifecycle (pure rules),
                    workspace-lifecycle (DB transitions), admin (overview, invites)
src/components/forms/  Field components + business profile / voice forms
src/lib/crypto.ts   AES-256-GCM for refresh tokens
src/config/         site.ts (business facts), models.ts, pricing.ts, retention.ts
src/db/             schema.ts, lazy db() client (postgres.js)
drizzle/            generated migrations — commit them
scripts/invite.ts   pnpm invite owner@shop.com [trade] ["note"] (or /admin → Invite an owner)
src/styles/theme.css   THE theme file — every color/token
tests/unit/         Vitest; DB tests use in-memory PGlite (tests/support/db.ts)
tests/e2e/          Playwright (mobile 375px + desktop); real Postgres; forged Auth.js cookie
docs/               BRIEF.md, SETUP.md, google-verification.md, legal drafts
```

## Commands

`pnpm dev` · `pnpm lint` · `pnpm format` · `pnpm typecheck` (runs `next typegen` first) ·
`pnpm test` · `pnpm build && pnpm test:e2e` · `pnpm db:generate` / `pnpm db:migrate`.
In a sandbox with preinstalled Chromium: `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium pnpm test:e2e`.

## Conventions

- Buttons name the action ("Send reply", never "Submit"); toast uses the same word ("Reply sent.").
- Two-tone only. No red/green/blue. Status = weight, position, charcoal/off-white inversion
  (`.sa-inverted`). All tokens in `src/styles/theme.css`.
- Every major heading uses `<Headline serif="…," heavy="….">`.
- Never log tokens, email bodies, or customer personal details. Log prompt version, model,
  tokens, latency only.
- Every gate (sending, plan limits, autopilot guardrails) is enforced server-side and has a test.
- Business facts from `src/config/site.ts`; `SUPPORT_EMAIL` and `APP_URL` from env, never hardcoded.
- Write tests with features. Guardrail tests are the product.

## Decisions

- **pnpm** as package manager (lockfile committed, CI uses `--frozen-lockfile`).
- **Next 16.3 / React 19.2 / Tailwind 4 / Zod 4** — latest stable at scaffold time.
- shadcn init installed a stray `cn` npm package; replaced with the standard clsx + tailwind-merge
  `cn` in `src/lib/utils.ts`.
- No OS dark mode. The brand is a light paper surface with charcoal inversions; a system dark theme
  would muddy the "inversion means status" rule.
- shadcn `destructive` maps to charcoal, not red; destructive actions are made clear by wording and a
  confirmation step.
- Haiku ID: using dated snapshot `claude-haiku-4-5-20251001` (as specified; alias is
  `claude-haiku-4-5`). Sonnet: `claude-sonnet-5`. Verified 2026-09-28 — unchanged from the brief.
- `db()` is created lazily so build/test don't need `DATABASE_URL`.
- **DB driver: postgres.js everywhere** (not `@neondatabase/serverless`). Works with Neon's pooled
  URL (`prepare: false` for PgBouncer), local Postgres, and CI's Postgres service, so signed-in e2e
  tests run without Neon. Unit tests use PGlite with the real migrations.
- **Sign-in and Gmail are two separate OAuth consents.** Auth.js asks only `openid email profile`;
  Gmail scopes are requested by our own flow after the explainer screen. Same Google client, two
  redirect URIs. Gives us full control of the refresh token and the "missing scope" handling.
- If Google's granular consent returns fewer than all three Gmail scopes, we revoke and save nothing.
- Connect uses `prompt=consent` + `access_type=offline` so a refresh token always comes back.
- OAuth `state`: random 32 bytes in an httpOnly, SameSite=Lax cookie scoped to `/api/gmail`,
  10-minute TTL, compared in constant time.
- **Sign-in is invite-only** via an `invites` table (script now, /admin later). `ADMIN_EMAIL` always
  allowed. First sign-in creates user + workspace (status `invited`), idempotently.
- JWT sessions (no Auth.js adapter tables); session carries our `users.id` as `uid`.
- CSRF: mutations are Server Actions (POST + Origin/Host check by Next). Every action re-checks the
  owner via `requireOwner()`; queries are always scoped by `workspaceId`.
- Mailbox limit before a plan is chosen (evaluation) = 1. Reconnecting the same address doesn't count.
- Disconnect revokes at Google, then deletes the mailbox even if revoke fails (logged
  `revokedAtProvider: false`). Deleting is what the owner asked for.
- `activity_log` created early (M1) to record connect/reconnect/disconnect; detail is content-free.
- Neon: project `autumn-term-70302192`, branch `production`, pooled URL in Vercel `DATABASE_URL`
  (prod+preview share it). Migration 0000 applied 2026-09-28.
- Cloud sandboxes can't reach Postgres port 5432; use `pnpm db:migrate:http` (Neon HTTPS driver,
  same migrations table as drizzle-kit). `@neondatabase/serverless` is a devDependency for this only.
- **Branches:** `main` = production (sa-dac3.vercel.app; Vercel Production branch = `main`). Work
  happens on `claude/squared-away-mvp-ddxl7s` → preview at
  `sa-git-claude-squared-away-mvp-ddxl7s-dac3.vercel.app`. Merging/pushing to `main` is a production
  deploy — only with Davi's okay.
- `APP_URL` is set for Production only; previews fall back to `VERCEL_BRANCH_URL` (`src/lib/app-url.ts`).
- Vercel env (2026-09-28): `AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`, `AUTH_GOOGLE_SECRET`
  (sensitive, prod+preview — shared because prod and preview share one database); `AUTH_GOOGLE_ID`,
  `ADMIN_EMAIL` (plain, prod+preview); `APP_URL` (prod only). Env changes need a redeploy.
- Inngest: Vercel Marketplace integration (Hobby/free), connected to `sa` 2026-09-30;
  `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` on prod + preview. `ANTHROPIC_API_KEY` on prod + preview.
  Previews stay behind Vercel login (Hobby plan has no automation bypass), so Inngest can only reach
  production. Production protection = `prod_deployment_urls_and_all_previews` (2026-10-03): the
  production domain sa-dac3.vercel.app is public; previews and per-deploy URLs need Vercel login.
  M1–M5 were merged to `main` by Davi (PR #1, 2026-10-03).
- Resend (2026-10-03): `RESEND_API_KEY` (sensitive) + `EMAIL_FROM="Squared Away <onboarding@resend.dev>"`
  on sa Production. Davi's team also has a `contractorflow` project with its own `RESEND_API_KEY` —
  the key was once pasted there by mistake; check the project name before env changes.
- Google OAuth client lives in Cloud project number 214188340483; app is in Testing (test users only).
- **Sync (M2):** `MailboxReader` interface in `src/mailbox/connector.ts`; Gmail impl in
  `src/mailbox/gmail/api.ts` is plain `fetch` (no googleapis SDK) with token refresh, 401 re-refresh
  once, 429/5xx/rate-limit-403 exponential backoff with full jitter + Retry-After, and
  `MailboxAuthError` on invalid_grant / repeated 401 / permanent 403.
- Engine in `src/server/sync.ts`: backfill = record `historyId` first, then page `newer_than:30d`
  (100/page, one Inngest step per page), metadata for all, `format=full` only for inbox threads and
  only within retention. Incremental = History API from cursor; on 404 re-read last 7 days and take
  a fresh cursor. Everything idempotent (unique gmail ids, onConflictDoNothing).
- `MailboxAuthError` anywhere → `status = reconnect_needed` + one `mailbox_access_lost` log; every
  job skips non-active mailboxes before touching Google. Banner on every signed-in screen.
- Retention purge nulls `body_text` AND `snippet` (Gmail snippets are body text) past
  `RETENTION_BODY_DAYS`; runs daily. Bodies capped at 20k chars. **M11 (S3):** it also empties
  `drafts.flags` (they quote draft text) with the draft body / original text, clears `send_after`,
  `send_claimed_at` and `auto_send_at` on the pending drafts it expires, and strips `address`,
  `dates` and `permit.corrections` from `threads.extracted` once the thread's newest email is past
  the window (content-free facts stay: invoice number/amount/due date/status, permit number /
  issuing body / inspection time / result, service, dollar figures, our true/false marks).
  `tests/unit/data-lifecycle.test.ts` is the gate.
- Jobs (Inngest v4, `triggers` in options): backfill (singleton per mailbox), sync (concurrency 1 +
  20s debounce per mailbox), poll every 5 min (also starts missed backfills), watch renewal daily
  (only if `GMAIL_PUBSUB_TOPIC`), purge daily. `enqueue()` swallows send failures; the poll recovers.
- Migrations run in `vercel-build` before `next build`. Keep them additive (old code must keep
  working against the new schema, since previews and prod share the DB).
- **Classification (M3):** prompt in `src/ai/prompts/classify.v1.ts` (versioned; new file per change),
  Haiku via `messages.parse` + `zodOutputFormat`, re-validated with Zod; one retry, then
  `unreadable` → needs_owner "Couldn't sort this one automatically". `applyOwnerRules`
  (`src/ai/classify.ts`) enforces complaint / legal / refund-dispute / VIP / amount > threshold /
  first-time sender + large job / confidence < 0.6 in code regardless of model output.
- Only the newest unclassified inbound message per inbox thread (last 14 days) goes to the model;
  older ones are marked superseded. Gmail Promotions/Social tabs → noise without a model call.
- Amount threshold defaults to $2,500 and VIP list is empty until the business profile (M4).
- "First-time sender" = no earlier message from that address in what we've synced (30 days).
- `src/ai/client.ts` `callStructured`: reserves a call against the per-workspace daily cap
  (`AI_DAILY_CALL_CAP`, atomic upsert; `ai_cap_80_percent` warning once/day), records tokens +
  estimated cost in `usage` (per UTC day, cost in centicents), logs only metadata. Tests swap the
  transport with `setModelTransportForTests`.
- Prompt caching: cache breakpoint after instructions + business block. Haiku 4.5 needs a 4,096-token
  prefix to cache, which the classifier prompt doesn't reach yet — it matters for Sonnet drafting
  (1,024 minimum), not here.
- `threads.needs_owner_manual`: the owner's "This one needs me" always wins over classification.
- Nav: Inbox · Settings in the header; Sign out lives at the bottom of Settings. Signed-in home = /inbox.
- **Profiles (M4):** `business_profile` (one row per workspace; business name + trade live on
  `workspaces`) and `voice_profile`. Form validation in `src/server/profile.ts` (plain-language Zod
  messages; list fields are one-per-line, trimmed, de-duped; VIPs must be emails, lowercased).
  Classification now reads the owner's threshold and VIP list.
- Voice learning (`src/server/voice.ts`, prompt `voice.v1`, Sonnet): up to 200 `in:sent` emails from
  the last year, quoted text stripped, 1.5k chars each / 150k total, held in memory only — never stored.
  <5 usable emails → `not_enough_mail` with no model call. Examples are model-written samples with
  placeholders, re-scrubbed in code (emails, phones, prices, street addresses).
- Owner edits set `source = edited`; the weekly refresh (Mon cron) skips those. "Re-learn from my sent
  mail" in Settings forces a re-learn and overwrites edits (explicit owner action).
- Onboarding: connect → `/welcome/profile` (only if the profile was never completed) →
  `/welcome/learning` (auto-refreshes every 5s until backfill + voice are done) → Inbox.
- Forms use `useActionState`; on error, focus + scroll to the first invalid field (phones).
- "Toasts" are currently `?done=` / `?error=` query params rendered as `<Notice>` (role=status/alert).
- Playwright's mobile project uses Chromium at 375×812 (not WebKit) to keep CI fast and single-browser.
- Favicon and wordmark are text placeholders until Davi's icon pack arrives (`public/brand/`).
- `/api/health` returns `{ ok, service, commit }` — used by Playwright's webServer check and for
  deploy verification.
- **Drafts + Queue (M5):** `src/server/drafts.ts`, prompt `draft.v1` (Sonnet, effort medium, one
  retry). Auto-drafts only quote_request / customer_question / scheduling / invoice_payment /
  supplier_vendor threads that aren't needs_owner; the owner's "Draft a reply" (Inbox/Queue) may draft
  anything non-noise, including complaints. One pending draft per thread (partial unique index).
  Skips: owner replied last, no text, AI cap, model failure.
- Every draft is a **real Gmail draft** (`MailboxWriter`, `src/mailbox/mime.ts` builds the threaded
  MIME and strips CR/LF from headers). `checkDraft` (`src/ai/draft-checks.ts`) flags invented $,
  new days/times/dates, never-promise items and filler, and caps confidence — it never rewrites.
- **Send gate:** `src/server/lifecycle.ts` (`SENDING_ALLOWED = setup_paid, active`). `sendDraft`
  checks it before any Gmail call → `SendingBlockedError` → 403 from `/api/drafts/[id]/send`.
  Tested for every blocked status with zero Gmail calls.
- Before sending we re-read the Gmail draft: deleted → discarded; changed in Gmail → take the Gmail
  text and ask the owner to tap Send again (never send text they haven't seen in the app).
- `reconcileDrafts` (runs at the start of every draft job): new inbound → expire + delete the Gmail
  draft; missing draft + newer outbound → sent; missing → discarded; changed → take Gmail body.
- Swipe-left on a draft card only reveals Discard's confirm — no gesture ever sends.
- Draft text is purged with the same retention as bodies; pending drafts past retention expire.
- Pipeline: sync → classify (if new mail) → draft; sync with no new mail still reconciles drafts.
- Signed-in home is now `/queue`. Nav: Queue · Inbox · Settings.
- **Lifecycle (M6):** rules are pure functions in `src/server/lifecycle.ts`; DB moves in
  `src/server/workspace-lifecycle.ts`. `effectiveStatus()` treats `evaluating` past
  `evaluation_ends_at` as `evaluation_expired`, so no gate waits on a cron.
- The 3-day clock starts on the **first Gmail connect** (`saveConnectedMailbox` → `startEvaluation`,
  only from `invited`, so reconnecting never restarts it). Cron `workspace-lifecycle` (every 15 min)
  starts any missed clocks and records expiries (logged once).
- `JOBS_ALLOWED` = invited, evaluating, setup_paid, active. Everything else is **read-only**: sync,
  classify, draft (auto and owner), voice and reconcile all skip before touching Google or the model;
  edit/discard throw `ReadOnlyError`. Read-only screens show drafts but no Edit/Discard/Draft a reply.
  Data is never deleted for expiry or non-payment.
- `StatusBanner` on every signed-in screen: "Day N of 3 · X left" during evaluation; inverted
  explanation + phone/support email when expired, setup paid, past due, paused, canceled.
- `/admin` (`requireAdmin` → 404 for anyone but `ADMIN_EMAIL`; actions re-check). Shows per-workspace
  status, plan, evaluation end, mailbox health, draft counts, AI calls/cost — selects no thread,
  message or draft text and no customer addresses (tested). Manual moves until Stripe (M10):
  extend 3 days, mark setup paid (turns sending on), setup call done (→ active), pause/resume
  (`ADMIN_MOVES` table; resume returns to where it was). Also an invite form. Link in Settings → Account
  for the admin only.
- Gmail pacing: 4 concurrent reads, 50 messages per backfill step. A rate limit that outlasts the
  client's retries throws `MailboxRateLimitError`; jobs wrap Gmail steps in `politely()` which turns
  it into Inngest `RetryAfterError("2m")` — pause and resume, not fail. (First live backfill on
  2026-10-03 kept tripping `rateLimitExceeded` at 8 concurrent / 100 per page.)
- **Follow-ups (M7):** daily cron `followup-scan` (9:11am America/New_York). `threadsToFollowUp`
  (`src/server/followups.ts`): quote_request / invoice_payment, not needs_owner, owner wrote last
  ≥ `followup_days` ago (default 3; choices 2/3/4/5/7) and ≤ 21 days ago, customer has written at
  least once, < 2 nudges **sent**, no draft of any kind since the owner's last message (so a
  discarded nudge isn't rewritten until they write again), none pending.
- Nudges reuse `createDraftForThread` with `trigger: "followup"` (prompt `followup.v1`, kind
  `followup`, to = last inbound sender, threaded to the owner's last message). The cap, category and
  needs-owner rules are re-checked there, whatever selected the thread. Sent nudges bump
  `threads.followup_count`; the cap counts sent `followup` drafts. Reconcile also expires a pending
  nudge if the owner wrote to the customer some other way.
- Settings → Follow-ups: on/off + wait days (stored on `business_profile`). Every nudge is a draft;
  nothing sends without a tap. The sent screen says "I'll nudge Dana on Thursday if there's no
  reply." / "That was the last nudge." for chased categories.
- **Digest + Activity (M8):** `/activity` (in the header nav) renders `activity_log` as plain
  sentences (`describeActivity`; unknown actions hidden) with the customer's first name from the
  owner's own synced mail, plus a month summary. Time saved = 3 minutes × drafted replies actually
  sent (`MINUTES_PER_SENT_REPLY`), labelled an estimate with the assumption shown.
- Digest (`src/server/digest.ts`): hourly cron `morning-digest`; due once per local day at/after
  `digest_hour` (5–9am) in the owner's `time_zone` (captured from the browser in Settings; invalid →
  Eastern). **Counts and categories only — no names, subjects or text** (email content only ever goes
  to the AI provider). Quiet days are skipped. Resend via plain fetch with
  `Idempotency-Key: digest-<workspace>-<local date>`; without `RESEND_API_KEY`/`EMAIL_FROM` nothing is
  sent and the day isn't marked done. Read-only accounts get none.
- **Resend 409s (2026-10-13, M8 review):** a retry whose body changed (summaries say how long
  things waited) gets 409 `invalid_idempotent_request`. `sendEmail` reports `already_sent` (the
  digest, monthly summary, cost alert and Gmail-access alert then mark it done) **only** when we
  hold our own `app_settings` `email-sent:<idempotency key>` row, written right after a 2xx
  (outside any marker transaction; purged daily after 2 days). Resend's docs don't say whether a
  key is kept when the first request was refused (e.g. 403 while `EMAIL_FROM` is
  onboarding@resend.dev); **not checked live** (no Resend key in the sandbox). To check: send to a
  forbidden address with a test key, retry the same key with a different body, and see 409 vs 403.
  Either way the code never marks an email sent without our 2xx. Any other 409 stays an error.
- Voice learning reads sent mail 3 at a time (8 tripped Gmail's limit live and the learn died at
  "learning"). Retries 6; `workspace-lifecycle` (15 min) restarts voice for read mailboxes with no
  profile or stuck in "learning" > 30 min (`workspacesNeedingVoice`).
- **Autopilot (M9)** — `src/server/autopilot.ts`, approved by Davi 2026-10-03. Three layers, all
  in code with tests: (1) account: plan with `autopilot` (Crew/Company) **and** status `active`
  (setup call done); (2) category: owner switched it on (`rules` table, mode draft|autopilot) and it
  has **earned** it — ≥10 replies in that category sent exactly as drafted from the app;
  (3) each email: eligible category (never complaint/noise), not needs_owner (incl. manual), reply
  not follow-up, confidence ≥ 85, no flags, no money in the draft, no amount on invoice emails, and
  the owner has **written to that address before**. Daily cap 20.
- Grace window: `considerAutopilot` sets `drafts.auto_send_at` = now + 10 min and the queue card shows
  "Autopilot sends this at 9:42 — Hold it". Job `autopilot-send` sleeps until then and
  `runAutopilotSend` re-checks every layer plus "no newer mail" before `sendDraft(..., by:
"autopilot")` (activity `reply_sent` actor squared_away, `autopilot: true`). Owner edit (app or
  Gmail), Hold it, switching it off, plan change or status change all clear the countdown.
  Backstop: the 15-min lifecycle job re-sends events for countdowns >5 min overdue.
- Admin sets plans by hand (`setWorkspacePlan`) until Stripe (M10); dropping to a plan without
  autopilot switches every category back to draft and clears countdowns.
- **Billing (M10, 2026-10-05):** Stripe SDK, `src/server/billing.ts` + pure rules in
  `src/server/billing-rules.ts`. Checkout (subscription mode) = plan price + the one-time setup fee
  only if `setup_paid_at` is empty; one live subscription per workspace; Stripe's Billing Portal for
  card/plan/cancel. Prices are found-or-created by lookup key `sa_<plan>_<cents>_month` /
  `sa_setup_<cents>` (amount in the key → config change = new price). **Only the signed webhook**
  (`/api/stripe/webhook`) changes status: paid checkout → setup_paid (active if the setup call was
  already done); past_due/unpaid → past_due; recovered → back; canceled → canceled (subscription id
  cleared, re-checkout allowed without the setup fee). Paused and trial accounts are never moved by
  Stripe. Events are idempotent via `stripe_events` (row deleted on handler error so Stripe retries).
  `/admin` → Payments → **Connect Stripe** sets up prices, the portal config and the webhook, storing
  its signing secret encrypted in `app_settings` (`STRIPE_WEBHOOK_SECRET` env overrides).
  `STRIPE_SECRET_KEY` (test) is on sa Production. Owner screen: `/billing` (Settings → Plan &
  billing; banner links "See plans" / "Choose a plan" / "Update payment").
- **Delete my account (2026-10-06):** Settings → Account → one confirmation.
  `src/server/account-deletion.ts`: cancel the Stripe subscription immediately (if that fails,
  **nothing** is deleted; an already-gone subscription is fine) → revoke Google for each mailbox (best
  effort) → delete the `users` row (everything cascades) → sign out → `/goodbye`. Gmail drafts stay
  in the owner's Gmail. Logs counts only. `/signin` only bounces to /queue if the account still
  exists (a deleted account's JWT would otherwise loop). **M11 (S3):** the database part is one
  transaction that also deletes the owner's `invites` row (coming back needs a new invite) and the
  `app_settings` markers `cost_alert:<ws>:%` and `email-sent:%-<ws|mailbox>-%`. Kept on purpose
  (Davi, amendment 2): waitlist rows (may hold a Growth call request); also referral_credits (salted
  hash, ids SET NULL), stripe_events, rate_limits (purged in 2 days), the draft-cleanup per-mailbox
  marker (bare uuid). `tests/unit/data-lifecycle.test.ts` is the gate: a new table or a new
  non-cascade foreign key fails it until its lifecycle is decided (KEPT / SET_NULL lists there).
- **Rate limits (2026-10-06):** `src/server/rate-limit.ts`, fixed windows in the `rate_limits` table
  (one atomic upsert; holds across serverless instances). Per workspace: send 60/10 min (action +
  API → 429 with Retry-After), Draft a reply 30/h, re-learn voice 3/day, billing 10/h, Gmail connect
  10/h. Waitlist 10/h per **hashed** IP (salted with AUTH_SECRET; raw IPs never stored). Webhooks
  are signature/token-checked instead. Purged daily with bodies. e2e global setup clears the table.
  **M11 (S4):** `poll` 300/10 min on `/api/badge` and `/api/push/summary` (429 + Retry-After,
  no-store; phones ask ≤1/min) and `gmailWrite` 120/10 min on save-edit and discard
  (`?error=busy`). No window may exceed a day (`MAX_WINDOW_SEC`; the purge drops 2-day-old rows).
- **Error alerts (2026-10-06):** `@sentry/nextjs`, off unless `NEXT_PUBLIC_SENTRY_DSN` is set.
  `src/instrumentation.ts` (server init + `onRequestError`), `src/instrumentation-client.ts` (SDK
  loaded lazily only with a DSN), Inngest middleware `ReportFinalFailures` (final attempt only, then
  flush). `scrubEvent` drops request data/cookies/headers/query, keeps only user id, masks emails,
  drops console breadcrumbs and `extra`. Errors only (tracesSampleRate 0, no replay). No
  `withSentryConfig` / source-map upload (keeps the build free of a Sentry auth token).
- **Upgrades (2026-10-09, Davi: "everything you said, let's do it"):**
  - Gmail access lost → owner email (`src/server/alerts.ts`, 15-min lifecycle job), plus one
    reminder after 2 days; `mailboxes.access_lost_at` / `access_alerts_sent`, reset on reconnect.
  - Price list: business profile "Your price list" (the `pricing_notes` column), prompt `draft.v2`
    quotes listed prices exactly as written; `checkDraft` still flags any other amount; autopilot
    still never sends money.
  - Draft cards show the classification summary (what the customer wants) above the reason.
  - Quote tracker `/quotes` (`src/server/quotes.ts`, rules in `quote-rules.ts`): quote_request
    threads + anything marked; stage = owner's Won/Lost, else waiting_on_you / talking / quiet
    (owner wrote last ≥ follow-up days). Amount = largest $ in the owner's own reply (quoted text
    stripped), captured before the body purge (`captureQuoteAmounts`, daily + on view) or typed on
    Won. Totals over the last 30 days. `threads.quote_outcome/_at/quote_amount_cents`.
  - Customers `/customers` (`src/server/customers.ts`): grouped by lower(sender) of inbound mail,
    noise excluded; links use an **opaque key** (their newest message id) so email addresses never
    appear in URLs or logs; search filters client-side for the same reason.
  - Admin health: per account last sorted / last draft / last morning email; a System box that
    inverts to "Background jobs look stopped" when no working mailbox synced in 20 min.
  - Instant loading placeholders (`loading.tsx` → `ScreenSkeleton`) on queue, inbox, quotes,
    activity, settings only. **Never** on /admin or /customers/[key]: streaming turns `notFound()`
    into a 200, and those must 404 (e2e caught it).
  - Nav: bottom tab bar on phones (Queue · Inbox · Quotes · Customers · Activity · Settings), the
    same links in the header from `sm` up; `(app)` layout pads the bottom on phones.
- **Text alerts (2026-10-09, plan #50; Davi: texting included in plans):** `src/server/sms-alerts.ts`,
  `src/lib/sms.ts` (Twilio over fetch, off without env). Owner's own US mobile, confirmed by a
  6-digit code (sha256 stored, 10-min expiry, 5 codes / 10 guesses per hour). Content-free counts +
  link, quiet 9pm–7am local, ≥10 min apart, ≤10/day, only fresh (<24h) inbound quote requests /
  needs_owner threads classified after the cursor; slot claimed atomically before sending. Runs
  after classification and in the 15-min lifecycle backstop. **Missed-call text-back dropped**: it
  would auto-text customers, which the feature plan forbids (no send path without approval; owner
  can't text customers).
- **Feature plan:** `docs/FEATURE-PLAN.md` (Davi's picks from 50 ideas, 2026-10-09) is the spec for
  work beyond the brief, filed by milestone. 1:1 calls package, app-store listings: later (Davi).
  Calendar booking: after Google approves Gmail access.
- **#44 Your Gmail health (2026-10-09):** `mailboxHealth()` (`src/server/mailbox-health.ts`, pure)
  → three plain lines (Google access / Last checked / New mail). `mailboxes.last_sync_error_code`
  (`access_lost` | `rate_limited` | `sync_failed`, never message text) set in `guarded()`, cleared on
  the next ok sync and on reconnect. Reconnect button only for lost access (the only thing the owner
  can fix); stale sync (>30 min) says "we're looking into it". Settings heading is "Your Gmail".
- **#48 More trades (2026-10-09):** one list in `src/config/trades.ts` (enum, forms, invite, admin).
  Per-trade `src/ai/prompts/trades/<trade>.ts` (vocabulary + quote questions; `Record<Trade, …>` makes
  a missing file a compile error, and a test checks the files). `draft.v3` puts the owner's trade
  words and "Before quoting, find out" into the cached business block; `followup.v2` / `voice.v2`
  only widen the trade wording. Enum values added with `ALTER TYPE … ADD VALUE` (additive).
- **Davi 2026-10-09 on the plan:** #4 voice-to-edit yes, with a plain note that the browser sends
  speech to Google/Apple; #10 offline approvals only as an opt-in setting; #46 evals on demand /
  before release, not nightly.
- **classify.v2 (2026-10-09, plan #17 #27 #42):** schema adds `signals.from_building_department`,
  `signals.tries_to_instruct_assistant`, `extracted.permit` (issuing body, number, inspection time,
  passed/failed/scheduled/other, corrections) and `extracted.invoice` (number, amount, due date,
  unpaid/paid/partly_paid/unknown). Code-side guards in `src/ai/guards.ts`: `injectionCheck`
  (rules: instruction phrases, base64 runs, ≥3 zero-width/bidi chars — tuned so "ignore my previous
  email" / "send me the invoice" pass) runs **before** the model; injection (rules OR model) →
  needs_owner with `INJECTION_REASON` (overrides the model's reason). `looksMunicipal` (.gov,
  ci./town./co.*.xx.us, townof…, sender names like "Building Dept") OR the model signal → never
  noise (→ scheduling if an inspection is scheduled, else customer_question), never `low`, skips the
  Promotions shortcut. Both stored as `extracted.injection` / `extracted.municipal`;
  `createDraftForThread` skips them for every trigger except the owner's tap, and autopilot
  guardrails refuse both. `untrusted()` (`src/ai/prompts/untrusted.ts`) stops email text closing
  its `<email>` / `<conversation>` block. Inbox shows a permit card and invoice facts. No separate
  Haiku call for injection: the classifier (Haiku) already returns the signal.
- **#46 Prompt evals (2026-10-09):** `tests/evals/cases.ts` (66 invented emails, every category and
  trade, injection + building-department cases, draft rules), `run.ts` (real `classifyEmail` +
  `draft.v3` + `checkDraft` on in-memory PGlite), `score.ts` (accuracy, needs-owner recall,
  injection recall/false alarms, permit/invoice facts, draft pass rate; `regressions()` allows 0.03
  wobble, **none** on needs-owner and injection recall). `pnpm eval` (tsx with
  `--conditions=react-server` so `server-only` loads) / `--update-baseline` / `--no-drafts`;
  GitHub Actions "Prompt evals" is workflow_dispatch only (needs the `ANTHROPIC_API_KEY` repo
  secret). `tests/evals/baseline.json` is empty until the first live run. Unit test runs the whole
  set through a stand-in model. **Extend the set whenever a prompt changes.**
- **Plan M4 (2026-10-10):** #39 checklist (`src/server/onboarding.ts`, pure `buildChecklist`):
  Connect Gmail / Tell us what you do (`business_profile.completed_at`) / Check your first 3 drafts
  (sent, discarded or edited); on the Queue; "Hide this list" only when all done (server re-checks,
  `onboarding_dismissed_at`); it comes back if a step un-does. #23 `business_profile.never_say`
  (owner list, apart from the learned voice so a re-learn can't drop it; `src/server/never-say.ts`):
  Settings textarea + draft editor "Never say this" on the selected text (a button, since a textarea
  long-press can't host a custom menu). `checkDraft` now returns `hits`; never_say / never_promise
  hits → **one** regenerate (`REGENERATE_ON`), then flags (cap 0.2). #25 `seasonal_notes` table
  (text ≤140, `ends_on` local date, ≤5 active, ≤1 year ahead; codes past/too_far/full),
  `activeNotes(now)` in the owner's time zone; only active notes go into `draft.v4`'s cached block
  and count as source text for checks; expired rows purged daily. `draft.v4` adds both lists.
- **Milestone 2 re-check (2026-10-10, Davi's M2 prompt, branch `claude/milestone-2-sync`):** brief scope
  (backfill, History API, Pub/Sub watch + 5-min poll, reconnect, revoked-token tests) was already
  built; plan M2 has only #44 (done) and **no R-numbered items exist** in `docs/FEATURE-PLAN.md`.
  Added the missing tests (`tests/unit/push-poll.test.ts`: watch renewal, poll selection, push
  endpoint) and fixed two things they found: a garbled Pub/Sub payload made `/api/gmail/push` throw
  (→ endless Pub/Sub retries; now acknowledged with 204), and `renewWatches` renewed watches for
  read-only accounts (now skipped via `jobsAllowed`).
- **Plan M5 (2026-10-10, branch `claude/milestone-5-drafts`; brief M5 was already built, no R-items):**
  - #43/#2/#1/#8: `checkDraft` also flags guarantee/warranty/promise words ("commitment") and
    "N dollars"; one regenerate on money/when/never_promise/never_say hits. Typed gaps
    `{{price}}` `{{date}}` `{{time}}` `{{custom:label}}` (`src/ai/gaps.ts`) shown as fill-in chips;
    the server refuses to send with any `{{`/`}}` left (also autopilot). `draft.v5` returns
    `used_facts` (keys) for "Why this?". Labels Ready / Check the details / Check everything
    (`src/config/drafting.ts`); flags or gaps never read Ready.
  - #3/#4: `reviseDraft` + prompt `revise.v1` (tweak chips, and "Tell it what to change" typed or
    hold-to-talk via the browser's Web Speech API, hidden where unsupported, with the
    Google/Apple note). Same checks as a new draft; a **flagged** draft's text never counts as
    source (a tweak can't launder a flag); spoken words do. Max 5 per draft, 40/h per workspace.
    Clears any autopilot countdown. Log `draft_revised` {via} only.
  - #7 undo send: drafts stay `pending` with `send_after` (no new enum value — adding one and
    using it in the same migration run is unsafe) and are hidden from the queue. `queueSend` runs
    every check at the tap (403 unchanged), job `send-after-undo` → `deliverQueuedSend` claims
    atomically (`send_claimed_at`, 2-min lease) and re-runs the whole gate via
    `sendDraft(..., {queued: true})`; anything that stops it un-queues and logs `send_stopped`.
    Reconcile skips claimed drafts and a Gmail change un-queues. Backstop in the 15-min job. The
    API route now answers 202 `{status: "queued"}`. Autopilot still sends directly (its 10-min
    hold is its window).
  - #5 `/queue/review` + `batchSend`: rules in `batch-rules.ts` re-checked on fresh rows; each
    reply goes through `queueSend`. Categories picked per visit (`?cat=`), not stored.
  - #6 `threads.snoozed_until`; rules in `snooze-rules.ts` (owner's time zone, DST-safe);
    emergencies (priority high + needs_owner) only until midnight; back on top for 24h.
  - #9 two-way swipe (thumb side opens for sending, other side discards after a 5s Undo),
    `navigator.vibrate`. #9/#37/#10 are **per-device cookies** (`src/lib/device-prefs.ts`:
    `sa_hand`, `sa_contrast`, `sa_offline`) so each phone renders right on first paint.
  - #41 `/record/[draftId]` from draft row + activity log (`send_approved` carries device,
    undo window, offline). No loading.tsx there (must 404).
  - #21 `edit_signals` (counts/yes-no in code, tone via Haiku prompt `edit-tone.v1`), captured
    daily before the purge; weekly `voice-ideas` proposes ≤3 `voice_suggestions`; only a yes
    changes the voice profile (source → edited). Evals gained revise + tone cases.
  - #36 web push without a library or payload: VAPID JWT in Node crypto, empty push, the service
    worker fetches `/api/push/summary` (counts) with the owner's cookie. Endpoints allow-listed to
    real push services. Same throttle/quiet hours as texts (shared `freshLeads`). Off until
    `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` are set.
  - #10 offline okays (opt-in): SW keeps `/queue` + `/_next/static` only while cache
    `sa-queue-v1` exists; okays stored in localStorage with a sha-256 of the text seen;
    server refuses `changed_since_seen` / `intent_expired` (>12h). Signed-out screens and
    sign-out delete the copy.
  - #37 sunlight: tokens under `:root:has([data-contrast="high"])` in theme.css; header toggle.
- **Plan M6 (2026-10-11, branch `claude/milestone-6-8`):** #40 practice sends — `practiceSend`
  (`src/server/practice.ts`) only while `effectiveStatus === evaluating`, a NEW unthreaded message
  via `MailboxWriter.sendMessage` to the owner's own address, subject "[Practice] …", and
  `onlyToOwner()` re-checks To/Cc/Bcc on the exact MIME before Gmail; max 10 (`practice_sent` log).
  Real sends stay 403. #45 `/admin/costs` (`admin-costs.ts`, rules in `admin-cost-rules.ts`):
  revenue = plan price for setup_paid/active/past_due; alert email to `ADMIN_EMAIL` when AI cost
  > 40% of plan, once per account per month (marker in `app_settings`), daily in the purge job.
- **Plan M7 (2026-10-12, branch `claude/milestone-6-8`; #27 #28 #29 #30 #15 done, #26 behind a flag):**
  One additive migration (0023: `drafts.purpose`, `threads.quote_outcome_source` /
  `invoice_paid_at` / `invoice_paid_source` / `complained_at`, `business_profile.review_url`,
  `price_history`) plus hand-written backfills (legacy outcomes → source `owner`; 0024 marks
  threads still sorted `complaint`). Any `Date` in raw `sql` is `.toISOString()::timestamptz`.
  - **classify.v3** adds `signals.accepts_quote` / `signals.job_done`, stored as
    `extracted.accepts_quote` / `extracted.job_done`. `extracted.quote_accepted` is decided in code
    at classification: acceptance AND (the thread was a quote before this email, or is one now) AND
    the owner has written on it AND the owner gave a price before it (`quote_amount_cents` known, or
    a `$` figure in an owner email) — an acceptance is often re-sorted as scheduling; "Sounds good,
    book us in" after "I can come look Tuesday" is a site visit. A quote sent only as an attached
    PDF ("Quote attached") has no `$` we can see, so its "Let's do it" is not auto-won and gets no
    deposit draft; the owner can still tap Won (attachments aren't recorded at sync; see Waiting on
    Davi). Kept across later re-sorts until decided. `afterClassified` (auto marks) runs after
    `classifiedAt` is set, in a try/catch that logs metadata only; injection emails get no auto
    marks at all.
  - **Purpose drafts:** `drafts.kind` stays `reply`; `drafts.purpose` ∈ deposit / review_request /
    closing_question (`purpose.v1`). Purposes **never** autopilot, never batch, never earn autopilot,
    never bump `followup_count`. Autopilot and batch also refuse any draft whose email
    `accepts_quote` ("Quote acceptances always wait for you."). Deposit = the next draft on a thread
    with `quote_accepted`, once per thread; no payment terms → `{{custom:deposit instructions}}`
    gap + `NO_PAYMENT_TERMS_FLAG` first in the flags (survives the 6-flag cap), confidence ≤ 0.3.
    `checkDraft({ checkTerms })` (deposit + review only): a %, way to pay or discount/free/gift
    word not in the source → `terms` hit, one regenerate, then flag (cap 0.3); review requests
    also flag any URL other than the review link.
  - **#30 outcomes:** `quote_outcome_source` owner | auto — **the owner always wins**
    (`canAutoSet`; the auto UPDATE's WHERE re-checks it, uses `.returning()`, and only then logs).
    Auto-won on `quote_accepted`; auto no answer (`guessNoAnswers`, on Quotes load and a step in
    `followup-scan`) after 2 sent nudges + 7 quiet days, or 21 quiet days with fewer. A quote
    thread = category quote_request OR an outcome ever set. Lost / no answer stop all nudges; won
    stops quote nudges (a won job's invoice is still chased until paid). Auto guesses don't delete
    a waiting nudge — they add a "check before sending" flag; an owner decision expires it (and
    deletes its Gmail draft). Read-only accounts can't mark quotes (`?error=readonly`). Activity:
    "You won N of M quotes decided this month (P%)." (by `quote_outcome_at`, in the owner's month:
    `business_profile.time_zone`, Eastern by default, via `localMonthStart`; the Activity month
    label and month counts use the same zone).
  - **#27 `/money`:** invoice threads (`extracted.invoice`, or `invoice_thread` kept across
    re-sorts; facts carried when a later email has none or the same number), oldest due first.
    Excludes supplier_vendor and threads whose newest sender is a receipt domain
    (`RECEIPT_SENDER_DOMAINS` stripe.com / quickbooks.com / intuit.com). Owner Mark paid / Undo,
    "Not owed to me" (`invoice_paid_source = not_owed`, out of both lists) / Put back via
    `?show=hidden`. Auto-paid: a customer's same-thread "paid" (never from a receipt sender), or a
    receipt that names the invoice number (normalized; **no amount-only match**). A paid or
    not-owed invoice is never chased; owner Mark paid expires the waiting nudge and deletes its
    Gmail draft (`expirePendingNudge`), an auto-paid mark only flags it ("We think this was paid").
    A later email naming a different invoice number reopens the row: the paid mark (ours or the
    owner's) is cleared and logged as `invoice_reopened`. "Not owed to me" is never cleared, and
    injection emails never reopen.
    A3: a sent purpose note, any quote outcome or a paid invoice stops nudges, and the sent screen
    then promises none. `expirePendingNudge` claims the nudge in one conditional UPDATE (pending,
    Send not tapped) before touching Gmail or Activity: a Send tapped first wins, and a double
    "Mark paid" closes it once.
  - **#29 review request:** `business_profile.review_url` (https only). "Ask for a review" on Inbox
    rows and paid Money rows, owner tap only, when `job_done` or the invoice is paid. Never a
    complaint: `threads.complained_at` is sticky, and any complaint from that address in the last
    12 months blocks it. Never no-reply/receipt senders, supplier_vendor, injection/municipal mail,
    or an address the owner never wrote to (`knownCustomer`). One per address per 12 months,
    serialized by `pg_advisory_xact_lock` (`src/server/review-lock.ts`).
  - **#26 closing question:** built behind `FEATURE_CLOSING_QUESTION` (`src/config/features.ts`;
    on only for "1"/"true"/"on"; off in every env until Davi says so). Offer on Quotes after 2 sent
    nudges + 7 quiet days; owner tap only (never a job), once per thread ever (partial unique index
    `drafts_one_closing_question_per_thread`; a lost race returns `already_asked`/`already_pending`
    and deletes the extra Gmail draft); separate from `followup_count`.
  - **#15 price memory:** `price_history` (amount, kind of job, date; one row per thread) written by
    `captureQuoteAmounts` from the owner's own sent quotes (plus a one-off backfill of existing
    captured amounts); owner-typed Won amounts never go in. Similarity in code (job-word overlap,
    `SIMILAR_AT` 0.5, top 3). Shown only on quote requests ("Last 3 similar"): on Queue (tap a
    figure to fill `{{price}}`) and as plain text on Inbox. **Never sent to the AI** and never in digest/admin/push/SMS:
    a static boundary test lists the only files that may touch it, plus per-prompt tests. Kept
    past the body purge; goes with the mailbox / account.
  - Sentry: `ui.*` breadcrumbs lose message and data (`scrubEvent`). A failed query's bound
    values never leave: `scrubEvent` cuts every exception value (causes too), `message` and
    `logentry` at `\nparams:` and keeps only the first line of anything starting `Failed query:`. M7's new controls (Money
    cards, past-price buttons) use aria-labelledby or visible text, never an aria-label with an
    amount or name. Older labels (draft card, quote card, seasonal-note remove, admin waitlist)
    still carry a name or owner text and are kept out of Sentry only by the `ui.*` scrub.
- **Plan M8 (2026-10-12, branch `claude/milestone-6-8`; #31 #32 #33 #34 #35 #38 done):**
  Migration 0025 (additive, no backfill): `threads.quote_requested_at` (set once when a thread is
  first sorted quote_request, never cleared, like `complained_at`; the time is the customer's
  first email since the owner last wrote — "wrote" as in `lastOutSql`, see "Side conversations"
  below — so a new job asked for on an old conversation dates from the request; threads sorted
  as quotes by older code fall back to the thread's first inbound), `threads.job_kind` (one of our
  fixed labels, set at classification; only replaced while null or "Other jobs"; injection emails
  leave no mark), `threads.at_risk_alerted_at`, `business_profile.monthly_summary_last_sent_for`
  ('YYYY-MM'). Queries count a quote request as `quote_requested_at IS NOT NULL OR` the current
  quote rule (`quoteRequestSql`), so a request re-sorted as scheduling still counts.
  - **Queue numbers have one source:** `queueMembership` / `queueCounts` (`src/server/drafts.ts`)
    share listQueue's filter but select only ids, category, priority, kind and times, with no
    50-row cap. The digest, `/api/push/summary` and `/api/badge` use them, never `listQueue`. This
    also fixed the digest counting snoozed threads and sends still in their undo window.
  - **#31 Needs you:** up to 3, emergencies first then oldest waiting; waiting since = the
    customer's first email after the owner last wrote (owner wrote last → noun only, sorted last).
    Fixed category nouns (`digest-rules.ts`), never the needs-owner reason. Links are only
    `/queue`, `/settings#digest`, `/quotes` and `/queue#t-<uuid>` (allow-list test, no `@` or `?`).
    Queue cards carry `id="t-<uuid>"`. The (app) header isn't sticky, so cards use `scroll-mt-4`
    plus `scroll-mb-28` on phones (the bottom tab bar), and `ScrollToThread` scrolls a streamed card
    into view (the browser's own hash scroll fires before the card exists).
  - **#32/#33 week:** Monday 00:00 → Monday 00:00 in the owner's zone (`weekBounds`, DST-safe;
    pure date code lives in `snooze-rules.ts`: `localParts`, `localMonthStart/Name`, re-exported).
    `src/server/scorecard.ts`: replies and follow-ups by `decided_at`; quotes out = each quote
    request once, in the week of the owner's first answer; response time = the request time
    (`requestAtSql`: `quote_requested_at`, else the thread's first inbound) → owner's first answer
    (synced email that isn't a side email, sent draft, or a send in its undo window), calendar time,
    filed under the week the request came in, plus how many are still unanswered. No-reply senders
    (`src/server/sender-rules.ts`, SQL twin in `thread-sql.ts`) count as neither. Time saved =
    `MINUTES_PER_SENT_REPLY` (now in `src/config/drafting.ts`) × (replies + follow-ups sent).
    `monthSummary` now counts sent items by `decided_at` too, so a week can't beat its month.
    Activity: "This week so far" card with last week alongside; Monday's morning summary gets a
    "Last week" section (skipped if all zero).
  - **#34 leads at risk** (`leads-at-risk.ts`, rules in `leads-at-risk-rules.ts`): business hours
    are one default in `src/config/business-hours.ts` (Mon–Sat 7am–6pm, owner's zone; the free-text
    `business_profile.hours` is for drafting only and is **not** parsed), `LEAD_AT_RISK_HOURS` 4
    (`businessMinutesBetween`), `LEAD_AT_RISK_MAX_AGE_HOURS` 72 calendar hours (so the 30-day
    backfill can't flood alerts), `LEAD_AT_RISK_PUSHES_PER_DAY` 3. Answered = an owner email after
    waiting-since, a sent draft decided since then, or a send queued / claimed. Only mailboxes that
    are active and synced in the last 30 min count (a stale mailbox can't see the owner's replies).
    Snoozed, decided, out-of-inbox and no-reply leads are skipped. A push step in the 15-minute
    lifecycle job (after `m7-backfill`): inside business hours and outside quiet hours, claims the
    shared push slot (10-minute gap with new-lead pushes), marks each lead once per **waiting
    episode** (`at_risk_alerted_at < waiting since` re-arms it), counts the day's cap from
    `lead_at_risk_push_sent` activity rows; if no phone got it, the marks and the slot are handed
    back and nothing goes in Activity. The tap opens `/queue?t=<uuid>#t-<uuid>` (a real
    navigation; `sw.js` `safeUrl` allows only that or `/queue`), or `/quotes` when the lead has no
    queue card. The morning summary always has the counts-only "N quote requests have waited more
    than 4 hours." line, push or not (harmless catch-up), plus a Needs-you line linking to Quotes
    for at-risk leads with no card.
  - **#35 monthly summary** (`monthly-summary.ts`, rules in `monthly-rules.ts`): a second step of
    the hourly `morning-digest` job; follows `digest_enabled`; due on local day 1–3 **at/after**
    `digest_hour` for the previous month in the owner's zone; Resend idempotency key
    `monthly-<workspace>-<YYYY-MM>`; marker set only after a send (no Resend env → nothing sent or
    marked); quiet months and read-only accounts get none. Contents: quote requests, top 3 job
    kinds (`src/config/job-kinds.ts`, per trade, whole-word keyword match on the model's
    `service_requested`, "Other jobs" fallback — only the label is stored or sent), top 3 lead
    sources (`src/config/lead-sources.ts`; domains split in SQL so no address reaches JS; Google
    only as the exact hosts `localservices.google.com` / `business.google.com`; facebookmail.com
    left out as too broad; else "Direct email"; the domain is the requester's,
    `requestSenderSql`), quote requests by `requestAtSql`, repeat customers (an address with a
    **new** request in the month — a conversation that began in the month or a quote asked for in
    it — and an earlier inbound on a **different** thread before the month, one SQL count; one job
    split over two September threads that carries on in October is not a repeat) and win rate
    (`closeRateBetween`).
  - **#38 badge:** `src/lib/app-badge.ts` + `AppBadge` in the (app) layout fetch the count-only
    `/api/badge` (`{ count }`, 401 signed out) at most once a minute, after a queue action and on
    becoming visible; `sw.js` sets it after a push. Count = replies ready + needs-you, capped at 99,
    0 for read-only accounts. Cleared at 0, on a 401 and on signed-out screens; a network error
    leaves it alone. True lock-screen widgets aren't possible for a web app (no API for them).
  - Logs: `console.error('<event>', { ids, error: err.name })` — never `err.message` (Stripe
    errors echo customer ids). `*-rules.ts` files never import `server-only` or `@/db` (test).
- **#47 referral credit (2026-10-12, built behind `FEATURE_REFERRALS`, off; no amount):**
  `src/server/referrals.ts`, rules in `referral-rules.ts`. Migration 0026 (additive):
  `workspaces.referral_code` (unique, 12 chars base64url, random) / `referred_by_workspace_id`,
  `waitlist.referral_code`, `invites.referred_by_workspace_id`, and `referral_credits` (unique
  `(referred_email_sha256, side)`; `referred_workspace_id` / `beneficiary_workspace_id` ON DELETE
  SET NULL; status pending / applied / failed / skipped; attempts, last error code).
  `REFERRAL_CREDIT_CENTS = null` and `REFERRAL_CREDIT_TO = "both"` in `src/config/pricing.ts`;
  `referralsVisible()` = flag on **and** a positive amount — otherwise no link, no code stored,
  nothing carried, no credit, no Stripe call. Path: `/?ref=<code>` → waitlist (hidden field) →
  `inviteFromWaitlist` → first sign-in copies it to the workspace and clears it on the invite (used
  once; a first sign-in while it's off still uses up the invite's referral, unlinked). Settled
  **once ever**, the first time the referred account is `active` with
  `setup_paid_via = 'stripe'` (not house, not legacy null): one insert of the sides in the config
  at that moment, or a single `skipped` row (flag off, no amount, self, same business domain —
  public webmail like gmail.com exempt). Later config changes add nothing. The email fingerprint
  (sha256 of the normalized email, salted with `AUTH_SECRET`) survives account deletion, so
  delete + re-sign-up can't be paid twice. Each credit = a negative Stripe balance transaction with
  `Idempotency-Key: referral-<referred workspace>-<side>`, and first a check of the customer's
  balance transactions for `metadata.referralCreditId` (Stripe idempotency keys expire after 24h).
  Hooks: any admin move that lands on `active` (setup call done, resume) and the webhook
  (`billing.ts`) call `creditReferralSafely` (never fails the move; settles only once); the
  15-minute sweep (after `m7-backfill`) applies pending rows once the beneficiary has a Stripe
  customer and settles missed actives; permanent Stripe errors (resource_missing / invalid
  request) → `failed`, shown on the /admin card. `stripeClient()` is exported from `billing.ts` (one
  client). Activity `referral_credit_applied` carries the side only. Test seam:
  `setReferralConfigForTests`.
- **Public site pass (2026-10-11, branch `claude/homepage-fixes`, PR — Davi reviews before merge):**
  `/privacy` and `/terms` render `docs/privacy-policy.md` / `docs/terms.md` (drafts, "Draft — not
  yet reviewed", `[To confirm]` items) through `src/lib/markdown.tsx` (tiny renderer, React elements
  only) with contact details substituted from `site.ts` + `SUPPORT_EMAIL`; footer links on every page.
  Marketing rules: present tense only for what's live on production; never say the app "can't send"
  in general; no shop counts, testimonials, invented numbers or logos; no "GC" (MA = CSL), no license
  number until Davi confirms. Live check 2026-10-11: sorting runs on prod (classify.v2 calls in
  logs); morning summary is not live for owners (Resend test sender) → copy says "When you're set
  up". Security headers in `src/config/security-headers.ts` (CSP with `unsafe-inline` scripts —
  nonces would make every page dynamic; form-action allows Google + Stripe for OAuth/Checkout
  redirects; microphone=(self) kept for M5 voice-to-edit). OG image from committed OFL TTFs in
  `src/app/_og/`; `metadataBase` from `appUrl()`. Waitlist trade + team size are now required.
- **Sending requires a real payment (Davi, 2026-10-10):** `canSend` = status in `SENDING_ALLOWED`
  **and** `workspaces.setup_paid_via` ∈ {`stripe`, `house`}. `stripe` is set only by the signed
  webhook's paid checkout that included the setup fee; `house` only by the admin move
  `house_account`, which `applyAdminMove` refuses unless the workspace's owner is `ADMIN_EMAIL` (and
  the button only shows on Davi's own card, pinned first in /admin). The old "Mark setup paid" move
  is gone. Accounts hand-marked before this (via null) can't send, see "Sending turns on once setup
  is paid" + Choose a plan, and are charged the setup fee (`checkoutTerms` uses `setupReallyPaid`).
- **Future goal (after the website is complete):** a downloadable app (phone app store). Not started;
  the site is mobile-first so a wrapper or native shell can reuse it later.
- **Public site (2026-10-05, Davi asked for a sales website):** `/` is the marketing page (signed-in
  users still go to `/queue`); sign-in moved to `/signin` (Auth.js `pages`, `requireOwner` redirect).
  Copy must stay true to the code (scopes, 30-day retention, trial can't send, autopilot rules);
  prices render from `src/config/pricing.ts`. Waitlist form → `waitlist` table (idempotent per
  email, hidden "website" honeypot); joining does NOT allow sign-in — Davi taps Invite in
  /admin → Waitlist (`inviteFromWaitlist`). `QueuePreview` is an HTML still of the queue.
- **Installable app (PWA, 2026-10-05):** Davi wants website + downloadable app. `src/app/manifest.ts`
  (start_url /queue, standalone), icons from `src/app/app-icon/[size]/route.tsx` (ImageResponse
  placeholder until the icon pack), Apple web-app metadata, and `public/sw.js` which **never caches
  pages or data** — only `public/offline.html`. Settings → "Get the app" (Install button on
  Android/Chrome, Share → Add to Home Screen steps on iPhone). App-store listings later (Apple
  $99/yr, Google $25) need Davi's okay; a Capacitor/TWA wrapper can reuse this site.
- Davi's direction (2026-10-05): keep features simple; make it faster, smoother, more reliable.
  Open idea, **his decision, don't build yet**: hands-on 1:1 business calls/reviews as part of a
  package (setup call already in the $499 setup).
- postgres.js can't bind a `Date` inside a raw `sql` template — pass `.toISOString()` with
  `::timestamptz` (PGlite tolerates it, so unit tests won't catch it; e2e did).
- Lesson: scripted `str.replace` edits must `assert old in s` — silent no-ops after Prettier caused
  M3/M4 regressions. `tests/unit/jobs.test.ts` fails if a `createFunction` isn't registered.
- **Squared Away Growth (2026-10-12, branch `claude/growth-page`, stacked on PR #9):** a separate
  one-on-one marketing service (ads, posts, Google Business Profile, reviews, websites) for anyone
  in the trades. `/growth` (public, static, charcoal edge to edge) and a second, charcoal chapter at
  the bottom of `/` after the app's waitlist: `GrowthBridge` (paper) → `GrowthWipe` (CSS-only
  scroll-timeline wipe in theme.css, `.sa-flip`; no support or reduced motion = an instant switch;
  e2e asserts `animation-timeline: --sa-flip` so Lightning CSS can't fold it away) → the
  `.sa-inverted[data-growth-chapter]` wrapper with a sticky chapter bar. All copy in
  `src/components/marketing/growth/growth-copy.ts` (names/phone/company from `siteConfig`; guard
  test bans prices, unlaunched features, he/him/his and "builder"). No Growth prices on the site.
  Services in `src/config/growth.ts`.
  - "Book a free call" (`requestGrowthCallAction`) → the existing `waitlist` table, **no migration**.
    Conventions: `team_size = 'growth-only'` marks a row that exists only for Growth; the note is
    the app note, then ONE `[Growth call]` block (newest request replaces the previous one;
    identical resubmit is a no-op). Read them only through `describeWaitlistEntry`
    (`src/server/growth-note.ts`). Typed `[Growth call]` is scrubbed (both forms). A Growth request
    never changes name/team size/created/invited, **never invites** (`inviteFromWaitlist` →
    `growth_only`; mixed rows invite with the app note only); an app join upgrades a growth-only row.
    `waitlist.phone` is the newest Growth number on a growth-only row, and only the app form's own
    number on an app row (a Growth number lives in its block, so a replaced request leaves no old
    number behind, as the privacy policy says). Email capped at 254 characters (both forms).
  - Shares the `waitlist` hashed-IP limit bucket (10/h across both forms). Content-free notice to
    `ADMIN_EMAIL` ("New Growth call request", Resend idempotency key = HMAC(AUTH_SECRET, email) +
    local date), awaited but capped at 5 s (`GROWTH_NOTIFY_TIMEOUT_MS`) so a hung Resend can't hold
    the form. Logs only `growth_call_requested {existing, services}`. Both form actions catch a
    failed save, log `growth_request_failed` / `waitlist_join_failed {error: name}` and throw a
    content-free error (Next logs whatever an action throws, and a Drizzle error's message carries
    every bound value). Sentry scrub ported
    verbatim from M7 (`src/lib/sentry.ts`) so a failed insert's params never leave;
    `tests/unit/sentry.test.ts` is M7's file (its price_history case included since the launch
    merge), and the Growth case lives in `tests/unit/growth-sentry.test.ts`.
  - The homepage chapter bar is opaque charcoal and stays pinned to the end of the page (the footer
    is shorter than the screen), so the paper header never comes back. Intended.
  - /admin → "Waitlist and Growth calls": chips, the request, Call link, growth-only explanation.
  - Homepage trial FAQ / "Our promise" wording left as on PR #9 (awaiting Davi's review there).
- **Launch merge (2026-10-13, branch `claude/launch-integration`):** M5–M8 + #47 and PR #9 + Growth
  in one tree. Referrals and Growth share the waitlist: the code is stored only while
  `referralsVisible()` (flag on AND an amount); a Growth request never stores one; an app join that
  upgrades a growth-only row stores its code (if visible and none was kept) and takes the app
  form's trade (required there, and it is what the invite uses); a different Growth trade stays in
  the block as "Trade given" (`withBlockTradeGiven`). robots.txt also disallows `/money` and
  `/record`. `inviteFromWaitlist`
  refuses growth-only rows (`growth_only`) before looking at any referral, then carries
  `referredByWorkspaceId` only while visible. /admin's "Came from a referral link" sits on the
  Growth-aware `WaitlistEntry` card (app sign-ups only, visible only). The homepage keeps
  `ForgetOffline` and Growth's opaque header (no backdrop blur). theme.css holds sunlight mode
  (#37) and the Growth flip / `.sa-light` / `/growth` background side by side.
- **Gmail drafts are not mail (2026-10-13, M8 review):** a Gmail draft is a message with the
  DRAFT label and no SENT. Sync used to store every draft (ours included) as owner mail ('out'),
  so an unsent draft read as "the owner answered". Sync now skips DRAFT-without-SENT
  (`isUnsentDraft`; no row, no thread, no `last_message_at` move). Google's drafts guide says a
  sent draft becomes a new message; not checked live, so the code is also right if Gmail kept
  the id: `listHistory` asks for `messageAdded` **and** `labelAdded` (ids that gain SENT);
  `ingest` re-fetches a stored row that is still an unsent draft and updates it in place
  (`setWhere`), never other stored rows; `sendDraft` stores its own sent message
  (`recordSentMessage`, best effort, **after** the `reply_sent` row, only when the writer can
  read). Thread `participants` are merged in SQL on upsert (an app send can run alongside a
  sync). "The owner wrote" reads ignore unsent drafts with one predicate (`notDraftSql` /
  `notDraftMessage` in `thread-sql.ts`, same rule as `isUnsentDraft`: DRAFT+SENT is mail):
  lastOutSql (so leads at risk, digest waits, no-answer guesses, price memory), follow-ups,
  scorecard, reconcile, knownCustomer, createDraftForThread / revise conversation,
  classification's ownerWroteBefore, ownerQuotedCents, Quotes' stage, the closing-question
  timing. **A stored draft never answers a lead** (alert even before the cleanup). The
  exceptions are on purpose and only matter for rows old sync stored: whatever could send on
  its own treats an unchecked row as a possible answer — `threadsToAutoDraft` still counts it
  as the owner's last write, autopilot layer 3 refuses a thread with one after the customer's
  email ("You might already have answered this in Gmail."), and `runAutopilotSend`'s
  newer-mail check counts it; sms-alerts' newest-direction check doesn't filter them either.
  **Autopilot asks Gmail before sending** (`MailboxWriter.threadDraftMessageIds`,
  threads.get format=minimal, ids only): any unsent draft on the thread other than ours →
  stood down "You're writing a reply in Gmail." (the owner's autosaved reply is no longer
  synced). Only asked when `canSend` and the mailbox is active (no Google call when blocked).
  One-shot `runDraftMessagesCleanup` (`src/server/draft-message-cleanup.ts`, 15-min job after
  `m7-backfill`): rows an app send recorded (`sent_gmail_message_id`) become SENT without Gmail;
  every other stored draft is looked up in Gmail (100 per mailbox per run) — sent → updated, gone
  or still a draft → deleted; pending drafts threaded to a deleted row are re-pointed to the
  newest real message; a quote amount / price-memory row taken from a deleted draft's text is
  cleared (unless the figure is in real sent mail, the owner typed it, or any real owner email
  on the thread has lost its text to the purge) so `captureQuoteAmounts` redoes it;
  `last_message_at` recomputed. **Done per mailbox** (`app_settings`
  `cleanup:draft-messages-v1:<mailboxId>`): a mailbox we can't read (lost access, read-only
  account) keeps its rows and no marker, and is checked again every run (one query) until it
  can be read; the run-wide key `cleanup:draft-messages-v1` is written only when every mailbox is
  done (nothing failed, skipped or left over). Not repaired: `extracted.quote_accepted` /
  auto-Won outcomes decided while a draft counted (the owner can change them). Ingest sets
  `last_message_at` = greatest(new messages, stored messages' max) so a stale read can't put a
  deleted draft's time back.
- **Side conversations (2026-10-13, M8 review):** Gmail keeps the owner's forward of a lead to
  the crew (and the crew's reply) in the customer's conversation, so "the owner wrote" counted a
  forward as an answer. `sideEmailSql` (`thread-sql.ts`) now leaves out side emails everywhere
  "who wrote last" is asked: `lastInSql` / `lastOutSql` / `waitingSinceSql` (leads at risk,
  Quotes' stages, digest waits, no-answer guesses, follow-ups), the scorecard's first answer,
  the `quote_requested_at` timing, and `createDraftForThread` for nudges / closing questions
  (`last`, the addressee, the threading and the model's conversation). Decided by **who the
  owner wrote to**, never by one "customer" address: the customer's side = anyone on the
  thread's inbound mail (sender, To or Cc). An owner email is side when it goes to someone,
  none of its recipients is on the customer's side (crew replies don't count as that), and it
  is a forward the owner started (subject `Fwd:` / `Re: Fwd:` on a thread whose lead didn't
  itself arrive as a forward) **or** every recipient is on the mailbox's own business domain
  (crew@shop.com; never on public webmail, `PUBLIC_WEBMAIL_DOMAINS` in `sender-rules.ts`).
  An inbound email is side when its sender got the lead from the owner (a recipient of such an
  owner email, or of any owner email when on the owner's business domain: "Dana, meet Mike")
  and had never been on the thread's inbound mail before. Not a strict "To/Cc holds the
  customer" rule because a contact-form lead's customer is answered at the form's Reply-To,
  which sync doesn't store (an additive `messages.reply_to_addresses` would allow the strict
  rule). **Known gaps:** a plain "Re:" sent only to an outside address answers the lead (the
  contact-form case); on a lead that arrived as a forward (a friend, an office or a property
  manager), the owner's forward to an outside crew counts as an answer.
  **Known limitation (A11):** `quote_requested_at` is sticky, so a returning customer asking for
  a new job on their old, already decided quote thread keeps the first request's time: the
  scorecard, the monthly count and the repeat-customer check miss the new request (no history of
  requests is kept). Re-stamping it when the outcome is decided would also need the outcome and
  Quotes' stage to move with it — not built.
  **A10 in every unit test:** `createTestDb` calls `refuseDateParams`
  (`tests/support/no-date-params.ts`), so PGlite refuses a JS `Date` bound into raw SQL as
  postgres.js does.
- **M11 security audit (S4, 2026-10-13):** static tests guard the surface —
  `tests/unit/security-surface.test.ts` (C1 every server action awaits `requireOwner` /
  `requireAdmin` first, reviewed public/inline allow-lists; C2 admin pages + no `loading.tsx` over
  must-404 screens; C3 every route handler in a table with its guard, a new route fails; C4 no
  redirect-target query param read, by property access or destructuring) and
  `tests/unit/no-content-logs.test.ts` (C11). Fixes: the send API answers 403 for an
  unparseable Origin (was a 500); `sendPush` re-checks the push-endpoint allow-list
  (`src/lib/push-endpoint.ts`) and never fetches anything else (returns `gone`); HSTS
  `max-age=31536000` (no includeSubDomains/preload); Connect Stripe failures travel as fixed
  codes (`src/server/stripe-error-rules.ts`) and /admin shows our sentence, never Stripe's text.
  **C9 accepted as the UI behaves today:** read-only accounts may still snooze and tap "This one
  needs me" (both only reorder the owner's own list; no Gmail or model call; tested).
  Verified, no change: push endpoint re-homing on upsert, the Gmail push `?token=`, the health
  commit SHA, CSP `'unsafe-inline'`, JWT-trusted admin email, `x-forwarded-for` on Vercel.
- **M11 legal drafts (S5, 2026-10-13):** `docs/privacy-policy.md` and `docs/terms.md` checked
  against the code; `tests/unit/legal-docs.test.ts` is the gate (numbers read from config/code,
  the scope table from `GMAIL_SCOPES`, the three terms `[To confirm]` items unchanged, no
  referral text while #47 is off). Limited Use uses Google's template sentence word for word and
  the merger clause says "only after asking for your explicit permission first". The deletion
  sentence ("Delete my account in Settings deletes your account and everything in it from Squared
  Away, after one confirmation. Stripe keeps its own payment records.") is shared word for word by
  the policy and the homepage FAQ (tested). Trial wording everywhere: nothing can go to a
  customer, practice copies to yourself only — never "sending is switched off completely" (the
  connect explainer and homepage are tested). `outputFileTracingIncludes` ships docs/*.md with
  /privacy and /terms. **Open for Davi (S7 carries these):** the three terms `[To confirm]` items
  (refunds, liability cap, governing law and venue); "plus any taxes" while Stripe collects no
  tax; a lawyer's review of both drafts; the #47 referral-fingerprint line before
  `FEATURE_REFERRALS` goes on; how to honour a waitlist / Growth removal request (the policy says
  "ask us and we'll delete it", and there is no admin tool — done by hand in the database).

## Milestones

- [x] **0. Scaffold**
- [x] **1. Auth + Gmail connect** — verified live 2026-09-28 (Davi signed in and connected Gmail on sa-dac3.vercel.app)
- [x] **2. Sync** — code + tests done; live sync waits on the Inngest integration
- [x] **3. Classification** — code + tests done; live run waits on Inngest (and `ANTHROPIC_API_KEY` on Preview)
- [x] **4. Profiles** — code + tests done; live voice learning waits on Inngest
- [x] **5. Drafts + Queue** — code + tests done; live drafting waits on Inngest; sending stays off
      until M6 moves a workspace to `setup_paid`
- [x] **6. Workspace lifecycle** — trial clock, read-only expiry, admin page with manual moves
- [x] **7. Follow-ups** — daily scan, nudge drafts, two-per-thread cap, settings
- [x] **8. Digest + Activity** — Activity screen + honest estimate; digest code done, live email
      waits on a Resend API key (and a verified domain for owners other than Davi)
- [x] **9. Autopilot** — three-layer guardrails, earned per category, 10-minute grace window
- [x] **10. Billing** — Stripe Checkout + portal + webhook; Connect Stripe in /admin
- [ ] 11. Hardening and launch

## Waiting on Davi

- **Gmail draft send behaviour (M8 review):** not yet checked live whether Gmail keeps a draft's
  id when it's sent. Counts-only check on the shared DB: join `drafts.sent_gmail_message_id` to
  `messages.gmail_message_id` and count the matches whose `label_ids` hold `SENT` vs `DRAFT`.
  Many DRAFT matches = same-id sends. The code is safe either way; this only says which path is
  live.
- Phone notifications (#36): add `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` (free; any VAPID key
  generator) to Vercel Production, then redeploy. Off until then.
- `ANTHROPIC_API_KEY` repo secret for the "Prompt evals" action (baseline still empty).
- Resend: verify the production domain in Resend and switch `EMAIL_FROM` off `onboarding@resend.dev`
  (until then the digest only reaches the Resend account's own address).
- Optional: Gmail instant notifications (docs/SETUP.md §6a) and Sentry error alerts (§6b).
- Rotate the Neon password and Google client secret that were pasted in chat; delete the old
  Google secret.
- Add each invited owner as a Google Cloud test user (Google Auth Platform → Audience).
- Icon pack (`sa.` monogram, stacked wordmark); `docs/terms.md`, `docs/privacy-policy.md` drafts;
  `SUPPORT_EMAIL`; production domain.
- **Plan #26 (closing question):** decide whether "Want to ask if they went another way?" may go
  live. Built and tested behind `FEATURE_CLOSING_QUESTION` (off); turning it on = set it to `1` in
  Vercel and redeploy (docs/SETUP.md §6d). Don't set it without his okay.
- **Plan #47 (referral credit):** built and tested behind `FEATURE_REFERRALS` (off), and it does
  nothing until he answers: (1) the credit amount in dollars (`REFERRAL_CREDIT_CENTS` in
  `src/config/pricing.ts` is `null`); (2) who gets it: both (the spec's default), the referrer only,
  or the new customer only (`REFERRAL_CREDIT_TO`); (3) whether he wants the same-domain block at
  all (as built: two owners on the same business domain never count, public webmail like gmail.com
  is exempt). Before turning it on, add the referral-fingerprint line to the privacy policy (the
  "Privacy policy line for #47" item below; docs/SETUP.md §6d), and don't rotate `AUTH_SECRET` once
  referrals have been paid (the "paid once" fingerprint is salted with it). Then set the switch
  (docs/SETUP.md §6d). Referrals that go active while it's off are never paid later.
- **PDF quotes (#28/#30):** a quote sent only as an attachment ("Quote attached", no `$` in the
  email) never counts as a price given, so "Let's do it" isn't auto-marked Won, isn't in the close
  rate until he taps Won, and gets no deposit draft. Conservative on purpose (a site visit isn't a
  quote). Alternative if he wants it: record "has an attachment" on owner emails at sync (additive
  column) and count an owner email with an attachment as a price given.
- **Privacy policy lines for M5/M7 (added to the draft at the launch merge, Davi to review):**
  `docs/privacy-policy.md` now covers the price memory (never sent to the AI), invoice paid /
  "not owed to me" marks, the complaint marker, review requests and the review link, seasonal
  notes, web push (#36: the endpoint is stored; Google/Apple/Mozilla/Microsoft push services
  deliver an empty ping; deleted on turn-off, a gone phone or account deletion), the per-phone
  display cookies and the offline-approvals queue copy (#9/#37/#10), and that these M7 records
  stay past the 30-day purge until the mailbox or account goes.
- **Privacy policy line for #47 referrals** (before `FEATURE_REFERRALS` goes on): "If you were
  referred, we keep a scrambled one-way fingerprint of your email and the credit record after you
  delete your account, so a referral is only paid once." (Otherwise the policy's Delete my account
  section and the homepage FAQ's "deletes your account and everything in it" aren't literally
  true.) Also his call: a referrer who deletes their account before the
  new owner is active voids the referral for both sides; repeat waitlist joins and plain invites
  carry no referral (docs/SETUP.md §6d).
- **Growth (2026-10-12):** confirm all seven services are offered today (websites and ad management
  especially) and the ground rules (no fake reviews, price before any work, Growth never touches
  the inbox). No Growth terms of service yet. A Settings link to /growth for signed-in owners needs
  his okay. No tracking pixels on /growth without a privacy-policy change and his okay. Removing a
  Growth request is done by hand in the database for now (policy says call, text or email us).
  Only the newest Growth request per email is kept and a growth-only row's phone becomes the
  newest number, so anyone who knows a lead's email can replace their number: check an
  unfamiliar number before calling.

## Launch blockers to remember

- Previews share the production database. Before real customers: give previews their own Neon
  branch (Neon's Vercel integration does this) so a preview can't touch customer data.
- **M7 merge timing (complaint memory, A1):** the first preview build of the M7 branch runs
  migration 0024 (marks threads still sorted `complaint` with `complained_at`). Until M7 merges,
  production's older code keeps re-sorting threads without setting the mark, so a complaint that
  turns into "fixed now, thanks" in that window leaves no trace and could later be offered "Ask
  for a review" (owner tap only, and it's a draft). The same goes for complaints re-sorted before
  M7. That data can't be recovered (no category history is kept): merge M7 soon after its first
  preview build. What _can_ be recovered is redone from new code once production runs it:
  `runM7Backfill` (`src/server/m7-backfill.ts`), a one-shot step in the 15-minute
  `workspace-lifecycle` job gated by the `app_settings` key `backfill:m7-v1`, marks threads still
  sorted `complaint` / showing a dispute or legal reason / `extracted.disputed`, and sets
  `quote_outcome_source = 'owner'` wherever the owner's newest `quote_marked` tap is newer than our
  newest `quote_outcome_guessed` (an old-code Won/Lost over our guess, or an old-code Reopen).
  0023/0024 stay as they are — they already ran on the shared DB; never edit an applied migration.
