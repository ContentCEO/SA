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
src/app/(app)/      signed-in screens: connect (pre-OAuth explainer), settings
src/app/api/gmail/  Gmail OAuth callback (connect is a server action in (app)/connect/actions.ts)
src/mailbox/        connector interface + gmail/ implementation (scopes, OAuth, state)
src/server/         domain logic: accounts.ts, mailboxes.ts, session.ts (requireOwner)
src/lib/crypto.ts   AES-256-GCM for refresh tokens
src/config/         site.ts (business facts), models.ts, pricing.ts, retention.ts
src/db/             schema.ts, lazy db() client (postgres.js)
drizzle/            generated migrations — commit them
scripts/invite.ts   pnpm invite owner@shop.com [trade] ["note"]
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
- "Toasts" are currently `?done=` / `?error=` query params rendered as `<Notice>` (role=status/alert).
- Playwright's mobile project uses Chromium at 375×812 (not WebKit) to keep CI fast and single-browser.
- Favicon/app icons come from Davi's icon pack (`sa.` monogram) in `public/` + `site.webmanifest`.
  The pack has no stacked wordmark file, so the header wordmark is still set in type.
- **Local Postgres without Docker:** `pnpm db:local` (`scripts/local-db.ts`, `embedded-postgres`
  pinned to the Postgres 16 build, devDependency only). Same URL as CI. Davi's Mac has no
  Homebrew/Docker; Node lives in `~/.local/node`, `gh` in `~/.local/bin`.
- **Merge note (2026-09-28):** two sessions built M0–M1 in parallel. This repo's version is the
  base; the other build (local branch `local-build`, not pushed) contributed only the icon pack and
  `db:local`. Build one milestone at a time from here — one session on the repo at a time.
- `/api/health` returns `{ ok, service, commit }` — used by Playwright's webServer check and for
  deploy verification.

## Milestones

- [x] **0. Scaffold**
- [x] **1. Auth + Gmail connect** — code + tests done; live verification waits on Neon + Google client
- [ ] 2. Sync
- [ ] 3. Classification
- [ ] 4. Profiles
- [ ] 5. Drafts + Queue
- [ ] 6. Workspace lifecycle
- [ ] 7. Follow-ups
- [ ] 8. Digest + Activity
- [ ] 9. Autopilot
- [ ] 10. Billing
- [ ] 11. Hardening and launch

## Waiting on Davi

- Confirm the Vercel ↔ GitHub link produced a preview deploy for this branch.
- Neon project + `DATABASE_URL` in Vercel; Google Cloud OAuth client + Gmail API + test users.
- Vercel env: `AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`, `AUTH_GOOGLE_ID/SECRET`, `APP_URL`, `ADMIN_EMAIL`.
- Icon pack (`sa.` monogram, stacked wordmark).
- `docs/terms.md`, `docs/privacy-policy.md` drafts.
- `SUPPORT_EMAIL`, production domain.

## Launch blockers to remember

- Connect screen promises "won't keep email text longer than 30 days" — the purge job (M11) must
  ship before real customer mail is synced (M2 lands bodies in the DB).
