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
                    workspace-lifecycle (DB transitions), admin (overview, invites),
                    reply-address-rules + reply-to-backfill (form leads), waitlist-emails,
                    source-rules (where sign-ups came from); *-rules.ts are pure
src/components/forms/  Field components + business profile / voice forms
src/lib/crypto.ts   AES-256-GCM for refresh tokens
src/config/         site.ts (business facts), models.ts, pricing.ts, retention.ts, nav.ts (tabs),
                    legal.ts (TERMS_VERSION)
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

## Working in parallel

Davi runs several builder sessions at once. The build order for review prompts is
`docs/BUILD-ORDER.md`.

1. Branch from the tip of `claude/squared-away-mvp-ddxl7s`; name the branch
   `claude/c<check>-p<prompt>-<slug>` when the prompt came from a review page; put "Check N PN" in
   the commit message.
2. First confirm the problem in the prompt still exists at the tip; if it's fixed, stop and say so.
3. Migrations: only one session adds migrations at a time. It holds the lane by assigning itself
   the pinned GitHub issue titled "Migration lane" (create it if missing, with `gh issue create`)
   and unassigns after its PR merges. Others don't run `pnpm db:generate` while the lane is taken.
   Write the schema change last: rebase on the tip, then `pnpm db:generate`, then push at once.
   Never renumber or edit a migration that has run on the shared database.
4. Shared files: `CLAUDE.md`, `docs/LAUNCH.md` and `docs/privacy-policy.md` are edited only by the
   session that merges branches (the integrator). Other builders write what those files need to
   say in `docs/notes/<branch>.md`; the integrator folds it in and deletes the note.
5. Open a draft pull request on the first push, titled with the check and prompt id.
6. Don't run two sessions whose prompts name the same file in their "area" line.

## Conventions

- Buttons name the action ("Send reply", never "Submit"); toast uses the same word ("Reply sent.").
- Two-tone only. No red/green/blue. Status = weight, position, charcoal/off-white inversion
  (`.sa-inverted`). All tokens in `src/styles/theme.css`.
- Every major heading uses `<Headline serif="…," heavy="….">`.
- Never log tokens, email bodies, or customer personal details. Log prompt version, model,
  tokens, latency only.
- Every gate (sending, plan limits, autopilot guardrails) is enforced server-side and has a test.
- A new send path needs Davi's okay and a new allowlist row in `tests/unit/security-surface.test.ts`
  ("Only two places can send mail": `sendDraft` in drafts.ts and `practiceSend` in practice.ts).
- Business facts from `src/config/site.ts`; `SUPPORT_EMAIL` and `APP_URL` from env, never hardcoded.
- Write tests with features. Guardrail tests are the product.

## Decisions

