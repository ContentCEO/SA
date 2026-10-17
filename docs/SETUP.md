# Local setup

Goal: a new developer runs Squared Away locally, and both test suites, in under 30 minutes.

## 1. New developer in under 30 minutes

You need Node.js 22 or newer (`node -v`), pnpm 10 (`corepack enable`, then `pnpm -v`), Git, and
Postgres 16 on this machine. The quickest Postgres is Docker:

```bash
docker run -d --name sa-postgres -p 5432:5432 \
  -e POSTGRES_USER=sa -e POSTGRES_PASSWORD=sa -e POSTGRES_DB=squared_away postgres:16
```

1. **Install.**

   ```bash
   git clone https://github.com/contentceo/sa.git
   cd sa
   pnpm install
   ```

2. **Local Postgres.** Two databases: one for `pnpm dev`, and a disposable one the browser tests
   fill with test rows.

   ```bash
   docker exec sa-postgres psql -U sa -d squared_away -c 'create database squared_away_e2e'
   # or, with psql installed: psql postgres://sa:sa@localhost:5432/squared_away -c '…'
   ```

   The browser tests create the tables in it themselves.

3. **`.env.local` from `.env.example`.** `cp .env.example .env.local`, then fill in at least
   these (every variable is explained in §4 and in `.env.example`):

   ```bash
   APP_URL=http://localhost:3000
   DATABASE_URL=postgres://sa:sa@localhost:5432/squared_away
   AUTH_SECRET=...           # openssl rand -base64 32
   AUTH_TRUST_HOST=true
   TOKEN_ENCRYPTION_KEY=...  # openssl rand -base64 32
   AUTH_GOOGLE_ID=...        # a Google OAuth client with the localhost redirect URIs (§8)
   AUTH_GOOGLE_SECRET=...
   ADMIN_EMAIL=you@example.com
   ```

   Sorting and drafting also need `ANTHROPIC_API_KEY`, and background jobs need Inngest (§6).
   Everything else is optional and stays off when empty.

4. **Create the tables.** `pnpm db:migrate`

5. **Invite yourself** (sign-in is invite-only; `ADMIN_EMAIL` is always let in):
   `pnpm invite you@example.com plumbing`

6. **Run it.** `pnpm dev`, then open:
   - http://localhost:3000 — the public homepage (_your inbox,_ / **handled.**).
   - http://localhost:3000/signin — **Sign in with Google**. After signing in you land on the Queue.
   - http://localhost:3000/api/health — `{"ok":true,...}`.

7. **Unit tests.** `pnpm test`. No database or keys needed: database tests run on an in-memory
   Postgres (PGlite) with the real migrations.

8. **Browser tests.** Stop `pnpm dev` first, then:

   ```bash
   pnpm exec playwright install chromium   # first time only
   pnpm build
   APP_URL=http://localhost:3100 \
   DATABASE_URL=postgres://sa:sa@localhost:5432/squared_away_e2e \
   pnpm test:e2e
   ```

   They start the built app on port 3100 and the fake Google / Anthropic servers on 3101, migrate
   the e2e database, and sign in without Google (§3). Values on the command line win over
   `.env.local`.

## 2. Checks (same as CI)

```bash
pnpm lint
pnpm format:check   # pnpm format to fix
pnpm typecheck
pnpm test           # unit tests (Vitest)
pnpm build
pnpm test:e2e       # browser tests against the production build (see §1 step 8 and §3)
```

Several builder sessions often run at once. Before starting one, read "Working in parallel" in
`CLAUDE.md` (branch names, one migration at a time, notes in `docs/notes/`) and find the step in
`docs/BUILD-ORDER.md`.

## 3. End-to-end tests with fake Google and Anthropic

The browser tests drive the real app (`pnpm start`, the production build) against local fakes of
Google sign-in consent, Gmail and the Anthropic API (`tests/e2e/fakes`), so the whole journey —
Connect Gmail, reading mail, sorting, a Gmail draft, Send reply — runs with nothing leaving the
machine. Sign-in itself is skipped by minting the Auth.js session cookie with `AUTH_SECRET`
(`tests/e2e/support.ts`). The fake Gmail answers a call only if the token it issued carries a
scope Google accepts for that method (copied from Google's API reference into
`tests/e2e/fakes/server.ts`), so the journey proves the two scopes the app asks for are enough.

`playwright.config.ts` sets these four variables itself, only for the app server it starts. Don't
put them in `.env.local`, and **never** set them on Vercel:

- `SA_E2E` — `1` turns e2e mode on (`src/config/e2e.ts`, the only file that reads these).
- `SA_E2E_GOOGLE_BASE_URL` — where the server sends Google token, userinfo, revoke and Gmail API
  calls instead of Google (the fake, `http://127.0.0.1:<PORT+1>/google`).
- `SA_E2E_ANTHROPIC_BASE_URL` — where the AI calls go instead of Anthropic (the fake's
  `/anthropic`), with a fake key.
- `SA_E2E_HOOK_SECRET` — a random secret (made fresh each run) that unlocks
  `/api/test-hooks/run`, which runs the job steps (backfill, sync, sorting, drafting, the send
  after the undo window) the way Inngest would.

