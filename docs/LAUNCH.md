# Launch checklist

For Davi. Plain steps, in order. Each step says **where** to click, **what to paste** and **how to
know it worked**. This file only ever names a setting (like `STRIPE_SECRET_KEY`); the value itself
goes straight into Vercel, Google or Stripe and is never written here, in chat or in an email.

Nothing in this checklist has been done for you: merging, deploying and every switch below are
your call. Engineering details live in [SETUP.md](SETUP.md); this page links to it where a step
needs more.

Contents:

- [0. Start now: Google verification (takes weeks)](#0-start-now-google-verification-takes-weeks)
- [1. Merge the launch branch](#1-merge-the-launch-branch)
- [2. Give previews their own database](#2-give-previews-their-own-database)
- [3. Change the passwords that were pasted in chat](#3-change-the-passwords-that-were-pasted-in-chat)
- [4. Settings in Vercel, per environment](#4-settings-in-vercel-per-environment)
- [5. Support email and the production domain](#5-support-email-and-the-production-domain)
- [6. Morning emails from your own domain (Resend)](#6-morning-emails-from-your-own-domain-resend)
- [7. Stripe live mode](#7-stripe-live-mode)
- [8. Error alerts (Sentry, optional)](#8-error-alerts-sentry-optional)
- [9. Phone notifications (VAPID keys)](#9-phone-notifications-vapid-keys)
- [10. Optional: text alerts and instant Gmail notifications](#10-optional-text-alerts-and-instant-gmail-notifications)
- [11. Check the background jobs after the merge](#11-check-the-background-jobs-after-the-merge)
- [12. Smoke test after each production deploy](#12-smoke-test-after-each-production-deploy)
- [13. Decisions waiting on you](#13-decisions-waiting-on-you)

## 0. Start now: Google verification (takes weeks)

Gmail read and draft access are what Google calls **restricted scopes**. Until Google verifies the
app, every owner sees Google's "unverified app" warning when they connect Gmail, and at most 100
people can use it. This is the slowest part of the launch, so start it first. The full answer for
Google (why we ask for each permission, the demo-video script, the reviewer account) is in
[google-verification.md](google-verification.md).

Today the app's publishing status is **Testing**. In Testing, Google's Gmail access for each owner
**runs out after 7 days**, so every owner would have to reconnect Gmail once a week, and only people
you add by hand as test users (at most 100) can connect at all.

These sub-steps need the production domain from [step 5](#5-support-email-and-the-production-domain).
Pick and add the domain first.

**Two of them can start now; the rest wait for the merge.** Production today has no `/privacy` or
`/terms` page and none of the screens the demo video shows, so Google would find a privacy link
that doesn't open and a reviewer would see old screens. Each rejection costs weeks.

- **Now** (once the domain is added): 0a and 0c.
- **After [step 1](#1-merge-the-launch-branch) (merge) and [step 5](#5-support-email-and-the-production-domain) (domain):**
  0b and 0d, then 0e (submit).
- **After you submit:** 0f once Google's email names the reviewer's address, and 0g.

**0a. Prove you own the domain.** (Now.)

- Where: Google Search Console (search.google.com/search-console) → Add property → Domain → type
  the production domain. It shows a TXT record; add it at your domain registrar's DNS page.
- Paste: nothing secret (the TXT record Google shows).
- Worked when: Search Console says "Ownership verified".

**0b. Put the domain and links on the consent screen.** (After steps 1 and 5.)

- Where: console.cloud.google.com (project number 214188340483) → Google Auth Platform →
  **Branding**.
- Paste: Application home page `https://<your domain>/`, privacy policy
  `https://<your domain>/privacy`, terms of service `https://<your domain>/terms`. (The domain is
  already under Authorized domains from [step 5](#5-support-email-and-the-production-domain); if
  it isn't, add it there first.)
- Worked when: Branding saves with no red warning, and those three links open the homepage, the
  privacy policy and the terms.

**0c. Switch to In production before real owners connect.** (Now.)

- Where: Google Auth Platform → **Audience** → Publishing status → **Publish app** (it then says
  "In production").
- Why: ends the 7-day expiry for Gmail access given **from now on**, and the hand-added test-user
  list. Until verification passes, owners still see the "unverified app" warning (they can tap
  through it), and the 100-user cap stays. Sign-in to Squared Away itself is still invite-only, so
  publishing doesn't let strangers in.
- Then reconnect once: Gmail access given while the app was in Testing (yours included) **still
  runs out** 7 days after it was given; publishing doesn't extend it. So right after publishing,
  you and every owner who connected during Testing reconnect once: open `/connect` (type it in
  the address bar) → Connect Gmail → pick the **same** Gmail address. Nothing is lost: it only
  replaces Google's key. Anyone who skips it loses Gmail access within the week; the app then
  says so on every screen, and its **Reconnect Gmail** button fixes it.
- Worked when: Audience shows **In production**, and you (and each owner from the Testing days)
  have reconnected since.

**0d. Record the demo video.** (After steps 1 and 5, on the merged production app.)

- Where: follow "Demo video script" in [google-verification.md](google-verification.md) word for
  word. It uses the real Google consent screen, shows the OAuth client id in the address bar, and
  shows each of `gmail.readonly`, `gmail.compose` and `gmail.send` in use. Record on a dedicated
  demo Gmail with invented emails, never your real customers' mail.
- Which account records the send part is your decision (see
  [step 13](#13-decisions-waiting-on-you); the options are under "Reviewer test account" in
  google-verification.md).
- If you record it on your own workspace (the recommended option), make it the house account
  first, or it can't send on camera: `/admin` → your own card (always shown first) → **Use as my
  own test account** → **Yes, this is my account**. It only ever shows on your own card. Worked
  when: the notice says "Your account can send now (marked as your own test account)." and your
  card's **Setup paid** line reads "Your own test account". If it already reads that, the button
  isn't shown and there's nothing to do.
- Worked when: the video is uploaded to YouTube as **Unlisted** and you have its link.

**0e. Submit for verification.** (After 0b and 0d.)

- Where: Google Auth Platform → **Data Access** → check the three Gmail scopes are listed, then
  **Verification Center** → Submit for verification.
- If any of the three is missing (an app in Testing works without them being listed): Data
  Access → **Add or remove scopes** → under "Manually add scopes" paste these three, one per line
  → **Add to table** → **Update** → **Save**:
  - `https://www.googleapis.com/auth/gmail.readonly`
  - `https://www.googleapis.com/auth/gmail.compose`
  - `https://www.googleapis.com/auth/gmail.send`

  Worked when: Data Access lists all three (Google files `gmail.readonly` and `gmail.compose`
  under restricted scopes and `gmail.send` under sensitive scopes).

- Paste: the sections "Two separate consent steps", "Scopes", "Google API Services: Limited Use"
  and "Data handling" from [google-verification.md](google-verification.md) (only those; the
  sections marked "for Davi only" are never pasted), and the video link.
- Worked when: Verification Center says the submission is **in review**, and Google emails you.
  Answer their emails quickly: the review waits on your replies.

**0f. Invite the reviewer.** (After 0e, once Google's email names the address.)

- Where: `/admin` → Invite an owner → the Google address Google's reviewer will use. It arrives in
  Google's review emails after you submit; if they don't name one, reply and ask for it.
- Worked when: `/admin` → Accounts lists them after they first sign in.

**0g. The security assessment (CASA).**

- Restricted Gmail scopes also need a yearly third-party security assessment (CASA). Google's
  review email explains it and lists the approved assessors. The cost and when to pay for it are your call
  (listed in [step 13](#13-decisions-waiting-on-you)); it renews every year.
- Worked when: Verification Center shows the assessment as passed and the app as verified; the
  "unverified app" warning disappears from the Connect Gmail screen.

## 1. Merge the launch branch

Everything waiting is in **one** pull request: `claude/launch-integration` into `main`. It already
holds the public site (PR #9), Squared Away Growth, Milestones 5–8 and the Milestone 11 launch work.
**Merging it is a production deploy.** That's your decision, nobody else's.

Merge it **as soon as you have reviewed it**. The window it closes is already open: the database
already has the new complaint marker, but production still runs older code that doesn't set it.
A complaint that turns into "fixed now, thanks" before the merge leaves no trace, and that customer
could later be offered "Ask for a review" (only on your tap, and only as a draft).

- Before you tap Merge (one minute, optional but only possible now): the **Gmail draft check**.
  It tells the engineers whether Gmail keeps a draft's id when it's sent. The app is safe either
  way. Neon console → project → SQL Editor (branch `production`), run:

  ```sql
  select
    count(*) filter (where m.label_ids ? 'SENT') as sent_label,
    count(*) filter (where m.label_ids ? 'DRAFT') as draft_label
  from drafts d
  join messages m
    on m.gmail_message_id = d.sent_gmail_message_id
   and m.mailbox_id = d.mailbox_id;
  ```

  It returns two numbers and nothing else. Send them to the engineers: many `draft_label` matches
  mean Gmail keeps the id. Run it **before** the merge: a one-time clean-up that runs after the
  merge relabels those rows, so afterwards `draft_label` always reads 0 whatever Gmail does.

- Where: GitHub → the `sa` repository → Pull requests → the one from `claude/launch-integration` →
  wait for the checks to go green (CI and the Vercel preview) → **Merge pull request**.
- Paste: nothing.
- Worked when:
  1. Vercel → sa → Deployments shows a **Production** deployment marked **Ready** for the merge
     commit.
  2. `https://<production address>/api/health` shows `"ok":true` and a `commit` equal to the
     first 7 characters of the merge commit (GitHub shows it on the pull request).
  3. About 30 minutes later, the two one-time clean-ups have run. Neon console → project → SQL
     Editor (branch `production`), run:

     ```sql
     select key from app_settings
     where key in ('backfill:m7-v1', 'cleanup:draft-messages-v1');
     ```

     It returns only setting names, no customer data. `backfill:m7-v1` should be there. If
     `cleanup:draft-messages-v1` is still missing, some mailbox couldn't be checked yet (Gmail
     access lost, or a read-only account) or there was more to check than one run does. It keeps
     trying every 15 minutes on its own; nothing for you to do.

## 2. Give previews their own database

**Launch blocker: do this before real customers.** Today every preview build uses the production
database, so a preview can read and change customer data. Two ways to fix it; which one is your
call (listed in [step 13](#13-decisions-waiting-on-you)).

**Read this first: production and previews share one entry today.** In Vercel, `DATABASE_URL`,
`AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`, `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` are each **one**
entry ticked for both Production and Preview. Deleting that entry, or changing its value, changes
**production** too: a changed `TOKEN_ENCRYPTION_KEY` makes every owner reconnect Gmail, a changed
`AUTH_SECRET` signs everyone out, and a changed `DATABASE_URL` points production at another
database. So never delete those entries and never change their values, apart from the two
planned changes in [step 3](#3-change-the-passwords-that-were-pasted-in-chat) (the new Neon
password changes `DATABASE_URL`, the new Google client secret changes `AUTH_GOOGLE_SECRET`).
Split them instead:

**How to split a setting** (used below; splitting never changes production's value):

1. Vercel → sa → Settings → Environment Variables → the existing entry → **Edit**.
2. Untick **Preview** only. Leave Production ticked and **leave the value alone** → Save.
3. **Add New** → the same name → tick **Preview** only → paste the new preview value → Save.

For `AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY` the new preview value is a fresh random one, made the
same way as the first ([SETUP.md](SETUP.md) §4: `openssl rand -base64 32`), different from
production's. Then Gmail access copied into a preview can't be unlocked, and a preview sign-in
can't be used on production.

**Option A: Neon branches per preview.**

- First: split `DATABASE_URL` (steps 1–2 only: untick **Preview** on the existing entry and save;
  don't add a Preview one, the integration does that).
- Where: Neon console → project `autumn-term-70302192` → **Integrations** → **Vercel** (the
  Neon-managed integration, not the Vercel Marketplace one) → connect it to the Vercel project
  `sa`, with preview branching **on** and parent branch `production`. If it offers to set
  variables for **Production** or Development, say no: Preview only. It may also add Preview
  variables starting with `PG`; leave those.
- Know this: each preview branch is a **copy of production**, customer email included, with the
  same account, mailbox and draft numbers. So also split `AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY`
  (all three steps above, new random Preview values), and ideally give previews their own Google
  OAuth client (see "A separate Google client for previews" below).
- **Background jobs:** Inngest dashboard (Vercel → sa → Integrations → Inngest) → the environment
  switcher at the top. Preview deployments must show up under a **Branch** environment, never
  under **Production**. Otherwise a tap on a preview (Draft a reply, Send) would start a
  production job for a production draft with the same number, in a real customer's Gmail. If you
  can't confirm it, split `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` and leave the Preview ones
  out (steps 1–2 only): previews then start no background jobs at all.
- Worked when:
  1. after the next push, Neon → Branches shows a `preview/<branch name>` branch;
  2. Vercel → Environment Variables still shows the **Production** `DATABASE_URL` entry exactly as
     before (pooled string, branch `production`, value not edited);
  3. Inngest shows preview deployments only under a Branch environment (or Preview has no
     `INNGEST_…` entries);
  4. production's `/admin` is unchanged (an invite you make on the preview doesn't appear there).
     Sign in on the preview at its **branch address** (see "Which preview address to sign in on"
     below).

**Option B: a separate, empty Neon project for previews.**

- Where: Neon console → New project (for example `sa-preview`) → Connect → copy the **pooled**
  connection string → split `DATABASE_URL` (all three steps above) with that string as the new
  Preview value.
- Also split `AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY`, as in option A.
- Previews then start empty: sign in with your admin address and invite test accounts there.
- Worked when: on the preview's **branch address** (below), after you sign in, `/admin` →
  Accounts shows only your own account ("Accounts (1)"), and production's `/admin` is unchanged.

Option B keeps customer email out of previews completely; option A is less set-up per preview but
copies production data into each one.

**Which preview address to sign in on.** Google only lets you sign in at addresses listed on the
OAuth client, and it allows no wildcards. Each branch has one fixed address,
`sa-git-<branch name>-dac3.vercel.app` (Vercel → the deployment → Domains shows it); the
one-off addresses of single deployments never work for sign-in. The branch address of
`claude/squared-away-mvp-ddxl7s` is already listed. For any other branch, add its two addresses
to whichever client previews use: Google Auth Platform → **Clients** → the client → Authorized
redirect URIs → add `https://<branch address>/api/auth/callback/google` and
`https://<branch address>/api/gmail/callback` → Save (it can take a few minutes). Worked when:
signing in and Connect Gmail work on that branch address.

**A separate Google client for previews (optional).** Skipping it is fine with option B (an
empty database); it matters most with option A.

1. Google Auth Platform → **Clients** → Create client → Web application, name it
   `sa preview`.
2. Authorized redirect URIs: the two addresses above, for each preview branch address you use.
3. Copy its Client ID and Client secret, then split `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`
   (all three steps of "How to split a setting") with those as the Preview values → Redeploy the
   preview.
4. While the app is still in Testing (step 0c not done yet), the test users on the Audience page
   apply to this client too; nothing to add.

Worked when: signing in and Connect Gmail work on the preview's branch address, and still work on
production.

Either way: Vercel → sa → Settings → Environment Variables → keep **"Automatically expose System
Environment Variables"** on. Preview addresses and the safety switch that keeps test mode off on
every Vercel deploy depend on it.

## 3. Change the passwords that were pasted in chat

The Neon database password and the Google client secret were once pasted into a chat. Replace both.

**Neon password.**

- Know this first: the moment you reset the password, production can't reach its database. Every
  screen and background job fails until the new string is saved in Vercel **and** the redeploy is
  live (a few minutes). Do it at a quiet hour (late evening), with Vercel already open, and go
  straight from one step to the next.
- Where: Neon console → project → Branches → `production` → Roles & Databases → the app's role →
  **Reset password**. Then Connect → copy the new **pooled** connection string.
- Paste: Vercel → sa → Settings → Environment Variables → `DATABASE_URL` (Production; also
  Preview only if previews still use the production database) → Save → Deployments → Redeploy the
  latest production deployment.
- Until previews have their own database (step 2), `DATABASE_URL` is one entry for both
  Production and Preview, so editing it changes both. That's fine here: both still use the
  production database until the split.
- Worked when: `/admin` loads your accounts. (`/api/health` answering isn't enough: it doesn't
  touch the database.)

**Google client secret.**

- Where: console.cloud.google.com → Google Auth Platform → **Clients** → the web client →
  **Add secret** → copy the new secret.
- Paste: Vercel → `AUTH_GOOGLE_SECRET` (every environment that uses this client) → Redeploy.
- Then: sign out of Squared Away, sign in again, and reconnect Gmail once (open `/connect` →
  Connect Gmail → the same Gmail address, as in step 0c). When both work, go back to the client in
  Google and **disable, then delete the old secret**.
- Worked when: after the old secret is deleted, sign-in and Connect Gmail still work.

## 4. Settings in Vercel, per environment

Where: Vercel → sa → Settings → Environment Variables. A change only takes effect after a
**Redeploy**. Mark secrets **Sensitive**. Full explanations: [SETUP.md](SETUP.md) §4.

| Setting                                                                               | Production                                                     | Preview                                               |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| `APP_URL`                                                                             | Yes: `https://<your domain>` (step 5)                          | No (previews use their own address)                   |
| `DATABASE_URL`                                                                        | Yes: Neon pooled string, branch `production` (sensitive)       | Its own database (step 2)                             |
| `AUTH_SECRET`                                                                         | Yes (sensitive)                                                | Yes, its own value (step 2)                           |
| `TOKEN_ENCRYPTION_KEY`                                                                | Yes (sensitive). Never change it: every owner would reconnect. | Yes, its own value (step 2)                           |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`                                                | Yes (secret sensitive)                                         | Yes; ideally a separate preview client                |
| `ADMIN_EMAIL`                                                                         | Yes                                                            | Yes                                                   |
| `SUPPORT_EMAIL`                                                                       | Yes (step 5)                                                   | Yes                                                   |
| `ANTHROPIC_API_KEY`                                                                   | Yes (sensitive)                                                | Optional (as today)                                   |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`                                            | Set by the Inngest integration                                 | Integration (Branch env), or none (step 2)            |
| `RESEND_API_KEY`, `EMAIL_FROM`                                                        | Yes (step 6; key sensitive)                                    | No                                                    |
| `STRIPE_SECRET_KEY`                                                                   | Yes: the live key (step 7; sensitive)                          | No                                                    |
| `NEXT_PUBLIC_SENTRY_DSN`                                                              | Optional (step 8)                                              | No                                                    |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`                                               | Yes, for phone notifications (step 9; private key sensitive)   | No                                                    |
| `VAPID_SUBJECT`                                                                       | Optional (defaults to `APP_URL`)                               | No                                                    |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`             | Optional (step 10; token sensitive)                            | No                                                    |
| `TWILIO_FROM_NUMBER`                                                                  | Only instead of the Messaging Service, for a quick test        | No                                                    |
| `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_VERIFICATION_TOKEN`                                 | Optional (step 10; token sensitive)                            | No                                                    |
| `AI_DAILY_CALL_CAP`, `RETENTION_BODY_DAYS`                                            | Leave unset (the defaults are what the policy promises)        | Leave unset                                           |
| `FEATURE_CLOSING_QUESTION`, `FEATURE_REFERRALS`                                       | Only after you decide (step 13)                                | No                                                    |
| `STRIPE_WEBHOOK_SECRET`                                                               | **Never set on Vercel** (Connect Stripe stores its own)        | **Never set on Vercel**                               |
| `SA_E2E`, `SA_E2E_GOOGLE_BASE_URL`, `SA_E2E_ANTHROPIC_BASE_URL`, `SA_E2E_HOOK_SECRET` | **Never set on Vercel** (test-only, this machine)              | **Never set on Vercel**                               |
| `INNGEST_DEV`                                                                         | **Never set on Vercel** (local only; see below)                | **Never set on Vercel**                               |
| `AUTH_TRUST_HOST`                                                                     | Not needed (Vercel handles it)                                 | Not needed                                            |
| `VERCEL`, `VERCEL_ENV`, `VERCEL_BRANCH_URL`, `VERCEL_GIT_COMMIT_SHA`                  | Set by Vercel itself; don't add                                | Set by Vercel itself; keep "Automatically expose…" on |

"Its own value" means a **separate entry** ticked for Preview only, made by splitting the shared
one (step 2, "How to split a setting"). Production's values for `DATABASE_URL`, `AUTH_SECRET`,
`TOKEN_ENCRYPTION_KEY`, `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` never change in this checklist,
except the two planned changes in step 3: the new Neon password (a new `DATABASE_URL`) and the new
Google client secret (a new `AUTH_GOOGLE_SECRET`).

`INNGEST_DEV` is for this machine only: on Vercel it would stop the jobs **and** switch off the
check that only Inngest can run them, so anyone could start them.

Worked when: Vercel's list matches this table; after step 2, each of `DATABASE_URL` (option B; in
option A the Preview one comes from the Neon integration), `AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`
(and `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` if you made a preview client) shows **two separate
rows**, one Production and one Preview; and no `SA_E2E…`, `INNGEST_DEV` or `STRIPE_WEBHOOK_SECRET`
row exists in any environment.

## 5. Support email and the production domain

**Support email.**

- Paste: Vercel → `SUPPORT_EMAIL` (Production and Preview) → Redeploy. More in [SETUP.md](SETUP.md)
  §6f.
- Worked when: the footer of the homepage and the contact block of `/privacy` and `/terms` show it.

**Production domain.** Every place below still points at `sa-dac3.vercel.app` until you change it.
Do the steps in this order: Google first (authorized domain, then redirect addresses), then
`APP_URL`, or Connect Gmail fails in between.

1. Vercel → sa → Settings → **Domains** → Add → the domain → add the DNS records it shows at your
   registrar. Worked when: Vercel shows **Valid Configuration**.
2. Google Cloud → Google Auth Platform → **Branding** → Authorized domains → **Add domain** → the
   production domain → Save. Do [0a](#0-start-now-google-verification-takes-weeks) (Search
   Console) first: Google wants the domain verified there. Google refuses a redirect address on a
   domain that isn't on this list, so this comes before item 3. The home page, privacy and terms links
   wait for step 0b. Worked when: Branding saves and lists the domain under Authorized domains.
3. Google Auth Platform → **Clients** → the web client → Authorized redirect URIs →
   **add** `https://<your domain>/api/auth/callback/google` and
   `https://<your domain>/api/gmail/callback`. Keep the old `sa-dac3.vercel.app` ones for now →
   Save. Worked when: the list shows both new addresses.
4. Vercel → `APP_URL` (Production only) = `https://<your domain>`, no trailing slash → Redeploy.
   Worked when: `https://<your domain>/api/health` answers, and signing in and Connect Gmail work
   on the new domain.
5. Stripe: `/admin` → Payments → **Connect Stripe again** (after the redeploy in item 4). The payment
   notification address comes from `APP_URL`. Then Stripe → Developers → Webhooks → the endpoint
   on the old address (`https://sa-dac3.vercel.app/api/stripe/webhook`) → **Delete**: it can't be
   checked any more, so Stripe would keep retrying it and email you warnings. Worked when: Stripe →
   Developers → Webhooks lists only `https://<your domain>/api/stripe/webhook`.
6. Inngest: Inngest dashboard (Vercel → sa → Integrations → Inngest) → **Apps** → sa. Worked when:
   it shows the new address and the last sync has no errors (if it still shows the old address,
   tap Resync).
7. If you set up instant Gmail notifications (step 10): Google Cloud → Pub/Sub → Subscriptions →
   the push subscription → Edit → change only the address part of the endpoint to
   `https://<your domain>/api/gmail/push` and keep the same `?token=` ending. Worked when: a new
   email shows up in Inbox within a minute.
8. Resend: the new domain (step 6).
9. Once the new domain passes the smoke test (step 12): Vercel → sa → Settings → **Domains** →
   `sa-dac3.vercel.app` → Edit → **Redirect to** your domain (permanent). After item 4 above, Connect Gmail
   only works when started on the new domain (Google sends the owner back there, and the old
   address's sign-in check can't be read on the new one), so the old address should forward
   everyone instead of staying a second way in. Worked when: opening
   `https://sa-dac3.vercel.app/queue` lands on `https://<your domain>/queue`.

## 6. Morning emails from your own domain (Resend)

Until this is done, morning and monthly summaries only reach the Resend account's own address.

- Where: resend.com → **Domains** → Add domain → add the DNS records it shows at your registrar.
  Steps in [SETUP.md](SETUP.md) §7b.
- Paste: Vercel → `EMAIL_FROM` (Production) = `Squared Away <hello@your domain>` (any address on
  the verified domain) → Redeploy. `RESEND_API_KEY` stays as it is; check it's in the `sa`
  project, not `contractorflow`.
- Worked when: Resend → Domains shows **Verified**, and the next morning summary to an owner other
  than you shows as **Delivered** in Resend → Emails.

## 7. Stripe live mode

**7a. Before switching: accounts that paid with a test card.** Every "paid" account today paid in
Stripe's test mode. Live Stripe doesn't know those customers (their next checkout or billing page
fails), and those accounts can send without a real payment.

- Where: `/admin` → each account card's **Setup paid** line: "Yes, through Stripe" means a test
  payment. For a count, Neon → SQL Editor (branch `production`):

  ```sql
  select
    count(*) filter (where stripe_customer_id is not null) as with_stripe_customer,
    count(*) filter (where stripe_subscription_id is not null) as with_subscription,
    count(*) filter (where setup_paid_via = 'stripe') as paid_via_stripe
  from workspaces;
  ```

- If any count isn't 0: whether to reset those accounts is your decision (step 13). There is no
  button for it on purpose.

**7b. Swap the key.**

- Where: Stripe → turn **Test mode** off → Developers → API keys → reveal the live **Secret key**.
- Paste: Vercel → `STRIPE_SECRET_KEY` (Production, sensitive). Also check that **no**
  `STRIPE_WEBHOOK_SECRET` exists in Vercel; delete it if it does (a leftover test value would make
  every live payment notification fail). Redeploy.

**7c. Connect Stripe.**

- Where: `/admin` → Payments → **Connect Stripe again** (test mode was connected before, so the
  button already says "again"; more in [SETUP.md](SETUP.md) §7c).
- Worked when: right after the tap, `/admin` shows the notice "Stripe connected in LIVE mode. Real
  cards will be charged." (The "Connected · last set up …" line was already there from test mode,
  so on its own it proves nothing; after the tap its time is today's.) In live Stripe: Product
  catalog has the setup fee and the three plan prices; Developers → Webhooks shows the endpoint
  ending `/api/stripe/webhook`. If `/admin` says "Couldn't connect Stripe." instead, it didn't
  finish: fix what it says and tap again (it's safe to tap again).
- Then clean up test mode: Stripe → turn **Test mode** on → Developers → Webhooks → the endpoint
  ending `/api/stripe/webhook` → **Delete**. Test subscriptions keep renewing and Stripe keeps
  sending their notifications to the same address, which now only accepts live ones, so Stripe
  would retry and email you failure warnings that look like a live problem. If you decide to reset
  the test-paid accounts (7a), also cancel their subscriptions in test mode → Customers.
  Worked when: test mode's Webhooks page lists no endpoint for the app.

**7d. Cancellation setting.**

- Where: Stripe (live) → Settings → Billing → **Customer portal** → Cancellations.
- Set: cancel **at the end of the billing period**. The terms promise that; Connect Stripe only
  sets it when live mode had no portal settings yet.
- Worked when: the portal page shows that option saved.

**7e. Sales tax (Stripe Tax).** You decided on 2026-10-14 to turn it on. The app doesn't set
anything up for tax; it only checks whether Stripe Tax is active.

- Where: Stripe (live) → Settings → **Tax**. Add your business address, a default product tax
  code, and a registration for each state where you collect sales tax (which states is a question
  for your accountant). Live mode and test mode are set up separately.
- Then: Stripe → Settings → Billing → **Customer portal** → Customer information → tick **Billing
  address**, so an owner can correct the address their tax is worked out from (Connect Stripe only
  ticks it when it creates the portal settings). Then `/admin` → Payments → **Connect Stripe
  again**: it makes the prices add tax on top.
- Worked when: `/admin` → Payments reads "Sales tax: on (Stripe Tax is set up)." "Sales tax:
  couldn't check." means Stripe didn't answer: reload in a minute. While Stripe can't be asked, a
  checkout fails rather than going through without tax. More in [SETUP.md](SETUP.md) §7c.

**7f. One real purchase.**

- Invite a second address of yours in `/admin`, sign in with it, Settings → Plan & billing →
  Choose a plan, pay with your own card. With sales tax on, Stripe's page asks for a billing
  address and shows the tax on top.
- Worked when: the billing page moves past "Payment received — finishing up.", and `/admin` shows
  that account as setup paid with "Yes, through Stripe". Refunding it in Stripe → Payments is up to you; a refund
  doesn't move the account back, so cancel its subscription in Stripe too (the account then shows
  as canceled).

## 8. Error alerts (Sentry, optional)

- Where: [SETUP.md](SETUP.md) §6b (sentry.io → new Next.js project → Client Keys (DSN)).
- Paste: Vercel → `NEXT_PUBLIC_SENTRY_DSN` (Production) → **Redeploy** (it's read when the app is
  built, so it does nothing until the next build).
- How you'll know: there is deliberately no "send a test error" button. Before launch, an
  automated test checks that every error report goes through the scrubber (no email text, no
  addresses, no tokens). After the DSN is set, the first real error appears in Sentry → Issues.
  An empty Issues page is normal when nothing is broken.

## 9. Phone notifications (VAPID keys)

- Where: [SETUP.md](SETUP.md) §6e (one command makes the key pair; free, no account).
- Paste: Vercel → `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (sensitive) and optionally
  `VAPID_SUBJECT` (Production) → Redeploy. Keep the pair afterwards: changing it makes every phone
  switch notifications off and on again.
- Worked when: Settings shows the phone-notification switch; turned on from the installed app (on
  iPhone, only the Home Screen app), the next new quote request buzzes your phone.

## 10. Optional: text alerts and instant Gmail notifications

**Text alerts (Twilio).**

- First: US carriers require registration before texts are delivered. In Twilio → Messaging →
  Regulatory compliance → **A2P 10DLC**: register the brand and a campaign (or verify a toll-free
  number). Approval **takes days**; until then texts may be blocked with no clear error.
- Then: [SETUP.md](SETUP.md) §6c → Vercel → `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (sensitive),
  `TWILIO_MESSAGING_SERVICE_SID` (Production) → Redeploy.
- Worked when: Settings → Text alerts → **Text me a code** reaches your own mobile, and a later new
  quote request texts you.

**Instant Gmail notifications (Pub/Sub).** Without this, new mail is picked up every 5 minutes.

- Where: [SETUP.md](SETUP.md) §6a. Use the production domain in the push endpoint.
- Paste: Vercel → `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_VERIFICATION_TOKEN` (sensitive) → Redeploy;
  then Inngest → Functions → renew-gmail-watches → Invoke.
- Worked when: a new email to a connected mailbox shows in Inbox within a minute.
- Later hardening (not needed to launch): switch the push subscription from the `?token=` check to
  Google's signed (OIDC) push authentication.

## 11. Check the background jobs after the merge

Sorting, drafting, the 30-day email-text purge the privacy policy promises, the trial clock and the
morning emails all run as background jobs.

- Where: Inngest dashboard (Vercel → sa → Integrations → Inngest) → Apps → sa → **Functions**.
- Worked when:
  1. The list includes `purge-expired-bodies`, `workspace-lifecycle`, `followup-scan` and
     `morning-digest`.
  2. The next day, `purge-expired-bodies` → Runs shows a **Completed** run.
  3. `/admin` → the first box is titled **System**, not "Background jobs look stopped".

## 12. Smoke test after each production deploy

Worked when: all eight checks below pass. If one fails, don't invite more owners until it's
fixed.

1. `https://<production address>/api/health` shows `"ok":true` and the `commit` you merged.
2. Sign in at `/signin` with your Google account.
3. Connect Gmail (or check Settings → Your Gmail shows access is fine).
4. Within about 5 minutes, **Inbox** shows mail sorted into categories and **Queue** shows a draft
   reply. Don't send anything to a real customer as a test.
5. On a trial account (a second address of yours, invited in `/admin`): a draft card says "Sending
   is off during your three days" and has no **Send reply** button.
6. `/privacy` and `/terms`: no `{{` anywhere, and the support email is shown.
7. `/admin` loads for you; signed in as anyone else it shows a 404 page ("This page could not be
   found.").
8. Google Auth Platform → Audience shows **In production** (step 0c). The first time after
   publishing, you have also reconnected Gmail once since then (step 0c): access given in Testing
   still ends 7 days after it was given, even when check 3 passes today.

## 13. Decisions waiting on you

Nothing here is switched on or changed until you say so.

- **Merge and deploy** ([step 1](#1-merge-the-launch-branch)): when.
- **Preview database** ([step 2](#2-give-previews-their-own-database)): option A (Neon branch
  copies) or option B (an empty preview project). With option A, previews must use an Inngest
  Branch environment (or have no `INNGEST_…` keys), since the copied drafts carry production's
  numbers; option B has no such overlap.
- **Test-mode Stripe accounts** ([step 7a](#7-stripe-live-mode)): whether to reset accounts that
  "paid" with a test card (clear their Stripe ids and setup payment, so they pay for real), or how
  else to handle them.
- **Taxes:** decided 2026-10-14: charge sales tax with Stripe Tax (set up in
  [step 7e](#7-stripe-live-mode)). Still yours, with your accountant: which states to register in,
  and the product tax code.
- **Terms, three [To confirm] items:** refunds (setup fee and current month), the liability cap,
  and governing law and venue. Plus a lawyer's review of the privacy policy and terms before
  launch.
- **Google review:** (1) which account records the send part of the demo video (options under
  "Reviewer test account" in [google-verification.md](google-verification.md)); (2) drop
  `gmail.send`? Google says `gmail.compose` is enough to send; dropping it is a code change (see
  "Before submitting" in google-verification.md); (3) the CASA assessment's cost and timing.
- **#26 closing question** ("Want to ask if they went another way?"): built and tested, off
  (`FEATURE_CLOSING_QUESTION`). Turning it on: [SETUP.md](SETUP.md) §6d.
- **#47 referral credit:** built and tested, off (`FEATURE_REFERRALS`). Decided 2026-10-13: the
  credit goes to the referrer only, and the same-domain block stays. Still open: the amount in
  dollars. Before turning it on, the privacy policy needs the referral-fingerprint line (in
  [SETUP.md](SETUP.md) §6d), and `AUTH_SECRET` must not be changed once referrals have been paid.
  Also your call: a referrer who deletes their account before the new owner is active voids the
  referral; a Growth call request never carries a referral (only an app waitlist sign-up from the
  link does).
- **Deleted owners:** Delete my account also removes their invite, so someone who deletes their
  account needs a new invite from `/admin` to come back (if they were invited from their
  waitlist entry, that card then says the invite is gone and shows "Invite … again"; otherwise
  use Invite an owner). Okay?
- **Waitlist and Growth removals:** Delete my account keeps waitlist entries and Growth call
  requests (they're a separate service). Removing one on request is done by hand in the database
  for now; the policy says "ask us and we'll delete it".
- **PDF quotes:** a quote sent only as an attached PDF (no `$` in the email) isn't counted as a
  price given, so "Let's do it" isn't marked Won automatically and gets no deposit draft. You can
  still tap Won. Change it only if you want it.
- **Growth:** confirm all seven services are offered today (websites and ad management
  especially) and the ground rules (no fake reviews, price before any work, Growth never touches
  the inbox); Growth terms of service; a Settings link to `/growth` for signed-in owners; no
  tracking pixels on `/growth` without a privacy-policy change.
- **Gmail draft check (counts only, for the engineers):** whether Gmail keeps a draft's id when
  it's sent. The app is safe either way. The query is in [step 1](#1-merge-the-launch-branch);
  run it **before merging**: after the merge it always reads 0.

- **Still needed from you:** the production domain, `SUPPORT_EMAIL`, the icon pack, and the
  `ANTHROPIC_API_KEY` repository secret for the "Prompt evals" GitHub action.
