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
(read-only) → `setup_paid` ($499 once; sending unblocked; setup call pending) → `active`
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
  `RETENTION_BODY_DAYS`; runs daily. Bodies capped at 20k chars.
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

- Resend: verify the production domain in Resend and switch `EMAIL_FROM` off `onboarding@resend.dev`
  (until then the digest only reaches the Resend account's own address).
- Optional: Gmail push via Pub/Sub (steps in docs/SETUP.md §6); polling works without it.
- Rotate the Neon password and Google client secret that were pasted in chat; delete the old
  Google secret.
- Add each invited owner as a Google Cloud test user (Google Auth Platform → Audience).
- Icon pack (`sa.` monogram, stacked wordmark); `docs/terms.md`, `docs/privacy-policy.md` drafts;
  `SUPPORT_EMAIL`; production domain.

## Launch blockers to remember

- Previews share the production database. Before real customers: give previews their own Neon
  branch (Neon's Vercel integration does this) so a preview can't touch customer data.