- **pnpm** as package manager (lockfile committed, CI uses `--frozen-lockfile`).
- **Next 16.3 / React 19.2 / Tailwind 4 / Zod 4** — latest stable at scaffold time.
- **Next 16.3.8** (and `eslint-config-next` 16.3.8), 2026-10-17 (Check 26 P1): clears the six
  `next` advisories for >=16.0.0 <16.3.8 in `pnpm audit --prod`. The only documented change between
  16.3.6 and 16.3.8 is the custom cache handler key format, which we don't use. The `braces`,
  `source-map-js` and MCP SDK advisories come through `shadcn` and `next`'s `postcss`; left for their
  own prompt.
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
  (Superseded: five tabs and Settings → Account, see "The app on a phone".)
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
- **Follow-ups (M7):** hourly cron `followup-scan` (:11); each owner's scan runs once a day at
  4am their time, due on the owner's calendar day (`nudgeDueDate`; Check 21 P3, wave 2 merge B;
  was daily 9:11am America/New_York). `threadsToFollowUp`
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
  nothing sends without a tap. The sent screen says "A nudge for Dana will be ready Monday
  morning if there's no reply." (Check 21 P3; was "I'll nudge Dana on Thursday…") / "That was
  the last nudge. I won't chase this one again." for chased categories.
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
    inverts to "Background jobs look stopped" when no working mailbox synced in 25 min
    (20 until wave 2 merge A).
  - Instant loading placeholders (`loading.tsx` → `ScreenSkeleton`) on queue, inbox, quotes,
    activity, settings only. **Never** on /admin or /customers/[key]: streaming turns `notFound()`
    into a 200, and those must 404 (e2e caught it).
  - Nav: bottom tab bar on phones, the same links in the header from `sm` up; `(app)` layout pads
    the bottom on phones. (Since 2026-10-16 five tabs: Queue · Inbox · Quotes · Money · More —
    see "The app on a phone".)
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
  can fix); stale sync (>30 min) says "We keep trying on our own, and your email is safe in Gmail"
  (round 2: "we're looking into it" wasn't true). Settings heading is "Your Gmail".
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
  workspace FKs ON DELETE SET NULL). Migration **0044_referral_free_month** (additive; written
  as 0028, renumbered to 0032 after round 2, to 0039 after `0038_growth` at the 2026-10-17
  merge and to 0044 after wave 1's `0043_fallback_calls` at the 2026-10-18 merge, regenerated by
  drizzle-kit each time with byte-identical SQL and journal `when` values after every earlier one
  so drizzle's migrator, which applies by timestamp, still runs it on the shared DB; `when`
  1792287535388): reward columns on
  `referral_credits` (`reward`, `stripe_mode`, `skip_reason`, Stripe ids, `attached_at`,
  `invoice_final_at`, `claimed_at` lease, `plan_change_seq`, `paid_plan/price_id/price_cents`,
  `free_plan`, `starts_at/ends_at`, `kept_at/kept_price_cents`, `ended_at`, `billing_mode`,
  `admin_flag/flagged_at`; partial unique indexes: one `scheduled` and one `running` per
  workspace), `workspaces.free_plan/free_plan_until/stripe_cancel_at`, `mailboxes.paused_reason`
  (unused since the 2026-10-17 merge, kept only so the migration stays byte-identical; a test in
  `referral-schema.test.ts` fails if any code uses it).
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
  - **Paused inboxes = the decisions package's plan pause** (since the 2026-10-17 merge; the
    branch's own `status = 'paused'` + `paused_reason`, `inboxLimitEffects`,
    `resumeOverPlanInboxes`, `swapPausedInbox`, `inbox_paused` and the queue's one-line count are
    gone). `fitMailboxesToPlan` (`mailbox-plan.ts`) reads the plan that counts (`effectivePlan`,
    so a running free month's plan covers more addresses), takes the caller's transaction, and
    runs inside every referral plan write (start, end, Keep / Go back, Stripe's billed plan, the
    test-reward reset) and the webhook's (`applyCheckoutCompleted` / `applyLiveSubscription`), so
    any subscription event fits the addresses, as the 15-minute `fit-mailboxes-to-plans` would.
    `swapPlanMailbox` and `mailboxLimit` use `effectivePlan` too; the paused card in Settings →
    Your Gmail adds plan #47's "Or move to Crew in Plan & billing." link (`pausedInboxCopy`);
    the swap action keeps the Gmail-connect rate limit. Activity describes `mailboxes_fit_plan` /
    `mailbox_plan_swap` (`referralActivityLine`) and a queued send stopped by `mailbox_paused`
    (never "back in your queue").
  - **UI:** Plan & billing (billed plan stays the heading + free line, "Your free month" with
    Keep / Go back, share card + status line), a bordered banner card on every screen (second card
    under "Setup's paid"; "what changes" from 3 days before the end), Settings notes (since the
    round 2 merge: Settings → Your Gmail holds the paused lines, the swap and the add-inbox note;
    Settings → Autopilot the free-month line; the list says "· N paused"), Activity
    lines (`referralActivityLine`, owner's time zone), /admin "Free months" lines + flags + plan
    stat + Payments lines (downgrade schedules, login page), `/admin/costs` "free month" tag.
    Page loads never call Stripe for this (except /admin Payments' short portal read).
  - **Reset test payments** deletes `stripe_mode = 'test'` rows (a running one stops with its
    effects) and the test portal cache — only rows whose referred account no longer stands as
    paid through Stripe (one the reset couldn't check keeps its row, so the sweep never settles
    it again on the live key); **account deletion** clears the rows' Stripe ids.
  - **Review fixes (2026-10-16):** migration **0045_referral_after_end_check** (was 0029, then
    0033, then 0040; `when` 1792287541302) `referral_credits.after_end_checked_at`: the
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
  - **The Growth door (Davi 2026-10-16: "a Growth request can earn a referral"; built
    2026-10-17):** `requestGrowthCall` keeps the form's `ref` on the waitlist row only while
    `referralsVisible()`, never replacing a code already there (the homepage passes it to
    `GrowthChapter` → `GrowthCallForm`; the static /growth page carries none). `startGrowth`
    (started / restarted) and `linkGrowthInvite` (linked) call `creditGrowthReferralSafely`
    (never fails Davi's move or the sign-in): `creditGrowthReferral` needs an **active**
    `growth_clients` row and resolves the waitlist row's code at that moment, then the shared
    `settleOnce` (also behind `creditReferralOnActive`): one `pending` free month (offer A, same
    pending/apply sweep) or one `skipped` row (off / self / same_domain / house), once ever per
    email fingerprint, whichever door is first — an app account and a Growth client for the same
    person never pay twice. Any code on the row counts (from the app form or a Growth request).
    `settleMissedReferrals` also settles active Growth clients with a code and no referral row
    (a failed hook, or a test-mode reward Reset test payments deleted). Settled by another
    (deleted) workspace → the waitlist row's code is cleared too. Growth's files may import only
    `creditGrowthReferralSafely` from `referrals` and `isReferralCode` / `referralsVisible` from
    `referral-rules` (`growth-boundary.test.ts`, which also checks the settle reads no inbox
    tables). /admin's "Came from a referral link" shows on Growth requests too. Tests:
    `tests/unit/growth-referrals.test.ts`.
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
  `referralsVisible()` (flag on AND a reward); a Growth request stores one too since 2026-10-17
  (see #47's Growth door); an app join that upgrades a growth-only row stores its code (if
  visible and none was kept) and takes the app
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
  and had never been on the thread's inbound mail before. Since 2026-10-16 (review B1) the
  customer's side also includes each inbound email's stored Reply-To (`involvedSql`), so an
  owner "Fwd:" to a form lead's own address answers them and their later reply isn't a crew
  reply. Still not a strict "To/Cc holds the customer" rule: rows outside the Reply-To backfill
  (older than 30 days / not inbox) have none stored, and a lead forwarded by a friend or
  property manager has the customer on no header. **Known gaps:** a plain "Re:" sent only to
  an outside address answers the lead; on a lead that arrived as a forward (a friend, an office
  or a property manager), the owner's forward to an outside crew counts as an answer.
  **Known limitation (A11):** `quote_requested_at` is sticky, so a returning customer asking for
  a new job on their old, already decided quote thread keeps the first request's time: the
  scorecard, the monthly count and the repeat-customer check miss the new request (no history of
  requests is kept). Re-stamping it when the outcome is decided would also need the outcome and
  Quotes' stage to move with it — not built.
  **A10 in every unit test:** `createTestDb` calls `refuseDateParams`
  (`tests/support/no-date-params.ts`), so PGlite refuses a JS `Date` bound into raw SQL as
  postgres.js does.
- **Website-form leads reach the customer (2026-10-16, outside review "Must fix", B1 + H7):**
  forms (Squarespace, Wix, WordPress, Jobber / Housecall Pro) email from a robot with the
  customer in Reply-To; drafts used to go to From ("Reply sent." to a robot). Migration 0028
  (additive): `messages.reply_to_header` jsonb — NULL = never read, `{}` = read / nothing usable
  (reply to From), `{address, name?}` = reply there. Chosen once at sync by `pickReplyTo`
  (`src/server/reply-address-rules.ts`, pure): well-formed, not any workspace mailbox nor its
  business domain (webmail exempt), not no-reply, **not a lead platform relay** (Thumbtack / Angi
  relays stay platform leads, `leadPlatformOf`), not From itself; first usable wins. Metadata
  reads ask for Reply-To; `MailMessage.headers.replyToRead` is true only when the request could
  return it, so a subset read stores NULL, never `{}`. ONE helper: `customerReplyAddress` /
  `customerReplyName` (TS) and `replyAddressSql` / `replyNameSql` / `messageReplyAddress` /
  `customerAddressSql` / `waitingReplySql` / `requestReplySql` (SQL twins, `thread-sql.ts`).
  **Reply address** = drafts (every kind), screen names (Queue, Inbox, Quotes, Money,
  Customers, Activity), customer grouping, known-customer / review eligibility, no-reply
  exclusions (leads at risk, scorecard, repeat customers), complaint memory (both addresses),
  first-time sender (new From OR new reply address) and VIP (either). **From** stays for
  identity: receipts (`isReceiptSender`, also on the reply address in Money), building
  departments, the monthly lead-source label, the classifier's "Sender:" line (no prompt change).
  Never in an alert, URL, push, SMS, digest, admin or log. Drafting a thread whose customer row
  is NULL reads Reply-To first (one metadata call, before any model call); 404 → `{}`; any other
  failure never falls back to From (jobs rethrow → `politely()`; the owner's tap gets
  `?error=gmail_busy` / `reply_to_unread`). A no-reply `to`: skipped for every trigger
  (`no_reply_address`; round 2 made the owner's tap skip too) and `sendDraft` / `queueSend`
  refuse it; `NO_REPLY_FLAG` stays only for older drafts (kept through tweaks). **Autopilot** checks `knownCustomer(draft.toAddress)` and refuses any
  draft whose To isn't the customer's From ("goes to a different address…") or whose customer
  row was never checked — a Reply-To never unlocks autopilot. H7: "To: address" on every draft
  card and the edit screen ("the reply address in their email" when redirected), on
  /queue/review rows and /record. One-shot job `reply-to-backfill` (own Inngest function, every
  15 min, concurrency 1, one step per mailbox; `app_settings` `backfill:reply-to-v1[:<mailbox>]`):
  inbound inbox mail of the last 30 days with NULL, newest first, Reply-To only, 2 at a time,
  100 / 20 s per mailbox per run; skips inactive / read-only / still-syncing mailboxes (no
  marker); 400/404 → `{}`. Pending drafts addressed to a robot whose form email now has a
  Reply-To are **re-pointed, not expired** (expiring would drop the lead from the Queue): Gmail
  draft rewritten first (same text; skipped if the owner changed it in Gmail — text or message
  id), then the row with `REPOINTED_FLAG` first and the countdown cleared; Activity
  `draft_repointed`. Replies sent in the last 30 days to a robot get one Activity line
  `reply_went_to_form` (links to its record). e2e: `tests/e2e/form-lead.spec.ts` (fake Gmail
  serves Reply-To; metadata reads return only the named headers).
- **Round 2 trust + trades (2026-10-16, branch `round2-fixes`; reviews "Trust Check" R2-A and
  "Trade Walkthrough" R2-B):** prompts `classify.v4`, `draft.v6`, `followup.v4`, `revise.v2`;
  eval set 109 cases (new metrics paymentChangeRecall / gasSmellRecall strict, billDirection,
  routinePaperwork). Migration 0030 (additive): trade enum `remodeling` (ADD VALUE),
  `workspaces.extra_trades` text[] (≤2, `cleanExtraTrades`).
  - **Attack guard** (`src/ai/guards.ts`): base64 only in space-free runs mixing case + digits,
    links stripped first; emoji joiners and flag tag sequences aren't "hidden"; Unicode tag
    characters are. New phrasings: "ignore the above", "dear AI assistant", "note for the
    automated system", "when drafting your response", "if an AI is reading", Spanish /
    Portuguese. Marks stick: `injection` / `payment_change` carry across re-sorts
    (`sticky`), every older unsorted email of the thread is checked in code (`alsoCheck`), and
    `createDraftForThread` re-checks every inbound email it would show the model (jobs only).
  - **Bursts (B4):** unsorted emails from the same sender ≤30 min before the newest (max 4) go to
    the model with it (`emailBlock.earlier`); older ones are marked classified only once their
    thread's newest is sorted, in the same write.
  - **Draft checks** (flags only, never rewrites): money in any form via `src/ai/money-words.ts`
    (1.2k, twelve hundred, a grand, ranges, /hr, bare "is 1500" = weak: also allowed if the number
    appears anywhere in the sources); loose timing (today, ASAP, in an hour, the 3rd, end of week,
    first thing, between 8 and 10); soft promises/admissions (`soft_promise`, cap 0.5, no
    regenerate); a % the owner never wrote (money); `customer_amount` (cap 0.5, no regenerate)
    when a draft repeats an amount only the customer named — needs `ownerSourceText` (owner
    emails + profile). The owner's spoken tweak (`ownerInstruction`): every number in it is
    theirs. `hasUnfilledGap` also blocks `[price]`, `[Customer Name]`, `$___`, `$X,XXX`.
    Autopilot's money test = `mentionsMoney`.
  - **Robots (A9):** no-reply pattern widened (token anywhere: voice-noreply, form-submission,
    wordpress, postmaster, bounces, automated, auto-reply); never drafted (any trigger), never
    sent, never a row on Customers.
  - **Payment change (A11):** code rule + model signal → needs you, priority high,
    `PAYMENT_CHANGE_REASON` ("Call them at a number you already have…"); no job draft, no
    batch, no autopilot. **Gas (TW B4):** rule + signal → high, needs you, `GAS_SMELL_REASON`;
    the draft job writes ONE fixed `safetyNote` (purpose `safety`, no model,
    `SAFETY_NOTE_FLAG` first) per thread; the owner taps Send like anything else.
  - **Autopilot (A10, stricter):** refuses any customer (sender or reply address) who
    complained or disputed in the last 12 months (`customerComplainedRecently`, same memory as
    review requests), and payment-change / gas threads.
  - **Claims (TW A1):** `signals.routine_paperwork`; the legal mark drops only when the model says
    paperwork AND `mentionsRealLegal` finds no lawyer / court / sue / lien-on-the-house / dispute
    word. No complaint mark then. **Money direction (TW A2):** `extracted.invoice_direction`;
    `extracted.bill_direction` (this email's, else the stored one) = `owed_by_business` keeps a
    thread off Money owed and out of follow-ups. **Towns (TW A5):** `looksMunicipal` adds
    `<town>.<st>.us`, inspectors of wires / plumbing & gas, fire prevention, boards of health,
    conservation / historic commissions, zoning / planning, "City of X via OpenGov", portal
    domains.
  - **Drafter's clock (A8):** `conversationBlock({ now, timeZone })` starts "Today is …" and
    stamps each email in the owner's zone. **Trades (TW A4, D1):** Remodeling trade + prompt +
    job kinds; extra trades merge words/questions (draft.v6), go to the sorter's business block
    and `jobKindsFor`. Keyword fixes: no bare "stain"/"heater"; roof replacement before gutters;
    "Snow and plowing" apart from "Cleanups" (old stored labels are recomputed).
  - **Outages (D4, D5, C6, C7):** a failed provider call (5xx, 429, 408, no connection) refunds
    its cap slot; a cap refusal never leaves the count above the cap. The 15-minute lifecycle job
    re-sorts mailboxes with mail unsorted 10+ minutes (`unsortedSweepMailboxes`, skips capped /
    read-only / inactive). `AssistantBanner` (every signed-in screen, counts only): limit used
    up (and when it restarts, owner's clock), "N new emails aren't sorted yet", 80% warning.
- **Round 2 first week (2026-10-16, branch `round2-fixes`; review "First Week" R2-C, Growth G3,
  Trust Check privacy lines):** migration 0031 (additive): `threads.handled_offline_at`,
  `invites.test_user_added_at`, `business_profile.first_look_hidden_at`. Pure rules and wording in
  `src/server/first-week-rules.ts`; DB side in `first-week.ts` and `invite-email.ts`.
  - **"I called them" (E11):** on draft and needs-you cards (`queue/called-them.tsx`, confirm
    step). Sets `handled_offline_at`, expires the waiting draft (`expirePendingDraft`, claim
    first, Gmail draft deleted). `lastOutSql` = greatest(owner email, the call), so every "who
    wrote last" read counts the call; `answeredByPhoneSql` (call ≥ newest inbound) keeps it off
    follow-ups, auto drafts and Needs you; `createDraftForThread` skips it for jobs; the
    scorecard's first answer counts it. The customer writing again undoes all of it.
  - **E9:** every card says "Wrote N days ago" (`QueueItem.customerWroteAt`, newest inbound).
  - **Setup (C1/C10):** required three marked "(required)", the rest folded under "More
    details, optional" on /welcome/profile only (opens if one needs fixing); the setup form sends
    the browser's time zone (`businessProfileInput.timeZone`, bad zones dropped). The sent
    screen's "I'll nudge Dana on Thursday" uses the owner's zone. Connect page says "Step 1 of 3"
    on a first connect; the queue shows one big Connect Gmail before anything else.
  - **D1/D2:** "Your last 30 days" card on the queue for 7 days after the first read (accounts
    under 14 days old only, `NEW_ACCOUNT_DAYS`; Hide this), and on the learning screen. Counts:
    emails read in the 30 days before the first read, conversations sorted in the last 14 days by
    category. Found money = quote requests waiting with no draft + answered quotes quiet past the
    follow-up wait with no nudge sent; "Draft them" (once, `app_settings`
    `found-money-drafted:<ws>`) enqueues `found-money-drafts` (owner-trigger replies, follow-up
    trigger nudges, ≤10). Drafts only.
  - **D4:** `sendFirstDraftsReady` (after drafting + the 15-min job): once ever per account
    (`first-drafts-ready:<ws>`), new accounts whose inbox was read in the last 3 days, voice done,
    a draft waiting; email + any phone push; counts only.
  - **Trial (E6/E7/F2):** practice copies tick "Check your first 3 drafts" (each draft once);
    read-only accounts get "Choose a plan to keep going" instead. Last 24 hours: inverted banner
    with sorted/drafted counts and a Choose a plan button; expired banner says what's waiting
    (counts). Expired wording: "Choose a plan to switch sending on" / "Sending turns on once you
    choose a plan". Push says "ready to check" unless the account can send.
  - **Billing:** each plan card shows the first charge from config (`firstChargeLine`: plan +
    setup when due, plus tax, then monthly). Paid + setup call pending → "What happens next" on
    /billing. **K7:** `notifyPaymentReceived` emails ADMIN_EMAIL once per checkout session
    (content-free: plan + setup yes/no; marker `payment-notice:<session>`), never fails the webhook.
  - **Invites (A1/A4):** `sendInviteEmail` after a new invite (form or waitlist): sign-in link,
    10 minutes, what to have ready; once per invite (marker keyed by a salted hash + invite time),
    skipped once accepted, never fails the invite. /admin invite rows show "Add … as a Google test
    user" + "I added them" (`test_user_added_at`).
  - **Wording:** terms box label has no links (tapping the words ticks it; "Read the Terms of
    Service" / "Read the Privacy Policy" sit below); the terms screen's way out names only what
    this person has (`leaveOptionsLine`); FAQ no longer says "send from either place"; Growth's
    "Book a free call" is "Ask Davi to call me" everywhere (it's a callback request).
  - **Privacy (TC):** breach notice (MA 93H), processed in the US, sender + subject go to the
    AI, the one-line reasons are kept past the purge, voice-example placeholder wording made
    true, the new emails and the payment notice named. Both documents and `TERMS_VERSION` moved
    to 2026-10-16 (the same date review-fixes uses), so everyone agrees again once. /privacy
    tables are focusable regions; `src/app/favicon.ico` exists.
- **The app on a phone (2026-10-16, outside review P3; I4, K1):**
  - Theme: `--input` is slate (≥3:1 on paper / off-white; `tests/unit/input-contrast.test.ts`
    checks every look); native checkboxes / radios take `accent-color: var(--primary)` in
    globals.css (never the browser's blue).
  - Draft card: the five tweak chips and "Tell it what to change" sit behind one **Change it**
    button (`aria-expanded`); the row is Discard · Change it · Edit (Edit on the thumb side,
    mirrored for left hands). The editor no longer holds the rewrite box. e2e checks Send reply
    is fully on screen, above the tab bar, for a typical draft at 375×812.
  - **Settings is a list** (`/settings`, `MenuList` rows ≥56px with a one-line state) of
    screens: `/settings/gmail`, `business` (profile facts + seasonal notes), `writing` (voice,
    ideas, never-say, Re-learn **behind a confirm**), `follow-ups`, `autopilot`,
    `morning-email`, `notifications` (only with VAPID keys), `texts` (only when
    `smsConfigured()`; both screens redirect to the list otherwise — no "Coming soon"),
    `phone` (Get the app, hand, offline queue), `account` (Plan & billing link, Sign out —
    the inline action moved here whole — and Delete my account), plus `/billing` and `/admin`
    (admin only). Each screen's notices live in `settings/messages.ts` (`SCREEN_MESSAGES`);
    every action redirects to its own screen (`tests/unit/settings-screens.test.ts` checks
    every `?done=` / `?error=` code has a notice and a page). Old `/settings?done=…` bookmarks
    still show on the list (`LIST_MESSAGES`). Old anchors (`/settings#digest` …, 12 ids) are
    sent on by `LegacySettingsAnchors` (`legacySettingsScreen`, a switch of fixed paths).
    Emails now link `/settings/morning-email`; the access-lost email links `/settings/gmail`.
  - Switches save themselves: `AutoSaveForm` (`src/components/forms/auto-save-form.tsx`) is a
    plain server-action form; once hydrated, a checkbox / radio change calls `requestSubmit()`.
    Forms with only switches (`hideButton`: the hand radios, the offline checkbox) hide their
    Save button after hydration (`form[data-autosave] .sa-autosave-button`); forms with a
    `<select>` (follow-up days, digest hour) keep a visible Save (WCAG 3.2.2). Without JS every
    form still saves with its button (e2e with `javaScriptEnabled: false`). Auto-saves land on
    `?done=saved` → "Saved." ("Saved for this phone." on the phone screen).
  - **Five tabs:** Queue, Inbox, Quotes, Money, More (`src/config/nav.ts`: `currentTab`,
    `MORE_PATHS` — More is current on /more, /customers, /activity, /settings, /billing,
    /admin, /record); labels 14px; the sm+ header shows the same five. `/more` lists Customers,
    Activity, Settings (+ Admin for the admin); it's in the proxy matcher and robots.
  - **Activity leads with money** (`monthMoney`, rules in `activity-rules.ts`): "Won and paid
    in {Month}" — quotes with outcome won this month (owner or guess) summed from
    `quote_amount_cents`, and invoices marked paid this month (`owner` / `auto`, never
    `not_owed`) after a **sent** follow-up decided before the paid mark, summed from
    `extracted.invoice.amount`; items without an amount are counted and said. Never reads
    price history. Time saved stays underneath. The feed is grouped by the owner's day
    (`groupByDay`: Today / Yesterday / "Monday, Oct 13").
  - **Inbox:** each row says "Replied" / "Waiting on you" (`replyState` from `lastInSql` /
    `lastOutSql`; junk gets none); on All, junk folds into one "N junk emails" `<details>`;
    a client search (`inbox-search.tsx`) filters by name, address, subject, summary and
    category — typed text never reaches a URL or the server.
  - Onboarding ends on "Go to my queue" (`/queue`).
- **Public site from the outside review (2026-10-16, P2):**
  - **Waitlist emails** (`src/server/waitlist-emails.ts`), sent from `after()` in
    `joinWaitlistAction` only when the result is "joined" (a new row, or a Growth-only row
    turned into an app sign-up): a content-free "New waitlist sign-up" to `ADMIN_EMAIL` through
    the shared `notifyAdmin` (one per address per day), and "You're on the Squared Away list" to
    the person, **once ever** (`waitlist.confirmation_sent_at`, set only on Resend "sent" /
    "already_sent"). Idempotency keys are HMAC-salted, no address. The confirmation carries
    nothing the visitor typed (anyone can type someone else's address), takes Davi's first name
    from `siteConfig.operator`, has no booking link, and replies go to `SUPPORT_EMAIL` only when
    set. A failure is logged by error name and never fails the sign-up. A repeat sign-up
    ("already") sends nothing, so people who joined before the Resend domain was verified never
    get a confirmation.
  - **Where sign-ups came from:** migration 0029 (additive) adds to `waitlist`: `utm_source`,
    `utm_medium`, `utm_campaign`, `referrer_host`, `confirmation_sent_at`. The browser keeps the
    first touch per tab in sessionStorage (`src/lib/landing-source.ts`); `<SourceFields/>` puts
    hidden fields in the waitlist and Growth forms, `<SourceCapture/>` runs on legal pages. The
    server cleans or drops every field, never errors (`source-rules.ts`; our own hosts dropped,
    `own-hosts.ts`); first touch wins across both forms; /admin shows "Came from: …".
  - **Measurement:** `@vercel/analytics` mounted only on `/`, `/growth`, `/privacy`, `/terms`
    (`SiteAnalytics`, production only via `VERCEL_ENV`; never in the root layout or `(app)`, a
    static test checks). `beforeSend` (`src/lib/analytics-rules.ts`) keeps page views of those
    paths with utm tags only — no `?ref=`, hash or custom events. First-party `/_vercel/insights`,
    so no CSP change; no cookies. Counting starts when Davi enables Analytics in Vercel. Counting
    signed-in screens would need a policy change and his okay.
  - GrowthSwitch layout gate: a line crossed with no real scroll in the last 150 ms (or during
    the 1.2 s hold after a thank-you's `sa:hold-switch`) waits for the visitor's next scroll
    (`crossingCause` / `deferredMode` in `switch-rules.ts`), so a thank-you that grows the page
    never plays the show or leaves the screen. Both thank-yous scroll into view and take focus.
  - Wording: "Business email" + "Gmail or Google Workspace today. On Outlook? Join anyway — it's
    on the list."; the trial is "Squared Away won't send anything to a customer during the
    trial" (never "nothing sends"); follow-ups "Two nudge drafts at most per conversation — each
    waits for your okay."; "Takes two minutes" gone (`legal-docs.test.ts` bans the old phrases
    and "automatic nudge"). The "photo coming soon" box is gone: one column until the `photo`
    constant in `about-davi.tsx` is set.
  - `Headline` (and every hand-written serif-over-heavy pair) has a real space between its two
    lines ("your inbox, handled."). Footer phone is a 44px `tel:` link; footer "Squared Away
    Growth" link on public pages only, plus "See everything Growth does →" on the homepage.
    `/growth` has its own share card (`src/app/_og/share-card.tsx`).
  - `src/app/not-found.tsx` ("nothing here, page not found." + Go to the homepage; /admin still
    a plain 404) and `src/app/error.tsx` (Next 16 `retry`, no message or digest). A failed form
    save returns a plain error keeping what was typed (`unstable_rethrow` first).
  - Search: homepage title "Squared Away — AI email help for contractors"; JSON-LD Organization +
    SoftwareApplication from `pricing.ts` (no rating, no free offer). Homepage caching **not**
    done: it needs the signed-in redirect in `proxy.ts` and `?ref=` read in the browser
    (referral code; after the referral branch merges).
- **Legal docs moved to 2026-10-16 (outside review P4):** the privacy policy now names the form
  Reply-To address in what we store from Gmail and in the kept metadata, the sign-up source
  (utm tags + referring site's name, not the page), the waitlist confirmation and Davi's
  content-free notice (Resend list), and Vercel Web Analytics (cookie-free, public pages only;
  Vercel also listed for it). Both docs' "Last updated" and `TERMS_VERSION` moved to 2026-10-16
  (the rule: the three stay equal); `docs/terms.md` text unchanged. Everyone who agreed to
  2026-10-15 is asked once more (only testers; the gate isn't live yet). `legal-docs.test.ts`
  holds each new sentence to the code. LAUNCH.md step 13 has "Outside review (2026-10-15)".
- **Outside-review follow-ups (2026-10-16, after verifying P1–P4):**
  - Reply-To backfill matches only the **one email a draft answers** (`answeredIdSql`: the
    inbound row it's threaded to, else the newest real non-side inbound before the draft was
    made); an older email's Reply-To never moves a draft or flags a past send. Re-point writes
    the **row first** (conditional), then Gmail; a Gmail failure puts the row back (and
    un-queues a tap made meanwhile).
  - `reply_went_to_form` detail carries `robot` (`looksLikeFormSender`: no-reply, known form
    hosts, wordpress@/forms@…). `robot: false` (a person naming their other address) reads
    "…went to the address their email came from… Check they got it." — never "send it again".
    REPOINTED_FLAG / `draft_repointed` / the Autopilot settings line are worded neutrally
    ("the reply address the customer's email named").
  - **Send checks the To the owner saw:** the card (and offline okays, `Intent.seenTo`) post
    `seenTo`; `queueSend` refuses `to_changed` (`?error=to_changed`, 409 on the API) when the
    draft now goes elsewhere, and its queue write requires the To it loaded.
  - `threadsToAutoDraft` leaves out threads whose newest inbound has a **checked** no-reply
    reply address (unchecked NULL stays in), so skipped robots can't starve real leads.
  - Inbox: only noise that doesn't need the owner folds into "N junk emails"
    (`isFoldableJunk`); needs-owner noise keeps its "Waiting on you"/"Replied" word.
  - AutoSaveForm: a radio saves at once only after a pointer tap (`isPointerChange`, 1.5s);
    an arrow-key change shows the Save button instead (WCAG 3.2.2).
  - Homepage: "Two nudges at most per conversation — each one a draft that waits for your
    okay." (the cap counts nudges sent); the queue still's card and caption say nothing goes
    to a customer during the three days. In-app `sendingOffLabel` unchanged (pinned).
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
    visible to the engineers. LAUNCH.md "Check your free plans now (this week)", before step 0.
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
    Growth removals are by hand today). A Growth request carrying a referral: yes (2026-10-16).
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
- **Leads package (2026-10-16, branch `leads-build`; plan `ideas-plan-leads.md`: B4 B5-lane B3
  B2 B6 B14 B9 G5):** migration 0032 `leads` (additive: `threads.lead_channel`,
  `complaint_fixed_at`, `complaint_checkin_done_at`; `business_profile.service_towns`). **No prompt change** (classify.v4 untouched; the eval
  baseline is still empty): the town is read in code from the address the classifier already
  extracts, emergencies use its existing `urgency`, lead-site names come from labelled lines.
  - **Where a lead came from** (`src/server/channel-rules.ts`, pure; `src/config/phone-services.ts`):
    `channelOf(from)` = `phone` (Google Voice `voice-noreply@google.com`, exact), `phone_text`
    (email-to-text gateways, carriers' own published domains) or `site` (via `leadPlatformOf`,
    so platform matching never disagrees with the monthly label / Reply-To rules). Every
    `LEAD_SOURCES` entry has `site` (Facebook `null`; Google Local Services included, exact
    hosts only); "Open <site>" is a **fixed** https URL whose host must be on `OPEN_SITE_HOSTS`
    (`openSiteUrl`; tested) — never a link read from an email. Stored at classification as
    `threads.lead_channel` (never cleared by a later email). Promotions/Social shortcut bypassed
    for phone channels only. Customers leaves lead-channel threads out.
  - **Never drafted, never sent:** `createDraftForThread` refuses `lead_site` / `phone_message`
    first (every trigger, before the Reply-To read or any model call), then on the final `to`
    `text_address` (any gateway, every trigger; also a form whose Reply-To is a gateway) and
    `lead_site` by address (older threads); a phone-number-shaped address the owner never wrote
    to → jobs skip (`maybe_text_address`), the owner's tap gets `MAYBE_TEXT_FLAG` first.
    `queueSend` → `text_address` (403 on the API, `?error=textaddr`); `sendDraft` closes such a
    draft as discarded with **no Gmail call**; `reconcileDrafts` first expires pending drafts to a
    gateway or a lead-site robot (and their Gmail drafts); autopilot refuses lead channels and
    phone-like addresses. Precedence: lead-site/phone refusals before the no-reply rule.
  - **Owner rules** (`applyOwnerRules`): every hit stored as content-free keys in
    `extracted.owner_rule_hits` (`OWNER_RULE_KEYS`); new hits `emergency` (model urgency
    `emergency` + `LEAD_CATEGORIES` → needs you, priority high: emergencies are no longer
    auto-drafted), `phone`, `site`, `outside_area`. When any of those four hit, the stored reason
    is our fixed text (never the model's prose, which could carry a town or name past the purge).
    Cards read flags, never reason strings.
  - **Done** = the existing "I called them" (`handled_offline_at`, round 2 E11), relabelled "Done —
    I answered" / "Done — I called back" on lead cards (`?done=done`); no `owner_done_at` column.
    It already answers leads at risk, Not answered yet, Quotes and follow-ups via `lastOutSql`.
  - **Queue** (`queueMembership`, shared by digest / badge / push / screen): `lane` (B5, sorted
    first; injection never) and G5 check-ins (`checkIn`: fixed 2–30 days ago, not closed since, no
    customer email and no owner email / app reply since, no draft pending; never an emergency)
    join needs-you, content-free. The screen renders
    `NeedsYouCard` (`queue/needs-you-card.tsx`) with `leadCardsFor` (`src/server/lead-cards.ts`:
    a fixed number of queries per render): Call / Text (`ContactButtons`, plain `tel:` /
    `sms:?&body=`; numbers from `src/lib/phone-numbers.ts` + `contact-rules.ts`, code only:
    toll-free / N11 / 555-01xx refused, the owner's signature / alert phone / sent-mail tails
    skipped, machine mail needs a field label like "Phone:", a voicemail's subject names the
    caller; nothing stored or logged), emergency section with Call now first, voicemail cards
    (Call back, no Draft a reply, "Open in Gmail (to play it)"), lead-site cards (Open <site>,
    name / service / town parsed from labelled lines only, `lead-site-rules.ts`), complaint
    cards (Call first, **Mark fixed** → `?done=fixed`, refused with a pending draft
    `has_draft` or a legal hit), check-ins (All good), repeat-customer line (B14,
    `repeat-customer-rules.ts`: won > quoted (amount or a real owner email) > asked; lead
    channels and no-reply skipped; no price) and the towns line (B9).
  - **Not answered yet (B6)** (`never-answered.ts`): over 24 h and under 14 days, one row per
    customer (`row_number() over (partition by waitingReplySql())`, address never selected), no
    queue card, active mailbox synced < 30 min; lead channels, no-reply, injection, municipal,
    job done and decided quotes left out; the morning email adds a count-only line (excluding
    queue cards and leads at risk).
  - **Towns (B9):** "Towns you work in" under "Where do you work?" (pre-filled from it while the
    list is empty; saved only on Save), de-duped by `normalizeTown`. `townFromAddress` only reads
    "…, Town, ST [zip]" / "…, Town" (no digits, not a street). "Add <town> to my towns" takes the
    town from the stored address (never the form) and clears needs-you only when
    `owner_rule_hits` is exactly `["outside_area"]`.
  - Scorecard response time and `guessNoAnswers` leave lead-channel threads out. Inbox swaps
    Draft a reply for Open <site> (or a plain line) on lead-channel threads.
  - Privacy policy lines added (lead source / rule-hit / done / fixed marks; towns; Call / Text
    reads the number at render and never stores it; never draft/send to lead sites, voicemails or
    gateways); the documents were already dated 2026-10-16 = `TERMS_VERSION`, so no date move.
  - **Not built (deviations):** classify.v5 (customer name / town from the model, strict
    emergency wording) — waits for the eval baseline; purpose.v2 notes (polite no, calm
    complaint reply, check-in note) — the owner's ordinary "Draft a reply" covers them for now, so
    no `declined_at`; held B5 part 2 (emergency alerts) and its columns; RingCentral /
    Grasshopper / OpenPhone senders (need samples).
- **Ideas "control" package (2026-10-16, branch `ideas-build`; H3, H4, G7, E7 built; G3 and B7
  not built in this pass, see Waiting on Davi):** migration 0033 `control` (additive; was 0032 before the leads merge): `owner_sender_rules`,
  `customer_notes`, `threads.category_manual` / `category_manual_at`, `business_profile.away_back_on`,
  `seasonal_notes.away` (+ partial unique index, one away note). No prompt change.
  - **H3 sender rules** (`sender-rule-store.ts`, pure `owner-sender-rule-rules.ts`; the store is
    not called `*-rules.ts` because the purity test scans that suffix): Always junk / Never draft
    (address or company domain) and company-wide Always needs me; "Always needs me" for one
    address writes the VIP list instead (one list for that fact; DB check refuses an address
    `needs_me`). Keyed only from an email whose Reply-To was read (`keyFromMessage`: NULL header,
    lead-site relays and no-reply addresses refused). **Direction:** caution (VIP, needs me, never
    draft) matches From or the reply address; junk only when From matches and there is no redirect
    or the reply address matches too; a NULL header never junks; any caution beats junk. The
    junk shortcut (no model call, `extracted.sender_rule = "junk"`) is skipped for a moved
    thread, municipal senders, injection text, sticky marks and a whole-word guard list (lawyer,
    refund, leak, damage…). Junk refused for anyone the owner wrote to, a VIP, an open quote or an
    owed invoice, building departments; company rules never on webmail or the owner's domain; cap 200. Never draft is read live in `createDraftForThread` (jobs only, the customer's newest
    non-side email) and the auto-draft / follow-up scans skip `sender_rule = no_draft`. Inbox
    rows carry "Rules for this sender" (posts the email id, never the address); Settings → Sender
    rules lists and removes. Activity `{action, scope}` only.
  - **H4 Move it** (`resort.ts`): `category_manual` wins in classification's UPDATE
    (`coalesce(category_manual, model)` in SQL, race-safe); the model's own kind is stored as
    `extracted.model_category`. To complaint: needs you + sticky `complained_at`. To junk:
    discards the waiting reply (refused while it's in its undo window). To quote: request time =
    first customer email after the owner's last real reply. **Decision:** `quote_requested_at` is
    set once and never cleared, _except_ by the owner moving an undecided quote away (also
    clears `job_kind` and `quote_accepted`, withdraws a waiting deposit note). A job never drafts
    on a moved thread whose `model_category` isn't auto-draftable (`owner_moved`); autopilot
    refuses manual ≠ model ("You chose this kind yourself…") and such sends don't earn.
  - **G7 private notes** (`customer-notes.ts`): ≤200 chars, one per customer reply address, saved
    from the customer page (key = an email id), shown on Inbox rows and Queue cards (drafts keyed
    on `to_address`, others on the newest non-side inbound). Never sent to the AI or anywhere else
    (boundary test in `control.test.ts`). Not encrypted (like bodies; only tokens are). With the
    offline queue on (`sa_offline`), cards say "Note saved · Open" without the text. Goes with
    the mailbox it was written under.
  - **E7 away mode** (`away.ts`, pure `away-rules.ts`, `/settings/away`): day back after today and
    ≤90 days, read at use (no cron); one `away` seasonal note "Away until … (Oct 9). Back …
    (Oct 10)." (both date forms so `checkDraft` sees the date as given), outside the 5-note cap,
    read-only on the business screen. Nudges pause (`threadsToFollowUp` → none, followup trigger
    → `away`). Autopilot, alerts and the digest don't change; the screen's last line says so
    when autopilot is on. A default-zone owner's browser zone decides "today" and is saved.
  - Privacy policy (same 2026-10-16 date as `TERMS_VERSION`, so no new re-agree): what you tell
    us (rules, VIPs, notes, away day), the moved-kind record, notes/rules never sent to Anthropic
    and the junk-shortcut exception, retention, and notes left out of the offline copy.

- **Ideas "numbers" package, part (2026-10-16, branch `ideas-build`; C8, H8, C5, K2 built;
  D4 and D7 not built, see Waiting on Davi):** migration 0034 `numbers` (additive; was 0033 before the leads merge): `threads.quote_lost_reason`.
  No prompt change; nothing new is sent to the AI or to a customer.
  - **C8 quote speed** (`quoteSpeed` / `quoteSpeedSentence`, `scorecard-rules.ts`): of the week's
    quote requests, answered within `QUOTE_SPEED_HOURS` 24 calendar hours (nights and weekends
    count; the Activity explainer says so) out of those that can be judged: answered ones plus
    unanswered ones already over 24 hours; owner-settled ones left out. Percent from 5. Same
    request set and exclusions as response time. **Known edge:** Monday's email counts last week
    at send time, so a late-Sunday request still in its first day is left out of it (never
    marked slow early); the Activity card counts it later.
  - **H8 sent without changes** (`asWrittenSentence`, query in `scorecardQueries.asWritten`):
    replies + follow-ups sent from the app this week (`sent_gmail_message_id` set, so a
    reconcile-"sent" draft counts in neither number), never autopilot (`reply_sent.detail.autopilot`),
    and drafts that had `{{gaps}}` left out of both: `sendDraft` now writes `hadGaps` (yes/no)
    into `reply_sent`; older rows fall back to `original_body` and drop out once purged. Shown
    from 5 sent, "up/down from" only when last week also had 5; a link to
    `/settings/autopilot` where autopilot can be had (no claim that it earns autopilot). Both
    lines go into `scorecardLines`, so Monday's email has them (counts only; `ScorecardNumbers`
    fields are optional for older callers).
  - **C5 why you lost it** (`setLostReason` in quotes.ts, rules in quote-rules.ts): Price /
    Timing / Went with someone else, one optional tap on a Lost card; any new outcome clears it;
    read only through `shownLostReason` (old code can leave a stale reason on a reopened quote).
    Activity: "Lost this month: …" (`lostReasonsBetween`, the owner's month, by
    `quote_outcome_at`). Activity row `quote_lost_reason {reason}` is hidden from the feed.
  - **K2 which lead sources pay** (`lead-pay.ts`, `leadPayRows` / `leadPaySentence`): Quotes
    card "Where your work comes from", last 90 days (`requestAtSql`), only the requester's
    domain leaves SQL. A no-reply From with a different Reply-To is "Website form". Lead sites
    (`leadPlatformOf`) count Won only when the owner marked it and never say "0 won" ("Tap Won on
    Quotes…"). ≥2 sources to show, 6 rows max ("Everywhere else"). Owner-only.
  - Privacy policy: why a quote was lost (store + retention), same 2026-10-16 date.
- **Leads + ideas merge (2026-10-16, `ideas-build` ← `leads-build`):** leads' `0032_leads` reaches
  the shared database first (PR #13's previews run it), and drizzle's migrator only applies a
  migration whose journal `when` is later than the last applied one, so the ideas migrations were
  renumbered after it: `0033_control` (when 1792192470911) and `0034_numbers` (when
  1792192476806; leads' 0032 is 1792180535102), regenerated with drizzle-kit (same SQL) so the
  snapshots chain 0032_leads → 0033 → 0034. `tests/unit/migrations-order.test.ts`
  fails if any journal `when` doesn't strictly increase in idx order (or tags/files disagree).
  Combined behaviour: `OWNER_RULE_KEYS` gains `sender_rule` (a company "Always needs me"), so
  "Add <town>" only clears needs-you when the town was the one reason; the junk-by-rule shortcut
  never fires for voicemail / text-message emails (they are always read, like the Promotions
  shortcut); `companyChoice` refuses email-to-text gateways ("Anyone at vtext.com" would be
  many people); `createDraftForThread` keeps every refusal from both sides (lead_site /
  phone_message first, then the jobs-only owner_moved / sender_rule / away, then text_address /
  maybe_text_address on the final address); autopilot refuses owner-moved kinds, lead channels and
  phone-like addresses. `NeedsYouCard` takes the private note line and the Move it sheet (not on
  check-ins or read-only accounts); draft cards show the lead lines then the note. Quote speed
  (C8) reads the same request query as response time, so it leaves lead-channel threads out too.
- **Growth cross-sell rule (Check 5 P1, 2026-10-17):** the app may mention Growth only with static
  text that is the same for every owner (no props, no counts, no conditions on mail, drafts,
  quotes, money owed or activity). No Growth mention on /billing, read-only or expired screens, or
  in lifecycle, digest, monthly-summary, alert or text-message content. No app data is ever copied
  into a Growth lead. The one allowed line is `GrowthMention` (`src/components/app/growth-mention.tsx`,
  no props, copy `growthCopy.appMention`), placed on the More screen only and hidden there for
  read-only or expired accounts (`jobsAllowed`).
- **Growth code may not import inbox modules or tables (Check 2 P5):** no `@/mailbox`, `@/ai`,
  `@/jobs`, sync / classification / inbox / drafts / voice / quotes / customers / followups / digest,
  and no threads, messages, drafts, mailboxes, voice or business profile, usage or activity log
  tables. `tests/unit/growth-boundary.test.ts` enforces both rules; a new Growth file (like the
  client portal) is added to its `GROWTH_PATHS` / `MENTIONS` lists on purpose, with a reason.
- **Where email text may go (Check 48 P7, 2026-10-17):** only to Anthropic, as one synchronous
  `messages.parse` per task (`src/ai/client.ts`), as the privacy policy says. No Message Batches or
  Files API until `ALLOWED_DATA_PATHS` (`src/config/models.ts`) turns one on with a policy update
  and a `TERMS_VERSION` bump; no "Covered Model" (30-day retention); `fetch` only to hosts tied to
  a privacy-policy line; no other AI SDK. `tests/unit/data-paths.test.ts` enforces it.
- **Preview guard (Check 26 P2, 2026-10-17):** `previewGuard` (`src/config/environment-guard.ts`,
  pure) runs in `db()`, `loadKey()` and `/api/health`: on `VERCEL_ENV=preview` a database host,
  `TOKEN_ENCRYPTION_KEY` or `AUTH_SECRET` whose sha256 is production's throws "This preview is
  pointed at production. See docs/LAUNCH.md step 2." (no values) and health answers 503
  `preview_uses_production`. Fingerprint lists ship empty (blocks nothing; see Waiting on Davi);
  `pnpm fingerprint [env file]` prints the hashes.
- **Reserved columns (Check 50 P3, migration `0035_reserved_columns`):** added once so several
  prompts don't fight over them; nothing reads or writes them yet. Check 38 P2, 44 P1, 45 P2 use
  `business_profile.state`; Check 20 P4 and 21 P1 use `messages.auto_reply` and
  `messages.ack_only`; Check 22 P10 and 41 P6 use `business_profile.crew_addresses` (max 30; not
  `team_addresses`), validated by `crewAddressesSchema` (`src/server/profile.ts`: emails,
  lowercased, de-duplicated). None of them adds a migration. `migrations-columns.test.ts` fails
  when two migrations add the same table.column.
- **Prompt versions (Check 50 P2, `src/ai/prompts/registry.ts`):** a new version is a new
  `<kind>.v<N>.ts` file (constant `<KIND>_PROMPT_VERSION = "<kind>.v<N>"`) plus one line in
  `ACTIVE`; `prompt-versions.test.ts` fails on two files with one version, a gap, an `ACTIVE`
  that isn't the newest file, or code that records a version imported from an older file.
  Active after the wave 1 integration: classify.v5, draft.v8, followup.v4, voice.v3, revise.v2,
  purpose.v2, edit-tone.v1, opening-tweaks.v1, dispute-caution.v1 (a suffix on draft / revise
  versions, never stored alone). Taken, so the review pages' names shift:
  - **draft.v8** = the review's "draft.v7" bundle: Check 23 P11 + 43 P1 + 44 P1 (and 45 P2) + the
    prompt parts of 40 P1 and 41 P1. Then the trade files of Check 36 P8, 37 P4 and 39 P6, in
    draft.v8 or the next version (**draft.v9**).
  - **classify.v5** = Check 12 P2 + 12 P3 + 22 P9 + 38 P5 + 45 P7, plus the classify parts of
    21 P1, 21 P2, 22 P4, 37 P3 and 39 P5.
  - **followup.v5** = Check 12 P7 + 21 P7. **voice.v3** = Check 24 P5 + 24 P9.
  - Any later purpose prompt starts at **purpose.v3**; any change to the "Other ways to reply"
    asks is **opening-tweaks.v2**.
- **Davi's decisions package (2026-10-16, branch `decisions-build`):** migration 0036
  `decisions` (additive; 0035 on its branch): `mailboxes.plan_paused_at`, `workspaces.trial_emails_stopped_at` /
  `trial_emails_sent` (text[]), partial unique index `drafts_one_thank_you_per_thread`. Prompt
  `purpose.v2` (re-exports v1's three tasks unchanged, adds `thankYouTask`); eval cases added
  (`tests/evals/purposes.ts` thank-you ×3, `cases.ts` i-paid-happy / i-paid-zelle).
  - **Headline:** "Built for carpenters, plumbers, and electricians" (hero, both meta
    descriptions, `opengraph-image.tsx`); `tests/unit/decisions-copy.test.ts` pins it.
  - **Trial side door stays:** the drafts are real Gmail drafts, so an owner may send one from
    Gmail during the trial; only Squared Away's own Send is off. One wording,
    `TRIAL_NO_SEND_LINE` + `TRIAL_SIDE_DOOR_LINE` (`trial-email-rules.ts`), on the homepage FAQ
    and promise, the connect explainer ("from Squared Away you can only send yourself practice
    copies"), the Day N banner (last day / expired: "to send replies from Squared Away"), the
    learning screen and /billing (trial only), the invite and first-drafts emails, the trial
    emails, `docs/terms.md` and the privacy policy (same 2026-10-16 date: no re-agree; Davi's
    call in LAUNCH.md). `sendingOffLabel(evaluating)` is now **"Send reply is off during your
    three days"** and `sendingBlockedReason` adds the Gmail line. Push stays "ready to check".
    `decisions-copy.test.ts` bans "nothing goes to a customer", "sending is off during",
    "customer: you can only send yourself practice copies", "can't be sent"….
  - **Trial emails** (`trial-emails.ts`, pure `trial-email-rules.ts`, links in
    `trial-email-links.ts`): day 1 = the existing first-drafts email (during the trial it gains the
    trial line and the stop link, and isn't emailed once stopped); `day2` from 24 h after the clock
    started; `day3` on the end's local date ("Your trial ends today at 3:00 PM") or the day before
    when the end is earlier than `digest_hour` + 2 h ("…tomorrow at 6:30 AM"); day 3 wins a tie
    and day 2 never goes after it; `after` 7–14 days after an expiry with no payment at all
    (`setup_paid_via`, `setup_paid_at` or a subscription). Window: `digest_hour` ≤ local hour < 20
    in `business_profile.time_zone` (Eastern default). Step `trial-emails` in the 15-minute
    lifecycle job, one email per account per run, marked in `trial_emails_sent` only after
    Resend took it (`array_append … where not = any`); keys `trial-<ws>-day2|day3|after`;
    no Resend → nothing sent or marked. Counts only (`trialCounts` + `queueCounts`). Every one
    carries "Stop these emails" → `/api/emails/stop?w=<ws>&s=<HMAC-SHA256(AUTH_SECRET,
"trial-emails:stop:"+ws)>` (constant-time; no secret → no link and no trial email) plus
    `List-Unsubscribe` / `-Post` headers (`OutgoingEmail.headers`). GET → 303 `/emails/stopped`
    (public, noindex; `?link=bad` changes nothing), POST (mail apps' one-click) → 200 / 400.
    Route guard `signed-link` in the C3 table. Settings → Morning email: "Trial emails" switch
    (`saveTrialEmailsAction`) only while `trialEmailsMatter` (evaluating / expired, unpaid).
  - **Plan pause** (`mailbox-plan.ts`, pure `mailbox-plan-rules.ts`): `fitMailboxesToPlan`
    (workspace row `FOR UPDATE`) keeps min(limit, connected) on — pauses the newest of those on,
    turns the oldest paused back on — after `setWorkspacePlan`, Stripe's checkout and plan
    changes (`fitMailboxesSafely`, never fails the webhook), a disconnect, and step
    `fit-mailboxes-to-plans` (15-minute backstop). Pausing clears that mailbox's autopilot
    countdowns; Activity `mailboxes_fit_plan {paused, resumed, limit}`. "Use this one instead"
    (`swapPlanMailbox`, Settings → Your Gmail; "Paused: your plan covers N Gmail address(es)."):
    one for one under the lock, or straight on when there's room; `choose` when no valid one to
    pause. **On** = `mailboxOn` / SQL `mailboxRunning()` (status active AND not plan-paused) in
    every gate that skipped a lost mailbox: sync, poll, Gmail push + watch, classify, unsorted
    sweep, voice (oldest running mailbox), drafts (every trigger → `mailbox_paused`), reconcile,
    reply-to backfill, draft cleanup, batch, follow-ups, leads at risk, not answered yet,
    new-lead texts / pushes (`freshLeads`), access-lost emails, the reconnect banner, admin's
    "jobs look stopped". `sendDraft` / `queueSend` / practice / revise / edit refuse with
    `mailbox_paused` before any Gmail call (API 403 `MAILBOX_PAUSED_LINE`, `?error=paused`);
    autopilot stands down with "This Gmail address is paused on your plan." The queue still shows
    its drafts (`QueueItem.mailboxPaused`, read-only card). A static test fails on any new
    status-only gate (`mailbox-plan.test.ts`).
  - **Reset test payments:** Davi chose "let it be usable" — already as built (past_due →
    `restored()`, jobs run, can't send without `setup_paid_via`); a test proves it end to end,
    LAUNCH.md moved it to "Decided on 2026-10-16".
  - **Lost reason "Other"** (`LOST_REASONS` + "another reason"; never the sentence's headline;
    plain text column, older code just doesn't show it).
  - **Say thanks** (Money's paid rows, replacing "Ask for a review" there; Inbox keeps its own):
    owner purpose `thank_you`, stored as `thank_you` or `thank_you_review` (the review ask inside,
    only when `reviewOfferReason` is null for that customer — the full review rules); both count in
    `recentReviewAddresses` via `REVIEW_ASK_PURPOSES`, and `thank_you_review` is inserted under
    `lockReviewAddress`. Base rule `thankYouOfferReason`: owner/auto paid mark (never not_owed),
    no injection / municipal, not junk / supplier, not a robot / receipt sender, once per thread
    (index; an expired one doesn't count; a discarded one does). A complaint or an unknown
    customer still gets a plain thank-you. Same `checkTerms` as review requests (`review: {url:
null}` flags any link on a plain one); reconcile expires it like a review note; never a job,
    autopilot, batch, earning or `followup_count`.
  - Privacy policy (same 2026-10-16 date): the trial emails in the Resend list, which trial emails
    went and whether they were stopped, and which Gmail address a plan pause stopped.

- **Replies package (2026-10-16, branch `replies-build`; Davi's answers that day):** migration
  0037 `replies` (0035 on its branch; additive: `drafts.opening`, `threads.emergency_alerted_at`,
  `business_profile.emergency_alerts_enabled` default true). Prompts `draft.v7`,
  `opening-tweaks.v1`; eval set +12 first-contact cases, +3 revise cases, metric
  `openingAccuracy`. **The eval baseline is still empty** (no `ANTHROPIC_API_KEY` repo secret).
  - **Warm first replies (draft.v7):** draft.v6's rules plus a "First contact" section, used only
    when the code says so: `isFirstContact` (`first-contact-rules.ts`, pure) = an ordinary reply
    (no nudge, purpose note or gas safety note) on quote_request / customer_question /
    scheduling, no "I called them" on the thread, and `ownerWroteBefore`
    (`known-customer.ts`) false — no non-draft, non-side owner email on this thread or to the
    customer's reply address (never the From: a form robot is shared by every lead) from **any**
    of the workspace's mailboxes, and no app send to them (sent, queued or claimed). Asked only when everything else already says first
    contact. The task line `FIRST_CONTACT_TASK` tells the model; it picks `opening` details /
    vague / urgent / price_only (`not_first` otherwise) via `replyDraftSchema` (draft.v6's
    schema + `opening` with `.catch("not_first")`: a bad value never loses the draft; the SDK
    puts enums in the description, so nothing enforces them at the API). Stored only on a first
    contact (`storedOpening`; the model's "not_first" there is kept, so non-null = code said
    first contact). The business block, conversation block and date helpers are re-exported
    from draft.v6 unchanged (cache and nudges untouched); nudges keep `draftSchema`. Purpose notes
    now use v7's instructions (evals too). `checkDraft`, regenerate rules and gaps unchanged.
    v7 still bans "Thank you for reaching out" (checkDraft's filler); the warm opener is
    "Thanks for reaching out". Activity `draft_created` gets `firstContact: true`.
  - **Card:** "First reply: asks 2 questions · they described the job" (`openingLine`, counts
    `?` runs in the current text) and **Other ways to reply** (`OtherWaysToReply`, below the
    Discard · Change it · Edit row so Send reply stays put): Ask a few questions / Offer to come
    take a look / Short and friendly (`OPENING_TWEAKS`, labels mirrored in
    `OPENING_TWEAK_LABELS`, a test keeps them equal). `reviseDraft({ opening })` = revise.v2's
    instructions + the fixed ask, logged `revise.v2+opening-tweaks.v1`, same 5-per-draft / 40-an-hour
    limits; refused (`not_first_contact`, before any model call) unless the stored opening is one
    of the four shapes on a plain reply. Hidden on read-only accounts (`offersOtherWays`).
    **Autopilot refuses any draft with an opening** ("First replies to new customers always wait
    for you."): Davi said no to instant replies to new leads, and an old forward could make a
    new lead look known.
  - **Money in the morning email:** `moneySoFar` (activity.ts) → `moneySoFarLines`
    (activity-rules.ts): "This month so far: $X in quotes you won · $Y in invoices paid." and
    "Still owed to you: $Z on Money owed.", plus Activity's own note (`MONEY_SO_FAR_NOTE`). Won =
    `quote_outcome` won (owner or guess) by `quote_outcome_at` in the owner's month, from
    `quote_amount_cents`; paid / owed = `invoiceTotals` (money.ts) on Money's own rows
    (`moneyThreads`, now with `paidSince` so a 31-day month reaches past the 30-day paid list):
    no supplier bills, receipt senders, bills the owner owes or "Not owed to me". Items with no
    amount are counted and said. Zero parts left out; no section when all zero; it never makes a
    quiet morning worth sending. Activity shows the same lines on its money card ("Nothing won or
    paid yet" only when neither). The M7 privacy test now allows the total line in the email
    (never a name, invoice number or due date); push and texts still carry no amounts.
  - **Emergency alerts (B5 part 2)** (`emergency-alerts.ts`, rules in
    `emergency-alert-rules.ts`): candidates = `inEmergencyLane` exactly (a gas smell counts via
    its urgency mark), needs_owner, in the inbox, mailbox on (`mailboxRunning()`: active and not
    plan-paused), never alerted, not snoozed, not injection, the customer's newest non-side email
    under an hour old **and already sorted**, its reply address not no-reply — **except** a
    voicemail / text-message email (`phoneMessageSenderSql`, the SQL twin of `channelOf` kind
    phone / phone_text; integration 2026-10-17) — unanswered (owner email / "I called them" / app send / undo
    window). One alert per run per owner covering every new emergency; caps 3 between 9pm and
    7am (from the night's 9pm, across midnight) and 6 per local day, counted from
    `emergency_alert_sent` rows; count + mark + Activity row in one transaction under
    `pg_advisory_xact_lock(hashtext('emergency-alert:<ws>'))`. Sent through the owner's push
    phones and verified text number; nothing reached → marks and row taken back. Takes the push /
    SMS slots (`push_last_sent_at` / `sms_last_sent_at`) without waiting for them, so ordinary
    alerts wait 10 minutes after it, and `freshLeads` leaves an alerted emergency out until a
    later email is sorted on it. Words: "An emergency email just came in. Open Squared Away."
    (push, via `/api/push/summary` while that alert is the newest push and < 30 min old,
    `emergencySummaryApplies`; the tap opens `/queue?t=<uuid>#t-<uuid>`) and "Squared Away: An
    emergency email just came in. Open: <deep link>" (text). Runs first in `alertsForMailbox`
    (after sorting) and in the 15-minute backstop. Read-only accounts never. Setting
    **Emergencies, even at night** (`EmergencySwitch`, one switch on both Notifications and Text
    alerts; `saveEmergencyAlertsAction` → `?done=saved` on the screen it came from); off = an
    emergency waits like any email. Activity "Let you know right away about an emergency email"
    (counts) and the switch's on/off row.
  - Privacy policy lines added (first-reply labels, emergency alert times, the switch, money totals
    in the morning email); same 2026-10-16 date as `TERMS_VERSION` (as the other 2026-10-16
    packages did, no new re-agree); `legal-docs.test.ts` holds them to the code. SETUP.md §6c
    names the emergency exception and a second A2P sample message.

- **Growth client portal (2026-10-16, branch `growth-portal`):** migration `0038_growth` (0035 on its branch)
  (additive; renumbered at merge): `growth_clients` (one per workspace, cascade; status active |
  paused | ended; `started_on` date; `services` text[] of `GROWTH_SERVICES` ids; `time_zone`,
  set by Davi, Eastern default), `growth_updates` (title ≤80, body ≤2000, Davi's words;
  `notified_at`), `growth_monthly` (unique client + 'YYYY-MM'; optional new_leads, calls,
  jobs_won, money_won_cents, reviews_gained, ad_spend_cents; note ≤280), and on `invites`
  `growth_invited_at` / `growth_services` / `growth_started_on`. Rules in
  `src/server/growth-client-rules.ts` (pure), DB in `src/server/growth-clients.ts`.
  - **Growth never uses inbox data (Davi's review, Check 5 P1 / Check 2 P5):** every dashboard
    number is one Davi entered in `growth_monthly`, labelled "From your monthly check-in(s) with
    Davi"; the money line is "Money from jobs you won since Growth started (as you told Davi)".
    Growth files never import mailbox / ai / jobs / sync / inbox / drafts / voice / quotes /
    customers / followups / digest code, nor the threads, messages, drafts, mailboxes,
    voice/business profile, usage or activity tables (`growth-portal.test.ts`); the client's
    months use `growth_clients.time_zone`, never `business_profile.time_zone`. /admin's Growth
    card shows only what Davi entered. Nothing goes to the AI.
  - **Sign-in lands on `/start`** (the sign-in action, `/signin` and `/` for a signed-in
    owner): an active or paused client picks "My inbox · Squared Away" (/queue, which shows
    Connect Gmail when none is connected) or "My Growth dashboard" (`/my-growth`; not `/g` —
    robots' `Disallow: /g` would also block `/growth`). Everyone else is redirected to /queue.
    Both are outside `(app)` (own header, no tab bar), in the proxy matcher and robots, behind
    `requireOwner` (terms). `/my-growth` 404s for non-clients and ended clients (no
    loading.tsx; in the C2 must-404 list).
  - **Admin "Growth clients"** on its own page `/admin/growth` (/admin only links to it with a
    count: with every client's forms inline, /admin got slow enough under load to time out older
    admin e2e tests). `admin/growth-admin.tsx`, actions in `admin/growth-actions.ts`, all
    `requireAdmin` first; `growth_*` notices on /admin/growth, `wl_*` in /admin's waitlist card: Start Growth for this account (accounts listed as business name +
    owner email; a client whose Growth ended can be started again), change services / start date
    / time zone, pause / resume / end (confirm each), Post an update, Monthly numbers (one form per
    month; emptying every box removes the month), Invite to Growth (no account yet).
  - **Invite to Growth** (also on a waitlist card's Growth request, services pre-ticked from the
    request): an invite row (sign-in gate) with the Growth fields; refused for an address with an
    account. `ensureUserAndWorkspace` → `linkGrowthInvite` makes the client once and clears the
    fields (never fails sign-in). No trial: the clock still starts only at Gmail connect. Email
    "Your Squared Away Growth dashboard" once per invite (`growth-invite-email:<hmac>-<time>`).
  - **Update email** "New update from Squared Away Growth": the title + a link only, Resend key
    `growth-update-<workspace>-<update>`, `notified_at` set only after Resend took it; off without
    Resend; "Email it to them" retries an unsent one.
  - **Remove** on a waitlist card's Growth request (confirm step): a growth-only row is deleted; a
    mixed row keeps the app sign-up and loses only the Growth block (`withoutGrowthBlocks`).
    Decided on the row as it is at the tap. Log `growth_request_removed {result}`.
  - **Pledge** `growthCopy.pledge` (GrowthChapter, so /growth and the homepage half; the dashboard
    too): names `GROWTH_OWNED` for every service (copy test), "We never take a percentage of
    your jobs or your business." The in-app mention is `GrowthMention` (no props, static
    `growthCopy.appMention`), More screen only, hidden on read-only or expired accounts; clients also get a
    "Growth" row to `/my-growth` there.
  - Docs: `docs/growth-agreement.md` (draft, not legal advice, [To confirm] items), privacy-policy
    Growth-client lines (same 2026-10-16 date, kept at the integration),
    LAUNCH.md step 13. **Referrals:** built 2026-10-17 at `startGrowth` / `linkGrowthInvite` (see
    #47's Growth door).

- **Integration (2026-10-17, branch `integrate-3` on `wave0`):** decisions, replies and
  growth-portal merged with `--no-ff` in that order.
  - **Migrations:** wave0 keeps `0035_reserved_columns`; the packages' 0035s were regenerated
    with drizzle-kit on top of it as `0036_decisions` (when 1792207285776), `0037_replies`
    (1792207482652) and `0038_growth` (1792208657111), SQL byte-identical to the originals.
    Applied on a scratch database on top of main's journal: 39 rows, nothing skipped.
  - **Emergency voicemails alert (lead engineer's decision):** an emergency-lane email from a
    phone service (Google Voice's voice-noreply@google.com, an email-to-text gateway) alerts the
    owner's phone even though its From is no-reply; every other no-reply sender still never
    alerts. The alert goes only to the owner's own push endpoints and verified number; the
    caller gets nothing (lead-channel threads are never drafted). Test in
    `emergency-alerts.test.ts`, plus a parity test of `phoneMessageSenderSql` against `channelOf`.
  - **Paused drafts aren't counted:** `QueueMember.paused` marks members on a plan-paused Gmail
    address; `actionableQueue` / `countQueue` leave them out, so the morning email (replies,
    nudges, needs-you), the badge, the phone's notification, the banner and the trial emails
    never count what the owner can't act on. The queue screen still shows them, marked paused
    (read-only card, no Send reply, no Other ways to reply).
    The morning email's money totals hold no drafts (won quotes and invoices, the same as Money
    and Activity), so the pause doesn't change them. Trial emails need a connected address the
    plan covers (`notPlanPaused()`); emergency alerts use `mailboxRunning()`. Static checks in
    `mailbox-plan.test.ts`.
  - The Growth boundary test lists the portal's files with reasons, and server imports of the
    portal modules are allow-listed (`accounts.ts` for `linkGrowthInvite`). `admin-no-content`
    covers /admin/growth's readers. The terms and privacy policy took clarifications only (trial
    emails, plan pause, emergency voicemails, alerts as a convenience, Growth as a separate
    service); the date stays 2026-10-16 with `TERMS_VERSION` (re-agree is Davi's call, LAUNCH.md).
- **Referral merge (2026-10-17, branch `referral-offer-a`):** the tip (cd15c59) merged into
  plan #47 offer A with `--no-ff`. Migrations `0039_referral_free_month` (when 1792211897302)
  and `0040_referral_after_end_check` (1792211898937), regenerated on top of `0038_growth`, SQL
  byte-identical; applied on a scratch database on top of main's journal (41 rows). The two
  plan-pause implementations became one (the decisions package's `plan_paused_at`, driven by
  `effectivePlan`; see #47 "Paused inboxes"). `FEATURE_REFERRALS` stays off; no amount or plan
  logic changed. New rule: a Growth request can earn a referral (#47 "The Growth door").

- **Wave 1 integration (2026-10-17, branch `integrate-w1` on `claude/squared-away-mvp-ddxl7s`):**
  `wave1-send`, `wave1-checks`, `wave1-home`, `wave1-safety` and `wave1-break` merged with
  `--no-ff` in that order.
  - **Migrations:** one chain after 0038 in merge order: `0039_send_path_sent_via` (when
    1792258162358), `0040_send_path_autopilot_claim` (1792258870232), `0041_licenses`
    (1792271229521; `0039_licenses` on its branch, regenerated with drizzle-kit on top of 0040, SQL
    byte-identical). Applied on a scratch database on top of main's journal: 42 rows, nothing
    skipped. The referral branch takes the numbers after these.
  - **Prompts:** `draft.v8` (Draft checks: Check 38 P6 licenses line, Check 40 P1 deductible, Check
    41 P1 safety), `voice.v3` (Check 23 P7 typed blanks), new kind `dispute-caution.v1` (Check 43
    P9). A dispute / legal draft stores `draft.v8+dispute-caution.v1` (a tweak
    `revise.v2+dispute-caution.v1`); `dispute-caution.test.ts` pins it to `ACTIVE.draft`.
  - **Edit box and blanks:** the Edit box's word swap (Check 9 P4: `{{time}}` shows as `[time]`)
    swaps only typed gaps; a `[name]`-style blank (Check 23 P7) shows as written, goes back
    unchanged, and is named in "Fill in [name] first" (`src/ai/gaps.ts`, test in
    `gmail-hiccups.test.ts`). The Queue's gap notice lives in `queue-messages.ts`: "Fill in every
    blank before sending. Nothing was sent."
  - **Merge of `wave1-safety` (same day, after the three above):** no migration. One `draft.v8`
    holds both groups' marked lines (Draft checks: Check 38 P6 / 40 P1 / 41 P1; Safety guards:
    Check 48 P1 "Who is writing"); `classify.v5` is Safety's (Check 22 P4 + 36 P1, 22 P3, 48 P1,
    22 P5). Safety notes keep their own versions (`safety-note.v1`, `safety-note-co.v1`,
    `safety-note-electrical.v1`) and never get the dispute caution. In `classifyPending` the
    code-only path after the AI limit (Check 39 P1) runs first and the change-order rule (Check
    38 P1) and quote acceptance run only on a model result. The business profile form has both
    the licenses group / MA deposit line and the remodeler's amount suggestions (the amount input
    is the controlled one). Privacy policy gained the safety-marks line (date unchanged).
    classify.v5's `co_alarm` is `z.boolean().catch(false)`; evals gained `coAlarmRecall`,
    `electricalHazardRecall` (strict) and `gasFalseAlarms` (no increase allowed). Evals not run.
  - **Merge of `wave1-break` (same day, last):** migrations `0042_paused_from` (when 1792276181035) and `0043_fallback_calls` (1792276182158), `0039_paused_from` /
    `0040_fallback_calls` on the branch, regenerated one at a time with drizzle-kit on top of
    0041 (SQL byte-identical). No prompt change. Three fence tests changed on purpose by the
    branch: `data-paths` checks `messages.create` (Check 29 P1 parses the answer itself; same
    single request, same data path), `e2e-mode` accepts `...anthropicClientOptions()` spread
    last (e2e mode still wins), `security-surface` has the new "shared-secret" route guard.
    `reviseDraft` takes both `openedHash` (Check 42 P2) and `aiMode` (Check 48 P4).
    **Integrator fix (missing model names the part):** `src/server/model-alert-rules.ts` (pure):
    `MODEL_PART` (classify → Sorting, draft → Drafting, voice → Voice learning),
    `stoppedHeading`, `modelDownEmail`, `modelDownLine`. `recordModelDown(role, model, now)`
    writes `model_down:<role>:<model>:<UTC day>` and emails once per role and model per day
    (`model_alert:<role>:<model>:<day>`), because drafting and voice share one model. The email
    says "Drafting is stopped: … Owners' replies are waiting to be drafted." (and so on);
    /admin's System box heading is "Sorting is stopped" / "Drafting is stopped" / "Voice
    learning is stopped" (several: "Drafting and voice learning are stopped") and each line
    starts with its part. Tests in `ai-client.test.ts`.
  - **Send path (wave 1, group "Send path"):**
    - **Check 9 P1 (seen text):** every Send reply (card, Edit box) posts `seen` = `bodyHash` of the
      text the card showed; the review page posts `seen:<draftId>` / `seenTo:<draftId>` per row.
      `queueSend({ seenHash })` returns `changed_since_seen` when the stored text differs, and the
      queue write itself only lands while `drafts.body` is still the text that was checked. The
      server action refuses a tap with no fingerprint (an old page) the same way; the JSON route
      takes an optional `seen` for online sends (409 `changed_since_seen`). Notice:
      "That draft changed since you opened it, so nothing was sent. Here's the latest version. Read
      it, then tap Send reply again."
    - **Check 42 P1 (answered from Gmail):** `answeredSince(threadId, since, mailboxEmail)`
      (`src/server/drafts.ts`): an email from the shop on the thread after the draft was written,
      not an unsent Gmail draft, not a practice copy (To/Cc only the mailbox's own address) and
      **not a side conversation** (`sideEmailSql`: a forward to the crew is no answer; the spec
      didn't say, but without it a forward to the crew would set the reply aside). queueSend and
      sendDraft return `answered_elsewhere` (with when) before any Gmail call; the Queue shows "This
      was already answered from Gmail at 2:14pm. Nothing was sent." with "Open the conversation in
      Gmail" (no Send anyway). reconcileDrafts sets a waiting reply aside (expired, Gmail draft
      deleted, note "Someone answered this from Gmail, so this reply was set aside.") after the
      customer-wrote-again and the Gmail-draft-gone branches. A send in its undo window is closed
      the same way by deliverQueuedSend, which logs `send_stood_down` {draftId, reason} (Activity:
      "Didn't send the reply to Dana: someone had already answered from Gmail") instead of
      `send_stopped`. Autopilot unchanged (its own newer-mail check runs first).
    - **Check 14 P1 (`drafts.sent_via`, migration `0039_send_path_sent_via`, additive):** app /
      autopilot / gmail / own_words; null = older rows, counted as before. Reconcile with our Gmail
      draft gone and a newer shop email: our message id or the same text (`prepareBody` +
      `sameText`) → `gmail` (`edited_and_sent` when the id matched but the text differs); otherwise
      `own_words` with status still `sent` (two-nudge cap unchanged), Activity
      `owner_wrote_own_reply` "You answered Dana yourself in Gmail" (no See record). decidedAt =
      that email's time. own_words is left out of monthSummary, the weekly scorecard's sent count,
      monthMoney's "paid after a follow-up" and the digest's "sent yesterday".
    - **Check 9 P2 (honest Hold it; migration `0040_send_path_autopilot_claim`, additive):**
      `drafts.auto_send_claimed_at`. `runAutopilotSend` claims the draft in one conditional UPDATE
      (pending, countdown due, unclaimed or claim older than `AUTOPILOT_CLAIM_LEASE_MS` = 2 min)
      before any Gmail call; only the claimer goes on, and the claim is released when it stands
      down, fails or throws. `sendDraft(by: "autopilot")` sends only a draft that is still counting
      down **and** claimed (an edit, hold or plan change that cleared the countdown wins);
      `queueSend` answers `already_sending` while a live autopilot claim holds it.
      `holdAutopilot` → `{status: "held"} | {status: "too_late", sent} | {status: "not_found"}`;
      "Held." only for a draft that did not go; too late → "Too late, autopilot already sent it.
      See it on Activity." (+ See record) or "Too late to hold: autopilot is sending it right now."
      The card shows a live countdown (`autopilot-countdown.tsx`: "Sends in 6 min", seconds in the
      last minute; the clock time once for screen readers) and refreshes every 4 s for a minute at
      zero.
    - **Check 42 P2 (never overwrite Gmail's text):** `saveDraftEdit` and `reviseDraft` read the
      Gmail draft first (reviseDraft before the model is called, and again before it writes): a
      different text there becomes the draft's (`takeGmailText`, countdown and queued send
      cleared) and they return `changed_in_gmail` without writing to Gmail. Both take an
      `openedHash` (the Edit box posts `opened`, the quick-change forms post `seen`): a stored text
      that moved on since → `changed_since_opened`, no Gmail call, no model call. The Edit box is
      now `draft-editor.tsx` with `editorAction` (useActionState; `saveDraftEditAction` is gone):
      it answers inside the card, puts the newest text in the box and keeps what was typed in a
      read-only "Your text" box. Quick changes redirect to `?error=changed_editing`.
    - **Check 8 P1 (no signal):** `NoSignalGuard` (`src/components/app/no-signal-guard.tsx`, once in
      the (app) layout) stops any form submit while `navigator.onLine` is false — a capture
      listener on `window`, ahead of React's own on `document` — unless the form is inside
      `[data-offline-ok]` (only the card's Send reply, and only with offline okays on). Strip above
      the tab bar: "No signal. Nothing was sent or changed. Try again when you have a bar."
      (role=alert, inverted), and a quieter "No signal right now." whenever offline. New
      `src/app/(app)/error.tsx` keeps the header and tab bar; offline or a failed request (a
      `TypeError`) says "We couldn't reach Squared Away. If this was a reply, open the Queue when
      you have signal: if the card is still there, it wasn't sent." Send reply shows "Still trying.
      Weak signal. Don't close the app." after 12 s (`send-button.tsx`, words only). Typed text is
      kept per tab in sessionStorage (`src/lib/kept-text.ts`, fingerprinted by what the screen
      showed so a stale copy is dropped once the save went through): the Edit box (key per draft;
      the card reopens the editor on reload) and the business profile form (`use-kept-form.ts`).
    - **Check 9 P3 (Gmail hiccups):** queueSend, saveDraftEdit, reviseDraft and discardDraft return
      `gmail_busy` (MailboxRateLimitError) or `gmail_failed` (anything else Gmail threw) instead of
      throwing; logged as `<where>_gmail_failed` {draftId, kind, error name}. Queue notices:
      `gmail_failed` "Gmail didn't answer, so nothing was sent. Try again in a minute.", and every
      notice a Send reply tap can reach now says whether anything was sent (unit test pins it).
      The Queue's notice words moved to `src/app/(app)/queue/queue-messages.ts`.
    - **Check 9 P4 (Edit box keeps the text):** the Edit box's Save changes and Send reply both go
      through `editorAction` (useActionState, `intent` = save | send); refusals answer inside the
      card (role=alert) and the editor stays open. Gaps show as words ([time], [job address]) with
      "Replace each [ ] before sending."; Send reply is replaced by "Fill in [time] first" while one
      is left; the text goes back with tokens (`toEditorText` / `fromEditorText` /
      `editorGapsLeft` in `src/ai/gaps.ts`), so the server's gap gate is unchanged.
    - **Check 43 P7 (stale "tomorrow"):** pure `staleTiming(body, createdAt, now, timeZone)` in
      `src/server/draft-timing.ts`: day words (today, tonight, tomorrow, this morning / afternoon /
      evening, this week / weekend, next week, later today; hoy, mañana, esta tarde; hoje, amanhã)
      when the draft's local day (owner's zone) is before today's; minute/hour words (in a few
      minutes, in an hour, shortly, right away) also when it's over 2 hours old. `sendDraft` and
      `queueSend` return `timing_check` {words, writtenOn, meant} before any Gmail call unless
      `confirmedTiming`; the queued send (`deliverQueuedSend`) passes it (the tap was checked
      seconds before); autopilot stands down with the note and can never confirm; batch counts it
      refused. The card shows "Written Friday. It says “tomorrow”, which meant Saturday. Check the
      timing." and Send reply becomes "Send reply anyway" (posts `confirmedTiming=1`), Edit stays.
      The JSON route takes `confirmedTiming: true` (else 409 `timing_check`); offline okays are
      refused with "its time words … may be out of date". **Wording differs from the spec** ("which
      now means Saturday" was wrong for a draft read days later): it says what "tomorrow" meant
      when written.
    - **Check 43 P9 (dispute caution; prompt `dispute-caution.v1`, new kind in the registry):** on a
      thread with `extracted.disputed` or the needs-owner reason LEGAL_REASON / DISPUTE_REASON,
      every draft (the owner's tap; jobs never draft these) and every quick change gets the fixed
      flag first ("This is about a dispute or something legal. What you write can be used later.
      Keep it short and factual; many owners call their lawyer or insurer first."), confidence
      capped at 40 (never Ready), and the fixed task line appended to the conversation's task.
      Stored prompt version `draft.v8+dispute-caution.v1` (was `draft.v7+…` on its branch) (or `revise.v2+…`). Eval cases
      `d-lawyer-reply`, `d-refund-dispute` (field `disputeCaution`); evals not run.
    - **Check 9 P10 (stopped / late sends):** `sentDraftSummary` now returns `stopped: {why}` when the
      newest send step for the draft is `send_stopped` (pending) or `send_stood_down` (expired),
      and `late` when its window ended over a minute ago and no job holds it. The Queue shows
      "Didn't send. It was changed in Gmail, so it's back below to check." (words shared with
      Activity via `sendStoppedWhy`), and lists late sends on top ("Waiting to send: reply to
      Priya", "Still sending. This is taking longer than usual.", Stop it = undo while unclaimed),
      refreshing every 10 s (`late-sends.tsx`, `lateSends()`).
    - **Check 38 P1 (change orders):** classification sets `extracted.change_order_approved` (only
      `true`, content-free) instead of `quote_accepted` when the email accepts and the thread's
      outcome was won before this email (`quote_outcome_at` < the email; any source; a legacy won
      with no time is not "before"). `createDraftForThread` never picks a deposit when the newest
      email is a change-order approval or the outcome was won before the newest customer email,
      and adds the fixed flag "Change order approved. Put it in writing with the price and any new
      finish date." Autopilot keeps refusing (accepts_quote). Eval cases `co-s3-lights`,
      `co-e02-vanity` (invented stand-ins: the review's E02 text wasn't in the prompt).
    - **Follow-ups on this branch:** the queue write also refuses a draft an autopilot run has
      claimed meanwhile (`already_sending`); the Send reply handler returns a kind and the actions
      redirect to fixed paths (the open-redirect fence, security-surface C4, stays unchanged).
  - **Draft checks (wave 1, group "Draft checks"):**
    - **Days and times as whole words (Check 20 P1 + 23 P3 + 23 P4, wave 1):** `src/ai/when-words.ts`
      (pure). `normalizeWhen` writes days, dates and times one way ("Fri" → friday, "8 a.m." → 8am,
      "Nov 27th" → november 27, "Mon–Fri" / "weekdays" → each day; "Sat", "Sun", "Wed" only when
      capitalised, since they are everyday words) and `whenTokens` turns them into keys; the check
      compares keys, never substrings ("fridge" no longer excuses "Fri"). New sources in
      `CheckContext`: `whenSourceText` (the conversation, seasonal notes **and their end dates**
      written "November 27", the owner's instruction / spoken words / a clean earlier draft — never
      the hours, lead time or policies), `hoursText` (its times always count; its days only with
      `allowHours`: the "Add my availability" tweak, or the customer asked when the owner is open,
      `asksWhenAvailable`), `leadTimeText` (only its "two weeks out" wording counts). Times now include
      "at 9", "around 8", "9:30", "9 o'clock", "10 a.m.", "in the morning"; loose timing adds "within
      the hour", "before the day is out", "by tonight", holidays as deadlines ("before Thanksgiving";
      any mention of the holiday in the conversation allows it), lead times ("three weeks out",
      "booked up through …"). A "today"/"tonight"/"tomorrow" whose only source is a customer email
      from an earlier local day gets "Says “tomorrow”, but they wrote that on Tuesday. Check the day."
      A never-promise item about same-day work is broken by "today", "tonight", "within the hour" or
      "before the day is out". Built in `whenContext()` in `src/server/drafts.ts` for new drafts and
      revisions. "This coming Friday" reads as Friday (the day token covers it).
    - **Money however it's said, round 2 (Check 23 P1 + 20 P11 + 36 P10, wave 1):** `moneyMentions`
      now reads k-ranges ("3-4k" → 3000 and 4000; not "model 3-4K" or "10k BTU"), spoken prices
      ("fourteen fifty", "twelve-fifty", "nineteen ninety-nine", "one fifty to come out" — only next
      to a price word; for one to twelve only the clearly-price words, since "it's nine thirty" is a
      time), "ninety-five bucks", "a buck fifty", "a hundred and a quarter/half", "seven hundred
      fifty" (750) and "two thousand five hundred" (2500), €/£, "dólares"/"reais"/"pesos" (with
      "1.500" thousands), "R$ 1.500,00", "mil quinientos", and the price words es / cuesta (unos) /
      custa / fica em. New `vagueMoney()` ("low four figures", "a few bucks", "couple hundred
      bucks"): autopilot's `mentionsMoney` counts it, and checkDraft flags it (hit `money`, cap 0.3)
      "Gives a rough price (“low four figures”). Check you want to name a number." unless the owner
      wrote it. Soft promise "for free" (also free of cost / won't cost you / we'll cover it); an
      owner whose text offers free estimates may say "estimates are for free".
    - **Claims, licenses and credentials (Check 23 P2 + 38 P6 + 36 P7, wave 1, migration
      `0039_licenses` on this branch — renumber at merge):** `business_profile.licenses` jsonb
      (`src/config/licenses.ts`: `hic_number`, `hic_expires_on`, `csl_number`, `lead_safe_license`,
      `insurance_carrier`; one line each, ≤40 characters). Settings → Your business → Edit business
      profile has a "Licenses and registrations (optional)" group (also in setup's optional
      section); a form without the fields leaves them alone, an emptied line clears it. Settings →
      Your business lists them and shows one line when the HIC runs out within 30 days (no email).
      **Never on the public site** (Davi: no license number published until confirmed). Drafting:
      `draft.v8`'s business block adds "Registration and licenses (quote exactly; never add
      others)" (so revise / follow-up / purpose prompts that share `workspaceBlock` see it too), and
      "Never invent" says never give another number or claim an unsaved credential; the numbers are
      owner text for the check. checkDraft: a number after HIC / CSL / CS- / MP- / JP- / MGF / LR- /
      license / lic. / registration / reg # (3+ digits) whose digits aren't in the owner's text →
      hit `license` ("Mentions a license or registration number you haven't saved. Check it.", cap
      0.3, in `REGENERATE_ON`), and the money finder never reads it as a price; "we're registered /
      licensed / lead-safe certified / insured" with the matching field empty and not in the
      owner's own words → hit `credential` ("Says you're registered and licensed. Add it in
      Settings or take it out.", cap 0.5, flag only). "Licensed" is also backed by a license
      number in the owner's text (a plumber's MP- in the signature). The old "licensed and
      insured" soft promise became these claims. Warranty / guarantee / promise words now compare
      with the owner's text only (a customer's "is that under warranty?" no longer excuses it). New
      soft promises: no permit needed (incl. "skip the inspection"), up to code, waived fee, price
      match, fit you in.
    - **Prompt versions after wave 1 "Draft checks":** `draft.v8` (Check 38 P6 so far; later steps
      add to it). `draft.v8` re-exports draft.v7's reply schema / openings / first-contact task and
      draft.v6's conversation block; its `workspaceBlock` is v6's plus the licenses line.
    - **Insurance-job promises (Check 40 P1, wave 1):** `INSURANCE_PROMISES` in draft-checks.ts —
      cover / waive / absorb / eat / take care of / pay the deductible, "insurance will cover",
      negotiating or dealing with the adjuster, handling the homeowner's claim, assignment of
      benefits, "sign … today", "free roof", "no cost to you" / "nothing out of pocket". Only when
      the owner never wrote it. Hit `insurance`, cap 0.2, in `REGENERATE_ON` (one fresh attempt),
      flag "Talks about the deductible or the insurance claim in a way you may not be allowed to
      promise. Check it." Any flag already keeps a draft out of autopilot and Send together (tested).
      `draft.v8` "Never invent" gains the deductible / claim / sign-today line.
    - **Lead-paint and safety claims (Check 41 P1, wave 1):** `SAFETY_CLAIMS` in draft-checks.ts —
      "no lead worries" (no need to worry about lead, lead-free, no lead), "safe for people or
      pets" (safe / harmless / non-toxic within a sentence of kids, baby, pets, dogs, family…,
      either order), "pet and kid safe" (pet-safe, kid-friendly…), and on an older home only
      (`olderHome()`: a year 1800–1977 near built / house / home / colonial, or "old house",
      "pre-1978", "victorian") power sanding, sandblasting, torching, burning off, heat guns. Only
      when the owner never wrote it. Hit `safety`, cap 0.3, in `REGENERATE_ON`; flag "Says “…”.
      Safety and lead claims are yours to make, not the assistant's. Check it before sending."
      `draft.v8` "Never invent" gains the safe / non-toxic / lead line. Eval cases: nursery paint,
      1924 colonial exterior, lawn treatment with dogs, mice bait with a toddler.
    - **Rule claims and rebate promises (Check 39 P4 + 37 P5, wave 1):** a draft sentence naming a
      program or rule word (rebate, incentive, tax credit / credit — not "credit card" — HEAT Loan,
      Mass Save, 0% loan, qualify, eligible, EPA, R-22, R-410A, R-454B, R-32, freon, refrigerant,
      banned, phased out, legal / illegal, no longer made / allowed, code requires) that the owner's
      own text (profile, price list, notes, instruction, their emails) never uses → hit
      `rule_claim`, "Says something about a rebate, tax credit or refrigerant rule. Check it's still
      true before sending.", cap 0.5, flag only (not in `REGENERATE_ON`, no extra model call). New
      soft promise "a rebate or utility will pay" (Eversource / National Grid / Unitil / Mass Save /
      the utility / rebates … covers / pays for / gives back / free / no cost; "you'll qualify for
      the rebate").
    - **“That's covered” and overages (Check 38 P7, wave 1):** new soft promises (owner-text rule,
      usual "make sure you stand behind that" wording): "that's covered" (that's / it's / this is
      covered, "covered under warranty / labor"; not "covered with plastic" or "you're covered for
      Tuesday"), "fix it for free", "add it to the (final) bill / invoice / price", "that's fine"
      right before an amount or "over", "no extra charge / cost / fee".
    - **Light payment-terms check (Check 23 P5, wave 1):** every ordinary reply now carries
      `termsSource` (payment terms + policies + price list, plus the owner's spoken words on a
      tweak) and `ownerWrote` (the owner's emails on the thread, a clean earlier draft). checkDraft
      flags a way to pay said the draft's way ("Venmo works", "by Zelle", "pay in cash"), deposit
      wording ("half down", "a deposit of", "30% up front") and credit terms ("net 30", "due in 15
      days", "pay later", "payment plan", "financing") that the owner's terms and emails don't say:
      "Mentions “net 30” — that isn't in your payment terms. Check it.", cap 0.5. **Adapted:** its
      hit is `payment_terms`, not `terms` as the prompt says, because `terms` is in `REGENERATE_ON`
      and the prompt says this one must flag without a rewrite. Off when a caller gives no
      `termsSource` (old callers unchanged). "Let me check" and "card" alone stay clean.
      (draft.v6's vocabulary line "T&M vs. fixed price, net 30" is Check 23 P11's, in the review's
      draft.v7 bundle — not done here.)
    - **Massachusetts deposit cap (Check 38 P2, wave 1; uses wave 0's `business_profile.state`, no
      migration):** "Which state do you work in?" (two-letter select, "Not set" allowed; in setup's
      optional section and Settings; **no** preselect from the browser's time zone — the owner
      picks it). `src/server/deposit-rules.ts` (pure): `depositShare()` reads the largest share paid
      before work ("50%", "40 percent down", "half down", "two-thirds up front", "a third at
      signing", "60/40", "in full up front"; a share only counts in a deposit clause, so "70% on
      completion" and "10% off" don't), `overMaDepositCap()` (> one-third, MA only; "33%" and
      "one-third" are fine). Wording and numbers in `src/config/ma-rules.ts`. An MA shop whose
      payment terms ask for more sees, under "How do you get paid?" and on Settings → Your
      business, "In Massachusetts a deposit can't be more than one-third of the contract, unless
      special-order materials cost more (c.142A §2). Check this line." (the save still goes
      through). checkDraft flags any MA draft (deposit notes included) that states a share over a
      third: hit `deposit_cap`, "Massachusetts caps a deposit at one-third, or the cost of
      special-order materials if higher. Check this before sending.", cap 0.5, never rewritten.
      `SelectField` gained `emptyLabel` (an empty choice the owner can pick).
    - **Phone numbers, links and names nobody gave (Check 23 P6, wave 1):** checkDraft flags (hit
      `contact`, cap 0.3, in `REGENERATE_ON` — one fresh attempt) a US phone number whose digits
      aren't in `sourceText` ("Has the number 978-555-0142, which isn't in your profile or this
      email. Check it."), any link or email address not in `sourceText` (a review request's own link
      keeps its own check), and a name the draft introduces — "my guy Pete", "our tech Luis", "the
      Hendersons", "for Marie last week" — found nowhere in the conversation, the profile or the
      conversation's From names (`knownNames`, from drafts.ts) ("Mentions “Pete”, who isn't in this
      email or your profile. Check it."). Narrow on purpose: greetings, towns, streets, days,
      holidays and brands ("for Eversource customers") don't trip it. At most two contact lines per
      draft. Any flag already keeps a draft from autopilot (tested).
    - **[name]-style blanks are gaps (Check 23 P7, wave 1):** `findGaps` now also returns the
      blanks the send gate already refused (`OTHER_PLACEHOLDER`): "[name]" → their name, "[time]"
      → time, "[date]" / "[day]" → date, "[price]" / "[amount]" / "$___" / "$X,XXX" → price,
      anything else → its own words; `fillGap` fills them the same way, in text order. So the card
      shows a chip, counts it in "Fill in N gaps to send", and never shows Send reply or Ready
      until it's filled. checkDraft adds "Has a blank (“[name]”) to fill in." (hit `blank`, cap
      0.6, no rewrite). The queue's gap notice is now "Fill in every blank before sending. Nothing
      was sent." Prompt **`voice.v3`**: sample replies use `{{custom:name}}`, `{{custom:address}}`,
      `{{date}}`, `{{time}}`, `{{price}}`; Settings → Your voice shows them as "[name]" etc.
      (`showGaps`), never braces. Profiles learned with v2 keep "[name]"; the card handles those.
      No voice eval set exists, so none was extended.
    - **Whole-word phrases (Check 23 P10, wave 1):** `phraseRegex()` in draft-checks.ts (escaped,
      inner spaces match any whitespace incl. a line break, no letter or digit either side, `iu`,
      curly quotes read as straight) for the never-say list, the voice's avoided phrases and FILLER.
      "hun" no longer flags "hunt", "sir" no longer flags "desire"; "Thanks hun!", "no problem!"
      and "a.s.a.p." still do.
    - **Filler variants (Check 23 P13, wave 1):** FILLER adds thanks (so much) for reaching out, I
      hope you're / you are doing well, hope all is well, don't / do not hesitate, I / we apologize
      for any inconvenience, at your earliest convenience, please be advised, rest assured, valued
      customer ("sorry for the delay" stays off). **Adapted:** on a first reply to a new lead
      (`firstContact` in the check context, from drafts.ts) "Thanks (so much) for reaching out" is
      not filler, because draft.v7's first-contact section (Davi, 2026-10-16) tells the drafter it
      may open that way.
    - **Price-list wording (Check 23 P14, wave 1):** `priceListRows()` reads each price-list line:
      its amounts, the qualifier on its first price ("from", "starting at", "starts at", "about"
      before it; "plus parts" / "+ parts", "per hour" after it) and its job words (longer than
      three letters, before the colon or the first price). checkDraft (given `priceList` = the
      owner's price list, from drafts.ts) flags a listed amount written without its qualifier
      ("Gives $1,450 without “from”, as your price list has it. Check it." — "from", "starting" and
      "starts" count as the same) or in a sentence with none of the line's job words, as whole words
      ("Uses your $1,450 price for something else. Check it."). **Adapted:** hit `price_list`, not
      `money`, because the prompt says these join `REGENERATE_ON` only if Davi says so (`money` is
      in it). Cap 0.5.
  - **Homepage words (wave 1, group "Homepage words"):**
    - **Homepage copy module (wave 1, Homepage words):** the homepage's steps, feature cards, FAQ,
      promise band and pricing paragraph live in `src/components/marketing/home-copy.ts` (pure);
      `src/app/page.tsx` renders them, and tests read the strings as visitors see them
      (`homepageFaq()` in `legal-docs.test.ts` now looks the answer up in `faqs`). Plan cards are
      `src/components/marketing/plan-cards.tsx`, keyed on plan ids.
    - **Rule numbers in one pure place:** `src/config/rules.ts` holds `EARN_THRESHOLD`,
      `GRACE_MINUTES` and `MAX_FOLLOWUPS` (re-exported from `src/server/autopilot.ts` and
      `src/server/drafts.ts`, so callers didn't change). The homepage builds every rule number from
      them (`numberWord()` in `src/lib/number-words.ts` spells 1–10).
    - **Trial length words:** `src/lib/trial-words.ts` (`dayWord`, `daysPhrase`, `dayAdjective`);
      nothing in `src/` types "three days" / "three-day" / "Day N of 3" / "3 more days" (guard test
      in `tests/unit/trial-words.test.ts`, skipping `src/ai/prompts/` and comment lines; setup
      steps "Step 1 of 3" aren't the trial and aren't caught). `TRIAL_NO_SEND_LINE` is built from
      `pricing.evaluationDays`. The trial banner is `TrialClock` (`src/components/app/trial-clock.tsx`)
      and says the clock's own length (`daysPhrase(clock.of)`), so a trial extended in /admin reads
      "Day 3 of 6 · … your six days". `trialLengthDays(w)` (lifecycle.ts) gives the same length to
      the Send reply note and the after-trial reason/banner ("Your six days are up."). Activity:
      "Your three days started" (config), "Your trial ended", "Your trial was extended by three
      days". Practice copies say "During your trial, Squared Away only sends to you." Admin buttons:
      `Give ${evaluationDays} more days` / `Add ${evaluationDays} days`. A unit test fails with "ask
      Davi to update the terms" if `evaluationDays` changes while `docs/terms.md` says "three-day
      trial".
    - **Plan lines by id:** `src/server/plan-features.ts` (pure): `FEATURED_PLAN`,
      `planFeatureLines(id)`, `autopilotPlanNames()`, `SIGN_INS_PER_PLAN`. Used by the homepage
      cards, `/billing` and autopilot's lock reason. No page compares a plan's display name.
    - **First payment on the homepage cards:** each card shows `firstChargeLine(id, true)` (the
      setup fee always included for a visitor), as `/billing` does. The standalone "Plus sales tax
      where it applies." note is gone from the homepage and `/billing` (each card's line says it);
      `SALES_TAX_NOTE` stays exported.
    - **Setup call wording:** `SETUP_CALL_COVERS` + `setupCallSentence("before" | "after")` in
      `billing-rules.ts`: "your prices, hours, service area and the things you never promise", then
      "tune your drafts until they sound like you". Used by the homepage setup box, `/billing`
      (before and after paying) and the setup_paid banner. "Scheduling" is gone.
    - **Homepage feature cards (nine):** Knows your trade · Won't take orders from strangers · Sorts
      every email (with the morning summary as its last sentence) · Writes like you · Chases quiet
      quotes (only quotes the customer emailed about and the owner emailed back; "Quotes sent from
      other software are left to that software"; "I called them" stops it) · Every quote in one list
      (stage names from `stageLabel`) · Who owes you · Your customers, in one place · Your data stays
      yours. No "Buzzes you" card (phone alerts aren't live until the VAPID keys are in) and no
      Autopilot card (its rules are in the first FAQ, the plan cards and the pricing paragraph,
      which now also says autopilot never answers a complaint or sends a reply that mentions money).
    - **Queue picture:** shows Send reply (across the card) with Edit and Discard under it, as the
      real card lays them out; no trial banner inside the phone; one caption under it: "Example.
      During your three-day trial it drafts like this, but won't send to a customer."
    - **Join button:** the header says "Join the waitlist" (was "Get on the list"), like every other
      join action.
  - **Safety guards (wave 1, group "Safety guards"):**
    - **Gas, propane, CO and smelly water (Check 22 P4 + Check 36 P1):** `mentionsGasSmell`
      (`src/ai/guards.ts`) first removes printed advice ("Smell gas? Leave the building…", "if you
      (ever) smell gas…", "gas odor calls…"), then matches gas / propane smells, a gas leak (not "gas
      leak detector / test"), a leaking or hissing gas line, Spanish and Portuguese, and a red tag only
      next to the word gas or propane (an electrical inspector's red tag is not a gas leak).
      Rotten-egg / sulfur smells are gas **unless** every one sits in the same sentence as a water word
      (water, shower, faucet, tap; "water heater" doesn't count) and nothing names gas, propane, a
      meter, stove, range, oven, furnace, boiler, pilot or dryer — then `mentionsWaterSmell`:
      needs you at normal priority, `WATER_SMELL_REASON`, `extracted.water_smell`, owner-rule key
      `water_smell`, no safety note, no emergency. The model's `smells_gas` only overrides the water
      reading when the email names gas or propane.
    - `mentionsCarbonMonoxide`: a CO word (carbon monoxide, CO alarm/detector, "co2 detector") with
      something happening within 60 characters (went off, going off, sounding, a reading, ppm,
      detected, headaches, dizzy…; beeping only without battery/chirp), or "detector going off" next
      to a furnace / boiler / heater (not a smoke detector). An install quote is not an alarm.
      `CO_REASON`, `extracted.co_alarm`, urgency emergency, owner-rule key `co_alarm`; treated like gas
      everywhere (needs you, high, emergency lane and night alerts through the urgency mark, autopilot
      and batch refuse it). Gas wins when both.
    - **Safety notes:** one per thread (purpose `safety`, gas or CO). The CO note is
      `coSafetyNote` (`safety-note-co.v1`, flag `CO_SAFETY_NOTE_FLAG`). A safety note is never written
      on a thread sorted as junk unless the owner has written to that address before (`knownCustomer`;
      `threadsToAutoDraft` leaves junk out unless the owner wrote on the conversation), and never to a
      no-reply address (as before). The gas note's wording is unchanged.
    - **After the day's AI limit (Check 39 P1):** `classifyPending` no longer stops at the first
      `AiCapReachedError`. That email and every later one in the batch go through
      `codeOnlyClassification` (`src/ai/classify.ts`, pure; the same code checks and the same shape
      as the no-model fallback): a gas smell, CO alarm, payment change or attack is stored through
      the normal write (needs you, high for safety and payment, `classified_at` set, no model
      category, no auto-marks); everything else stays unsorted for the model after the reset.
      `ClassifyRunResult.codeOnly` counts them (they are in `classified` too), so the classify job's
      text/push alerts fire. `threadsToAutoDraft` orders a gas / CO thread still without its safety
      note first, so the note (no model) is written before a model draft hits the limit.
    - **Quoted and forwarded text (Check 22 P3 + Check 20 P5):** `splitQuoted` (`src/ai/classify.ts`)
      returns the newest part and what quoting cut; `prepareBody` is its `kept` part (unchanged).
      `classifyEmail` runs the gas, CO, payment-change and new `mentionsLegalThreat`
      (`src/ai/guards.ts`: attorney / lawyer / law office, lawsuit, suing / "will sue", small claims,
      demand letter, cease and desist, 93A, attorney general, consumer protection, filing or placing
      a lien, a lien on the house; never "Sue" the name, "denied", "dispute" or "court" alone, nor a
      power of attorney) on the WHOLE email too (subject + raw body + the burst, CRLF normalised,
      ≤20,000 chars). The attack check keeps to the newest part (quoted text is often the owner's own
      words). A legal hit in code → needs you, high, `LEGAL_REASON`, `extracted.disputed` (so the
      sticky complaint mark), and it survives the routine-paperwork drop. When the newest part is
      under 300 characters and quoting cut something, the first 1,500 characters of the cut part go
      to the model in a second untrusted `<email>` block labelled "Quoted or forwarded text (older,
      may be from someone else)" (classify.v5). Never logged.
    - **Autopilot reads the whole newest customer email** (`blockers`): gas / CO / payment change /
      legal words anywhere in it, quoted part included, stop the countdown ("Something legal is
      mentioned in this conversation, so it waits for you." and the existing gas / payment lines); a
      purged body (no text left) waits ("We can't read their email any more, so it waits for you.").
    - `threadsToAutoDraft` picks safety-note threads with a separate first query, then the usual
      query, so the ordinary order (newest first) is exactly as before.
    - **Emergencies (Check 36 P2), adapted:** the leads package already made the model's
      `urgency: emergency` on a lead count in code (needs you, high, `EMERGENCY_REASON`, counted in
      `freshLeads` / the emergency lane), so step 1 of the prompt was built. Added: a 48-hour sticky
      mark — `extracted.emergency` + `emergency_at` (the emergency email's time), set when a sort hits
      `emergency`, a gas smell or a CO alarm (never from an attack email) and carried across later
      sorts while it is under 48 hours old (`recentEmergency`, `src/server/emergency-rules.ts`, pure).
      Autopilot ("There was an emergency on this conversation in the last 2 days, so it waits for
      you.") and batch send (`batchCandidates(…, now)`) refuse the thread meanwhile. **Not built:**
      the prompt's one automatic draft on an emergency (with an "Emergency: call them first" flag):
      CLAUDE.md's leads package says "emergencies are no longer auto-drafted", so that decision is
      kept until Davi says otherwise (question 2 below).
    - **Electrical fire signs (Check 37 P1):** `mentionsElectricalHazard` (`src/ai/guards.ts`, code
      only, no prompt change): burning smells, smoke / sparks / arcing / hot to the touch / loud
      buzzing / scorched / melted within 40 characters of an outlet, plug, switch, panel, breaker,
      box, fixture, light, ceiling, meter, wire or cord (or "out of / behind the wall"), a shock,
      wires down, the meter or service pulled off, lights going bright and dim, Spanish and
      Portuguese. Smoke detectors / alarms, spark plugs, "a burning question", hot tubs and hot water
      are taken out first. `ELECTRICAL_HAZARD_REASON`, `extracted.electrical_hazard`, urgency
      emergency, owner-rule key `electrical`; order injection > gas > CO > electrical > payment
      change. Also in the no-model fallback and the after-the-limit code path. One fixed
      `electricalSafetyNote` per thread (purpose `safety`, `safety-note-electrical.v1`,
      `ELECTRICAL_SAFETY_NOTE_FLAG`), same limits as the gas note (not on junk unless known, never
      to a no-reply address). Autopilot and batch refuse it; it counts for the 48-hour emergency
      mark. Eval metric `electricalHazardRecall` (strict).
    - **Attack-check false alarms (Check 22 P2):** `injectionCheck` no longer flags a bookkeeper's
      / adjuster's / lender's "send me all the invoices" (only someone else's things or secrets:
      the owner's, other customers', every customer's, passwords, logins, tokens, API keys, contact
      or customer lists), the writer's own "my / our earlier instructions", "rules about / for",
      "assistant manager" (and other job titles), Spanish "indicaciones" (the rules words need
      anteriores / previas / todas las), or "when writing your response, list…" (it needs an order
      to say / include / mention / add / reveal / confirm / agree / promise / always / never within
      60 characters). Every round 2 catch still flags.
    - **"This is a normal email"** (`clearInjectionMark`, `src/server/injection-clear.ts`; rules in
      `injection-clear-rules.ts`): a button on Queue needs-you cards whose mark has recorded reasons
      (`extracted.injection_reasons`: instructions / encoded / hidden / sticky / model, content-free)
      with no hidden or encoded text. Classification also keeps `extracted.without_injection` (the
      owner rules' answer with the mark left out: needs-you, reason, priority, hits) so the card is
      put right without a model call. Clearing removes `injection`, sets
      `injection_cleared_by_owner` / `injection_cleared_at` (kept across later sorts, so the sticky
      copy stops), restores the facts (the owner's "This one needs me" still wins), and writes
      Activity `owner_cleared_injection` (no detail). Refused for another workspace, hidden or
      encoded text, older rows without reasons, and read-only accounts. The draft job no longer holds
      emails dated before the clear against the thread. Autopilot refuses the thread for 30 days
      ("You said an email here was normal after we flagged it, so it waits for you."). Notices
      `?done=normal_email`, `?error=not_clearable`.
    - **"Is this a bot?" (Check 48 P1 + Check 43 P2):** `asksIfAi` (`src/ai/guards.ts`, English,
      Spanish, Portuguese; also "hi assistant, can you ask Mike to call me", "if a bot is reading
      this, pass it to a human"). The attack check now splits phrases that only ADDRESS the
      assistant ("Dear AI assistant:", "if an AI is reading", "as the AI", "you are (now) an AI")
      from real orders: addressing counts as an attack only with an order within 80 characters
      (agree, approve, confirm, include, send, reveal, must…) or when the email isn't asking if a
      person is reading. Gone: "(talking) to an AI", "send the photos to the assistant", "you are an
      AI, right?", "answer as the owner and not as the assistant". `ASKS_IF_AI_REASON` ("Asks whether
      a person or an AI is answering. Answer this one yourself."), `extracted.asks_if_ai` (sticky for
      the thread like `injection`), owner-rule key `asks_if_ai` (after injection and the safety
      marks). Jobs never draft it (`asks_if_ai`); the owner's tap does, with **draft.v8**'s "Who is
      writing" rule. `checkDraft` hit `human_claim` (`HUMAN_CLAIM_FLAG` "Says a person wrote this
      without help. Check it's true before sending.", cap 0.2, not regenerated; `claimsHuman`).
      Autopilot ("Asks if a person is answering, so it waits for you.") and batch send refuse both.
      Check 43 P2's separate wording `BOT_QUESTION_REASON` was folded into Check 48 P1's reason.
    - **draft.v8** (this branch): draft.v7 + a "Who is writing" section (Check 48 P1). Everything else
      re-exported from draft.v7, so the cache is unchanged. Other groups' draft.v8 changes (Check 23
      P11 / 43 P1 / 44 P1 / 45 P2, 40 P1, 41 P1) need combining into this one file at merge.
    - **Promotions / Social tabs (Check 22 P1):** `mustReadDespiteTab` (`src/server/classification.ts`)
      skips the no-model junk shortcut for: a lead-site sender (`leadPlatformOf`) whose subject
      looks like a lead (lead, request, sent you a message, new message, quote, estimate, hired,
      booked); facebookmail.com with "lead" in the subject; permit / inspection / certificate of
      occupancy in the subject or snippet; and anything the code checks catch (gas, CO, electrical,
      payment change, attack). A lead site's own marketing keeps the shortcut. The municipal, phone
      and sticky-mark exceptions are unchanged; the shortcut's result shape is unchanged.
    - **Payment change (Check 22 P5):** `looksLikePaymentChange(text, { supplier })` splits "pay
      somewhere new" (pay / wire / send TO a new account, "update your records … new bank", "don't
      pay the old account", gift cards of any brand up to three words) from "details changed", which
      counts only with "our" / "the" and an ask within 60 characters (update, use, send, remit, pay,
      wire, attached, below, going forward) — or always for a supplier (`supplier_vendor` sort, or a
      thread whose stored `bill_direction` is `owed_by_business`). A customer's own card, bank or
      payment info ("my", "I") never counts. classify.v5's `payment_change_request` says the same.
      The reason text is unchanged.
    - **Real legal words (Check 22 P11 + 36 P6 + 45 P4):** `REAL_LEGAL` drops "denied", "denial" and
      a bare "court" (kept: "take / see you in court", "court date / case / order"); "dispute" counts
      only as disputing a charge / bill / invoice / payment, "disputing the / your…", "filed a
      dispute" or a chargeback. Added other states' words (DTPA, FDUTPA, CUTPA, CSLB / Contractors
      State License Board, Registrar of Contractors / "ROC complaint", DBPR, TDLR, licensing board
      complaint, recovery fund, deceptive / unfair trade practices) and Spanish (abogado(s),
      demandar, poner una demanda, queja formal; not "corte" or a bare "demanda"). A lawyer word in
      the same sentence as closing / title / real estate / purchase and sale is not a threat. Both
      `mentionsRealLegal` and the code legal check `mentionsLegalThreat` use the sentence rule and
      the state words. Note: removing "dispute" alone / "court" / "denied" can drop a legal mark that
      was set before, as Check 22 P11 and 36 P6 ask; Check 45 P4's "only add" applies to its own
      words. Evals not run (`pnpm eval --no-drafts` needs `ANTHROPIC_API_KEY`), so needs-owner recall
      wasn't measured live.
    - **The money limit (Check 38 P3 + 22 P6 + 39 P2):** in `applyOwnerRules` the amount rule
      never applies to junk (`noise`), ignores `incentiveAmounts` (a "$" figure with rebate,
      incentive, tax credit, credit of, loan, financing, 0%, zero percent, per ton, grant, Mass
      Save, HEAT Loan or utility program in the same clause within 40 characters; whole dollars) and
      amounts the owner already wrote on the conversation (`ownerAmounts`: `moneyMentions` of the
      owner's own non-draft, non-side emails, quoted text cut; never logged). "New customer asking
      about a big job." now reads before "Mentions more than $X." (`owner_rule_hits` already holds the
      content-free codes, so no `owner_codes`). `extracted.dollar_amounts` is stored as the model
      gave it. `prepareBody` also cuts at an Outlook header block (From: then Sent:/Date: and
      Subject: within four lines, only below something the sender wrote) and at Spanish "El …
      escribió:" / Portuguese "Em … escreveu:". Setup asks a remodeler (main or extra trade) for the
      amount up front with the hint "Most of your job emails mention big numbers…" and suggestion
      buttons (`AMOUNT_SUGGESTIONS` in `src/config/trades.ts`; $10,000 / $25,000 are the review's
      examples, question 4); other trades keep it folded. The stored default ($2,500) is unchanged.
      The eval stand-in now lists every $ figure, and the unit test checks each case's needs-you
      against the code; `v-statement` now expects needs-you (question 5).
  - **When things break (wave 1, group "When things break"):**
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
      model not available (<model>)." and the heading "Sorting is stopped" (integrator: each line and the heading name the part that stopped, see the merge block above).
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

- **Referral merge 2 (2026-10-18, branch `referral-offer-a`):** production `main` (bae1387, PR
  #13, wave 1 included) merged into plan #47 offer A with `--no-ff`. Migrations renumbered after
  `0043_fallback_calls`: `0044_referral_free_month` (when 1792287535388) and
  `0045_referral_after_end_check` (1792287541302), regenerated one at a time with drizzle-kit on
  top of the 0043 snapshot, SQL byte-identical; applied on a scratch database after main's
  journal. Conflicts kept both sides: the Stripe webhook keeps wave 1's paused rule (Check 17 P1:
  a paused account stays paused and Stripe's verdict goes to `paused_from`) inside the referral
  branch's `applyLiveSubscription` / `applyCheckoutCompleted` transactions, so the plan effects
  and `fitMailboxesToPlan` (driven by `effectivePlan`) still run with every plan write, paused or
  not; autopilot layer 1 reads `effectivePlan` with wave 1's `autopilotPlanNames()` wording; the
  Queue's countdown (wave 1's ISO time + clock) shows only while autopilot is open; Activity's
  `send_stopped` keeps the plan-pause line and otherwise uses wave 1's `sendStoppedWhy`; the
  status banner keeps wave 1's setup-call sentence with the free-month card under it.
  `FEATURE_REFERRALS` stays off.

- **Wave 2 merge A (2026-10-18, branch `integrate-w2a`):** the Voice, Inbox, Sync and Gmail
  connect, and Queue screen groups merged with `--no-ff`, in that order, on top of cc34707 (main
  plus the referral offer). Migrations regenerated one at a time with drizzle-kit on the previous
  snapshot (SQL byte-identical to each branch's; the voice branch's hand-edited 0040 snapshots
  were dropped and `learned_from_mailbox_id` regenerated without a foreign key from the schema):
  `0046_voice_attempts`, `0047_voice_learned_from`, `0048_voice_examples_stale`,
  `0049_voice_retries`, `0050_needs_owner_since` (was `brown_dreadnoughts`; adds
  `threads.needs_owner_since` and `quote_dismissed_at`), `0051_gmail_units`, `0052_resync_cursor`,
  `0053_attachment_counts`, `0054_job_runs`, `0055_backfill_cursor`, `0056_mailbox_email_index`,
  `0057_onboarding_done`. Prompt lines the groups couldn't write wait in
  `docs/notes/prompt-versions-inbox.md` for the Prompt versions group (voice-examples.v1, the
  classify reason wording, `acknowledgment_only`, the follow-up "look it over" line, the
  `Attached:` line and photo rule). Reconciled with wave 1:
  - The 15-minute `workspace-lifecycle` job is four `runChecks` steps (clock / backstops /
    housekeeping / alerts, at most 4 `step.run`, one try/catch per check with a Sentry capture);
    wave 1's `enforce-plan-autopilot` is in clock, `restartVoiceLearns` (not
    `workspacesNeedingVoice`) in backstops, `runReferralRewards` and the voice clean-up in
    housekeeping, Check 1 P4's `record-run` last in alerts. A failed check throws
    `LifecycleChecksFailedError` at the end, then Check 18 P1's access-alert report
    (`reportAlertFailures`). A failed check isn't retried within the run (its step is memoized); the next
    15-minute run tries again.
  - `deliverQueuedSend`: the Trash/Spam check (`threadGoneInGmail` → `left_inbox`) runs before
    `sendDraft(…, { queued, confirmedTiming })`; wave 1's answered-elsewhere stand-down stays.
    `reconcileDrafts`: an auto-reply never expires a draft, beside wave 1's Gmail-reply rule.
    `runAutopilotSend`: wave 1's stale-timing note and sync's "left your inbox" both stand it
    down; `blockers` reads the customer's subject, body and `auto_reply`. `threadsToAutoDraft`
    keeps wave 1's safety-first shape plus the auto-reply / acknowledgement filters.
  - Classification: wave 1's `codeFallback` (model failure and the AI-cap code path) now also
    stores `extracted.unreadable`, so Inbox says "Couldn't sort"; the Inbox group's plain reasons
    (`COMPLAINT_REASON` etc.) with wave 1's `legalThreat` check; `OLD_LEGAL_REASON` stays a
    dispute reason. Wave 1's new safety reasons already had no dashes.
  - Voice: `learnVoice` keeps `voice.v3` and 8192 max tokens around the scrub, accepted ideas and
    stale samples; the reader is `serverMailboxClient` with `{ sentOnly, newerThanDays: 365 }`.
  - Activity's `sendStoppedWhy` gains `archived_in_gmail` / `left_inbox`; Settings → Your Gmail
    has the free-month limit and note with the first-read progress and `?add=1`; Inbox cards
    carry Draft ready, attachments and the bounced line together; `CalledThem` takes both `back`
    (Inbox, fixed `/inbox` redirects) and `compact`, and the Queue's next-card redirect; queue
    draft cards keep the referral merge's `autopilotOpen` check and the attachment line.
  - `resyncPage` also clears answered "Needs you" when a re-read finishes (Check 10 P1).
  - Integrator decisions: `runVoiceIdeaCleanup` (`src/server/voice-idea-cleanup.ts`, housekeeping,
    `app_settings` `cleanup:voice-idea-edited-v1`, tested): a voice marked `edited` with an idea
    accepted after its newest `voice_learned` and no `voice_profile_edited` since goes back to
    `learned`, so the weekly refresh runs again. /admin's "jobs look stopped" waits 25 minutes
    (`JOBS_STALE_AFTER_MS`; push on, the poll leaves a quiet inbox for up to 15 minutes). Privacy
    policy: the voice scrub "recognizes" (and covers the stored description, not only examples),
    speech goes to "Google, Apple or Microsoft", "What you tell us" names license and registration
    numbers, "What we store" names attachment counts. Legal date and `TERMS_VERSION` unchanged.
- **Voice (wave 2, `w2-voice`):**
  - **What's stored vs. how the last learn went (Check 24 P1 + Check 29 P2):**
    `voice_profile.last_attempt` (learning | ready | not_enough_mail | failed | capped |
    reconnect_needed) + `last_attempt_at` record every learn; `status` only becomes "ready" on
    success, and a row that already holds a voice (summary, greeting, sign-off or examples) stays
    "ready" whatever an attempt says (decided in SQL in `recordAttempt`). `workspaceContext` uses
    the voice whenever the row has content (`hasVoiceContent`, `src/server/voice-rules.ts`).
    Settings → Your voice: "The last update didn't finish (Oct 13). We're still using this voice."
    Stuck = `last_attempt` (else legacy `status`) "learning" for 30+ minutes.
    `voice_profile.restart_count`: the 15-minute backstop (`restartVoiceLearns`) counts restarts
    of a stuck learn; at 2 it stops, records "failed" and emails ADMIN_EMAIL once per workspace
    per day ("Voice learning failed twice for this account"; marker
    `voice_failed_alert:<ws>:<day>`, purged daily by `purge-voice-alert-markers`). Reset on a
    successful learn and on "Re-learn from my sent mail". An unexpected error after "learning"
    records "failed" and rethrows.
  - **Only the owner's own words (Check 24 P2):** `ownWords` / `splitOwnWords`
    (`src/server/voice-text.ts`, pure) cut quoted replies (multi-language "On … wrote" headers,
    also wrapped), forwards, Outlook blocks, ">" lines, phone/app footers and signature blocks.
    Any email with one word left counts; a forward with under 5 own words is skipped.
    `console.info("voice_learn", …)` logs the outcome and counts only (emails read, forwards and
    app-sent replies skipped). Classification's `prepareBody` is unchanged.
  - **Skips the app's own replies (Check 24 P3):** sent-folder ids matching
    `drafts.sent_gmail_message_id` with status `sent` are dropped; `edited_and_sent` stay.
  - **Scrub (Check 24 P4):** `src/server/scrub.ts` (pure) — named `SCRUB_RULES` (emails, spelled
    emails, phones incl. wa.me / tel:, prices in many forms, PO boxes, streets incl. Spanish /
    Portuguese order, units, ZIP after a state, Canadian postal codes). Invoice / permit / model
    numbers stay; the business's own phone and website (read from `business_profile.signature`)
    stay. Every stored field is scrubbed; owner-typed edits are not.
  - **Voice inbox (Check 24 P6):** `voiceMailbox()` picks among running mailboxes the owner's
    sign-in address, else the oldest by `created_at`. `voice_profile.learned_from_mailbox_id` (no
    foreign key: the voice stays when that Gmail is disconnected) → "Learned from mike@shop.com".
  - **Accepted ideas don't stop the weekly refresh (Check 24 P7):** `decideSuggestion` no longer
    sets `source = edited`; `ideaChanges` (`edit-learning-rules.ts`) applies the change and
    `learnVoice` re-applies every accepted idea oldest first after building its values.
  - **Stale samples (Check 24 P8, adapted):** `voice_profile.examples_stale` is set when greeting,
    sign-off, formality or length change (owner save or accepted idea) and by a learn whose
    re-applied ideas moved length or formality; while stale, drafts get `examples: []` and
    Settings hides the samples. Writing new ones (`voice-examples.v1` + job) waits for the Prompt
    versions group (`docs/notes/prompt-versions-inbox.md`).
  - **Failed first learn retried (Check 24 P12):** `voice_profile.retry_day` /
    `retries_that_day`: the backstop restarts a failed / capped first learn (no stored voice) after
    1 hour, at most 3 times a UTC day. A failed refresh of a stored voice waits for the weekly run.
- **Inbox (wave 2, `w2-inbox`):**
  - **Needs you lets go (Check 10 P1):** `threads.needs_owner_since`; one rule,
    `openNeedsOwnerSql()` (`src/server/needs-owner.ts`): `needs_owner` and the owner hasn't written
    since `needs_owner_since` (`lastOutSql`; older rows fall back to `classified_at`; an old manual mark with no time
    never lets go). The sorter sets the time to the email's own time when the flag goes up, keeps
    it while it stays up, nulls it when it goes down; "This one needs me" and Move it → complaint
    set it to now. `clearAnsweredNeedsOwner(mailboxId)` runs once per `incrementalSync`, in
    `finishBackfill` and when a re-read finishes: clears the flag, manual mark, reason and time
    and logs `needs_owner_cleared {by: "gmail_reply"}`; a dispute / legal reason stays on the row.
    `markAnsweredByPhone` clears it too (`{by: "phone"}`). Inbox: `CalledThem` (back="inbox") on
    "Waiting on you" cards; "Take it off my list" → `takeOffListAction` (`{by: "owner"}`).
  - **Quotes closed another way / Not a quote (Check 11 P8):** `threads.quote_dismissed_at`. "I
    sent the price another way" → `markAnsweredByPhone(…, { via: "other", amountCents })` (typed
    price into `quote_amount_cents`, never price memory). "Not a quote" (one confirmation) →
    `quote_dismissed_at`; `quoteNotDismissedSql` keeps such threads out of quote rules unless an
    outcome comes after it. "Not quotes (N)" with Put back. Follow-ups skip a dismissed quote.
  - **Emergencies first (Check 10 P3):** tier order (`tierSql`, twin of `inboxTier` / `inboxRank`
    / `compareInbox` in `inbox-rules.ts`): emergency in 24 h with the customer last (4) + open
    needs-you (2) + priority high in 24 h (1), then newest, then id. "Emergency" / "Urgent" lead
    the card in font-black.
  - **Paging (Check 10 P2):** `inboxPage()` keyset paging (`?before=<ISO>&after_id=<uuid>`,
    Zod-checked, anchor looked up inside the workspace); 100 non-junk rows per page; junk and
    older unsorted mail folded (count + 50 newest, first page).
  - **Draft ready / reason (Check 10 P4, P5):** `pendingDraftId` → " · Draft ready" and "See the
    draft" (`/queue?t=<uuid>#t-<uuid>`); the needs-you reason under the tag line.
  - **Open in Gmail and the customer (Check 10 P6):** "Open in Gmail" and "From <name>" →
    `/customers/<opaque key>` (never for lead sites / phone services); no address in a URL.
  - **Unsorted mail (Check 10 P7):** a model failure stores `extracted.unreadable` ("Couldn't
    sort"); never-sorted mail older than `CLASSIFY_LOOKBACK_DAYS` folds into "N older emails, from
    before Squared Away started sorting" with a "Not sorted" chip.
  - **Search (Check 10 P8):** also the work, address, invoice and permit numbers; accents folded
    (`foldForSearch`). **Chips (Check 10 P9):** wrap from `sm`, one scroll row with a fade on
    phones; the tag says " · Needs me". **Plain reasons (Check 10 P10):** no dashes
    (`COMPLAINT_REASON`, `LOW_CONFIDENCE_REASON`, `UNREADABLE_REASON`, `MODEL_FLAG_REASON`,
    `INJECTION_REASON`, `LEGAL_REASON` "Mentions a lawyer, a lien or a claim.").
- **Sync and Gmail connect (wave 2, `w2-sync`):**
  - **Gmail quota (C25 P1):** per-mailbox unit budget in `gmail_units` (5,400 of Google's 6,000
    units a minute; `src/mailbox/gmail/quota.ts`); every Gmail request reserves first; a spent
    minute or Gmail's own retry time (`mailboxes.gmail_cool_until`) stops calls before any fetch
    and `politely()` pauses. Inbox emails are read once (full); others as metadata.
    `logGmailUnits` → `console.info("gmail_units", {job, mailboxId, gmailUnits})`. Purged daily.
  - **Archive, Trash, Spam, Not spam (C25 P2):** `listHistory` asks for label changes and
    deletions; `applyLabelChanges` keeps stored labels in step and recomputes `threads.in_inbox`.
    Whole conversation in Trash / Spam / deleted → pending drafts expire ("You deleted this in
    Gmail." / "You marked this as spam in Gmail."); nothing is deleted in the owner's Gmail.
    Archive only → the draft stays with "You archived this in Gmail.", its autopilot countdown
    cleared and a send in its undo window un-queued (`send_stopped` `archived_in_gmail`). A tap on
    Send for an already-archived conversation still sends.
  - **No Gmail (C47 P1):** `exchangeCode` calls `/profile`; `failedPrecondition` → revoke,
    `NoGmailError`, `/connect?error=no_gmail`; nothing saved, no trial clock.
  - **Expired history (C25 P3):** `mailboxes.resync_since` / `resync_page_token`: a fresh cursor
    is stored at once and the gap (7–30 days) re-read one page per step; a gap over 30 days logs
    `mail_gap` (dates only, hidden on Activity).
  - **Automatic replies (C20 P4 + C21 P1):** only real automatic responses mark
    `messages.auto_reply` (Auto-Submitted `auto-replied`, Precedence `auto_reply`, X-Autoreply /
    X-Autorespond, out-of-office subjects, mailer-daemon / postmaster bounces; header values never
    stored). They're set aside with no model call, never supersede the customer's own email,
    never expire a draft, never get a reply; autopilot guardrail `autoReply`. Bounces set
    `extracted.bounced` ("Your email to this customer bounced. Check the address."), no nudge.
    Acknowledgements (`messages.ack_only`, inert until the prompt signal): `lastAnswerInSql`,
    `ballInTheirCourtSql`, `quietSinceSql`; nudges count from the acknowledgement.
  - **Attachments (C40 P2):** `messages.attachment_images` / `_pdfs` / `_other` (counts only, no
    names); `AttachmentLine` "3 photos attached · open in Gmail" on Inbox and Queue cards.
  - **Fewer executions (C25 P4):** `job_runs` (runs + steps per function per UTC day, middleware
    `CountJobRuns`); /admin "Background work this month: N steps". `afterSync` sends a draft job
    only with new mail or something pending. Lifecycle job grouped (above). `reply-to-backfill`
    daily at 4:43 UTC, re-sending itself 15 minutes later while unfinished. With
    `GMAIL_PUBSUB_TOPIC`, the watch covers INBOX + SENT and the poll skips a mailbox with a live
    watch synced under 15 minutes ago (`pollDue`).
  - **Big first read resumes (C25 P5):** `backfill_page_token` / `backfill_pages_done` /
    `backfill_since`; at most 300 pages a run, the poll continues; a refused token restarts the
    listing; a reconnect starts fresh. Sync uses `after:` windows only.
  - **Plain "mail is behind" line (C25 P6):** `StaleMailLine` on every signed-in screen when an
    active inbox's last check is over 30 minutes old; `mailboxHealth` and the learning screen show
    first-read progress ("Reading your last 30 days: 1,250 emails so far, started 2:10 PM.").
  - **One Gmail in one account (C25 P7):** `saveConnectedMailbox` refuses an address held by
    another workspace (`MailboxInUseError`, `/connect?error=in_use`, activity
    `mailbox_in_use_refused`); the new token is **not** revoked (a revoke could cut off the other
    account). Plain index on `lower(mailboxes.email)`, not unique yet.
  - **Right account on Connect another / Reconnect (C42 P3):** `/connect?reconnect=<id>` /
    `?add=1`; `login_hint` or `prompt=consent select_account`; state cookie
    `<state>~<mode>~<mailbox id>`; `already_connected` / `wrong_account` errors save nothing and
    revoke nothing.
  - **One provider switch (C47 P2):** `mailboxClientFor` (`src/mailbox/clients.ts`) is the only
    `createGmailReader` caller outside src/mailbox/gmail; `serverMailboxClient` adds the unit
    budget and saves a rotated refresh token (`saveRotatedRefreshToken`, encrypted, never logged).
  - **Labels and search words in one place (C47 P4):** `MAIL_LABELS`;
    `listMessages({ newerThanDays?, after?, inbox?, sentOnly?, pageToken?, maxResults? })`
    replaces raw queries; a guard test bans Gmail query words and label names outside
    src/mailbox/.
  - **Test Gmail (C25 P8):** `tests/support/fake-mailbox.ts` keeps a typed history log, lists by
    window, counts units per fake minute; vitest `hookTimeout` 30 s / `testTimeout` 60 s.
- **Queue screen (wave 2, `w2-queue`):**
  - **Focus (Check 32 P1):** a card button that turns into a question moves focus into it
    (`QuestionLine`, `src/app/(app)/queue/focus.tsx`); Keep it / Never mind / Cancel / Escape put
    focus back (`useFocusReturn`).
  - **Keeping the owner's place (Check 9 P5):** forms carry `threadId` / `nextThreadId`
    (`CardTargets`); redirects carry `&t=<uuid>` (same card for refusals and saves; the next card,
    else the one before, else its own id, for send / discard / snooze / I called them / They said
    no / Already paid); the notice renders on that card. URLs keep a literal `/queue` prefix.
  - **After Send reply (Check 9 P5 + Check 32 P7):** `SentStrip` fixed above the tab bar, its
    line the page's h1, focus once on mount; `UndoSend` speaks "You have 20 seconds to undo." then
    "Time's up. Sending now."
  - **Right now (Check 9 P6):** `queueMembership` returns `now` (emergencies with or without a
    draft), a view onto needs-you / drafts, so counts are unchanged.
  - **Whole reply above Send reply (Check 9 P7)**; **once per card (Check 9 P12):** header = tag and
    summary, the reason in Why this?, `withoutCategoryPrefix` (`src/lib/card-words.ts`).
  - **Draft a reply (Check 9 P9):** `DraftReplyButton` ("Writing a draft…");
    `createDraftForThread` takes a 2-minute per-thread lease (`src/server/draft-claims.ts`,
    `app_settings` `draft-claim:<threadId>`, purged daily) for every trigger.
  - **Gaps (Check 9 P11 + Check 23 P8):** "Fill in N gaps to send" opens the first gap; quick
    changes post the card's text, used only when `filledGaps(saved, current)` proves only gaps
    changed.
  - **Warnings order (Check 23 P9):** `scoreDraft` orders fixed cautions, purpose flags, check
    flags, model notes; `capFlags` keeps 6 ("And N more things to check."); `betterAttempt` keeps
    the retry with fewer REGENERATE_ON hits (`draft_retry_kept {kept}`).
  - **Getting started (Check 9 P13):** `business_profile.onboarding_done_at`; a finished list is
    one line and hides itself 3 days later.
  - **Swipe (Check 9 P14)**, **Send together (Check 41 P2):** a scheduling draft that names a
    visit time (`namesAVisitTime`) is never batch-eligible. **Nudge cards (Check 21 P8):** "They
    said no" / "Already paid". **Headings (Check 32 P9/P11)**, **Edit (Check 8 P7/P9):** the tab
    bar hides while a text field has focus. **Words (Check 9 P15 / Check 48 P5):** the Hold to
    talk note names Google, Apple or Microsoft.

- **Wave 2 merge B (2026-10-18, branch `integrate-w2b`):** the Quotes and Money, Settings and
  time zone, Follow-ups, Customers and senders, and Autopilot rules groups merged with `--no-ff`,
  in that order, on top of 5b4579d (merge A). Migrations regenerated one at a time with
  drizzle-kit on the previous snapshot (SQL byte-identical to each branch's): `0058_quote_amount_note`,
  `0059_quote_amount_from`, `0060_time_zone_source`, `0061_work_hours`, `0062_reply_languages`,
  `0063_nudge_after`, `0064_owner_invoice_at`, `0065_big_quote_days`, `0066_autopilot_skip`.
  Prompt lines the groups couldn't write wait in `docs/notes/prompt-versions-inbox.md`
  (classify.v6 `declines_quote` / `wait_until` / the "unknown" first-time sender; followup.v5
  invoice reminders; the reply-language line). Reconciled with merge A and each other:
  - **One quote rule:** `quoteThreadSql` / `isQuoteThread` = Quotes' rule (category, sticky
    `quote_requested_at`, any outcome; noise / injection left out unless the owner marked it)
    **and** the Inbox group's "Not a quote" (`quoteNotDismissedSql`; an owner outcome after the
    dismissal brings it back). `quoteRequestSql` is an alias. Customers' conversation stages use
    the same rule and Check 11 P6's priced test (`pricedThreadIds` in quotes.ts).
  - **Who wrote last, everywhere:** `threadsToFollowUp` and `guessNoAnswers` keep the Sync
    group's ball-in-their-court (an acknowledgement or auto-reply since the owner wrote doesn't
    count) and count the quiet from `quietSinceSql` — against the normal and big-quote waits and
    with the asked-for wait on top (`greatest(quiet start, nudge_after)`). A fresh invoice email
    (no customer email) is the other way in. `guessNoAnswers` also keeps the priced pre-filter,
    this-quote-only nudges, service calls and the big-quote clock. The drafter keeps the bounce
    and acknowledgement rules beside wait / not-due; the service-call check reads the owner's
    newest email, never a later acknowledgement.
  - **listQueue** keeps the Queue group's needsYou / drafts / now shape and lanes; each item also
    carries the reply languages, `alsoQuote`, `customerKey` and `autopilotSkip`. Queue cards keep
    the h3 name heading with the `CustomerName` link inside it; `CustomerName` now wraps a long
    name (Check 32 P11) instead of cutting it. The draft card shows the language line above
    "Check before sending" and the autopilot wait line in the header; the queue note line shows
    "Also about your quote", the private note and attachments.
  - **Autopilot codes:** besides the Autopilot group's own, `crew` (Customers), `auto_reply`
    (Sync, Check 20 P4) and the run code `left_inbox` (Sync, Check 25 P2: "This conversation left
    your inbox in Gmail.") — each with one sentence, one phrase and one Settings line.
    `autopilotOnKinds` takes `AutopilotWorkspace` (the referral free-plan fields).
    `threadMessageLabels` uses the gmail client's unit names (`threads.get`).
  - **Money card:** the follow-ups group's chasing line replaces "Nudges used" at 16px
    (`data-testid="chase-line"`, read by the Check 8 P9 e2e), beside Quotes' "See it" / "Draft a
    reminder" and `CustomerName`. **Quotes card:** a decided card says when ("Won Oct 14"); an
    open service call reads "Service call"; "I sent the price another way" and "Not quotes" stay.
  - **Settings:** Your Gmail uses the settings group's pure `syncLine` (one email, no check time)
    with the Sync group's "This can take a while."; Your business's every-fact list gains "Your
    crew" (a count); `SettingsScreen` keeps `errorText` beside `fillCounts`.
  - **Integrator decisions:** a price typed on Quotes' "I sent the price another way" is the
    owner's (`quote_amount_from = 'owner'`, `quote_amount_at` = the tap): never replaced by a
    price read from mail, never in price memory, and — like any typed amount — not in "Priced"
    unless the quote is won. That tap without a price reads "Quoted", not "Replied, no price yet"
    (`answered_by_phone` with `via: "other"`). Inbox cards say "Your crew" in place of the kind.
- **Quotes and Money (wave 2, `w2-quotes`):**
  - **One quote rule (Check 11 P1):** `quoteThreadSql` / `isQuoteThread` are twins (144-case twin
    test); `quoteRequestSql` is the same rule, so Quotes, Customers, follow-ups, the scorecard,
    the monthly summary, lead pay and leads at risk count the same threads.
  - **The quote amount (Check 11 P2 + Check 39 P3):** `readOwnerAmount` (quote-rules.ts) replaces
    "largest $ figure". `stripForAmounts` cuts a "--" signature, Outlook header blocks, a wrapped
    Gmail "On …" line and "Sent from my iPhone" (amounts only; the classifier's `prepareBody` is
    unchanged). Figures need digits right after "$", proper thousands commas. Dropped: rates,
    deposit, trip charge, guarantee, warranty, tax, "normally / was / not / save / budget",
    and program words (rebate, incentive, credit, loan, financing, Mass Save, HEAT Loan, …) — the
    saved price is before incentives. The last figure marked as the price → 'total'; the only
    figure → 'total'; two or more "Option …" figures → none; else the LAST figure → 'picked'.
    `threads.quote_amount_note` ('total' | 'picked'); 'picked' shows "Check amount" and never
    goes into price memory. `ownerGavePrice` / acceptance use the same reader, so "$95 per hour"
    alone isn't a price given.
  - **A corrected price replaces the first (Check 11 P3):** `threads.quote_amount_from`
    ('reply' | 'owner') and `quote_amount_at` (when the price went out). `captureQuoteAmounts`
    re-reads open quotes whose amount came from a reply and moves amount, note, time and the
    `price_history` row; a typed amount and a decided quote are never touched (the UPDATE
    re-checks both). "Save as won" with the prefilled amount unchanged stays the reply's price.
  - **Daily capture (Check 11 P4):** only quote threads with an owner email that still has text;
    the purge job pages every match by id (500); the Quotes screen keeps one page.
  - **30-day totals (Check 11 P5):** `quoteTotals` in SQL — Asked for by `requestAtSql`, Priced by
    `quote_amount_at` (else the owner's last email; a typed amount only when won), Won and the
    win rate by `quote_outcome_at` (exactly `closeRateBetween`'s rows).
  - **A site visit isn't a quote (Check 11 P6):** stage `replied` ("Replied, no price yet") when
    the owner wrote last without a price; it never goes quiet, and `guessNoAnswer` needs
    `priced`. Homepage `stageWords` use semicolons.
  - **Amount only on Won (Check 11 P7):** "Mark won" step (optional amount, prefilled) plus "Mark
    lost" / "Mark no answer"; `setQuoteOutcome` ignores an amount unless won; "Change amount" on a
    won card (`setQuoteAmount`, activity `quote_amount_changed {amountTyped}`). Decided cards say
    the day ("Won Oct 14", `decidedLabel`).
  - **Filters (Check 11 P9):** chips wrap, in the order Open, Waiting on you, Quoted, Gone quiet,
    Won, Lost, No answer; one line per stage under the list; "Last email 41 minutes ago".
  - **Supplier bills (Check 12 P4):** `billOwedByOwner` + SQL twin `billOwedByOwnerSql`: owed by
    the business when the sorter said so, or the direction is unknown and the newest sender has a
    `supplier_vendor` thread from the same business (domain; exact address on public webmail) or
    an exact-address "Not owed to me" mark. A clear `owed_to_business` and the owner's own mark
    win. Used by Money and follow-ups; addresses compared only in SQL. A receipt sorted owed by
    the business, or with no amount, never marks anything.
  - **No amount yet (Check 12 P5):** owed invoices with no amount show "Amount not stated", out of
    the total; `captureInvoiceAmounts` (on view, and daily step `capture-invoice-amounts`) takes
    the amount from the owner's own newest email on the thread (`readOwnerAmount`, never an
    inbound email), stored with `amount_source: "your_email"` ("From your email").
  - **Net terms (Check 12 P6):** `dueDay` reads "net 30", "within N days", "N days from …", "upon
    receipt"; unknowable starts → "No due date"; the card shows "Due Oct 31".
  - **Money card actions (Check 12 P8 + P9):** a pending draft → "A reply to Linda is waiting in
    your Queue." + "See it"; else, owner wrote last, a nudge left and no needs-you → "Draft a
    reminder" (the follow-up drafter, so it re-checks paid / not owed / caps and **counts as a
    nudge**). No big $0: "No open invoices found"; the total shows with "Counted from your
    email, not your books."
- **Settings and time zone (wave 2, `w2-settings`):**
  - **Money box (Check 15 P1):** "2,500" / "$2,500" save as 2500; blank is refused, never $0.
  - **Time zone (Check 45 P1 + 44 P5 + 15 P7):** `business_profile.time_zone_source` default |
    browser | owner. `ZoneCapture` (gated in the (app) layout) posts the browser's zone once while
    the source is `default` (`saveDetectedTimeZone`, activity `time_zone_detected`);
    `saveBusinessProfile` sets `completed_at` on conflict too. Setup's zone saves as `browser`,
    never over `owner`; /settings/profile never moves it. Settings → Morning email has a visible
    "Your time zone" select and "Use Central time" when the phone differs (saves at once;
    `setOwnerTimeZone` → `owner`, logged `time_zone_changed {from, to}`). Playwright runs every
    page with `timezoneId: "America/New_York"`.
  - **Plain errors (Check 15 P2):** every profile rule has its own message (tested against Zod's
    wording); "People who always need you" takes Gmail-style pastes.
  - **Ways back (Check 15 P3):** `BackLink` / `CancelLink` on the two edit screens.
  - **Every fact (Check 15 P4):** `describeProfileFacts` (pure) lists every saved fact with
    "Not set." and a Change link to `/settings/profile#<field>`.
  - **Never-lists (Check 15 P5):** wording only; `saveNeverSay` reports skipped lines.
  - **Sign-off once (Check 15 P6 + 24 P11):** `signatureWithoutSignoff` drops a signature first
    line equal to the learned sign-off in `workspaceContext`; greeting / sign-off can be "I don't
    use one".
  - **Working days for alerts (Check 15 P8):** `business_profile.work_days` / `work_start_hour` /
    `work_end_hour` (defaults Mon–Sat 7–18) drive leads-at-risk; free-text hours stay for drafts.
  - **Reply language (Check 43 P8):** `src/ai/language.ts` `detectLanguage` / `chooseReplyLanguage`
    / `languageCardLine` / `languageMismatchFlag` / `replyLanguageLine`;
    `business_profile.reply_languages` (English always; Spanish / Portuguese switches);
    `drafts.customer_language` / `reply_language` (codes only); `checkDraft({ replyLanguage })`
    flags a wrong-language reply (cap 0.5, never regenerated). The prompt doesn't name the
    language yet (prompt-versions-inbox).
  - **Polish (Check 15 P9–P12):** seasonal-note dates via `src/lib/plain-date.ts`, Add note keeps
    what was typed, "1 email", per-trade `servicesExample`.
- **Follow-ups (wave 2, `w2-followups`):**
  - **Big invoices are chased (Check 12 P1):** `applyOwnerRules` returns `needsOwnerCode`
    (`extracted.owner_code`, an `OWNER_RULE_KEYS` value or "model"). `amountOnlyNeedsOwner` /
    `amountOnlyNeedsOwnerSql`: an invoice thread that needs the owner only for its amount (no
    manual, complaint, dispute, injection, payment-change or "is this a bot" mark) is still
    chased. Money's `chaseLine` says when nothing will be ("Not chased: this one needs you
    first", "…it's been quiet too long"). `FOLLOWUP_MAX_AGE_DAYS` lives in followup-rules.ts.
  - **A no stops nudges; "after the holidays" waits (Check 21 P2):** `threads.nudge_after` (start
    of the asked-for day in the owner's zone, replaced at every customer email; injection emails
    set nothing). `followupSignalsOf` reads `signals.declines_quote` / `extracted.wait_until`
    (inert until classify.v6). A decline on a quote thread → auto Lost (`DECLINED_FLAG` on a
    waiting nudge; the owner always wins). Quotes card / sent screen: "Waiting until Jan 4, as
    they asked."
  - **The owner's calendar day (Check 21 P3):** see Follow-ups (M7) above; `followupScanDue` /
    `markFollowupScanned` (`app_settings` `followup-scan:<workspaceId>`), `quietCutoff`,
    `nudgeDueDate`; the no-answer guess runs per due workspace in the same job.
  - **Invoices the owner sends (Check 21 P4):** `threads.owner_invoice_at`; `looksLikeOwnerInvoice`
    (pure, at sync, outbound rows, subject or first 2,000 own words; never a forward) sets
    `extracted.invoice_thread`. A fresh invoice is chased only when its first To address has
    written to the business before (`freshInvoiceToKnownSql`).
  - **Answered elsewhere (Check 21 P5):** no nudge when the customer's reply address wrote on
    another conversation after the owner's last email (`customerWroteElsewhere`); the newer card
    shows "Also about your quote from Nov 2" (`QueueItem.alsoQuote`).
  - **This quote's nudges (Check 21 P6):** `guessNoAnswers` counts only nudges sent after the
    customer's newest email; `MAX_FOLLOWUPS` (two per conversation, ever) unchanged.
  - **Service calls (Check 36 P3):** `isServiceCall` / `serviceCallSql`: an emergency the owner
    answered with no dollar amount isn't chased or guessed "no answer"; Quotes shows "Service
    call" (display only).
  - **Big quotes (Check 38 P4):** `business_profile.big_quote_days` (null = normal wait; 7/10/14/21);
    `FOLLOWUP_DAY_CHOICES` gains 10 and 14. `isBigQuote` / `chaseTiming` / `noAnswerAfterDays(n,
big)`; the hourly job runs `captureQuoteAmounts` first.
- **Customers and senders (wave 2, `w2-customers`):**
  - **Crew (Check 13 P1 + 22 P10 + 41 P6):** `business_profile.crew_addresses` (wave 0's column;
    Settings → Your business "Your crew's email addresses", max 30; `crew_list_saved {count}`).
    Crew = on that list or one of the workspace's own Gmail addresses (`isCrewAddress` /
    `crewSql`, parity-tested); the owner's business domain only files a Customers row. A
    crew-only thread is stored as scheduling, low, needs nobody, `extracted.crew = true`, "From
    your crew: …", with **no model call** unless a safety check fires. Jobs never draft for the
    crew (thread mark or a crew To, read live); the owner's tap still drafts. Customers rows have
    `kind` (town → crew → supplier → customer) with 44px group links (`?group=`). Quotes, found
    money, leads at risk and the scorecard leave crew out.
  - **Robots (Check 13 P2 + 41 P7):** `MACHINE_SENDER_DOMAINS` (indeed, ziprecruiter, glassdoor,
    snagajob) in `isNoReplyAddress` / `noReplySql`; `customerRobotSql` / `isCustomerRobot`
    (parity-tested); a robot or junk email's key is a 404.
  - **First-time sender "unknown" (Check 22 P7):** a no-reply / lead-platform From with no usable
    Reply-To → `"unknown"` (counts as first time); voicemail-by-email compares the number named.
  - **Every customer (Check 13 P3):** no 500 cap (`CUSTOMERS_CEILING` 10,000, `customers_ceiling_hit`
    logged), 50 at a time, `quoteFactsByAddress` (read-only; Customers never runs the Quotes
    screen's work).
  - **Names and the page (Check 13 P4–P8):** `newestNameSql`; `bigJobReason(historyDays)` ("…hasn't
    written in the mail we've read so far." under a year of mail); the customer page's facts
    line, job addresses and stage per card; `wroteWords`, `headlineName`, `listStartsOn`.
  - **Names link to the page (Check 13 P9):** `customerKeySql` (opaque uuid) on Queue, Quotes and
    Money; `CustomerName` (44px). No address in any URL.
- **Autopilot rules (wave 2, `w2-autopilot`; Checks 20 P2 P13 P3 P8 P7 P6):** only stricter or
  clearer; no new send path; the three layers, the 10-minute window and the claim are unchanged.
  - **Unsynced mail (20 P2):** `MailboxWriter.threadMessageLabels` (threads.get format=minimal,
    ids and labels only) gives the owner's drafts and the thread's mail in one call;
    `unsyncedMessageIds` → "There's newer mail in this conversation." and `syncMailboxId`, so the
    job asks for a sync. `threadDraftMessageIds` stays for other callers.
  - **Daily cap (20 P13):** the cap check, countdown and `autopilot_scheduled` row are one
    transaction under `pg_advisory_xact_lock(hashtext('autopilot-cap:<workspace>'))`; a rolling
    24 hours ("At most 20 in any 24 hours."). `MIN_CONFIDENCE_PCT` / `DAILY_AUTOPILOT_CAP` in
    `src/config/rules.ts`.
  - **Other languages (20 P3):** `looksNonEnglish` (src/ai/language.ts) on the draft and the
    newest part of the customer's email → "Not in English, so it waits for you."
  - **Someone new copied (20 P8):** `newPersonCopied` (pure) → "Someone new is on this
    conversation, so it waits for you." (crew aren't exempt).
  - **Why it waited (20 P7):** `src/server/autopilot-reasons.ts` (`GUARDRAIL_CODES`, `RUN_CODES`),
    `guardrailCodes` + `guardrailReasons`; `drafts.autopilot_skip` (jsonb codes) on refusals in a
    switched-on kind and stand-downs, cleared when a countdown starts. Queue card and Activity
    say why in fixed words; unknown codes are dropped.
  - **Settings → Autopilot (20 P6):** two lists from the same codes (`AUTOPILOT_WHEN_LINES` /
    `AUTOPILOT_NEVER_LINES`); a test fails when a guardrail code has no line or two.
  - **Not built (Davi's yes needed):** 20 P9 (no day or time), 20 P10 (earn only from replies sent
    one at a time; would add "batch" to `drafts.sent_via`), 48 P6 (assistant note).

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

- **Inngest plan (Check 49 P1):** the free plan pauses every job at 50,000 executions a month (21,029
  from Oct 1 to 16 with one shop). `docs/LAUNCH.md` "Check your free plans now", Inngest item.
- **Vercel Pro (Check 49 P1):** the team is on Hobby, which is non-commercial only; Pro (about $20 a
  month) before the first paying customer. `docs/LAUNCH.md` "Check your free plans now", Vercel
  item. All outside accounts: `docs/VENDORS.md`.
- **Protect main + hold production for CI (Check 31 P3):** tap through `docs/LAUNCH.md` "Protect
  main" (GitHub ruleset: PR required, checks `check` + `old-code-new-schema`, no force push or
  delete) and "Hold production for CI" (Vercel Deployment Checks on `check`, or the stated
  fallback). Needs his admin rights; the engineers can't do it.
- **Preview guard fingerprints (Check 26 P2):** `src/config/environment-guard.ts` ships with empty
  `PRODUCTION_DB_HOST_SHA256` / `PRODUCTION_KEY_SHA256S`, so it blocks nothing yet. Either Davi
  supplies production's fingerprints (`pnpm fingerprint <pulled env file>` prints hashes only;
  `docs/LAUNCH.md` step 2, "The preview guard"), or this becomes moot once previews have their own
  database and keys (LAUNCH.md step 2a–2e, the real fix). Never read the values to make them.
- **Leads package (2026-10-16):** (1) **Privacy lines — merge blocker:** approve the new lines in
  `docs/privacy-policy.md` (lead source / done / fixed marks, towns, Call / Text reads the number
  without storing it, no drafts to lead sites / voicemails / email-to-text). The documents were
  already dated today, so no extra re-agreement; if this merges after another 2026-10-16 bump has
  shipped, batch it with the other packages' lines into one date move. (2) **Real samples**
  (customer details blurred) of each lead site's email (Thumbtack, Angi / HomeAdvisor, Houzz, Yelp,
  Nextdoor, Porch, Bark, Networx, Google Local Services) — Primary or Promotions? does any take an
  email reply? does each fixed "Open <site>" link land on the pro's inbox? — and RingCentral /
  Grasshopper / OpenPhone voicemail emails. The site parsers and the Open links were written
  against invented samples. (3) Emergency alerts (B5 part 2): Davi said yes on 2026-10-16,
  built in the replies package. (4) The eval baseline (`ANTHROPIC_API_KEY` repo secret) before classify.v5 (names / towns from
  the model, strict emergency wording) can be written and compared.
- **Replies package (2026-10-16):** (1) the eval baseline (`ANTHROPIC_API_KEY` repo secret, then
  run "Prompt evals") before draft.v7 can be compared with a live model; (2) a Google Voice
  voicemail comes from `voice-noreply@google.com`, a no-reply sender, so an emergency
  voicemail does **not** buzz at night (as specified) — his call whether it should; (3) the
  privacy lines ride on the 2026-10-16 date: if another 2026-10-16 bump has already shipped when
  this merges, batch them into one date move.
- **The launch checklist is `docs/LAUNCH.md`** (in order, where to click, how to know it worked,
  and every open decision in its step 13, split into "Decided on 2026-10-15", "Decided on
  2026-10-14", "Still open" and "Still needed from you"). The items below are the same list in engineering words.
- **Neon plan (urgent, this week):** check Neon → Billing and production's Usage box; on Free the
  5-minute poll likely uses up the 100 CU-hours mid-period and pauses production. Launch is about
  $19–20 a month (LAUNCH.md "Check your free plans now"). His money decision.
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
- **Terms re-agreement (2026-10-16 decisions package):** `docs/terms.md`'s trial paragraph now
  names the Gmail side door; the date stayed 2026-10-16 (no re-agree). If Davi wants everyone to
  agree to it, move both documents' date and `TERMS_VERSION` together (LAUNCH.md "Still open").
- **Phone notifications (#36):** `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` (free) in Vercel
  Production, then redeploy. Off until then. The engineers can generate and add them if Davi says
  so.
- `ANTHROPIC_API_KEY` repo secret for the "Prompt evals" action (baseline still empty).
- Resend: verify the production domain in Resend and switch `EMAIL_FROM` off `onboarding@resend.dev`
  (until then the digest, the monthly summary and the waitlist confirmation only reach the Resend
  account's own address). This is also what makes the pricing cards' "morning summary" true for
  owners (the cards weren't changed). LAUNCH.md step 6.
- **Outside review (2026-10-15), his part** (LAUNCH.md step 13 "Outside review"): everything in
  its "Your calls" (trial side door — app/homepage now say "won't send anything to a customer
  during the trial", `docs/terms.md` and the policy's trial sentence still say "sending to
  customers is switched off"; setup fee; trial length; [To confirm] items; hero line; homepage
  A/B test; referral amount / founding / association offers; instant "got it" reply; more Gmail
  permissions; money in the morning email; Outlook; app stores); the domain; `SUPPORT_EMAIL` and
  a business phone; his photo; legal answers so the "Draft" banners can go; Web Analytics
  (Vercel → sa → Analytics → Enable; code ready); the sitemap in Search Console; a booking
  calendar link (needs an account); the confirmation email's wording; whether Thumbtack / Angi
  relay addresses should ever be answered by email; whether to say on the site that form leads
  are answered at the customer's own address; a Growth link inside the app; and his picks from
  the 100 ideas. Testers re-agree to the terms once (2026-10-16 version).
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
  stand (no fake reviews, price before any work, Growth never touches the inbox). Built
  2026-10-16: client portal, pledge, the More line, admin Remove. Still open: a lawyer's review
  of `docs/growth-agreement.md` and its [To confirm] items, Growth prices (none anywhere until he
  picks) and whether ended clients should keep seeing their dashboard (today a 404). (A Growth
  request may carry a referral: decided 2026-10-16, built.) No tracking pixels on /growth without a privacy-policy change and his
  okay. Only the newest Growth request per email is kept and a growth-only row's phone becomes the
  newest number, so anyone who knows a lead's email can replace their number: check an
  unfamiliar number before calling.

- **Ideas packages (2026-10-16, `ideas-build`) — not built yet, and his questions:**
  - Not built in this pass (time box): G3 suggested VIPs and B7 "Send at 7am instead" (control
    plan), D4 part payments (numbers plan; its nudge wording needs `followup.v5`), and the whole
    site package (A3 trade pages incl. /remodelers, A15 /security, A6 slow-reply calculator).
  - Wait for the eval baseline (prompt changes): D7's "thank them for the payment" line
    (`purpose.v4`), D4's balance-only nudges and `classify.v5`'s `amount_paid`.
  - His calls (defaults built): what a VIP means (today: needs you, no automatic draft); whether
    away mode should pause autopilot, texts / phone alerts / the morning email (built: no);
    remembered "not junk" / "always supplier" rules (cut); the privacy-policy lines added for
    these features (same 2026-10-16 version). Decided 2026-10-16: "Other" added; "Say thanks"
    built (decisions package above).

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
