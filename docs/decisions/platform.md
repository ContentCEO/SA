# Platform: stack, Vercel, Neon, settings, auth, migrations and tooling

Moved unchanged from `CLAUDE.md`'s "Decisions" section on 2026-10-19 (Check 49 P5), in their
original order. Rules that a test or gate depends on are also stated in `CLAUDE.md`.

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
- `db()` is created lazily so build/test don't need `DATABASE_URL`.
- **DB driver: postgres.js everywhere** (not `@neondatabase/serverless`). Works with Neon's pooled
  URL (`prepare: false` for PgBouncer), local Postgres, and CI's Postgres service, so signed-in e2e
  tests run without Neon. Unit tests use PGlite with the real migrations.
- **Sign-in is invite-only** via an `invites` table (script now, /admin later). `ADMIN_EMAIL` always
  allowed. First sign-in creates user + workspace (status `invited`), idempotently.
- JWT sessions (no Auth.js adapter tables); session carries our `users.id` as `uid`.
- CSRF: mutations are Server Actions (POST + Origin/Host check by Next). Every action re-checks the
  owner via `requireOwner()`; queries are always scoped by `workspaceId`.
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
- Migrations run in `vercel-build` before `next build`. Keep them additive (old code must keep
  working against the new schema, since previews and prod share the DB).
- Playwright's mobile project uses Chromium at 375×812 (not WebKit) to keep CI fast and single-browser.
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
- postgres.js can't bind a `Date` inside a raw `sql` template — pass `.toISOString()` with
  `::timestamptz` (PGlite tolerates it, so unit tests won't catch it; e2e did).
- Lesson: scripted `str.replace` edits must `assert old in s` — silent no-ops after Prettier caused
  M3/M4 regressions. `tests/unit/jobs.test.ts` fails if a `createFunction` isn't registered.
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
