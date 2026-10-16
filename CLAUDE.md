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
tests/e2e/          Playwright (mobile 375px + desktop); real Postgres; forged Auth.js cookie;
                    fakes/ = fake Google consent + Gmail + Anthropic (127.0.0.1, PORT+1)
docs/               BRIEF.md, SETUP.md, LAUNCH.md (Davi's launch checklist),
                    google-verification.md, legal drafts
```

## Commands

`pnpm dev` · `pnpm lint` · `pnpm format` · `pnpm typecheck` (runs `next typegen` first) ·
`pnpm test` · `pnpm build && pnpm test:e2e` · `pnpm db:generate` / `pnpm db:migrate`.
In a sandbox with preinstalled Chromium: `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium pnpm test:e2e`.
e2e needs no real keys: Playwright starts the fakes itself on `PORT+1` (app 3100 / fakes 3101 by
default, CI too) and refuses a non-local `DATABASE_URL` or an `APP_URL` that isn't
`http://localhost:<PORT>`. Stop any `pnpm dev`/`pnpm start` on those ports first. In the
`/home/user/SA-launch` worktree use `PORT=3300` (fakes 3301, database `squared_away_launch`).

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
- If Google's granular consent returns fewer than both Gmail scopes (`gmail.readonly` +
  `gmail.compose`), we revoke and save nothing. A grant with more than we asked for (an older
  connection's `gmail.send`, which `include_granted_scopes=true` brings back) is accepted.
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
  (prod+preview share it until the `sa-preview` split; see "Davi's decisions, 2026-10-14").
  Migration 0000 applied 2026-09-28.
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
- **Fonts are self-hosted via `next/font/local` (2026-10-15)**, because CI builds failed when
  Google Fonts was unreachable (Next's Google loader downloads at build time). `src/app/_fonts/`
  holds Google's own latin files (Inter Tight variable, Instrument Serif Italic; byte-identical to
  what the loader served) with their OFL 1.1 texts and a README. Inter Tight keeps Google's three
  single-weight faces (400/600/900 on the one variable file), so 500 still renders 400 and 700/800
  render 900 — exactly as before; a "100 900" range would be a visible design change. Family names
  are the JS variable names (`interTight`, `instrumentSerif`; Turbopack ignores a `font-family`
  declaration), the CSS variables are unchanged. Fallback metrics come from `adjustFontFallback`
  (Arial / Times New Roman), slightly different from Google's precomputed ones. Latin only: other
  scripts use the fallback. `tests/unit/fonts.test.ts` forbids the Google loader anywhere in `src`.
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
  (setup call done) **and** setup really paid (`setupReallyPaid`, 2026-10-14: an unpaid active
  account's countdown could never send; `runAutopilotSend` also stands down when `!canSend`
  instead of letting `sendDraft` throw); (2) category: owner switched it on (`rules` table, mode draft|autopilot) and it
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
  only if the setup wasn't really paid (`setupReallyPaid`; a date alone doesn't count); one live subscription per workspace; Stripe's Billing Portal for
  card/plan/cancel. Prices are found-or-created by lookup key `sa_<plan>_<cents>_month` /
  `sa_setup_<cents>` (amount in the key → config change = new price). **Only the signed webhook**
  (`/api/stripe/webhook`) changes status: paid checkout → setup_paid (active if the setup call was
  already done); past_due/unpaid → past_due; recovered → back; canceled → canceled (subscription id
  cleared, re-checkout allowed without the setup fee). Paused and trial accounts are never moved by
  Stripe. Events are idempotent via `stripe_events` (row deleted on handler error so Stripe retries).
  Events whose `livemode` doesn't match the key's mode are answered 200 and ignored
  (`eventFromOtherMode`, 2026-10-14), so test renewals can't undo "Reset test payments" before
  Connect Stripe swaps the stored secret.
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
  (Davi, amendment 2): waitlist rows (may hold a Growth call request; /admin's waitlist card reads
  the invite list, not only `waitlist.invited_at`, so a deleted owner's card offers "Invite … again"
  instead of a stale "Invited" — `waitlistInviteState`, matched with the sign-in gate's own
  `inviteForEmails`); also referral_credits (salted
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
    on only for "1"/"true"/"on"; the code default stays off). **On since 2026-10-14** (Davi): `1`
    in Vercel on Production and Preview, live from the next deploy (the launch merge). Offer on Quotes after 2 sent
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
- **#47 referrals (built 2026-10-12; reward = offer A since 2026-10-15/16, behind
  `FEATURE_REFERRALS`, off):** `src/server/referrals.ts`, rules in `referral-rules.ts`. Migration
  0026: `workspaces.referral_code` / `referred_by_workspace_id`, `waitlist.referral_code`,
  `invites.referred_by_workspace_id`, `referral_credits` (unique `(referred_email_sha256, side)`;
  workspace FKs ON DELETE SET NULL). Migration **0028** (additive): reward columns on
  `referral_credits` (`reward`, `stripe_mode`, `skip_reason`, Stripe ids, `attached_at`,
  `invoice_final_at`, `claimed_at` lease, `plan_change_seq`, `paid_plan/price_id/price_cents`,
  `free_plan`, `starts_at/ends_at`, `kept_at/kept_price_cents`, `ended_at`, `billing_mode`,
  `admin_flag/flagged_at`; partial unique indexes: one `scheduled` and one `running` per
  workspace), `workspaces.free_plan/free_plan_until/stripe_cancel_at`, `mailboxes.paused_reason`.
  Path: `/?ref=<code>` → waitlist (hidden field) → `inviteFromWaitlist` → first sign-in copies it
  (used once). Settled **once ever** when the referred account is first `active` with
  `setup_paid_via = 'stripe'`: one `pending` row (`free_month_up`, tagged with the key's
  `stripe_mode`) + Activity, or one `skipped` row (off / self / same_domain / house). Salted email
  fingerprint survives deletion. `REFERRAL_REWARD = "free_month_one_plan_up"` in `pricing.ts`;
  `referralsVisible()` = flag on and a reward set (the cash credit and its constants are gone).
  - **Mechanism:** a one-time 100%-off coupon `sa_ref_<row id>` on the referrer's live
    subscription (discounts-only updates that pass back other discounts, per-attempt idempotency
    keys, a fresh `subscriptions.retrieve(..., {expand: ["discounts"]})` decides every outcome).
    Stripe keeps billing their own plan; the renewal invoice that used the coupon starts the month
    from its **plan line** (paid plan + exact price, `free_plan = planAbove`). `effectivePlan()`
    (pure, time-bounded) is what features read: inbox limits, autopilot layer 1, Settings, /admin.
    One at a time with a paid month between (Davi Q1); attaches only while the account is on, not
    while the portal schedules downgrades, never across Stripe modes. Ends on whichever comes
    first, our clock or Stripe's renewal; `done` + `autopilotPlanEffects` + `inboxLimitEffects` +
    Activity in one transaction. The webhook reads the live subscription on every event
    (`applyLiveSubscription`: status, plan, `stripe_cancel_at`, plan effects; Q2: a move down a
    plan on Stripe's page pauses extra inboxes, newest-created first) and then reconciles rewards
    without ever failing. Sweep: `runReferralRewards` (15-min job step `referral-rewards`); a
    running month always ends even with the flag off. Backstop: positive prorations for free days
    are deleted (`invoiceItems.del`).
  - **Keep / Go back** (`keepFreePlan` / `goBackToPaidPlan`, actions in `billing/actions.ts`):
    the only code that changes a subscription's price (static test
    `referral-guardrails.test.ts`). Keep: the owner confirms plan + today's config price (inline
    confirm names price, tax, delta, first charge date); Go back restores exactly
    `paid_price_id`. Claim → per-tap key `referral-plan-<id>-v<seq>` → fresh-read verify; refused
    within 1h of the end, after Stripe renewed, while set to end or with a schedule.
  - **Q3 (yes):** while a month runs, Manage billing uses `ensureNoPlanChangePortal()` (the
    default portal settings copied with plan changes and the login page off; cached per mode in
    `app_settings` `stripe_portal_no_plan_change:<mode>`, rebuilt when the default's `updated`
    moves, recreated on `resource_missing`; any failure falls back to the default page).
  - **Paused inboxes** (`paused_reason = 'over_plan'`): Send → `inbox_paused` before Gmail; out
    of `queueMembership` (one queue line instead); Settings shows why + "Switch this one on
    instead" (`swapPausedInbox`); a reconnect at the limit is refused; room on the plan resumes
    them oldest-first.
  - **UI:** Plan & billing (billed plan stays the heading + free line, "Your free month" with
    Keep / Go back, share card + status line), a bordered banner card on every screen (second card
    under "Setup's paid"; "what changes" from 3 days before the end), Settings notes, Activity
    lines (`referralActivityLine`, owner's time zone), /admin "Free months" lines + flags + plan
    stat + Payments lines (downgrade schedules, login page), `/admin/costs` "free month" tag.
    Page loads never call Stripe for this (except /admin Payments' short portal read).
  - **Reset test payments** deletes `stripe_mode = 'test'` rows (a running one stops with its
    effects) and the test portal cache — only rows whose referred account no longer stands as
    paid through Stripe (one the reset couldn't check keeps its row, so the sweep never settles
    it again on the live key); **account deletion** clears the rows' Stripe ids.
  - **Review fixes (2026-10-16):** migration **0029** `referral_credits.after_end_checked_at`: the
    Stripe follow-up after `done` (strip a lingering coupon, sweep or flag free-day charges, flag
    `second_month_given` when the next renewal used our coupon too) is retried by every sweep
    (flag on or off) until it fully goes through. A running month whose invoice is still a draft
    has our coupon taken off from 24h before the end (`STRIP_BEFORE_END_MS`; flag
    `free_invoice_lost_discount` if the draft loses its discount — unchecked live). A renewal
    that skipped our coupon while it stayed on keeps the row **scheduled** for the renewal after
    (so account-off detach and use detection still apply); a booked coupon on an old, still-live
    subscription comes off before the row waits again. `applyCheckoutCompleted` runs the plan
    effects with its plan write (Q2 pause no longer depends on webhook order). A paused inbox
    that lost Google access resumes as `reconnect_needed` (`resumedInboxStatus`). Activity's
    `send_stopped` / `inbox_paused` line never says "back in your queue". /admin Payments shows
    a positive "changes plans straight away" line or "Couldn't check…" (never silence). Plan &
    billing says what moving down pauses (`downgradePausesLine`). Flags: neutral
    `plan_changed_in_free_month`, separate `free_day_charges_removed`.
  - Answers (Davi 2026-10-16): Q4 free Company includes priority support; Q5 waiting months never
    expire; Q6 refunds don't claw back; Q7 no reminder email. Terms/privacy lines wait in
    docs/SETUP.md §6d. The local Stripe Test Clock check (§6d step 4) has **not** been run.
  - Test seams: `setReferralConfigForTests({ reward })`, `tests/support/fake-stripe.ts` (typed on
    stripe@23, idempotency like Stripe, renew / portalChange / clock).
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
  in the trades. `/growth` (public, static, charcoal edge to edge; no switch, no `data-sa-half`, no
  theme attribute) and the second half of `/`: `<div data-sa-half="app">` (hero … waitlist, then
  `GrowthBridge`, `growth-bridge.tsx`, the paper hinge, no id) and
  `<div class="sa-inverted" data-growth-chapter data-sa-half="growth">` (sticky chapter bar, then
  the opener, which carries `#growth` via `openerId` + `scroll-mt-18`, … Book a free call). All copy in
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
  - **Scroll switch (2026-10-13, Davi: "it's not a tap, they're just scrolling down… it switches,
    boom, to the one-on-one"):** replaces the old CSS scroll-timeline wipe (`GrowthWipe`, `.sa-flip`,
    and the e2e that asserted `animation-timeline` are gone; don't bring them back). `GrowthSwitch`
    (`growth-switch.tsx`, mounted once on `/`, last child) sets `<html data-sa-theme="app|growth">`
    in an effect only (absent without JS, removed on unmount) and `data-sa-switching="in|in-quiet|out"`
    while a transition plays. Two IntersectionObservers on the Growth wrapper (`rootMarginFor`:
    −15% / 0% bottom), no scroll listeners; `nextMode` (`switch-rules.ts`, pure): growth at top ≤
    0.85·vh (the chapter bar just came up: the opener is never readable on paper first), app at ≥
    1.0·vh (back off the bottom edge), else unchanged (hysteresis band, no strobing). Each reading
    is decided against the height **its observer measured** (`rootHeight`, from the entry's
    `rootBounds.bottom` and its line), never `innerHeight` (phone toolbars / pinch zoom make them
    differ, which could strand a reading in the band). Instant (no show) until both observers reported + load + 2 rAFs +
    `SETTLE_MS` 500, and afterwards only for real navigation: a `#` link click, `hashchange`,
    `popstate`, keyboard focus moving into Growth (capture `focusin` inside the wrapper while on the
    app side, last input a key, not a pointer: Tab from the waitlist must not hide the focused link
    under the cover) (readings for `NAV_MS` 1000 after it are instant and band-free via `jumpMode`, line
    at 0.925·vh; a short passive scroll listener covers a landing that crosses no line), bfcache
    `pageshow` (also `jumpMode`), a hidden tab or reduced motion (live matchMedia). No distance-
    based jump rule (a fast flick across both lines must still play the show).
  - **The show is "Big words", and it replays (Davi, 2026-10-14: picked look 4 of the five
    `?look=` previews, and "after one time the animation … doesn't do it ever again … I wanted
    to see the animation more").** The preview chooser (`?look=`, `data-sa-look`, the light
    switch / curtains / tide / blinds looks) and the old flood-and-pill cover are gone; don't
    bring them back. `big-words.tsx` draws it, `big-words-rules.ts` is its clock (mirrored in
    theme.css, comment and declarations unit-checked in `tests/unit/growth-big-words.test.ts`),
    `switch-rules.ts` decides: `switchPath(next, instant, queued)` and `tapPlaysShow(...)` (pure,
    unit-tested). **Every** crossing from the app into Growth plays the full show ("in"), however
    many times it has played (no once-per-page memory anywhere; a unit test greps for one); the
    way back up is always the quiet "out". **Every** pointer tap on a `#growth` link (hero,
    header) while on the app side, settled and not mid-transition plays it too: default and
    Next's Link are stopped, the show plays, and under full cover `pushState(null, "", "#growth")`
    adds the entry the link would have (pushed **before** the page moves, so Back returns to where
    the tap was), or nothing when the address already ends in `#growth` (the link and Next would
    only replace it, so repeated taps don't stack copies). Keyboard activation keeps the native
    jump. A `#growth` click that isn't the show while the address already ends in `#growth` (in
    Growth, keyboard, mid-wipe) is scrolled to the opener by GrowthSwitch itself, because Next's
    Link doesn't move the page for the address it's already on (e2e caught it).
    Full show ("in"): five charcoal bands slam in from alternate sides (240 ms each, the middle
    band first, the outer two from 80 ms, full cover at 320) with "The app" in huge serif in the
    middle band; the theme swaps at `BW_THEME_AT_MS` 380 under full cover **and the page moves to
    the opener** (`#growth`, `scrollIntoView` instant; again at `BW_REALIGN_AT_MS` 1220 in case a
    fling's momentum carried on), so every full show lands on the one-on-one opener with its
    `.sa-land` headline on screen, however fast or slow the scroll (review 2026-10-13: a flick went
    3000px past the opener under the cover, and a slow scroll lifted the cover onto the bridge with
    the opener below the fold); not when navigation (Back etc.) happened during the show. The
    words tick over to "One-on-one" in huge heavy sans (240 ms from 440), which inverts at 680
    (1 ms flip), holds 620 ms, then the bands fly back out the way they came, outer ones first,
    from 1300 (all gone by 1540); `.sa-land` delays 960 / 1020 ms after the swap; cleanup at
    `BW_DONE_MS` 1740 re-applies the theme then drops the attribute. Each band reaches 1px into
    the next (no paper hairline); transforms and 1 ms opacity flips only, no clip-path.
    While it covers the screen, taps are swallowed (capture-phase click / pointerup / mousedown
    on the document, added in `play()`, removed in `finish()` and cleanup), so nothing hidden under
    it (tel: link, form) can be hit, and the page is held still (non-passive wheel / touchmove
    `preventDefault`, and PageUp/Down, Space, arrows, Home/End unless typed in a field). One show
    at a time: decisions during a show or wipe queue as `pending` and play quietly at cleanup
    (`queued` → "in-quiet" / "out"), or instantly when they came from navigation
    (`pendingInstant`); every timer and hold ends in `finish()` before the next can start. Every
    path ("in", "in-quiet", "out") forces a style flush of the stage before setting
    `data-sa-switching` (`getBoundingClientRect` in `play()`, with the attribute absent, so the
    stage computes display none and drops the old animations). A queued path starts in the same
    task the last one ended, and all of them run `sa-bw-out-*`, so without the flush the browser
    keeps the finished animations and the bands stay off-screen: a bare colour cut (review
    2026-10-14; e2e checks a band is on screen during a queued "in-quiet" and a queued "out").
    Quiet paths ("out", and "in-quiet" for a queued way down): bands of the old colour fly apart
    sideways, no words, never fades (`BW_QUIET_MS` 260, cleanup `BW_QUIET_DONE_MS` 300). The stage
    is 100vh. There is **no interactive switch**: the stage is aria-hidden, inert, pointer-events
    none, display none unless switching (and in print / reduced motion).
  - theme.css: the seven colours are written once as `--sa-k-*` constants and the palette points at
    them. `:root[data-sa-theme="growth"]` swaps the palette in place (paper↔charcoal, offwhite↔graphite,
    stone→graphite, slate↔ash, `--input` ash), so the whole site (header, body, cards, AboutDavi,
    the waitlist form) flips with no per-component code; `.sa-inverted` / `.sa-light` get the
    canonical seven plus popover/secondary/accent/destructive back (growth-scoped restore). In app
    mode `[data-sa-half="growth"]` is mapped the other way (paper with charcoal text) so nothing
    dark shows before the switch; its `.sa-light` gets the canonical seven. Every rule is scoped by
    `data-sa-theme`, so nothing changes off `/`.
    `tests/unit/growth-switch.test.ts` guards this and bans literal colours in page.tsx, marketing
    components and the footer (QueuePreview's shadow is allow-listed).
  - **Merged into claude/launch-integration (2026-10-14):** sunlight mode (#37,
    `:root:has([data-contrast="high"])`) used to write literal hexes onto `--sa-*`; they are now
    constants on `:root` too (`--sa-k-hc-charcoal` #111111, `--sa-k-hc-offwhite` #fffef9,
    `--sa-k-hc-black` #000000), the sunlight block points at them, and the "each colour written
    once" test lists them. The two never meet at runtime (`data-contrast` is only on the signed-in
    app's wrapper and `/` redirects signed-in owners to /queue; `data-sa-theme` exists only on
    `/`). The old `.sa-flip` / `view-timeline` block is gone from the launch branch too.
  - AboutDavi stays in the app part. Its old "a working builder." / "He built…" wording broke the
    site's no-"builder" / no-pronouns-for-Davi rule, so on 2026-10-15 (before the production merge)
    it became "who's behind this, someone in the trades." / "It began as the tool for A&C
    Construction's own inbox." (`tests/unit/about-davi.test.ts` guards it like the Growth copy).
    LAUNCH.md step 13 tells Davi and asks if he wants other words.
  - The homepage chapter bar is opaque charcoal and stays pinned to the end of the page (the footer
    is shorter than the screen), so the site header (charcoal by then, after the switch) never
    comes back. Intended.
  - /admin → "Waitlist and Growth calls": chips, the request, Call link, growth-only explanation.
  - Homepage trial FAQ / "Our promise" wording left as on PR #9 (awaiting Davi's review there).
    M11 S5 later changed the trial and deletion wording (see "M11 legal drafts").
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
  (#37) and the Growth switch / `.sa-light` / `/growth` background side by side (the flip was
  replaced by the scroll switch, merged 2026-10-14; see "Merged into claude/launch-integration").
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
  must-404 screens; C3 every route handler in a table with its guard, a new route fails, and no
  `src/pages`, root `app/` or root `pages/` may exist (the table covers src/app only); C4 every
  navigation sink — server: `redirect` / `permanentRedirect` (also renamed), any `.redirect(…)`,
  Auth.js `redirectTo`, a Location header in any case (object key, string / computed key,
  shorthand, `[name, value]` pair, `new Headers(…)`, `.set` / `.append`; outside a `headers:`
  value or `new Headers(…)` a plain string literal is let through, e.g. site.ts's place name);
  client: `push` / `replace` on a `useRouter()` router (or one named `router`),
  `location.assign` / `.replace`, `window.open`, and assigning `location` / `window.location` /
  `document.location` or their `href` / `host` / `hostname` / `protocol` — takes a visible own
  path (`"/x…"`, a template or concat starting `/x`, our imported `appUrl` of one, a `const` /
  helper / non-exported top-level helper parameter whose every call passes one and that is never
  written to), else it must be in the reviewed list (Stripe URLs, Google consent, the profile
  `returnTo` enum); names are resolved with TypeScript's binder (`bindFiles` in
  `tests/support/source-ast.ts`), so a for-of / catch / hoisted `var` / inner helper of the same
  name can't borrow an outer const's verdict; plus the old redirect-target param-name check). Not
  covered: link `href`s and a computed key held in a variable. The scans read
  .js/.jsx/.mjs/.cjs as well as TS (`allowJs`; Next serves JS routes), and src/app must hold no JS
  file (M11 review findings 3–4). Also
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
  (refunds, liability cap, governing law and venue); "plus any taxes" (settled 2026-10-14: Stripe
  Tax, below); a lawyer's review of both drafts; the #47 referral-fingerprint line before
  `FEATURE_REFERRALS` goes on; how to honour a waitlist / Growth removal request (the policy says
  "ask us and we'll delete it", and there is no admin tool — done by hand in the database).
- **Milestone 11 summary (2026-10-13, branch `claude/launch-integration`, not deployed):**
  - **e2e seams (S1/S2):** `src/config/e2e.ts` is the only reader of `SA_E2E*`. `e2eMode()` is on
    only when `SA_E2E === "1"`, `VERCEL`/`VERCEL_ENV` are unset, both `SA_E2E_GOOGLE_BASE_URL` and
    `SA_E2E_ANTHROPIC_BASE_URL` are set with an http(s) hostname of exactly localhost / 127.0.0.1
    / [::1], and `DATABASE_URL` is loopback or a unix socket (`isLocalDatabaseUrl`, read the way
    postgres.js reads it: a comma, a second `@` or a `#` in the raw host part is refused, since
    postgres.js cuts at the first `@`; `PGHOST` checked when it names no host). Otherwise
    `googleEndpoints()` / Anthropic options are the real ones and `e2eHookSecret()` is null.
    `/api/test-hooks/run` (POST; backfill, sync, voice, classify, draft, deliver through the
    same functions the jobs call) is 404 unless e2e mode and a ≥32-char secret (constant-time);
    errors return `err.name` only. No request-host check: under `next start`, request.url is
    the server's own listen hostname, so it could never refuse. Instead playwright.config.ts
    starts the app with `--hostname localhost` (an e2e spec proves the network addresses are
    refused). Smoke runs (`PLAYWRIGHT_BASE_URL`) open no database: the global setup returns
    first and only `tests/e2e/smoke-specs.ts` run (smoke + `security-public.spec.ts`: headers and
    the hook's 404, Playwright-only imports); `tests/e2e/support.ts` throws at import on a
    non-local `DATABASE_URL` (`tests/unit/e2e-harness.test.ts`). Fakes in
    `tests/e2e/fakes` (loopback only, record no secrets, Gmail-faithful drafts/history).
    `tests/e2e/full-flow.spec.ts` is the whole owner journey (paid: connect → backfill → voice →
    classify → draft → sync → Send reply → exactly one threaded `drafts/send` → Delete my account
    → one revoke, no rows; trial: 403 + practice copy to self only), and its steps map to the
    demo-video script in `docs/google-verification.md` (tested).
  - **Purge and deletion (S3):** see the M11 notes under the retention purge and Delete my account
    above (draft flags, extracted free text, cleared send timers; invite + cost/email markers in
    one transaction; waitlist kept). `tests/unit/data-lifecycle.test.ts` is the gate.
  - **Security (S4):** see "M11 security audit" above (HSTS, `poll` / `gmailWrite` limits,
    `sendPush` allow-list re-check, Origin parsing → 403, read-only gates as the UI behaves,
    Stripe error codes, static surface tests incl. C15: every Sentry path goes through
    `scrubEvent`; no "send a test error" button on purpose).
  - **Docs (S5–S7):** legal drafts (above); `docs/google-verification.md` + `docs/SETUP.md`
    (every env var the code reads, `tests/unit/env-docs.test.ts`; verification facts and the
    demo-script mapping, `tests/unit/verification-doc.test.ts`); **`docs/LAUNCH.md`**, Davi's
    plain-words launch checklist (Google verification first, merge, preview database, secret
    rotation, env per environment, domain, Resend, Stripe live, Sentry, VAPID, Twilio/Pub/Sub,
    Inngest check, smoke test, every open decision). `tests/unit/launch-doc.test.ts`: no
    secret-looking value in any doc (also CLAUDE.md, AGENTS.md, .env.example), links and anchors
    resolve, every setting SETUP.md marks required is in its table, and the screens, setting keys
    and job names it tells Davi to look for exist in the code. Keep LAUNCH.md in step with the
    code: a renamed screen line or job fails that test.
- **Stripe Tax (Davi, 2026-10-14: "turn on Stripe Tax"):** detect, don't configure. Davi
  activates Stripe Tax in Stripe's dashboard (origin address, registrations, default tax code);
  `stripeTaxActive()` (`src/server/billing.ts`) = `tax.settings.retrieve()` status `active`. No
  env var. `createCheckout` asks **first** (nothing is created in Stripe if it can't answer); a
  failure logs `stripe_tax_check_failed` {workspaceId, err.name, reason} and rethrows into the
  existing path (the action rethrows anything but `CheckoutNotAllowedError`) — never an untaxed checkout
  once tax might be on. Active → `automatic_tax: {enabled: true}`, `customer_update: {address:
"auto", name: "auto"}` (our customers are made without an address; note Checkout then saves
  the name typed there over the business name) and `billing_address_collection: "required"`;
  inactive → the session is exactly as before (tested by key set). Prices: new ones are
  `tax_behavior: "exclusive"` (tax on top, matching the terms' "plus any taxes");
  `ensurePrices({ fixTaxBehavior: true })` — **only from connectStripe** — sets found prices with
  no / `unspecified` tax behavior to exclusive (the one change Stripe allows) and never touches
  inclusive/exclusive ones. So Davi taps Connect Stripe again **before** Stripe's tax settings
  (LAUNCH.md 7e; it works whether or not tax is on, so no checkout runs with tax on and an
  unspecified price). A newly created portal configuration also allows `customer_update`
  `["address"]`; an existing one is left alone (docs tell Davi to tick Billing address).
  `/admin` Payments: `salesTaxStatus()` (5 s timeout, no retries, never throws; null without
  Stripe) → `SALES_TAX_LINES` in `billing-rules.ts` ("Sales tax: on (Stripe Tax is set up)." /
  "off. Set up Stripe Tax in Stripe to charge it." / "couldn't check."), plus `SALES_TAX_ON_NOTE`
  under "on": Stripe's status turns `active` once the head-office address is saved — it only
  means Stripe can calculate tax, and it charges tax only where a registration exists. So 7e's
  "worked when" is "on" **and** Stripe → Tax → Registrations listing each state. Owner copy:
  `SALES_TAX_NOTE` "Plus sales tax where it applies." under the plan cards on the homepage and
  /billing (static: true whether or not tax is on). Privacy policy: Stripe's checkout may ask
  for the billing address; we don't store it (tested; no address column); Stripe saves it and
  the typed name on its customer record, which account deletion leaves at Stripe (the "Delete my
  account" bullet says so; tested against `customer_update` in billing.ts). Subscriptions made
  before Stripe Tax was active keep running untaxed until changed in Stripe.
  **Stripe error logs:** stripe-node 23's `StripeError` never sets `name` (always "Error"); the
  class is in `type`. Log `reason: stripeErrorReason(err)` (`stripe-error-rules.ts`, fixed codes)
  next to `err.name`, and build test errors with `new Stripe.errors.<Class>(...)`, never a
  hand-set `err.name`.
- **Reset test payments (Davi, 2026-10-14):** /admin → Payments, **live key only**
  (`stripeKeyMode` in `billing-rules.ts`: `sk_live_` / `rk_live_`; `stripeMode()` in billing.ts,
  also what Connect Stripe's LIVE/TEST notice reads). Test key → the card says "Reset test
  payments shows up after you switch Stripe to live mode." and both actions refuse
  (`StripeNotLiveError`) before any Stripe call. `src/server/test-payments.ts`, rules in
  `test-payment-rules.ts`. Candidates = any Stripe id or `setup_paid_via = 'stripe'`;
  `customers.retrieve` / `subscriptions.retrieve` with the live key: `resource_missing` = test
  id, an answer (a `{deleted: true}` customer too) = live, anything else = "couldn't check" (the
  account is left whole). Reset = the 2026-10-10 precedent: clear the test ids; `setup_paid_via`
  'stripe' → null unless a live customer or subscription is left (a 'stripe' setup with no ids
  counts as test); `setup_paid_at` is **kept**, like the precedent's hand-marked accounts
  (review fix: clearing it made Resume send a paused reset account to evaluation_expired);
  house keeps house; setup_paid / active stay (can't
  send, setup fee at checkout); past_due → `restored()` (a test subscription can't be paid);
  other statuses and the plan unchanged. One transaction per account with a conditional UPDATE on
  the ids, `setup_paid_via`, status and setup-call nullness (a live checkout meanwhile is never
  overwritten; counted as couldn't check), `clearAutopilotCountdowns` (extracted from
  `setWorkspacePlan`), activity `test_payment_reset` (booleans; Activity shows "Your test payment
  was cleared — the setup fee is still due" only when the setup payment went; no "choose a
  plan", since a paused account can't). No Stripe
  call on a plain page load: **Check test payments** asks Stripe and keeps counts only in
  `app_settings` `stripe_test_payments` (`{found, unchecked, reset, at}`); the card shows "Test
  payments: N accounts still carry a test-mode payment." and, when N or M > 0, **Reset test
  payments** behind the details/confirm pattern ("Yes, reset test payments") → "Test payments
  reset for N accounts." (+ "Couldn't check M accounts. Tap again."). Afterwards: admin card
  (Setup paid: Not yet, it reads `setup_paid_via`), checkout (fee included; a real payment now
  records its own `setup_paid_at` unless one was already really paid), `resumeTarget` (unchanged:
  a paused reset account resumes to setup_paid / active, still unable to send), house move (keeps
  any date), `/billing` (`billingStatusLine`: "Sending turns on once your setup payment goes
  through." instead of "Setup's paid…" / "renews monthly"; the Stripe-page sentence only with a
  customer id), autopilot (locked: "Autopilot opens up once your setup payment goes through.";
  the owner's switches are kept). Referral settlement needs `setup_paid_via = 'stripe'`, so a
  reset account settles only after it really pays. `/admin/costs` still counts setup_paid/active
  as revenue (status-based). LAUNCH.md step 7 order (2026-10-15 review): 7a key swap, 7b Connect
  Stripe again **right away** (only `connectStripe` creates a webhook endpoint, so a live checkout
  paid before it never reaches the app and nothing can mark it paid; 7a–7c in one sitting), 7c
  Check / Reset test payments (order-independent: `eventFromOtherMode` drops test events before
  Connect, and they fail the live endpoint's signature after it). The past_due → `restored()`
  move leaves read-only without a payment (jobs and AI resume, still can't send):
  `PAST_DUE_RESET_NOTE` says so on the /admin confirm and in LAUNCH.md 7c, and step 13 asks Davi
  whether that's okay (keeping past_due read-only would be a small code change).
- **Davi's decisions, 2026-10-14** (all in `docs/LAUNCH.md`: the "Decided" and "Still open"
  parts of step 13; research with sources was gathered that day, facts marked unconfirmed are
  worded as such in the docs):
  - **Merge: okay.** The engineers open the pull request `claude/launch-integration` → `main`
    once CI and the preview are green; Davi presses Merge (the production deploy). Nobody else
    merges.
  - **Preview database: option B**, a separate, empty Neon project `sa-preview` in the same Neon
    organization and region as production, Postgres service only. Option A (Neon branch copies of
    production) is gone from LAUNCH.md step 2; the "how to split a setting" explanation, the
    shared-entry warnings, the branch-address sign-in notes and the optional preview Google
    client stay. Division of work: Davi creates the project, opens Connect with "Connection
    pooling" on, copies the pooled string (host contains `-pooler`) and tells the engineers; the
    engineers untick Preview on the existing `DATABASE_URL` entry through the Vercel API (a
    target-only edit; production's value is never sent or touched); Davi adds `DATABASE_URL` as a
    new **Secret** with only Preview ticked and pastes the string; the engineers add Preview-only
    `AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY` (fresh random values, same split) and redeploy the
    preview, whose `vercel-build` migrates the empty project (build log "Migrations applied.").
    Worked when: the preview's `/admin` shows "Accounts (1)" after Davi signs in at the branch
    address, and production's `/admin` is unchanged. Why not a second database in the production
    project: same host and compute (and, on Free, the same 100 CU-hours), and every role made in
    Neon's console joins `neon_superuser` (can read and write production). Background jobs need no
    change: every id a job event carries is a random UUID, so a stray preview event can't match a
    production row (previews are behind Vercel login anyway). **Not checked live:** Neon's console
    strings end `&channel_binding=require`, postgres.js 3.4.9 forwards unknown URL parameters as
    startup parameters and Neon's pooler accepts only a few; production's string (saved
    2026-09-28) works, so it's probably fine. If the first preview build fails with
    `Migration failed` mentioning `channel_binding` / an unsupported startup parameter, drop that
    parameter from the Preview value. `ANTHROPIC_API_KEY` and `AUTH_GOOGLE_SECRET` are still
    shared prod+preview Secrets (metadata checked 2026-10-14). Cost: $0 on Neon Free (own 100
    CU-hours, 1 GB); cents a month on Launch (estimate).
  - **Neon plan (new, urgent, Davi's money decision):** `poll-mailboxes` (every 5 min),
    `workspace-lifecycle` (15 min) and `morning-digest` (hourly) query the database, and Neon only
    suspends a compute after 5 idle minutes, so production rarely sleeps: about 180 CU-hours a
    30-day month at 0.25 CU (more if it autoscales) against Free's 100 per project, so on Free it
    would likely be suspended around day 16–17 of each billing period. Launch = $0.106/CU-hour,
    about $19–20 a month for that compute (estimate from Neon's prices). Production's plan isn't
    visible to the engineers. LAUNCH.md "Check your Neon plan now (this week)", before step 0.
  - **Test-mode Stripe accounts: reset them** with the built `/admin` → Payments → Reset test
    payments after the live key swap and Connect Stripe (LAUNCH.md 7c; see "Reset test
    payments" above).
  - **Sales tax: Stripe Tax on** (built; see "Stripe Tax" above). LAUNCH.md 7e is now the whole
    job: register with Massachusetts first on MassTaxConnect (Davi is in Concord; Stripe can't
    register an in-state seller; SSN for a sole owner with no employees, else EIN; free and about
    3–10 business days per third-party guides, not confirmed on mass.gov), then Stripe → Settings
    → Tax: head office = the Concord address, preset code `txcd_10103001` (SaaS - business use),
    Include tax in prices = Exclusive; the setup product `txcd_20120002` (SaaS Implementation and
    Setup Services - Mandatory) unless the accountant says otherwise; Tax → **Locations** → Add
    registration → Massachusetts → I've already registered. Stripe's docs call that page
    Locations (its URL ends `/tax/registrations`); `SALES_TAX_ON_NOTE` still says "Tax →
    Registrations" (not changed here; the docs bridge it). Without the Massachusetts
    registration Stripe charges $0 tax and warns about nothing (its threshold alerts never cover
    the home state). The portal section is "Billing information" (not "Customer information").
    Tax Basic = 0.5% of each taxed payment, no monthly fee, no filing: Davi files on
    MassTaxConnect from Stripe's report (state sets the frequency; each return due within 30 days
    after its period). Accountant questions are listed once, in 7e.
  - **Terms: still open** (Davi reads later). Recommended option A for each of the three
    `[To confirm]` items (refunds: cancel any time, no partial months, setup fee refundable only
    before the setup call, Delete my account ends the plan with no refund for the rest of the
    month; liability: mutual cap at the greater of $100 or 12 months' fees, carve-outs; law:
    Massachusetts, 30-day contact-first step, Middlesex County state courts or D. Mass., small
    claims allowed, no arbitration). New open question: assent. Stripe Checkout
    `consent_collection.terms_of_service = "required"` (terms URL in Stripe's public details) and
    an "I agree" checkbox at sign-in for trial users (Kauders v. Uber 2021, Good v. Uber 2024):
    code changes that need Davi's yes (yes on 2026-10-15, built: "I agree" boxes below). Lawyer review about $750–$2,500 (Boston Bar referral: 30
    minutes for $25 at most); questions on an LLC, insurance and "no contract". `docs/terms.md`
    wording is unchanged.
  - **Google review: both questions decided 2026-10-15** ((a) option B; (b) `gmail.send`
    dropped and built; both below).
    (a) Demo account: option A (house account with
    the demo Gmail swapped in, as google-verification.md describes) or **option B** (new: a
    separate demo account invited from `/admin`, paid with Stripe's test card while production
    Stripe is in test mode so `setup_paid_via = 'stripe'` lets it send; nothing of Davi's touched;
    delete it before step 7 or let Reset test payments clear it in 7c — the button only exists
    with the live key — after which it can't send, so a re-recording of a send needs option A or
    a real card; needs an engineer's dry run on **production** first with the demo Gmail while
    Stripe is in test mode). (b) Drop `gmail.send` (decided yes 2026-10-15, built; see "Gmail
    scopes: two" below): recommended yes (`users.drafts.send`
    accepts only mail.google.com / gmail.modify / gmail.compose; `users.messages.send` also takes
    gmail.compose; doesn't avoid CASA; small change, no reconnect since `mailboxes.scopes` is
    never read after connect; not tried live: checked on production with the demo Gmail right
    after it ships — the demo Gmail's old grant cleared first, then a practice copy, then a
    test-card payment and a real reply — and reverted at once if either fails). **A preview
    can't run either check** (2026-10-15 review): after the split no background job reaches a
    preview's database (Inngest only reaches production; previews sit behind Vercel login) and
    `STRIPE_SECRET_KEY` is Production-only, so a preview never syncs, drafts, takes a payment or
    delivers a queued send. CASA facts now in LAUNCH.md 0g and
    google-verification.md: AL1/AL2 chosen by Google, TAC Security $675/$855 (AL1) and $5,400
    (AL2), budget about $700–$1,000/yr (AL1) or $4,500–$5,400+ (AL2), don't pay until Google's
    email names the level, two quotes, 2–6 weeks lab, 1–3 months whole review, renews every 12
    months. The unverified app's 100-new-user cap is for the project's lifetime (can't be reset):
    keep sign-up invite-only.
  - **#47 referral reward: decided** (2026-10-15 offer A; answers 2026-10-16). Built behind
    the switch; see the #47 entry above.
  - **#26 closing question: on** (see Plan M7 above). The env var stays the switch; no code
    default change. The privacy policy ("How we use it"; dated October 15, 2026 with the terms)
    and google-verification.md (where email content goes, the notes bullet, the autopilot list)
    name it since the 2026-10-15 review.
  - **Growth:** Davi confirmed all seven services and the ground rules. Still open: a written
    agreement (Growth terms), a Settings link to `/growth`, an admin Remove button (waitlist /
    Growth removals are by hand today), and whether a Growth request may carry a referral.
  - **Homepage:** "Big words", replaying every time (scroll into Growth and every tap on a
    `#growth` link from the app side). Built on `claude/growth-page`, merged into this branch; the
    details are under "Squared Away Growth" above.
- **"I agree" boxes (Davi, 2026-10-15: "add those in"; branch `claude/squared-away-mvp-ddxl7s`,
  on top of PR #10):** Massachusetts' SJC enforces online terms only with clear notice and clear
  assent (Kauders v. Uber 2021); a checkbox plus a button with the terms linked was enough in Good
  v. Uber (2024).
  - `TERMS_VERSION` (`src/config/legal.ts`) = the terms' "Last updated" date as YYYY-MM-DD
    (`2026-10-15`); a unit test keeps it equal to both docs' dates. **Bump it with the docs**:
    everyone is asked again on their next screen. Migration 0027 (additive): `users.terms_accepted_at`
    / `users.terms_version` (latest acceptance only; no history). Goes with the user row on Delete
    my account (cascade). Rules in `src/server/terms-rules.ts` (pure), DB in `src/server/terms.ts`.
    **A newer version on record counts as agreed** (`hasCurrentTerms`: stored YYYY-MM-DD ≥
    TERMS_VERSION; anything not shaped like a date never counts), and `recordTermsAcceptance`
    never lowers a stored version (`collate "C" <=` in the UPDATE's WHERE): previews share the
    production DB and a Vercel rollback runs older code, so an exact match would flip owners back
    and forth between versions and show "we've updated our terms" when nothing changed.
  - **Sign-in:** `/signin` renders `TermsForm` (`src/components/app/terms-form.tsx`, client,
    `useActionState`): an unticked box (no `required`: the server is the gate) + Sign in with
    Google → `signInWithGoogleAction` (`src/app/signin/actions.ts`, public). Without
    `agree=yes` → plain error, focus moves to the box. With it → cookie `sa_terms_agreed` =
    TERMS_VERSION (httpOnly, SameSite=Lax, Secure in production, path `/api/auth`, 10 min) →
    `signIn("google")`. Auth.js's jwt callback (sign-in only) calls `takeSignInAgreement`: records
    the acceptance when the cookie names the current version, deletes it either way, never fails
    sign-in.
  - **Every signed-in screen:** `requireOwner()` / `requireAdmin()` (after the non-admin 404)
    redirect anyone without the current version to `/welcome/terms?next=<path>` ("one thing
    first, the fine print." first time; "we've updated our terms." after a bump; Agree and
    continue; then "Don't agree?" with the ways out). The page is
    `src/app/welcome/terms` (outside the (app) layout, whose nav would loop) and uses
    `requireSignedIn()` (signed in + workspace, no terms; only that page and its actions may use it,
    static test). `agreeToTermsAction` re-checks the box server-side and redirects to
    `safeNextPath(next)` (one leading `/`, then no `/` or backslash; no backslash, whitespace or
    control characters anywhere; same-origin by URL parse; never `/welcome/terms` or `/api`;
    ≤1000 chars; else `/queue`; both reads are reviewed exceptions in the C4 test). **Where they were going** comes from
    `src/proxy.ts` (Next 16's middleware): on the signed-in paths only (a test checks every
    `(app)` folder is in its matcher) it overwrites the request header `x-sa-request-path` with
    the path + query (minus `_rsc`); `requireOwner` reads it through `safeNextPath`. It checks
    and blocks nothing.
  - **API routes** that read the session (`/api/badge`, `/api/push/summary`,
    `/api/drafts/[id]/send`, `/api/gmail/callback`) answer **403** `TERMS_REQUIRED_API_MESSAGE`
    (never a redirect) right after the 401 check, before any limit, send or Google code exchange
    (C3 test). The badge leaves the icon as it is on 403; the service worker shows its generic
    line. Background jobs keep running for accounts that haven't agreed (the gate is on the
    person, not the mailbox).
  - **Leaving without agreeing (review fix, 2026-10-15):** the terms and privacy policy an owner
    already agreed to promise they can cancel, disconnect Gmail or delete their account any time,
    so `/welcome/terms` → "Don't agree?" offers **Manage billing** (Stripe's portal, only with a
    Stripe customer; `createPortal(workspace, "/welcome/terms")` returns there), **Disconnect
    Gmail** per mailbox, **Delete my account** (both with the same confirmations as Settings:
    `DeleteAccountButton` / `DisconnectButton` moved to `src/components/app/` and take the
    action as a prop) and Sign out. Their actions (`deleteAccountFromTermsAction`,
    `disconnectMailboxFromTermsAction`, `openPortalFromTermsAction` in
    `src/app/welcome/terms/actions.ts`) run the same server code as Settings' / Plan & billing's
    (same billing rate limit) but are guarded by `requireSignedIn` (requireOwner would loop
    them back), reviewed in `SIGNED_IN_ONLY` of the C1 test; they only end or remove things.
    The portal redirect is a reviewed C4 exception (Stripe's URL). Results come back as
    `/welcome/terms?done=disconnected` / `?error=delete_billing|busy|unknown`.
  - **Stripe Checkout:** `createCheckout` adds `consent_collection.terms_of_service = "required"`
    and `custom_text.terms_of_service_acceptance` ("I agree to the [Terms of Service](APP_URL/terms)
    and the [Privacy Policy](APP_URL/privacy)."). Stripe refuses that until a Terms of Service URL
    is saved in Dashboard → Settings → Business → Public details; its docs say so but don't print
    the error, so `isTermsUrlMissingError` (`stripe-error-rules.ts`) = a
    `StripeInvalidRequestError` whose `param` starts `consent_collection`, or whose message names
    the terms of service and a URL / public details (**not checked live**: no Stripe key in the
    sandbox). Then: `console.warn("stripe_terms_url_missing", { workspaceId })`, the same session
    again without the two keys, and `app_settings` `stripe_terms_box_off` (time) → /admin Payments
    shows `TERMS_BOX_OFF_LINE`; a later checkout with the box deletes it. Writing the note never
    fails a checkout. Any other Stripe error (or a refusal of the retry) goes up as before; no
    third try; no Stripe call on page load.
  - Docs: LAUNCH.md "Add your terms link in Stripe (right after step 1)" (test mode) and 7d (live
    mode), both with the admin line as the check. **Two merges:** PR #10 (`claude/launch-integration`)
    puts `/terms` and `/privacy` live (production 404s them until then); the boxes, the terms
    screen, Stripe's box and the /admin line ship only with the second merge of
    `claude/squared-away-mvp-ddxl7s` (LAUNCH.md step 1 says so); step 13 "Decided on 2026-10-15"; privacy policy: "When you
    agree to our terms" (time + version), the short-lived sign-in cookie, and retention (until
    Delete my account). `docs/terms.md` text unchanged; both docs stay dated October 15, 2026.
  - e2e: `signInAs(context, owner)` marks the user as agreed (current version) unless
    `{ agreedToTerms: false }`; `tests/e2e/terms.spec.ts` covers the sign-in box (error + focus,
    stays on /signin; with it, Google's routed consent and the cookie), the hold on
    /welcome/terms (screens redirect, `/api/badge` 403, agree → back to the screen), the
    "updated" wording, Sign out, Disconnect Gmail + Delete my account without agreeing, and a
    foreign `next`.
- **Google demo video: option B (Davi, 2026-10-15: "just do b"):** a separate demo account
  invited from `/admin`, paid with Stripe's test card while production Stripe is in test mode; an
  engineer's dry run on production first; delete it before step 7 or Reset test payments clears it
  in 7c. LAUNCH.md 0d / step 13 and google-verification.md updated (the demo script's sign-in step
  now ticks the box). Dropping `gmail.send` was still open then (decided yes later that day, see
  "Gmail scopes: two" below): Davi asked whether it is what keeps
  replies from going out by accident; answered in LAUNCH.md step 13 (no: the approval is the app's
  own Send reply rule; `gmail.compose` already sends approved replies; `gmail.send` only carries
  trial practice copies today).
- **Gmail scopes: two (Davi, 2026-10-15: "remove the gmail.send permission"):** Connect asks
  for exactly `gmail.readonly` + `gmail.compose` (`src/mailbox/gmail/scopes.ts`). Google's API
  reference (discovery doc revision 20261012, read 2026-10-15): `users.drafts.send` and
  `users.messages.send` both accept `gmail.compose`; `gmail.send` alone can't send a draft;
  `gmail.readonly` and `gmail.compose` are restricted (CASA still required). Owners who connected
  before keep their grant (it carries `gmail.send`, and `include_granted_scopes=true` brings it
  back on a reconnect): nothing reads `mailboxes.scopes` after connect, so they keep working and
  nobody reconnects. `missingScopes` only refuses a missing scope, never an extra one (unit tests
  in `gmail-connector.test.ts`; the callback in `gmail-connect-callback.test.ts`: either one
  unticked → revoke, no row, no trial clock; a reconnect leaves the saved row untouched).
  Copy uses Google's consent wording: "View your email messages and settings" (readonly),
  "Manage drafts and send emails" (compose); the `/connect` explainer adds that a reply still goes
  out only on **Send reply**, or by autopilot if the owner switches it on for a kind of email (the
  same promise as the privacy policy's compose row; the older "Send a reply only when you tap Send
  reply" bullet now says so too). The privacy policy says older connections may still show "Send
  email on your behalf" at Google until they disconnect. **The e2e Gmail fake enforces scopes**
  (`GMAIL_METHOD_SCOPES` in `tests/e2e/fakes/server.ts`, copied from the discovery doc): the
  token carries what the consent page allowed (`registerScenario(..., { untick, earlier })`),
  each call needs one accepted scope or gets Google's 403 `insufficientPermissions` (recorded as
  `insufficientScope`), a code needs a consent first, and a revoke ends the grant. full-flow
  asserts the consent asked for exactly the two, the token carried exactly those and nothing was
  refused, so the reply (`drafts.send`) and the practice copy (`messages.send`) are proven with
  the two scopes. Not yet tried live: checked on production right after it ships. **That live
  check clears the demo Gmail's old grant first** (2026-10-15 review): a grant given while we
  still asked for `gmail.send` keeps it, a reconnect brings it back, and `messages.send` accepts
  it, so the practice copy would pass without testing `gmail.compose`. Before the check: Disconnect
  Gmail on every account holding the demo Gmail (revokes at Google; removing it only at
  myaccount.google.com while an account is connected puts that account in `reconnect_needed`),
  confirm at myaccount.google.com/permissions that Squared Away has no Gmail access, reconnect,
  and confirm that mailbox's `mailboxes.scopes` has no `gmail.send`. The demo video's "Before
  recording" note repeats the clear-out (filming comes after the check).

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
- [ ] 11. Hardening and launch — built and tested on `claude/launch-integration`. Davi okayed the
      merge on 2026-10-14: the engineers open the pull request once it's green and Davi presses
      Merge (the production deploy). Then the steps in `docs/LAUNCH.md`.

## Waiting on Davi

- **The launch checklist is `docs/LAUNCH.md`** (in order, where to click, how to know it worked,
  and every open decision in its step 13, split into "Decided on 2026-10-15", "Decided on
  2026-10-14", "Still open" and "Still needed from you"). The items below are the same list in engineering words.
- **Neon plan (urgent, this week):** check Neon → Billing and production's Usage box; on Free the
  5-minute poll likely uses up the 100 CU-hours mid-period and pauses production. Launch is about
  $19–20 a month (LAUNCH.md "Check your Neon plan now"). His money decision.
- **Preview database (decided: option B):** Davi creates the Neon project `sa-preview`, copies
  its pooled string and tells the engineers; they untick Preview on the shared `DATABASE_URL`
  (Vercel API, target only); Davi adds `DATABASE_URL` as a Preview-only Secret with that string;
  the engineers add Preview-only `AUTH_SECRET` / `TOKEN_ENCRYPTION_KEY` and redeploy the preview
  (LAUNCH.md step 2). After the split a preview shows screens, sign-in and Connect Gmail only
  (no jobs, no Stripe). Only test Gmail addresses on previews: the Google client (and project)
  is shared with production, so a preview's Disconnect / Delete my account revoke most likely
  ends production's grant for that address. Vercel's docs don't say saving a Secret with an
  empty value box keeps it, so "How to split a setting" says Cancel and ask the engineers (API)
  if Save asks for a value. Every Neon step names `autumn-term-70302192` (not `sa-preview`; both
  have a `production` branch), with a header check before Reset password.
- **Massachusetts sales tax registration** on MassTaxConnect before any Stripe tax setup; then
  Stripe's tax settings and the Massachusetts registration in Stripe (LAUNCH.md 7e). Questions
  for his accountant are listed there. It takes about 3–10 business days, so LAUNCH.md has it
  start before step 0 ("Start your sales tax registration now"); step 7 says not to ask anyone
  to pay until 7e passes, and 7e lets him do the Stripe tax settings (items 2–4, 6) before the
  certificate arrives so later subscriptions carry automatic tax.
- **Gmail draft send behaviour (M8 review):** not yet checked live whether Gmail keeps a draft's
  id when it's sent. Counts-only check on the shared DB: join `drafts.sent_gmail_message_id` to
  `messages.gmail_message_id` and count the matches whose `label_ids` hold `SENT` vs `DRAFT`.
  Many DRAFT matches = same-id sends. The code is safe either way; this only says which path is
  live. **Run it before the launch merge** (`docs/LAUNCH.md` step 1): after it, the one-time
  `runDraftMessagesCleanup` (`markRecordedSends`) relabels every matched row DRAFT → SENT, so the
  count always reads 0 DRAFT.
- **Terms (open; Davi reads later):** the three `[To confirm]` items (recommended option A for
  each, in LAUNCH.md step 13); a lawyer's review of both legal drafts (questions: LLC, insurance,
  "no contract" wording). The assent question is decided and built (2026-10-15, "I agree" boxes
  above).
- **Stripe terms link (his, right after the launch merge):** Stripe → Settings → Business →
  Public details → Terms of service URL `https://<production address>/terms` and Privacy policy
  URL `.../privacy` (test mode right after PR #10 merges, since production 404s both pages until
  then; checked again in live mode at LAUNCH.md 7d). The checkout box and the /admin line
  ("Terms box at checkout: off. …") only exist once the second merge
  (`claude/squared-away-mvp-ddxl7s`) is deployed.
- **Google review:** (a) decided 2026-10-15: option B (separate demo account on Stripe's
  test card; needs an engineer's dry run on production first, while Stripe is in test mode — a
  preview can't sync, draft, pay or send); (b) decided 2026-10-15: `gmail.send` dropped (built,
  ships with the second merge). **His console step:** Google Auth Platform → Data Access → remove
  `gmail.send` before submitting (LAUNCH.md 0e). Engineers: right after it goes live, first clear
  the demo Gmail's old grant (Settings → Disconnect Gmail on every account holding it; then
  myaccount.google.com/permissions shows no Gmail access for Squared Away; reconnect; its
  `mailboxes.scopes` has no `gmail.send`), then a practice copy and a real reply (test card) on
  production with the demo Gmail, before filming; put it back at once if either fails. CASA:
  nothing to pay until Google's email names the level.
- **Homepage About section wording (changed 2026-10-15, ships with the merge):** now "someone in
  the trades." / "It began as the tool for A&C Construction's own inbox." (no "builder", no
  pronouns). Davi may want other words (LAUNCH.md step 13). Separate from his photo and license
  line.
- **Reset test payments and past_due (open):** as built, a past_due test account goes back to
  setup_paid / active (jobs and AI resume, can't send); alternative: keep it read-only until it
  pays (small code change). LAUNCH.md step 13.
- **Phone notifications (#36):** `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` (free) in Vercel
  Production, then redeploy. Off until then. The engineers can generate and add them if Davi says
  so.
- `ANTHROPIC_API_KEY` repo secret for the "Prompt evals" action (baseline still empty).
- Resend: verify the production domain in Resend and switch `EMAIL_FROM` off `onboarding@resend.dev`
  (until then the digest only reaches the Resend account's own address).
- Optional: Gmail instant notifications (docs/SETUP.md §6a) and Sentry error alerts (§6b).
- Rotate the Neon password and Google client secret that were pasted in chat; delete the old
  Google secret.
- Only while Google Auth Platform is in Testing: add each invited owner as a test user (Audience).
  Ends at docs/LAUNCH.md step 0c (In production).
- Icon pack (`sa.` monogram, stacked wordmark); his photo and the exact license wording for the
  homepage's About section (PR #9; no license number until he confirms); `SUPPORT_EMAIL`;
  production domain.
- **Plan #47 (referral free month, offer A):** decided and built behind `FEATURE_REFERRALS`
  (off). Nothing left to choose; turning it on follows docs/SETUP.md §6d in order: live key,
  Connect Stripe, Reset test payments; /admin Payments says the billing page "changes plans
  straight away" (not "schedules downgrades", not "Couldn't check"); the
  terms line, the privacy lines (fingerprint + "which plan, the dates, and whether you chose to
  keep it") with the legal-docs test and a terms-version bump; an engineer's **local** Stripe Test
  Clock check (not run yet: no Stripe key in the sandbox); then the switch. Don't rotate
  `AUTH_SECRET` once referrals have been given.
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
- **Terms and privacy lines for #47** (before `FEATURE_REFERRALS` goes on): held word for word
  in docs/SETUP.md §6d step 3. Also his call: a referrer who deletes their account before the new
  owner is active voids the referral; repeat waitlist joins and plain invites carry no referral.
- **Growth:** confirmed 2026-10-14: all seven services are offered today and the ground rules
  stand (no fake reviews, price before any work, Growth never touches the inbox). Still open: a
  written agreement (no Growth terms of service yet), a Settings link to /growth for signed-in
  owners, an admin Remove button (removing a waitlist entry or Growth request is done by hand in
  the database for now; the policy says call, text or email us), and whether a Growth request may
  ever carry a referral. No tracking pixels on /growth without a privacy-policy change and his
  okay. Only the newest Growth request per email is kept and a growth-only row's phone becomes the
  newest number, so anyone who knows a lead's email can replace their number: check an
  unfamiliar number before calling.

## Launch blockers to remember

- **Neon plan:** if production is on Neon Free, the 5-minute poll likely exhausts its 100
  CU-hours mid-period and Neon suspends the compute (the whole app stops until the next period).
  Davi checks Billing / Usage this week and decides on Launch (about $19–20 a month).
- Previews share the production database. Before real customers: give previews their own
  database so a preview can't touch customer data — `docs/LAUNCH.md` step 2, decided 2026-10-14:
  an empty Neon project `sa-preview` (Davi creates it and pastes the Preview `DATABASE_URL`; the
  engineers untick Preview on the shared entry via the Vercel API and add Preview-only
  `AUTH_SECRET` / `TOKEN_ENCRYPTION_KEY`). `DATABASE_URL`, `AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`
  and `AUTH_GOOGLE_*` are each ONE Vercel entry for Production + Preview: split them (untick
  Preview, Add New for Preview); deleting or editing the shared entry's value changes production.
- Google OAuth is still in **Testing** (7-day Gmail tokens, ≤100 hand-added users): switch to In
  production and submit verification + CASA — `docs/LAUNCH.md` step 0. Until approval the app
  has a lifetime cap of 100 new users (can't be reset): keep sign-up invite-only.
- Stripe live mode: test-mode customer ids / `setup_paid_via = 'stripe'` from test checkouts stay
  in the shared DB until Davi taps /admin → Payments → Reset test payments after the key swap and
  Connect Stripe (`docs/LAUNCH.md` step 7c; decided 2026-10-14). Key swap → Connect Stripe must
  be back to back (no live webhook in between).
- Sales tax: Stripe Tax charges **$0** until Davi is registered with Massachusetts and has added
  the registration in Stripe → Tax → Locations (`docs/LAUNCH.md` 7e). Stripe never warns about the
  home state.
- Terms assent: decided and built 2026-10-15 ("I agree" boxes at sign-in, on /welcome/terms and
  at Stripe Checkout), but live only after the **second merge** (`claude/squared-away-mvp-ddxl7s`,
  after PR #10); until then production's terms are only a footer link. A lawyer's review of both
  legal drafts is still due before launch.
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
  The window is open now: merge as soon as Davi has reviewed, then check `backfill:m7-v1` in
  `app_settings` (`docs/LAUNCH.md` step 1).
