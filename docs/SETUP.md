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
```

## 6. Inviting an owner

```bash
pnpm invite owner@shop.com electrical "note for Davi"
```

Runs against whatever `DATABASE_URL` is in `.env.local`. (Becomes a button in `/admin` in Milestone 6.)

## 7. Google OAuth client

One OAuth client handles both sign-in and connecting Gmail. In Google Cloud Console →
APIs & Services → Credentials, the client needs two redirect URIs per environment:

- `{APP_URL}/api/auth/callback/google`
- `{APP_URL}/api/gmail/callback`

The Gmail API must be enabled, and while unverified, each owner must be added under OAuth consent
screen → Test users. See `docs/google-verification.md` for why we ask for each scope.

## 8. Deploys (Vercel)

The Vercel project is `sa` in the **DAC** team. To make every push deploy automatically:

1. Go to https://vercel.com/dac3/sa/settings/git
2. Under **Connected Git Repository**, click **Connect** → GitHub → pick `contentceo/sa`.
3. Under **Build and Deployment → Node.js Version**, choose **22.x** (matches CI).

After that: every push to a branch makes a Preview deployment; `main` deploys to production.
Deployment Protection (Vercel login) is on for previews, so only team members can see them.
