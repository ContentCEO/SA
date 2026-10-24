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

Gates (each server-side and tested; details in `docs/decisions/`):

- Send gate: `sendDraft` checks `canSend` before any Gmail call: status in `SENDING_ALLOWED`
  (`setup_paid`, `active`) **and** `workspaces.setup_paid_via` ∈ {`stripe`, `house`}; otherwise
  `SendingBlockedError` → 403. `stripe` comes only from the signed webhook's paid checkout with
  the setup fee, `house` only from Davi's own account.
- `JOBS_ALLOWED` = invited, evaluating, setup_paid, active; every other status is read-only
  (no sync, sorting, drafting or sending; nothing deleted). `effectiveStatus()` ends a trial on
  time without waiting for a cron.
- Autopilot has three layers, all re-checked just before it sends: the account (a plan with
  autopilot and status `active`), the category (switched on by the owner and earned: 10 replies
  sent exactly as drafted), and each email (guardrails: never complaints or money, a known
  address, high confidence, no flags); a 10-minute hold the owner can stop; at most 20 a day.

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
src/mailbox/        connector interface + gmail/ implementation (scopes, OAuth, state);
                    outlook/ (Microsoft Graph, behind FEATURE_OUTLOOK)
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
                    fakes/ = fake Google consent + Gmail + Anthropic + Graph (127.0.0.1,
                    PORT+1); a second app with Outlook on runs outlook.spec.ts on PORT+2
