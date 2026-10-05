# Local setup

Goal: a new developer runs Squared Away locally in under 30 minutes.

## 1. Prerequisites

- Node.js 22 or newer (`node -v`)
- pnpm 10 (`corepack enable` then `pnpm -v`)
- Git
- Postgres 16 running locally (or Docker: `docker run -d -p 5432:5432 -e POSTGRES_USER=sa -e POSTGRES_PASSWORD=sa -e POSTGRES_DB=squared_away postgres:16`)

## 2. Install

```bash
git clone https://github.com/contentceo/sa.git
cd sa
pnpm install
cp .env.example .env.local
```

Fill in `.env.local`. Each variable has a comment saying where to get it and which milestone first
needs it. For local work you need at least:

```bash
APP_URL=http://localhost:3000
DATABASE_URL=postgres://sa:sa@localhost:5432/squared_away
AUTH_SECRET=$(openssl rand -base64 32)
AUTH_TRUST_HOST=true
TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
AUTH_GOOGLE_ID=...        # a Google OAuth client with http://localhost:3000 redirect URIs
AUTH_GOOGLE_SECRET=...
ADMIN_EMAIL=you@example.com
```

Then create the tables and invite yourself (sign-in is invite-only):

```bash
pnpm db:migrate
pnpm invite you@example.com plumbing
```

## 3. Run

```bash
pnpm dev            # http://localhost:3000
```

Open http://localhost:3000 — you should see _your inbox,_ / **handled.** and **Sign in with Google**.
Open http://localhost:3000/api/health — you should see `{"ok":true,...}`.

## 4. Checks (same as CI)

```bash
pnpm lint
pnpm format:check   # pnpm format to fix
pnpm typecheck
pnpm test           # unit tests (Vitest)
pnpm build
pnpm exec playwright install chromium   # first time only
pnpm test:e2e       # browser tests against the production build (needs DATABASE_URL — it writes test rows)
```

The browser tests sign in without Google by minting a session cookie with `AUTH_SECRET`
(`tests/e2e/support.ts`). Point them only at a disposable database.

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

Gmail push (optional, faster than the 5-minute poll): create a Pub/Sub topic, grant
`gmail-api-push@system.gserviceaccount.com` the Publisher role on it, add a push subscription to
`{APP_URL}/api/gmail/push?token=...`, and set `GMAIL_PUBSUB_TOPIC` + `GMAIL_PUSH_VERIFICATION_TOKEN`.

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
4. Going live: swap in the live secret key, redeploy, tap Connect Stripe again.

What payments do: checkout paid → `setup_paid` (or back to `active` if setup was finished before);
payment fails → `past_due` (jobs pause, nothing deleted); recovers → back; subscription ends →
`canceled` (read-only). The $499 setup fee is charged once per account, on the first checkout.

## 8. Google OAuth client

One OAuth client handles both sign-in and connecting Gmail. In Google Cloud Console →
APIs & Services → Credentials, the client needs two redirect URIs per environment:

- `{APP_URL}/api/auth/callback/google`
- `{APP_URL}/api/gmail/callback`

Registered today: production `https://sa-dac3.vercel.app` and the working-branch preview
`https://sa-git-claude-squared-away-mvp-ddxl7s-dac3.vercel.app`.

The Gmail API must be enabled, and while unverified, each owner must be added under OAuth consent
screen → Test users. See `docs/google-verification.md` for why we ask for each scope.

## 9. Deploys (Vercel)

The Vercel project is `sa` in the **DAC** team. To make every push deploy automatically:

1. Go to https://vercel.com/dac3/sa/settings/git
2. Under **Connected Git Repository**, click **Connect** → GitHub → pick `contentceo/sa`.
3. Under **Build and Deployment → Node.js Version**, choose **22.x** (matches CI).

After that: every push to a branch makes a Preview deployment; `main` deploys to production.
Vercel runs `pnpm vercel-build`, which applies pending migrations (`scripts/migrate.ts`) before
`next build`. Previews and production share one database today, so a preview build migrates it too —
keep migrations additive.
The Production branch must be `main` (Settings → Environments → Production → Branch Tracking).
Changing an environment variable only takes effect after a redeploy.
Deployment Protection (Vercel login) is on for previews, so only team members can see them.
