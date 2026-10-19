# When the app stops

For Davi. What to do when something stops working, in the same style as
[LAUNCH.md](LAUNCH.md): **where** to look, **what you see**, **what to do** and how to know it
**worked**. This page only ever names a setting (like `STRIPE_SECRET_KEY`); never paste a value
here, in chat or in an email.

Two quick checks tell you most of the time whether the app itself is up:

- `https://<production address>/api/health` answers `"ok":true` when the site is running. It
  doesn't touch the database, so `"ok":true` alone doesn't prove much.
- `/api/health/deep` (needs `HEALTH_TOKEN`, [SETUP.md](SETUP.md) §6g) also checks the database and
  that the 15-minute safety job ran in the last 30 minutes. It answers 503 when either is wrong,
  and emails `ADMIN_EMAIL` "Background jobs look stopped" at most once an hour.

When it's fixed, write it down ([After it's fixed](#after-its-fixed)).

## Is it us or them?

First look at the status page of each company the app runs on. If one shows a problem, the app
waits for it like everyone else; there's usually nothing to fix on our side.

- Vercel (the site): https://www.vercel-status.com
- Neon (the database): https://neonstatus.com
- Inngest (background jobs): https://status.inngest.com
- Anthropic (the AI): https://status.claude.com
- Resend (the app's emails): https://resend-status.com
- Stripe (payments): https://status.stripe.com
- Google Workspace (Gmail and Google sign-in): https://www.google.com/appsstatus/dashboard/

## 1. The database is paused or unreachable

- What you see: every signed-in screen shows "sorry about that, something broke."; `/admin`
  doesn't load; `/api/health/deep` answers `{"db":"down"}`.
- Where: Neon console → project `autumn-term-70302192` (not `sa-preview`) → its first page →
  **Usage**, and console.neon.tech/app/billing.
- Most likely: on Neon's Free plan the compute hours ran out and Neon paused the database until
  the next billing period ([LAUNCH.md "Check your free plans now"](LAUNCH.md#neon-the-database)).
- What to do: move to Neon's Launch plan on the Billing page (your money decision); the database
  starts again on its own. If the plan is fine, check neonstatus.com, then tell the engineers.
- Don't reset the database password to "fix" it: that stops production until the new string is
  in Vercel (LAUNCH.md step 3).
- Worked when: `/admin` loads your accounts again, and `/api/health/deep` shows `"db":"ok"`.

## 2. Background jobs stopped

- What you see: `/admin` → the first box is titled **Background jobs look stopped** instead of
  **System**; an email "Background jobs look stopped" (if the uptime monitor is set up); owners see
  "N new emails aren't sorted yet." at the top of their screens and no new drafts.
- Where: Inngest dashboard (Vercel → sa → Integrations → Inngest) → Apps → sa → **Functions**,
  and its Billing or Usage page.
- Most likely: the free plan's 50,000 executions a month are used up (Inngest pauses every job;
  [LAUNCH.md "Inngest"](LAUNCH.md#inngest-background-jobs)), the integration broke, or a deploy
  broke the jobs.
- What to do: limit reached → move to the paid plan. Apps shows a sync error → tap Resync. Runs
  fail since the last deploy → [section 7](#7-a-bad-deploy). Otherwise tell the engineers.
- Worked when: [LAUNCH.md step 11](LAUNCH.md#11-check-the-background-jobs-after-the-merge) passes
  again, and `/admin`'s first box says **System**. Waiting mail is sorted on its own.

## 3. AI calls failing

- What you see: `/admin` → the first box says **Sorting is stopped**, **Drafting is stopped** or
  **Voice learning is stopped** (with an email of the same name when a model is missing). Owners
  see "N new emails aren't sorted yet.", or "Writing is slow right now…" when they tap a button
  that writes.
- Where: console.anthropic.com → **Settings** → **Billing** (credit) and **Limits** (monthly spend
  limit); status.claude.com. What each shop costs: `/admin/costs`.
- Most likely: the prepaid credit ran out, the spend limit was reached, the key was revoked, or
  Anthropic is having an outage.
- What to do: add credit or raise the limit; a revoked key → [section 8](#8-a-leaked-key). A
  model that's no longer available is the engineers' to switch (`src/config/models.ts`). Nothing
  is lost: email waits in Gmail and is sorted when the AI answers again.
- Worked when: the box says **System** and owners' new mail is sorted and drafted again.

## 4. Emails not arriving

- What you see: owners say they never got an invite, the morning email or a "lost access" email.
  `/admin` → the **Email** box shows a refusal count ("Refused in the last 7 days: N") or "Test
  sender: emails only reach the Resend account's own address."
- Where: resend.com → **Emails** (each email's status) and **Domains**.
- Most likely: the domain isn't verified yet ([LAUNCH.md step 6](LAUNCH.md#6-emails-from-your-own-domain-resend)),
  the free plan's daily or monthly limit is reached, or Resend refused one address.
- What to do: verify the domain; move to a paid Resend plan if the limit is the problem; for one
  refused address, check it with the owner. `/admin` → Email → **Send me a test email** shows
  whether sending works at all.
- Worked when: the test email arrives and Resend → Emails shows the next ones as **Delivered**.

## 5. Payments not moving accounts

- What you see: an owner paid, but their billing page stays on "Payment received — finishing up."
  and then says Stripe has the payment; `/admin` → Payments says "An owner paid but no Stripe
  notice arrived (N). Check Stripe → Developers → Webhooks." and their card says "Paid, waiting on
  Stripe".
- Where: Stripe → Developers → **Webhooks** → the endpoint ending `/api/stripe/webhook` → its
  failed deliveries.
- Most likely: the webhook's signing secret doesn't match (often a leftover
  `STRIPE_WEBHOOK_SECRET` in Vercel), or the endpoint points at an old address.
- What to do: delete any `STRIPE_WEBHOOK_SECRET` in Vercel and redeploy; then `/admin` → Payments
  → **Connect Stripe again** (it sets up the endpoint and its secret). Then, in Stripe, resend the
  failed events from the endpoint's page. Only the signed Stripe notice turns sending on; there's
  no button to do it by hand.
- Worked when: the account's card shows setup paid "Yes, through Stripe" and the Payments line is
  gone.

## 6. Many owners lose Gmail access at once

- What you see: owners see "Squared Away lost access to … Reconnect Gmail" on every screen and get
  the email "Squared Away lost access to your Gmail" (then one reminder two days later);
  `/admin` → System says "N need reconnecting".
- Most likely: the Google app is still in Testing, where Google ends access 7 days after it was
  given ([LAUNCH.md 0c](LAUNCH.md#0-start-now-google-verification-takes-weeks)); or
  `AUTH_GOOGLE_SECRET` changed or the old Google secret was deleted too early (LAUNCH.md step 3);
  or the Google client was disabled or deleted.
- Where: Google Cloud → Google Auth Platform → **Audience** (publishing status) and **Clients**.
- What to do: make Vercel's `AUTH_GOOGLE_SECRET` a secret the Google client still has (Clients →
  the web client → **Add secret** if needed) and redeploy, or publish the app (0c). Then each owner taps **Reconnect Gmail** once; nothing is
  lost. Call the owners who don't.
- Worked when: `/admin` → System no longer counts mailboxes that need reconnecting.

## 7. A bad deploy

- What you see: right after a production deploy, a screen breaks, the **Smoke** run in GitHub
  Actions is red, or [LAUNCH.md step 12](LAUNCH.md#12-smoke-test-after-each-production-deploy)
  fails.
- Where: Vercel → sa → **Deployments**.
- What to do: pick the last Production deployment that worked → ⋯ → **Promote** (Instant
  Rollback). It goes live in seconds; then tell the engineers which commit broke. Database changes
  are written so older code keeps working with them, so going back is normally safe; if the bad
  deploy changed the database, tell the engineers before you promote.
- Worked when: `/api/health` shows the older `commit` and every check in LAUNCH.md step 12
  passes.

## 8. A leaked key

If a setting's value was pasted somewhere it shouldn't be (chat, an email, a screenshot), change
it at the company that issued it, then in Vercel, then **Redeploy**:

- `DATABASE_URL` (Neon password) and `AUTH_GOOGLE_SECRET`: [LAUNCH.md step 3](LAUNCH.md#3-change-the-passwords-that-were-pasted-in-chat).
- `STRIPE_SECRET_KEY`: Stripe → Developers → API keys → roll the key; paste as in LAUNCH.md 7a.
- `RESEND_API_KEY`: Resend → API Keys → new key, delete the old one (LAUNCH.md step 6).
- `ANTHROPIC_API_KEY`, `TWILIO_AUTH_TOKEN`, `HEALTH_TOKEN`, `CRON_SECRET`, `VAPID_PRIVATE_KEY`:
  the table in [LAUNCH.md step 4](LAUNCH.md#4-settings-in-vercel-per-environment) says where each
  comes from (a new VAPID pair makes every phone switch notifications off and on again).
- `AUTH_SECRET`: a new one signs everyone out (and must not change once referrals have been paid).
- `TOKEN_ENCRYPTION_KEY`: **never just change it**: every owner would have to reconnect Gmail.
  The engineers replace it with the two-key switch in [SETUP.md](SETUP.md) §5a.
- Worked when: the old value no longer works at the company that issued it, and LAUNCH.md step 12
  passes.

## After it's fixed

Write five lines in `docs/incidents/YYYY-MM-DD-short-name.md` (for example
`docs/incidents/2026-11-02-neon-paused.md`), or tell the engineers and they add it:

1. What stopped.
2. When it was noticed, and how.
3. How it was fixed.
4. How long owners were affected.
5. What changes so it doesn't happen again.

Never put an owner's name, a customer's name or anything from anyone's email in it.