docs/               BRIEF.md, SETUP.md, LAUNCH.md (Davi's launch checklist),
                    RUNBOOK.md (when the app stops), google-verification.md, legal drafts
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
   Never renumber or edit a migration that has run on the shared database. **A migration is frozen
   the moment its branch is pushed, because the preview build applies it to the shared database**
   (regenerating it with a new hash or `when` makes the migrator re-run it and the build fails).
   Undo a pushed migration only with a new one.
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
- Email text goes only to Anthropic, as one synchronous call (no Batches or Files API).
- /admin shows no email content, customer names or addresses (counts and health only).
- Growth code never reads inbox data (`tests/unit/growth-boundary.test.ts`).
- Migrations are additive: older code must keep working against the new schema (previews and
  production share the database), and an applied migration is never edited ("Working in
  parallel" rule 3).
- Readers and forms keep values they don't recognize; new list values may arrive in the database
  before the code that knows them. (`SelectField` shows them as "Current: …"; `orStored` accepts
  the stored value back, nothing else.)

## Decisions

Every decision bullet that used to sit here now lives, word for word, in `docs/decisions/`.
**Before changing an area, read its decisions file.** New decisions go at the end of the matching
file (the integrator writes them, as for this file: "Working in parallel" rule 4). A code comment
that cites a CLAUDE.md decision by its bold name finds it in one of these files.

- `docs/decisions/platform.md`: stack and versions, Vercel, Neon, environment settings, sign-in
  and sessions, migrations, fonts, the preview guard, reserved columns, tooling lessons.
- `docs/decisions/gmail-and-sync.md`: Gmail OAuth and scopes, connect / disconnect, sync engine,
  pacing, Gmail health, drafts that aren't mail, side conversations, inbox and customers.
- `docs/decisions/ai-and-prompts.md`: models and their keep-until dates, `callStructured`,
  classification and its guards, profiles and voice, trades, prompt versions, evals, leads, where
  email text may go, town and utility lists.
- `docs/decisions/queue-and-sending.md`: drafts and the queue, sending in use, autopilot,
  follow-ups, digest and Activity, alerts, plan milestones M4–M8, the app's screens and settings,
  quotes and money, mail format.
- `docs/decisions/lifecycle-and-billing.md`: trial clock and statuses, the status banner, Stripe
  billing and tax, test-payment reset, delete my account, referrals, the "I agree" boxes.
- `docs/decisions/site-and-growth.md`: the public site, the installable app, legal drafts and
  their dates, Squared Away Growth and its boundaries.
- `docs/decisions/admin-and-ops.md`: /admin, rate limits, error alerts, security audit, planning
  notes, and every merge and integration record (launch, waves 1–3), which span all areas.

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
      Merge (the production deploy). Then the steps in `docs/LAUNCH.md`. Merged as PR #10 (`8cfb749`,
      2026-10-16); the "I agree" boxes followed in PR #11 (`c1bf580`).

## Waiting on Davi

The one list Davi reads is `docs/LAUNCH.md` step 13 ("Decisions waiting on you": decided lists,
"Still open", "Still needed from you"). Add every new question or hand-over there, in plain words.
This file keeps only the engineering notes below, each naming its LAUNCH.md item.

### Engineering notes for open items

- **"First: finish the legal text…" / "One legal release" / "A lawyer's review":** every proposed
  sentence waits in `docs/notes/legal-*.md`; applied once (`docs/LEGAL-RELEASE.md`), moving both
  documents' date and `TERMS_VERSION` (`src/config/legal.ts`) together. The terms gate is live in
  production since `c1bf580` (PR #11, 2026-10-16), so owners are agreeing to the drafts now.
- **"Your Inngest plan" / "Vercel Pro" / "Your Neon plan":** /admin System box "Background work this
  month: N steps"; the Vercel Cron backstop `/api/cron/jobs-check` needs `CRON_SECRET` and a
  `vercel.json` (Pro only); `/api/health/deep` needs `HEALTH_TOKEN` (SETUP §6g).
- **"Protect main" / "Hold production for CI":** ruleset checks are the job names `check` and
  `old-code-new-schema` in `.github/workflows/ci.yml`; renaming a job means changing the ruleset.
- **"The preview guard's fingerprints":** `PRODUCTION_DB_HOST_SHA256` / `PRODUCTION_KEY_SHA256S`
  in `src/config/environment-guard.ts` ship empty; `pnpm fingerprint <pulled env file>` prints
  hashes only. Never read the values to make them.
- **Preview database (step 2, decided option B):** the engineers untick Preview on the shared
  `DATABASE_URL` through the Vercel API (target only) and add Preview-only `AUTH_SECRET` /
  `TOKEN_ENCRYPTION_KEY`; every Neon step names `autumn-term-70302192`.
- **"Your terms and privacy links in Stripe":** checkout falls back without
  `consent_collection` and writes `app_settings` `stripe_terms_box_off`; /admin Payments shows
  `TERMS_BOX_OFF_LINE` until a checkout with the box deletes it.
- **"Gmail draft check":** the query joins `drafts.sent_gmail_message_id` to
  `messages.gmail_message_id`; `runDraftMessagesCleanup` (`markRecordedSends`) relabels matches
  DRAFT → SENT, so after the launch merge it reads 0 DRAFT.
- **Google review (decided 2026-10-15, 0e):** the live check of the two scopes first clears the
  demo Gmail's old grant (Disconnect revokes at Google), then confirms `mailboxes.scopes` has no
  `gmail.send`, then a practice copy and a real reply on production; put `gmail.send` back at once
  if either fails. `GOOGLE_APP_STATE` (testing / unverified / verified) drives the connect screen
  and `accessLostReason`.
- **"Phone notifications" (step 9):** `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` (+ optional
  `VAPID_SUBJECT`); the engineers can generate them if Davi says so.
- **Resend (step 6):** `EMAIL_FROM` on a verified `mail.<domain>` with DMARC; `SUPPORT_EMAIL` is the
  Reply-To (`defaultReplyTo`, else `ADMIN_EMAIL`); the /admin catch-up buttons re-send the waitlist
  confirmations and invites. `emailHealth()` drives the /admin Email box.
- **"#47 turning referrals on":** order in SETUP §6d (live key, Connect Stripe, Reset test payments,
  the held terms / privacy / fingerprint lines with a `TERMS_VERSION` bump, a local Stripe Test
  Clock check, then `FEATURE_REFERRALS`). Never rotate `AUTH_SECRET` once referrals were given.
- **"PDF quotes":** the alternative is an additive column recording "has an attachment" on owner
  emails at sync, counted as a price given.
- **Eval baseline (several items):** `ANTHROPIC_API_KEY` repository secret, then "Prompt evals"
  with drafts on and commit `tests/evals/baseline.json`; prompt changes waiting on it are listed
  under "Prompt versions" in `docs/decisions/ai-and-prompts.md`. A model trial: `pnpm eval --model classify=<id>`.
- **"Lead websites and voicemail emails":** the site parsers and "Open <site>" links were written
  against invented samples; adjust them from the real ones.
- **Ideas package, not built (engineering backlog, no decision needed):** G3 suggested VIPs, B7
  "Send at 7am instead", the site package (A3 trade pages incl. /remodelers, A15 /security, A6
  slow-reply calculator); D7's payment thank-you line and D4's balance-only nudges wait on the
  eval baseline. Check the tip before building: later waves may have done parts (D4's
  `amount_paid_now` is in classify.v6).
- **"One Gmail per account, made strict":** the unique index waits until
  `select lower(email), count(distinct workspace_id) from mailboxes group by 1 having count(distinct workspace_id) > 1;`
  returns no rows on the shared database.

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
  at Stripe Checkout). The terms gate is live in production since the **second merge**
  (`claude/squared-away-mvp-ddxl7s`, PR #11, `c1bf580`, 2026-10-16), so owners are agreeing to
  the draft documents now: finishing the legal text (the one legal release) and a lawyer's
  review of both legal drafts are still due before launch (LAUNCH.md step 13, first open item).
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