E2e mode is on only when **all** of these hold, so it can't switch on anywhere real: `SA_E2E` is
exactly `1`; `VERCEL` and `VERCEL_ENV` are both absent (it's ignored on any Vercel deploy); both
base URLs are http(s) on `localhost`, `127.0.0.1` or `[::1]`; and `DATABASE_URL` points at this
machine (read the way postgres.js reads it: a host list such as `remote,y@localhost`, more
than one `@` or a `#` in the host part is refused). The hook route doesn't check the request's
host (under `next start` the app only ever sees its own listen hostname); instead the e2e app is
started with `--hostname localhost`, so nothing on your network can reach it, and the per-run
secret is what unlocks the route. Keep Vercel's **"Automatically expose System Environment
Variables"** setting on (Settings → Environment Variables): it is what sets
`VERCEL`/`VERCEL_ENV` (and `VERCEL_BRANCH_URL`, which preview URLs depend on).

The app server is also given neutral stand-ins (`AUTH_GOOGLE_ID=e2e-client-id`, a fake Google
secret and Anthropic key, an empty `INNGEST_EVENT_KEY`) and every other outside service blanked
(Resend, Stripe, Twilio, web push, Pub/Sub, Sentry at runtime), so a test run can't email, charge,
text or push anyone, and your real keys never reach the fakes. In e2e mode the AI client also
drops any headers from `ANTHROPIC_CUSTOM_HEADERS`, and a `DATABASE_URL` with no host counts as
local only if `PGHOST` is too (that is where postgres.js would connect). Build for e2e without
`NEXT_PUBLIC_SENTRY_DSN` set (it is fixed at `pnpm build`).

Other knobs (test-only, never in the app): `PORT` (default 3100; `APP_URL` must be
`http://localhost:<PORT>` or the config stops with a message saying so), `E2E_FAKES_PORT`
(default `PORT+1`), `PLAYWRIGHT_CHROMIUM_PATH` (use a preinstalled Chromium instead of
`playwright install`), and `PLAYWRIGHT_BASE_URL` (a smoke run against a deployed site: no
servers, no fakes, and **no database** — the global setup returns before connecting, and only the
specs listed in `tests/e2e/smoke-specs.ts`, which touch no database, run). Otherwise the global
setup refuses a `DATABASE_URL` that isn't on this machine, migrates the local database and
clears `rate_limits` before each run; `tests/e2e/support.ts`, which every seeding spec imports,
refuses a non-local `DATABASE_URL` too, smoke run or not. Outside CI, Playwright reuses a server
already listening on `PORT` or `PORT+1`; a `pnpm dev` or `pnpm start` you started yourself there
lacks the e2e variables, so stop it first.

In a sandbox with a preinstalled Chromium:
`PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium pnpm test:e2e`.

## 4. Environment variables

Every outside account behind these settings (its plan, the limit that bites and whose login holds
it) is listed in [VENDORS.md](VENDORS.md).

Every variable the code reads. "Environments" says where it belongs in Vercel (Settings →
Environment Variables); a change there needs a redeploy. Previews and production share one
database until the preview split (`docs/LAUNCH.md` step 2: an empty Neon project, `sa-preview`,
Davi's choice on 2026-10-14). After it, `DATABASE_URL`, `AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY`
each have a separate Preview-only entry. `tests/unit/env-docs.test.ts`
fails if the code reads a variable that isn't in this table (and, unless Vercel or Playwright
sets it, in `.env.example`).

| Variable                                                                              | Required?                | What it turns on                                                                                                                                                                                            | Where to get it                                                                        | Environments                      |
| ------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------- |
| `APP_URL`                                                                             | Production: yes          | Absolute links, OAuth redirect URIs, cookies, emails. Previews fall back to `VERCEL_BRANCH_URL`, local to `http://localhost:3000`.                                                                          | The production domain, no trailing slash.                                              | Prod only; local                  |
| `DATABASE_URL`                                                                        | Yes                      | The database (postgres.js).                                                                                                                                                                                 | Neon → Connect → pooled string. Local: `postgres://sa:sa@localhost:5432/squared_away`. | Prod + Preview (sensitive); local |
| `AUTH_SECRET`                                                                         | Yes                      | Signs sessions; salts hashed IPs and referral fingerprints. Rotating it signs everyone out.                                                                                                                 | `openssl rand -base64 32`                                                              | Prod + Preview (sensitive); local |
| `AUTH_TRUST_HOST`                                                                     | Outside Vercel           | Lets Auth.js trust the host header (`pnpm start`, CI). Vercel handles it itself.                                                                                                                            | `true`                                                                                 | Local, CI                         |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`                                                | Yes                      | Google sign-in and Connect Gmail (one OAuth client).                                                                                                                                                        | Google Cloud → APIs & Services → Credentials (§8).                                     | Prod + Preview (secret sensitive) |
| `TOKEN_ENCRYPTION_KEY`                                                                | Yes                      | Encrypts Gmail refresh tokens (AES-256-GCM). Losing it means every mailbox reconnects.                                                                                                                      | `openssl rand -base64 32`                                                              | Prod + Preview (sensitive); local |
| `ADMIN_EMAIL`                                                                         | Yes                      | The only address allowed into `/admin`; always allowed to sign in; gets cost alerts.                                                                                                                        | Davi's address.                                                                        | Prod + Preview                    |
| `SUPPORT_EMAIL`                                                                       | Before launch            | Support address in the footer, status banner, not-invited page and legal pages (§6f).                                                                                                                       | Davi provides it.                                                                      | Prod + Preview                    |
| `ANTHROPIC_API_KEY`                                                                   | For sorting and drafting | Every AI call (sorting, drafts, voice, rewording) and `pnpm eval`.                                                                                                                                          | console.anthropic.com → API Keys.                                                      | Prod + Preview (sensitive); local |
| `AI_DAILY_CALL_CAP`                                                                   | No (default 500)         | Per-account daily ceiling on AI calls; warning at 80%.                                                                                                                                                      | A number.                                                                              | Prod                              |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`                                            | Production: yes          | Background jobs (sync, sorting, drafting, sends after undo, crons).                                                                                                                                         | Set by the Inngest Vercel integration (§6).                                            | Prod + Preview                    |
| `INNGEST_DEV`                                                                         | Local only               | `1` = use the local Inngest dev server.                                                                                                                                                                     | —                                                                                      | Local                             |
| `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_VERIFICATION_TOKEN`                                 | No                       | Gmail instant notifications; without them the 5-minute poll picks up mail.                                                                                                                                  | §6a.                                                                                   | Prod (token sensitive)            |
| `RESEND_API_KEY`, `EMAIL_FROM`                                                        | No                       | Morning and monthly summaries, Gmail-access-lost emails, cost and Growth notices. Without both, nothing is emailed.                                                                                         | §7b.                                                                                   | Prod (key sensitive)              |
| `STRIPE_SECRET_KEY`                                                                   | For payments             | Checkout, billing portal, webhook, Connect Stripe in `/admin`.                                                                                                                                              | §7c.                                                                                   | Prod (sensitive)                  |
| `STRIPE_WEBHOOK_SECRET`                                                               | No                       | Overrides the signing secret Connect Stripe stores. Leave unset in Vercel (a stale test value breaks every live webhook).                                                                                   | `stripe listen` locally.                                                               | Local only                        |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`                                             | No                       | Text alerts to the owner's own phone (both plus one sender below).                                                                                                                                          | §6c.                                                                                   | Prod (token sensitive)            |
| `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_FROM_NUMBER`                                  | One of them, for texts   | The sender: a Messaging Service (preferred: STOP/HELP and A2P 10DLC) or, for quick tests, a number in E.164.                                                                                                | §6c.                                                                                   | Prod                              |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`                                               | No                       | Phone notifications (web push). Public key alone shows the switch; both are needed to send.                                                                                                                 | §6e.                                                                                   | Prod (private key sensitive)      |
| `VAPID_SUBJECT`                                                                       | No (default `APP_URL`)   | Contact the push services can reach.                                                                                                                                                                        | `mailto:` address or https URL.                                                        | Prod                              |
| `NEXT_PUBLIC_SENTRY_DSN`                                                              | No                       | Error alerts (scrubbed). Read at build time: redeploy after setting.                                                                                                                                        | §6b.                                                                                   | Prod                              |
| `FEATURE_CLOSING_QUESTION`                                                            | No (off when unset)      | Plan #26. **On** in Vercel since 2026-10-14 (Davi's okay); live from the next deploy.                                                                                                                       | `1` (§6d).                                                                             | Prod + Preview                    |
| `FEATURE_REFERRALS`                                                                   | No (off)                 | Plan #47 (a free month, one plan up). **Ask Davi first**; the switch is the only control (§6d).                                                                                                             | `1` (§6d).                                                                             | Prod, only with Davi's okay       |
| `RETENTION_BODY_DAYS`                                                                 | No (default 30)          | Days before email text is purged. The privacy policy and homepage promise 30: don't change it without changing them.                                                                                        | A number.                                                                              | Prod                              |
| `VERCEL`, `VERCEL_ENV`, `VERCEL_BRANCH_URL`, `VERCEL_GIT_COMMIT_SHA`                  | Set by Vercel            | Deploy detection (turns e2e mode off), preview URLs, preview-only CSP, Sentry environment and release, `/api/health`'s `commit`, Web Analytics on production only.                                          | Automatic, while "Automatically expose System Environment Variables" is on.            | Vercel sets them                  |
| `NODE_ENV`                                                                            | Set by Next              | Development vs production behaviour.                                                                                                                                                                        | Automatic.                                                                             | —                                 |
| `SA_E2E`, `SA_E2E_GOOGLE_BASE_URL`, `SA_E2E_ANTHROPIC_BASE_URL`, `SA_E2E_HOOK_SECRET` | Set by Playwright        | Local e2e mode (§3).                                                                                                                                                                                        | `playwright.config.ts` sets them.                                                      | **Never** on Vercel               |
| `PGHOST`, `ANTHROPIC_CUSTOM_HEADERS`                                                  | Not ours                 | Read by postgres.js and the Anthropic SDK. We never set them; e2e mode checks `PGHOST` (when `DATABASE_URL` names no host) and drops any `ANTHROPIC_CUSTOM_HEADERS` so nothing real reaches the fakes (§3). | —                                                                                      | Not set                           |

## 5. Database

We use the `postgres` (postgres.js) driver everywhere: local Postgres, CI, and Neon's **pooled**
connection string in production.

```bash
pnpm db:generate    # after editing src/db/schema.ts — commit the new files in /drizzle
pnpm db:migrate     # apply migrations to DATABASE_URL
pnpm db:migrate:http   # same, over Neon's HTTPS endpoint — for networks that block port 5432
```

## 6. Background jobs (Inngest)

Sync, polling, watch renewal and the retention purge run as Inngest functions
(`src/jobs/functions.ts`, served at `/api/inngest`).

- Local: set `INNGEST_DEV=1` in `.env.local`, run `pnpm dev`, and in another terminal
  `npx inngest-cli@latest dev -u http://localhost:3000/api/inngest`. The dashboard at
  http://localhost:8288 shows every run and lets you trigger the crons.
- Production: the Inngest Vercel integration sets `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` and syncs
  the app on every deploy.

Without Inngest nothing syncs: connecting Gmail still works, but no mail is read.

### 6a. Gmail instant notifications (optional)

Without this, new mail is picked up by the 5-minute poll. With it, Gmail tells us within seconds.
Free at this volume (Pub/Sub's free tier is 10 GB/month; each notification is a few hundred bytes).
All in the same Google Cloud project as the OAuth client (project number 214188340483):

1. console.cloud.google.com → APIs & Services → Library → **Cloud Pub/Sub API** → Enable.
2. Pub/Sub → Topics → **Create topic**, ID `gmail-push`, untick "Add a default subscription" → Create.
   Copy its full name: `projects/<project-id>/topics/gmail-push`.
3. On that topic → **Permissions** (right panel; "Show info panel") → Add principal
   `gmail-api-push@system.gserviceaccount.com`, role **Pub/Sub Publisher** → Save.
4. Make a long random token (e.g. `openssl rand -hex 24`, or any 40+ random letters and digits).
5. Pub/Sub → Subscriptions → **Create subscription**: topic `gmail-push`, delivery type **Push**,
   endpoint `https://sa-dac3.vercel.app/api/gmail/push?token=<the token>`, everything else default.
6. Vercel → sa → Settings → Environment Variables (Production): `GMAIL_PUBSUB_TOPIC` = the full topic
   name from step 2, `GMAIL_PUSH_VERIFICATION_TOKEN` = the token (sensitive). Redeploy.
7. Watches start at the next daily renewal (6:17 UTC). To start now: Inngest dashboard → Functions →
   **renew-gmail-watches** → Invoke.

The push only says "something changed in this mailbox" — we never read content from it; it just
starts the normal sync. The poll keeps running as a safety net.

### 6b. Error alerts (Sentry, optional)

Server errors, browser errors, and background jobs that fail after all their retries are reported
to Sentry. Every event is scrubbed first (`src/lib/sentry.ts`): no request bodies, cookies, headers
or query strings, user reduced to an id, email addresses masked. No tracing or session replay.

1. sentry.io → sign up (free Developer plan) → Create project → platform **Next.js**, name `sa`.
   Skip the wizard — the code is already in place.
2. Project → Settings → Client Keys (DSN) → copy the DSN.
3. Vercel → sa → Environment Variables (Production): `NEXT_PUBLIC_SENTRY_DSN` = the DSN. Redeploy.
4. Sentry → Alerts: the default "new issue" email alert is enough to start.

### 6c. Text alerts (Twilio, optional)

Owners can opt in to a text when a new quote request or an email that needs them arrives. Texts
are counts plus a link only (no names, no email text), confirmed with a 6-digit code, quiet from
9pm–7am in the owner's time zone, max one per 10 minutes and 10 a day. An emergency email (a leak,
no heat, no power, a gas smell) is the one exception while the owner leaves "Emergencies, even at
night" on (it's on by default): "An emergency email just came in." right away, night or day, once
per conversation, at most 3 a night and 6 a day (phone notifications follow the same switch). A
voicemail or text message emailed by a phone service (Google Voice) counts, though its sender is
no-reply. Costs: about $1.15/month
for the number plus about $0.01 per text, and a one-time US carrier (A2P 10DLC) registration.

1. twilio.com → sign up → upgrade the account (add a card).
2. Phone Numbers → Buy a number (local, SMS-capable).
3. Messaging → Regulatory compliance → **A2P 10DLC**: register the brand (your business) and a
   campaign. Use case "Account notifications"; sample message
   `Squared Away: 1 new quote request needs you. Open: https://…/queue` (and a second one,
   `Squared Away: An emergency email just came in. Open: https://…/queue`); opt-in = "the business
   owner enters their own mobile number in Settings and confirms a texted code". Approval takes
   days; texts may be blocked by carriers until it's approved.
4. Messaging → Services → Create → add the number to the service. Opt-out (STOP/HELP) handling is
   on by default.
5. Vercel → sa → Environment Variables (Production): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
   (sensitive), `TWILIO_MESSAGING_SERVICE_SID`. Redeploy.

### 6d. Feature switches (off by default)

Some features are built and tested behind a switch that only Davi's okay turns on. Each one is off
unless its env var is exactly `1`, `true` or `on` (any case); empty, missing or anything else means
off (`src/config/features.ts`). The code default stays off: the env var is the switch.

- `FEATURE_CLOSING_QUESTION` (plan #26, **on in Vercel since 2026-10-14**, Davi's okay): on a quote
  that has had both follow-up nudges and then 7 more quiet days, Quotes offers "Want to ask if they
  went another way?". Only the owner's tap writes the draft (never a job), once per thread ever,
  never on a complaint, and it goes through the normal queue. It is not a nudge and doesn't count
  as one.

- `FEATURE_REFERRALS` (plan #47, default **off**; offer A, decided 2026-10-15): each account gets
  a referral link in Plan & billing (`/?ref=<code>`). The code rides on the waitlist form, onto the
  invite when Davi taps Invite, and onto the new workspace at its first sign-in (used up there).
  The first time the referred account is **active** (paid through Stripe and the setup call done),
  the referral is settled once, ever: **the referrer's next month is free on the plan above
  theirs** (Solo → Crew, Crew → Company, Company → Company). There is no amount to set
  (`REFERRAL_REWARD` in `src/config/pricing.ts`); the switch is the only control. Self,
  same-business-domain and house-account referrals never count (gmail.com, yahoo.com, outlook.com,
  icloud.com and other public webmail are fine).
  **A Growth request can earn it too** (Davi, 2026-10-16): a Growth call request sent from the
  homepage with the referral link keeps the code on its waitlist row; when Davi makes that person
  a Growth client (/admin/growth → Start Growth, or their first sign-in after Invite to Growth),
  the referral is settled the same way, with the same reward and the same self / same-domain /
  house rules. One person is only ever counted once: the app account and the Growth client share
  the email fingerprint, whichever comes first.
  How it works: a one-time 100%-off coupon (`sa_ref_<id>`, "Referral thanks: this month is free")
  goes on the referrer's live subscription, so Stripe keeps billing their own plan and the next
  renewal's plan line is free; the app gives the plan above for exactly that line's period. It
  starts only while the account is on (setup paid or active, paid through Stripe), one free month
  at a time with a paid month between (Davi, Q1), and a month that can't start yet waits with no
  expiry (Q5). Afterwards they go back to their own plan by itself unless they tap **Keep**
  (normal price, named in full before the tap); **Go back** after a Keep restores exactly the
  price they paid. Nothing else ever raises a price. At the end, autopilot turns off if the plan
  has none and extra inboxes pause (oldest-created stay on, nothing deleted, the owner can switch
  which one); a move down on Stripe's page pauses extra inboxes the same way (Q2). During the free
  month Stripe's page offers card, invoices and cancel only (Q3), and any charge Stripe adds for
  free days is removed. The 15-minute job and every Stripe webhook keep it in step, always from a
  fresh read of the subscription.
  **Free months wait while Stripe's billing page schedules downgrades for the period end**
  ("Manage downgrades"): such a schedule can drop the coupon. /admin → Payments says so; turn it
  off in Stripe → Customer portal.
  Referrals that become active while the switch is off are settled as "skipped" and are **never
  given later**, even if it's turned on again. The same goes for an owner whose first sign-in
  happens while it's off: the invite's referral is used up then without linking them. A free month
  already booked or running carries on if the switch goes off (Stripe already holds the coupon);
  waiting ones stay on the /admin card. Refunding the new contractor later doesn't take the
  referrer's free month back (Q6).
  Known gaps, by design until Davi decides otherwise: if the referrer deletes their account
  before the new owner is active, the referral is void (the link is cleared with the account).
  Only a waitlist sign-up or a Growth call request from the link counts (the /growth page itself
  carries no code): someone already on the waitlist who joins again from a link keeps their first
  (code-less) entry, and an owner invited with the plain "Invite an
  owner" form is never linked to anyone.
  **Don't rotate `AUTH_SECRET` once referrals have been given** (or know what it costs): the
  "once, ever" check matches a fingerprint salted with `AUTH_SECRET`. After a rotation, earlier
  referrals no longer match, so an owner who deleted their account and is linked again from a
  referral link could earn the referrer a second month. Rotating it also signs everyone out. If it
  must be rotated, settle it with Davi first.

**`FEATURE_CLOSING_QUESTION` is on** (Davi, 2026-10-14). The engineers set it to `1` in Vercel →
sa → Environment Variables on Production and Preview that day, at his request; it takes effect with
the next deploy (the launch merge). Turning it off needs his okay too: delete the variable (or set
it empty) and redeploy; the offer disappears, and any closing-question drafts already in the queue
stay there for the owner to send or discard.

**Ask Davi before turning `FEATURE_REFERRALS` on.** The reward itself is decided (offer A,
2026-10-15; his answers to the seven questions on 2026-10-16 are in `docs/LAUNCH.md` step 13).
In order, all before the switch:

1. The live Stripe key, **Connect Stripe** and **Reset test payments** (LAUNCH steps 7–7c). Reset
   also deletes free months earned in test mode, so a test-card referral never becomes a real free
   month (the real payment settles it again, once).
2. /admin → Payments shows "Stripe's billing page changes plans straight away, so free months
   can be booked." (Not the "schedules downgrades" line, and not "Couldn't check…": refresh until
   Stripe answers.)
3. Add these lines (held here so the terms version doesn't change before then), update
   `tests/unit/legal-docs.test.ts` (it pins that the privacy policy says nothing about referrals
   while they're off) and bump the terms version in the app with the terms' "Last updated" date:
   - **Terms:** "If someone you referred becomes a customer, your next month is free on the plan
     above yours. Afterwards you go back to your own plan unless you choose to keep it at its
     normal price. During that free month, plan changes are made in the app; you can still update
     your card or cancel."
   - **Privacy policy** (its Growth-request sentence, "If you followed another Squared Away
     owner's referral link while we offer referrals, we keep that link's code with your request…",
     is in the policy already and the test allows it): "If you were referred, we keep a scrambled one-way fingerprint of your
     email and the referral record after you delete your account, so a referral only counts
     once." and "If you earn a free month: which plan, the dates, and whether you chose to keep
     it." (Otherwise the policy's "Delete my account" section and the FAQ's "deletes your account
     and everything in it" aren't literally true once referrals are on.)
4. **An engineer runs the Stripe Test Clock check, locally only** (never on a preview or
   production: previews share production's database). A laptop with its own Postgres, a **test**
   key, `FEATURE_REFERRALS=1` and `stripe listen --forward-to localhost:3000/api/stripe/webhook`.
   Make a Test Clock and a customer on it with a Massachusetts address; put that customer id on
   the referrer workspace and choose a plan (if Checkout refuses a clock customer, make the
   subscription in the Dashboard's clock simulation with automatic tax and
   `metadata.workspaceId`, and set the workspace's ids and status by SQL). Settle a referral by
   seeding an active, Stripe-paid referred workspace. Then check, advancing the clock (at most two
   billing periods per step): the sweep books the coupon; the renewal's plan line is −100% with $0
   tax on it, the app shows the plan above (provisional, then confirmed once the invoice
   finalizes); Keep makes no invoice and the next renewal is the kept plan plus tax, ended by
   Stripe's renewal rather than our clock; without Keep the next renewal is the old plan plus tax,
   autopilot is off and the extra inbox paused; a plan change on Stripe's page during the month
   (with the login page, since the app's page has none) leaves no charge for free days; a change
   while booked charges at most the normal proration and the free month is one above the new
   plan; canceling or a past-due card (test card `4000000000000341`) while booked returns it to
   waiting; repeat on a **classic**-mode subscription made in the Dashboard; and remove the address
   so the renewal can't finalize: provisional; from a day before the end the coupon comes off the
   subscription, and **the stuck draft must keep its −100% line** (if it loses it, /admin flags
   "lost its discount"); the next renewal is the normal price. Also check that a renewal drafted
   just before the coupon landed leaves the coupon on for the renewal after. Record the results
   in `docs/LAUNCH.md`.
5. Vercel → sa → Environment Variables → add `FEATURE_REFERRALS` with value `1` (Production only,
   unless Davi says otherwise) → Redeploy.

To turn it off again, delete the variable (or set it empty) and redeploy: the Share section and
links disappear, new codes aren't carried, and nothing new is earned or booked. Free months
already booked or running carry on (Stripe holds the coupon); waiting ones wait and are booked if
it's turned back on. Referrals whose account went active while it was off are settled as
"skipped" and are never given later.

### 6e. Phone notifications (VAPID, optional)

Owners can turn on phone notifications (Settings) for new quote requests, emails that need them
and leads waiting too long. The push is **empty**: the push service (Google, Apple, Mozilla or
Microsoft) only sees a ping, and the phone then fetches the counts from us (`src/lib/web-push.ts`,
`public/sw.js`). Free; no account needed.

1. Make one key pair (P-256, base64url) on any machine with Node:

   ```bash
   node -e "const c=require('crypto');const{privateKey:k}=c.generateKeyPairSync('ec',{namedCurve:'P-256'});const j=k.export({format:'jwk'});console.log('VAPID_PUBLIC_KEY='+Buffer.concat([Buffer.from([4]),Buffer.from(j.x,'base64url'),Buffer.from(j.y,'base64url')]).toString('base64url'));console.log('VAPID_PRIVATE_KEY='+j.d)"
   ```

   (Any VAPID key generator works too, for example `npx web-push generate-vapid-keys`.)

2. Vercel → sa → Environment Variables (Production): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`
   (sensitive) and, optionally, `VAPID_SUBJECT` (`mailto:` the support address; defaults to
   `APP_URL`). Redeploy.
3. How to know it worked: Settings → Notifications shows the phone-notification switch; turn it on from an installed
   app (on iPhone, only from the Home Screen app) and the first new quote request buzzes the phone.

Keep the pair once owners use it: after a change, each phone has to switch notifications off and
on again.

### 6f. SUPPORT_EMAIL

The address owners write to for help. It appears in the site footer, the account status banner
(expired, past due, paused…), the "not invited" page and the privacy policy and terms (their
contact block). It is read from the environment, never typed into the code. Empty means those
places show the phone number only and the legal pages leave out the email line.

Set it in Vercel → sa → Environment Variables (Production and Preview) to the address Davi gives
us, then redeploy. How to know it worked: the footer of https://<domain>/ and the contact block of
`/privacy` show it.

## 7. Inviting an owner

```bash
pnpm invite owner@shop.com electrical "note for Davi"
```

Runs against whatever `DATABASE_URL` is in `.env.local`. Day to day, use `/admin` → Invite an owner.

## 7b. Morning summary email (Resend)

The digest is sent through Resend's HTTP API (`src/lib/email.ts`). Without `RESEND_API_KEY` and
`EMAIL_FROM`, nothing is sent — the job reports "not configured" and tries again next hour.

1. resend.com → API Keys → Create API Key (sending access is enough).
2. Until a domain is verified, Resend only delivers to the email address on the Resend account,
   from `onboarding@resend.dev`. For testing: `EMAIL_FROM="Squared Away <onboarding@resend.dev>"`.
3. For real owners: resend.com → Domains → add the production domain, add the DNS records it shows,
   then set `EMAIL_FROM="Squared Away <hello@thatdomain>"`.
4. Put both in Vercel (Production) and redeploy.

The digest carries counts and categories only — no customer names, subjects or email text.

The trial emails (2026-10-16, `src/server/trial-emails.ts`: day 2, the last day, and one a week
after an unpaid trial ends) use the same key and sender, counts only, from the 15-minute
lifecycle job. Each carries a one-click "Stop these emails" link signed with `AUTH_SECRET`
(rotating it makes old links land on "that link didn't work"; owners can still switch them off in
Settings → Morning email).

The same key and sender also carry the waitlist emails (`src/server/waitlist-emails.ts`): a
content-free "New waitlist sign-up" notice to `ADMIN_EMAIL`, and one "You're on the Squared Away
list" to the person who joined (replies go to `SUPPORT_EMAIL` when it is set). Until a domain is
verified the confirmation can't reach anyone but the Resend account's own address. It is only
marked sent after Resend accepts it, but it is only tried when someone first joins, so people who
join before the domain is verified never get one. No new settings.

## 7c. Payments (Stripe)

Payments move accounts through the commercial flow — only Stripe's signed webhook changes status,
never the browser redirect.

1. dashboard.stripe.com → Developers → API keys → copy the **Secret key** (`sk_test_…` while
   testing). Put it in Vercel → sa → Settings → Environment Variables as `STRIPE_SECRET_KEY`
   (Production, sensitive) and redeploy.
2. Open `/admin` → **Payments** → **Connect Stripe**. It creates (or reuses) the setup-fee and plan
   prices from `src/config/pricing.ts` (lookup keys include the amount, so a price change makes a
   new Stripe price), the customer billing portal, and a webhook to `/api/stripe/webhook`. The
   webhook's signing secret is stored encrypted in `app_settings`. Safe to tap again.
3. Test: as an owner, Settings → Plan & billing → Choose a plan, card `4242 4242 4242 4242`, any
   future date, any CVC. The page shows "finishing up" until the webhook lands, then the account is
   `setup_paid` (sending on). Admin still marks the setup call done (→ `active`).
4. Going live (`docs/LAUNCH.md` step 7, in one sitting): swap in the live secret key, redeploy,
   then **right away** tap Connect Stripe again. Until then live mode has no webhook endpoint, so a
   live checkout paid in between would never reach the app (no `checkout.session.completed`, no
   `setup_paid_via`, and no admin move can set it). Then `/admin` → Payments → **Check test
   payments** → **Reset test payments** (accounts that paid with a test card lose their test-mode
   Stripe ids, and a setup paid that way goes back to unpaid, so they pay for real; a past_due one
   goes back to setup_paid / active, so its jobs run again but it can't send; only works with the
   live key, safe to tap again). The order of Connect and the reset doesn't matter to the reset:
   before Connect, test events are dropped (`eventFromOtherMode`); after it, they fail the live
   endpoint's signature.
5. Sales tax (Stripe Tax; Davi turned it on 2026-10-14). The app never configures tax — it only
   asks Stripe whether Stripe Tax is **active**. Davi's click-by-click steps are `docs/LAUNCH.md`
   7e. Test mode and live mode are separate, so do the Stripe part in each, in this order:
   - Before anything in Stripe: Davi registers for Massachusetts sales and use tax on
     MassTaxConnect (he's based in Concord; Stripe can't register a seller in its home state).
     Without that registration Stripe charges $0 tax and warns about nothing. It takes days, so
     `docs/LAUNCH.md` has it start before step 0 ("Start your sales tax registration now").
   - Tap **Connect Stripe again** in `/admin`. Prices made before have no tax behavior, and
     Connect Stripe sets each of those to **exclusive** (tax on top; the one change Stripe allows —
     a price already inclusive or exclusive is left alone) whether or not tax is on yet, so no
     checkout ever runs with tax on and a price that has no tax behavior. New prices are always
     made exclusive.
   - Stripe → Settings → Tax: head office = the Concord business address; preset product tax
     code **Software as a service (SaaS) - business use** (`txcd_10103001`); Include tax in
     prices = **Exclusive**. Stripe calls the settings **active** as soon as the head office is
     saved. That only means Stripe can work tax out, not that it charges any.
   - Product catalog → **Squared Away — Setup** → Product tax code **SaaS Implementation and Setup
     Services - Mandatory** (`txcd_20120002`), unless the accountant says otherwise (setup is
     required before sending, and Massachusetts' rules tax a required service sold with software).
   - Stripe → Tax → **Locations** (the page the admin card calls Tax → Registrations; its address
     ends `/tax/registrations`) → Add registration → Massachusetts → I've already registered.
     Stripe charges tax only where a registration exists; with none, checkouts still ask for an
     address but charge no tax.
   - Worked when: `/admin` → Payments reads "Sales tax: on (Stripe Tax is set up)." **and**
     Stripe → Tax → Locations shows Massachusetts as "Collecting tax". The "on" line alone
     doesn't prove tax is being charged anywhere (the admin card says so under it).
   - Tax Basic costs 0.5% of each taxed payment (tax included), no monthly fee, and doesn't file:
     Davi files the Massachusetts returns on MassTaxConnect from Stripe's report (frequency set by
     the state; each due within 30 days after its period).

   While Stripe Tax is active, every checkout turns on automatic tax and asks for the owner's
   billing address, which Stripe saves on their customer record together with the name typed on
   its page (that name can replace the business name we sent; Squared Away stores neither). `/admin` →
   Payments shows "Sales tax: on / off / couldn't check". If Stripe can't be asked at checkout
   time, the checkout fails rather than charging without tax, and the log line
   `stripe_tax_check_failed` carries a `reason`: `connection` / `rate_limit` / `api` are
   Stripe-side and usually pass; `auth` / `permission` mean `STRIPE_SECRET_KEY` is wrong or restricted
   and every checkout keeps failing until it's fixed. Customer portal: Connect Stripe lets owners
   update their address only when it creates the portal settings; if they already existed, tick
   Stripe → Settings → Billing → Customer portal → Billing information → **Billing address**.
   Subscriptions started before Stripe Tax was active keep running without tax until changed in
   Stripe.

What payments do: checkout paid → `setup_paid` (or back to `active` if setup was finished before);
payment fails → `past_due` (jobs pause, nothing deleted); recovers → back; subscription ends →
`canceled` (read-only). The $499 setup fee is charged once per account, on the first checkout.

## 8. Google OAuth client

One OAuth client handles both sign-in and connecting Gmail. In Google Cloud Console →
APIs & Services → Credentials, the client needs two redirect URIs per environment:

- `{APP_URL}/api/auth/callback/google`
- `{APP_URL}/api/gmail/callback`

Registered today: production `https://sa-dac3.vercel.app` and the working-branch preview
`https://sa-git-claude-squared-away-mvp-ddxl7s-dac3.vercel.app`. For local work add
`http://localhost:3000/api/auth/callback/google` and `http://localhost:3000/api/gmail/callback`
(the browser tests don't need them: they never talk to Google).

The Gmail API must be enabled. Connect Gmail asks for exactly two Gmail scopes,
`https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/gmail.compose`
(`src/mailbox/gmail/scopes.ts`; `gmail.send` was dropped on 2026-10-15, since `gmail.compose`
already covers both `drafts.send` and `messages.send`). Google Auth Platform → Data Access should
list those two and nothing else from Gmail (`docs/LAUNCH.md` step 0e). Owners who connected while
the app still asked for `gmail.send` keep it in their grant; that's harmless, and a grant missing
either of the two is refused and revoked. While the app's publishing status (Google Auth Platform →
Audience) is **Testing**, each owner must be added there as a test user (at most 100), and Google's
refresh tokens for Gmail scopes expire after 7 days, so every owner has to reconnect weekly. Switch
it to **In production** before real owners connect; until Google's verification passes, owners see
Google's "unverified app" warning. Access given while it was still Testing keeps its 7-day end, so
everyone who connected then reconnects once after the switch (`/connect` → the same address;
`docs/LAUNCH.md` step 0c). See `docs/google-verification.md` for why we ask for each scope,
the demo-video script and the reviewer account.

## 9. Deploys (Vercel)

The Vercel project is `sa` in the **DAC** team. To make every push deploy automatically:

1. Go to https://vercel.com/dac3/sa/settings/git
2. Under **Connected Git Repository**, click **Connect** → GitHub → pick `contentceo/sa`.
3. Under **Build and Deployment → Node.js Version**, choose **22.x** (matches CI).

After that: every push to a branch makes a Preview deployment; `main` deploys to production.
Vercel runs `pnpm vercel-build`, which applies pending migrations (`scripts/migrate.ts`) before
`next build`. Until previews get their own database (`docs/LAUNCH.md` step 2, the `sa-preview` Neon
project), a preview build migrates the production database too — keep migrations additive.
The Production branch must be `main` (Settings → Environments → Production → Branch Tracking).
Changing an environment variable only takes effect after a redeploy.
Keep **Settings → Environment Variables → "Automatically expose System Environment Variables"** on:
preview URLs (`VERCEL_BRANCH_URL`) and the "this is a Vercel deploy" check that keeps e2e mode off
(`VERCEL`, `VERCEL_ENV`; §3) depend on it.
Deployment Protection (Vercel login) is on for previews, so only team members can see them.

## 10. Prompt evals (before a release)

`pnpm eval` sends the 66 invented emails in `tests/evals/cases.ts` through the real models and
prints a score table plus token cost (about $1–2 for a full run; `--no-drafts` is cheaper). It fails
if anything is worse than `tests/evals/baseline.json`. Needs `ANTHROPIC_API_KEY` in `.env.local`.

- First time (or after an intended improvement): `pnpm eval --update-baseline`, then commit the file.
- From GitHub: Actions → **Prompt evals** → Run workflow. Add `ANTHROPIC_API_KEY` as a repository
  secret first (Settings → Secrets and variables → Actions). It never runs on its own.
