# Local setup

Goal: a new developer runs Squared Away locally in under 30 minutes.

## 1. Prerequisites

- Node.js 22 or newer (`node -v`)
- pnpm 10 (`corepack enable` then `pnpm -v`)
- Git

## 2. Install

```bash
git clone https://github.com/contentceo/sa.git
cd sa
pnpm install
cp .env.example .env.local
```

Fill in `.env.local`. Each variable has a comment saying where to get it and which milestone first
needs it. For Milestone 0 nothing is required.

## 3. Run

```bash
pnpm dev            # http://localhost:3000
```

Open http://localhost:3000 — you should see _your inbox,_ / **handled.**
Open http://localhost:3000/api/health — you should see `{"ok":true,...}`.

## 4. Checks (same as CI)

```bash
pnpm lint
pnpm format:check   # pnpm format to fix
pnpm typecheck
pnpm test           # unit tests (Vitest)
pnpm build
pnpm exec playwright install chromium   # first time only
pnpm test:e2e       # browser tests against the production build
```

## 5. Database (from Milestone 1)

```bash
pnpm db:generate    # after editing src/db/schema.ts — commit the new files in /drizzle
pnpm db:migrate     # apply migrations to DATABASE_URL
```

## 6. Deploys (Vercel)

The Vercel project is `sa` in the **DAC** team. To make every push deploy automatically:

1. Go to https://vercel.com/dac3/sa/settings/git
2. Under **Connected Git Repository**, click **Connect** → GitHub → pick `contentceo/sa`.
3. Under **Build and Deployment → Node.js Version**, choose **22.x** (matches CI).

After that: every push to a branch makes a Preview deployment; `main` deploys to production.
Deployment Protection (Vercel login) is on for previews, so only team members can see them.
