# Launch checklist

For Davi. Plain steps, in order. Each step says **where** to click, **what to paste** and **how to
know it worked**. This file only ever names a setting (like `STRIPE_SECRET_KEY`); the value itself
goes straight into Vercel, Google or Stripe and is never written here, in chat or in an email.

Where a step says "the engineers", they do that part and tell you when it's done. Everything else
here is yours to do or decide: merging, deploying and every other switch. Engineering details live
in [SETUP.md](SETUP.md); this page links to it where a step needs more.

Contents:

- [Check your Neon plan now (this week)](#check-your-neon-plan-now-this-week)
- [Start your sales tax registration now (it takes days)](#start-your-sales-tax-registration-now-it-takes-days)
- [Add your terms link in Stripe (right after step 1)](#add-your-terms-link-in-stripe-right-after-step-1)
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

## Check your Neon plan now (this week)

**A money decision, and it can't wait for the launch.** The app checks every connected Gmail for
new mail every 5 minutes, and each check uses the database. Neon only lets a database sleep after
5 minutes with no use, so production's database probably never sleeps. Neon's **Free** plan gives
each project 100 "CU-hours" of database time a month (about 400 hours at the smallest size), and a
month has about 720 hours. So on Free, production would likely run out around the middle of each
month (about day 16 or 17 of Neon's billing period) and **pause until the next one**: the app
stops for everyone, you included. That's the engineers' estimate from Neon's published limits, not
something Neon has told us.

- Where: console.neon.tech → the menu at the top right → your organization → **Billing**
  (console.neon.tech/app/billing). "This month's summary" shows your plan and the billing period.
- Then: Projects → `autumn-term-70302192` → its first page → the **Usage** box. It shows the
  database time ("compute") used so far this period. It can be about an hour behind.
- What the numbers mean: on Free the limit is 100 CU-hours per project per period. If you're on
  Free and the number is already close to 100 before the period ends, decide this week.
- The fix is Neon's paid **Launch** plan: no monthly minimum, $0.106 per CU-hour plus $0.35 per GB
  of storage a month. A database that never sleeps uses about 180 CU-hours a month at the smallest
  size, so about **$19–20 a month** for that time, more if it grows. That's worked out from Neon's
  prices, not a quote. Plans are changed on the same Billing page.
- Paste: nothing.
- Worked when: you know which plan production is on and how much it has used this period, and
  either it's on Launch or you've chosen to stay on Free knowing it may pause mid-month. Tell the
  engineers which.

## Start your sales tax registration now (it takes days)

You decided on 2026-10-14 to charge sales tax, starting with Massachusetts, and to register with
the state before Stripe is set up. Registering takes days, and Stripe goes live in
[step 7](#7-stripe-live-mode), so start now. Otherwise the first real owners would pay with no
tax added, while you'd likely still owe Massachusetts the tax on those payments.

You're based in Concord, so you collect Massachusetts sales tax from your first sale there,
whatever your sales total.

- Where: MassTaxConnect (mass.gov/masstaxconnect) → Register a New Business → sales and use tax.
- Have ready: your SSN if you're a sole owner with no employees (otherwise an EIN), your business
  and mailing addresses, and the start date your accountant picks (the questions for your
  accountant are in [step 7e](#7-stripe-live-mode)).
- Cost and time: guides say it's free and takes about 3–10 business days. The state's own site
  wouldn't load for the engineers, so check both in MassTaxConnect.
- Paste: nothing.
- Worked when: you have a Massachusetts sales tax account and its registration certificate (Form
  ST-1). The Stripe part comes later, in step 7e.

## Add your terms link in Stripe (right after step 1)

Decided on 2026-10-15: owners tick an "I agree to the Terms of Service and the Privacy Policy" box
when they sign in, and the app asks Stripe to show a required "I agree" box on its checkout page
too. Stripe only shows that box once your terms address is saved in Stripe. Until then, checkout
still works, just without the box (owners have already agreed at sign-in), and `/admin` tells you
so.

**This comes in two merges, so it is done in two parts.**

- **Step 1's merge** (`claude/launch-integration`) puts the `/terms` and `/privacy` pages live.
  Today both addresses show "page not found" on production, so don't save them in Stripe before
  step 1: Stripe's own pages (checkout and the billing page) would link to that.
- **A second merge**, of `claude/squared-away-mvp-ddxl7s` (built on top of step 1's branch),
  brings the boxes themselves: the sign-in box, the terms screen, Stripe's checkout box and the
  `/admin` line below. The engineers open its pull request after step 1's merge; merging it is
  another production deploy.

Do it in test mode right after step 1, and check it again in live mode in
[step 7d](#7-stripe-live-mode).

- When: right after [step 1](#1-merge-the-launch-branch).
- Where: Stripe → Settings → Business → **Public details**.
- Paste: Terms of service URL `https://<production address>/terms` and Privacy policy URL
  `https://<production address>/privacy`. Until your own domain is set up
  ([step 5](#5-support-email-and-the-production-domain)) the production address is
  `sa-dac3.vercel.app`; change both links when the domain changes.
- Worked when:
  1. After step 1: Stripe saves both, and each one opens your terms or your privacy policy.
  2. After the second merge: after the next checkout (an owner choosing a plan, or your own test
     purchase), Stripe's checkout page shows the "I agree" tick box above the pay button, and
     `/admin` → Payments does **not** show "Terms box at checkout: off. Add your terms link in
     Stripe → Settings → Business → Public details." If that line shows, Stripe didn't have the
     link at that checkout: save it, and the line goes away after the next checkout that has the
     box. (The line only changes when someone goes to checkout; opening `/admin` never asks
     Stripe.) Before the second merge there is no checkout box and no `/admin` line at all,
     whatever Stripe has saved: that isn't a sign of a wrong setting.

## 0. Start now: Google verification (takes weeks)

Gmail read and draft access are what Google calls **restricted scopes**. Until Google verifies the
app, every owner sees Google's "unverified app" warning when they connect Gmail, and at most 100
people can use it. This is the slowest part of the launch, so start it first: plan on 1 to 3 months
from submitting to approved. The full answer for Google (why we ask for each permission, the
demo-video script, the reviewer account) is in [google-verification.md](google-verification.md).

**The 100 is for life.** Google allows an unverified app 100 new users **in total, for the life of
the project**, and the count can't be reset. Each Gmail address that connects before approval
likely takes one place: yours, the demo Gmail and the reviewer's included. Signing in to Squared
Away doesn't count (it only asks Google for name and email); connecting Gmail does. So keep sign-up
invite-only until Google approves the app.

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

The video's sign-in shows the "I agree" box, which goes live with the second merge (see
[step 1](#1-merge-the-launch-branch)), so record after that one too.

- Where: follow "Demo video script" in [google-verification.md](google-verification.md) word for
  word. It uses the real Google consent screen, shows the OAuth client id in the address bar, and
  shows each of the two Gmail permissions in use: `gmail.readonly` ("View your email messages and
  settings") and `gmail.compose` ("Manage drafts and send emails"). Record on a dedicated demo
  Gmail with invented emails, never your real customers' mail.
- Which account records the send part: **option B**, which you chose on 2026-10-15. It's a
  separate demo account, invited from `/admin` and paid with Stripe's test card, so nothing of
  yours is touched. It can send only while Stripe is still in test mode, so record it before
  [step 7](#7-stripe-live-mode); an engineer tries it once on production first. The steps are
  under "Reviewer test account" in google-verification.md.
- Record it after the engineers' live check of the two permissions (decided on 2026-10-15,
  [step 13](#13-decisions-waiting-on-you)): the video shows Google's list of permissions, and they
  tell you once a practice copy and a real reply have gone out on production with just those two.
  Their check starts by removing the demo Gmail's earlier access to Squared Away, so an old third
  permission can't do the sending for it (step 13 says how).
- Only if you ever film with option A instead (your own workspace with the demo Gmail swapped in,
  for example a new recording after Stripe has gone live), make it the house account first, or it
  can't send on camera: `/admin` → your own card (always shown first) → **Use as my
  own test account** → **Yes, this is my account**. It only ever shows on your own card. Worked
  when: the notice says "Your account can send now (marked as your own test account)." and your
  card's **Setup paid** line reads "Your own test account". If it already reads that, the button
  isn't shown and there's nothing to do.
- Worked when: the video is uploaded to YouTube as **Unlisted** and you have its link.

**0e. Submit for verification.** (After 0b and 0d.)

- Where: Google Auth Platform → **Data Access** → check the two Gmail scopes are listed and
  `gmail.send` isn't, then **Verification Center** → Submit for verification.
- **Remove `gmail.send` first** (you decided on 2026-10-15 to stop asking for it): the app no
  longer requests it, but Data Access may still list it from before (under "Your sensitive
  scopes"). Remove that row (the bin icon on it, or untick it under **Add or remove scopes** →
  **Update**) → **Save**. Owners who already connected keep working; nobody has to reconnect.
- If either of the two is missing (an app in Testing works without them being listed): Data
  Access → **Add or remove scopes** → under "Manually add scopes" paste these two, one per line →
  **Add to table** → **Update** → **Save**:
  - `https://www.googleapis.com/auth/gmail.readonly`
  - `https://www.googleapis.com/auth/gmail.compose`

  Worked when: Data Access lists `gmail.readonly` and `gmail.compose` (Google files both under
  restricted scopes) and no `gmail.send`.

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

- Restricted Gmail scopes also need a yearly security test by an outside lab (CASA). It's needed
  because `gmail.readonly` and `gmail.compose` are both restricted (dropping `gmail.send` didn't
  change that).
- Level: Google picks it, **AL1** (the lower one) or **AL2**, from user count, permissions and
  other signals, and its email says which. Companies that help with these reviews say a small app
  like this one usually gets AL1, but Google decides.
- **Don't pay anything until Google's email names the level.** Then get written quotes from two
  labs, and ask each whether the price covers the yearly renewal. Approved labs are listed by the
  App Defense Alliance (appdefensealliance.org → authorized labs), for example TAC Security,
  NetSentries, Bishop Fox and DEKRA. Google's own pages name none.
- Cost: TAC Security's posted prices today are $675 or $855 for AL1 and $5,400 for AL2 (up about
  25% since August 2025). Budget about $700–$1,000 a year for AL1, and about $4,500–$5,400 or
  more for AL2. Prices are from the labs' sites and can change.
- Time: allow 2–6 weeks for the lab (more if it finds something to fix), inside the 1 to 3 months
  of the whole review.
- It renews every 12 months, counted from the lab's letter, and Google contacts you when it's due.
  Set a reminder 60–90 days before.
- Worked when: Verification Center shows the assessment as passed and the app as verified; the
  "unverified app" warning disappears from the Connect Gmail screen.

## 1. Merge the launch branch

Almost everything waiting is in **one** pull request: `claude/launch-integration` into `main`. It
already holds the public site (PR #9), Squared Away Growth (with the "Big words" homepage switch
you picked), Milestones 5–8 and the Milestone 11 launch work. **Merging it is a production deploy.**

You said okay to the merge on 2026-10-14. The engineers open the pull request once every check is
green and tell you; you press **Merge pull request**. The closing question (#26, step 13) is
already switched on in Vercel and starts working with this deploy.

Merge it **as soon as you have reviewed it**. The window it closes is already open: the database
already has the new complaint marker, but production still runs older code that doesn't set it.
A complaint that turns into "fixed now, thanks" before the merge leaves no trace, and that customer
could later be offered "Ask for a review" (only on your tap, and only as a draft).

The merge also puts the homepage's About section live. Its wording changed on 2026-10-15 (see
"The homepage's About section" in [step 13](#13-decisions-waiting-on-you)); tell the engineers
before you tap Merge if you want different words.

**Not in this merge: the "I agree" boxes** (decided on 2026-10-15, [step 13](#13-decisions-waiting-on-you)).
They are on a second branch, `claude/squared-away-mvp-ddxl7s`, built on top of this one. The
engineers open its pull request once this merge is live, and you merge it the same way (another
production deploy, checked the same way as below). This merge does put the `/terms` and `/privacy`
pages live, so right after it, save them in Stripe:
[Add your terms link in Stripe](#add-your-terms-link-in-stripe-right-after-step-1).

- Before you tap Merge (one minute, optional but only possible now): the **Gmail draft check**.
  It tells the engineers whether Gmail keeps a draft's id when it's sent. The app is safe either
  way. Neon console → project `autumn-term-70302192` (not `sa-preview`) → SQL Editor (branch
  `production`), run:

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
  3. About 30 minutes later, the two one-time clean-ups have run. Neon console → project
     `autumn-term-70302192` (not `sa-preview`) → SQL Editor (branch `production`), run:

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
database, so a preview can read and change customer data. You chose on 2026-10-14 to give previews
a separate, **empty** Neon project called `sa-preview`. Customer email never goes there. Some of
it is yours (2a, 2b, 2d) and some is the engineers' (2c, 2e).

**Read this first: production and previews share one entry today.** In Vercel, `DATABASE_URL`,
`AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`, `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` are each **one**
entry ticked for both Production and Preview. Deleting that entry, or changing its value, changes
**production** too: a changed `TOKEN_ENCRYPTION_KEY` makes every owner reconnect Gmail, a changed
`AUTH_SECRET` signs everyone out, and a changed `DATABASE_URL` points production at another
database. So never delete those entries and never change their values, apart from the two
planned changes in [step 3](#3-change-the-passwords-that-were-pasted-in-chat) (the new Neon
password changes `DATABASE_URL`, the new Google client secret changes `AUTH_GOOGLE_SECRET`).
Split them instead:

**How to split a setting** (2c–2e follow these steps; done this way, production's value is meant
to stay as it is):

1. Vercel → sa → Settings → Environment Variables → the existing entry → **Edit**.
2. Untick **Preview** only. Leave Production ticked and **leave the value alone** → Save. If Save
   asks for a value or shows an error, don't type anything: tap **Cancel** and tell the engineers.
   They can untick Preview through Vercel's API instead, as in 2c, without touching the value.
3. **Add New** → the same name → tick **Preview** only → paste the new preview value → Save.

For `AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY` the new preview value is a fresh random one, made the
same way as the first ([SETUP.md](SETUP.md) §4: `openssl rand -base64 32`), different from
production's. Then Gmail access copied into a preview can't be unlocked, and a preview sign-in
can't be used on production.

**What it costs.** `sa-preview` is billed under the same Neon organization as production. On the
Free plan it costs $0: it gets its own 100 CU-hours a month and 1 GB, separate from production's,
and if it ever runs out it pauses until the next month (Free never sends a bill). On the paid
Launch plan there's no monthly fee and no charge just for having a second project; you pay only
while it's awake, and it sleeps after 5 minutes of no use, so expect a few cents a month (maybe a
dollar or two in a busy month). That's worked out from Neon's prices, not a quote.

**2a. Create the `sa-preview` project (you, in Neon, about 10 minutes).**

- Where: console.neon.tech → the menu at the top right → pick your organization. Check that its
  project list shows your real project, `autumn-term-70302192`. If the organization's name starts
  with "Vercel:", stop and tell the engineers.
- Then: **New Project** → Project name `sa-preview` → Region: the **same region** as
  `autumn-term-70302192` → Services: leave only **Postgres database** on → **Create project**. Add
  nothing else: the first preview build creates the tables.
- Worked when: the organization's project list shows `sa-preview` next to `autumn-term-70302192`.

**2b. Copy its pooled connection string (you, in Neon).**

- Where: check that the page says `sa-preview`, not your real project. Click **Connect**, make sure
  **Connection pooling** is on, and copy the connection string.
- Worked when: the address you copied contains `-pooler`.
- Paste it only into Vercel (2d), never into a chat or an email. Tell the engineers you have it
  (not the string itself).

**2c. Untick Preview on the existing `DATABASE_URL` (the engineers).**

- They untick **Preview** on the existing entry through Vercel's API. That changes only where the
  entry applies: production's value isn't touched and Production stays ticked. They tell you when
  it's done.

**2d. Add the Preview `DATABASE_URL` (you, in Vercel).**

- Where: Vercel → sa → Settings → Environment Variables → **Add New**.
- Paste: name `DATABASE_URL`, type **Secret**, tick **Preview** only, value = the string from 2b →
  Save. Then tell the engineers.

**2e. Preview-only secrets and a redeploy (the engineers).**

- They add Preview-only `AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY` with fresh random values (split
  the same way), then redeploy the preview. That first preview build creates every table in
  `sa-preview`.
- Background jobs need no change: in an empty database every account, mailbox and draft gets a new
  random id, so a preview's job can never match a production row.
- What a preview can do after the split: show the screens, sign in and Connect Gmail. Nothing is
  synced, sorted, drafted or sent there, and Choose a plan doesn't work: background jobs and
  Stripe only reach production (previews sit behind Vercel's login). So anything that needs mail
  read, a draft, a payment or a send is tried on production instead (step 13 says where).

Worked when:

1. Vercel → Environment Variables shows two `DATABASE_URL` rows: Production (unchanged) and
   Preview.
2. On the preview's **branch address** (see "Which preview address to sign in on" below), after
   you sign in with your admin address, `/admin` shows only your own account: "Accounts (1)".
3. Production's `/admin` is unchanged (an invite you make on the preview doesn't appear there).

Previews then start empty: invite test accounts there from the preview's own `/admin`.

**On a preview, connect only test Gmail addresses**: never your own, a customer's, or the demo
Gmail while it's connected on production. Previews use the same Google app as production, so a
**Disconnect** or **Delete my account** on a preview most likely ends Google's access for that
address on production too (production then asks for a reconnect). A separate preview Google client
(below) may not keep the two apart either: it is in the same Google project.

**Which preview address to sign in on.** Google only lets you sign in at addresses listed on the
OAuth client, and it allows no wildcards. Each branch has one fixed address,
`sa-git-<branch name>-dac3.vercel.app` (Vercel → the deployment → Domains shows it); the
one-off addresses of single deployments never work for sign-in. The branch address of
`claude/squared-away-mvp-ddxl7s` is already listed. For any other branch, add its two addresses
to whichever client previews use: Google Auth Platform → **Clients** → the client → Authorized
redirect URIs → add `https://<branch address>/api/auth/callback/google` and
`https://<branch address>/api/gmail/callback` → Save (it can take a few minutes). Worked when:
signing in and Connect Gmail (with a test Gmail address) work on that branch address.

**A separate Google client for previews (optional).** With an empty preview database it's fine to
skip this. It doesn't make it safe to connect a real Gmail address on a preview (see above).

1. Google Auth Platform → **Clients** → Create client → Web application, name it
   `sa preview`.
2. Authorized redirect URIs: the two addresses above, for each preview branch address you use.
3. Copy its Client ID and Client secret, then split `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`
   (all three steps of "How to split a setting", including its **Cancel** rule) with those as the
   Preview values → Redeploy the preview. Or ask the engineers to untick Preview on both entries
   through Vercel's API first; then you only do step 3 of the split.
4. While the app is still in Testing (step 0c not done yet), the test users on the Audience page
   apply to this client too; nothing to add.

Worked when: signing in and Connect Gmail (with a test Gmail address) work on the preview's branch
address, and still work on production.

Also: Vercel → sa → Settings → Environment Variables → keep **"Automatically expose System
Environment Variables"** on. Preview addresses and the safety switch that keeps test mode off on
every Vercel deploy depend on it.

## 3. Change the passwords that were pasted in chat

The Neon database password and the Google client secret were once pasted into a chat. Replace both.

**Neon password.**

- Know this first: the moment you reset the password, production can't reach its database. Every
  screen and background job fails until the new string is saved in Vercel **and** the redeploy is
  live (a few minutes). Do it at a quiet hour (late evening), with Vercel already open, and go
  straight from one step to the next.
- Where: Neon console → project `autumn-term-70302192` (not `sa-preview`: both have a branch
  called `production`) → Branches → `production` → Roles & Databases → the app's role → **Reset
  password**. Before you tap it, check that the page header names `autumn-term-70302192`. Then
  Connect → copy the new **pooled** connection string.
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
**Redeploy**. Mark secrets **Sensitive** (newer Vercel screens call this type **Secret**). Full
explanations: [SETUP.md](SETUP.md) §4.

| Setting                                                                               | Production                                                     | Preview                                               |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| `APP_URL`                                                                             | Yes: `https://<your domain>` (step 5)                          | No (previews use their own address)                   |
| `DATABASE_URL`                                                                        | Yes: Neon pooled string, branch `production` (sensitive)       | Its own: the `sa-preview` project (step 2)            |
| `AUTH_SECRET`                                                                         | Yes (sensitive)                                                | Yes, its own value (step 2)                           |
| `TOKEN_ENCRYPTION_KEY`                                                                | Yes (sensitive). Never change it: every owner would reconnect. | Yes, its own value (step 2)                           |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`                                                | Yes (secret sensitive)                                         | Yes; ideally a separate preview client                |
| `ADMIN_EMAIL`                                                                         | Yes                                                            | Yes                                                   |
| `SUPPORT_EMAIL`                                                                       | Yes (step 5)                                                   | Yes                                                   |
| `ANTHROPIC_API_KEY`                                                                   | Yes (sensitive)                                                | Optional (as today)                                   |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`                                            | Set by the Inngest integration                                 | Set by the Inngest integration (as today)             |
| `RESEND_API_KEY`, `EMAIL_FROM`                                                        | Yes (step 6; key sensitive)                                    | No                                                    |
| `STRIPE_SECRET_KEY`                                                                   | Yes: the live key (step 7; sensitive)                          | No                                                    |
| `NEXT_PUBLIC_SENTRY_DSN`                                                              | Optional (step 8)                                              | No                                                    |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`                                               | Yes, for phone notifications (step 9; private key sensitive)   | No                                                    |
| `VAPID_SUBJECT`                                                                       | Optional (defaults to `APP_URL`)                               | No                                                    |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`             | Optional (step 10; token sensitive)                            | No                                                    |
| `TWILIO_FROM_NUMBER`                                                                  | Only instead of the Messaging Service, for a quick test        | No                                                    |
| `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_VERIFICATION_TOKEN`                                 | Optional (step 10; token sensitive)                            | No                                                    |
| `AI_DAILY_CALL_CAP`, `RETENTION_BODY_DAYS`                                            | Leave unset (the defaults are what the policy promises)        | Leave unset                                           |
| `FEATURE_CLOSING_QUESTION`                                                            | `1` (set 2026-10-14 at your request; step 13)                  | `1` (set 2026-10-14)                                  |
| `FEATURE_REFERRALS`                                                                   | Only after the SETUP.md §6d steps (step 13)                    | No                                                    |
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

Worked when: Vercel's list matches this table; after step 2, each of `DATABASE_URL`,
`AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY` (and `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` if you made a
preview client) shows **two separate rows**, one Production and one Preview; and no `SA_E2E…`, `INNGEST_DEV` or `STRIPE_WEBHOOK_SECRET`
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

**Before you start:**

- Do 7a, 7b and 7c back to back, in one sitting, at a quiet hour (late evening). Between the key
  swap (7a) and Connect Stripe (7b), live Stripe has nowhere to send its "payment received"
  notice. An owner who paid in that gap would be charged and still couldn't send, and there's no
  button to fix it by hand.
- Until 7e's "Worked when" passes (sales tax added at checkout), don't ask anyone to pay.
  Subscriptions that start before then run without tax until each one is changed by hand in Stripe
  (7e says how).
- The Massachusetts registration should already be under way
  ([Start your sales tax registration now](#start-your-sales-tax-registration-now-it-takes-days)).
- If you want the optional test-mode tax check (7e item 7), do it **before** 7a: it needs the test
  key.

**7a. Swap the key.**

- Where: Stripe → turn **Test mode** off → Developers → API keys → reveal the live **Secret key**.
- Paste: Vercel → `STRIPE_SECRET_KEY` (Production, sensitive). Also check that **no**
  `STRIPE_WEBHOOK_SECRET` exists in Vercel; delete it if it does (a leftover test value would make
  every live payment notification fail). Redeploy.
- Worked when: `/admin` → Payments shows **Check test payments** (with the test key it says
  "Reset test payments shows up after you switch Stripe to live mode." instead). Go straight on to
  7b.

**7b. Connect Stripe.**

- Where: `/admin` → Payments → **Connect Stripe again** (test mode was connected before, so the
  button already says "again"; more in [SETUP.md](SETUP.md) §7c). Do it right after 7a's
  redeploy: it creates the live payment notifications.
- Worked when: right after the tap, `/admin` shows the notice "Stripe connected in LIVE mode. Real
  cards will be charged." (The "Connected · last set up …" line was already there from test mode,
  so on its own it proves nothing; after the tap its time is today's.) In live Stripe: Product
  catalog has the setup fee and the three plan prices; Developers → Webhooks shows the endpoint
  ending `/api/stripe/webhook`. If `/admin` says "Couldn't connect Stripe." instead, it didn't
  finish: fix what it says and tap again (it's safe to tap again).
- Then clean up test mode: Stripe → turn **Test mode** on → Developers → Webhooks → the endpoint
  ending `/api/stripe/webhook` → **Delete**. Test subscriptions keep renewing and Stripe keeps
  sending their notifications to the same address, which now only accepts live ones, so Stripe
  would retry and email you failure warnings that look like a live problem. Worked when: test
  mode's Webhooks page lists no endpoint for the app.

**7c. Reset test payments.** Every "paid" account today paid with a Stripe test card (on its card
in `/admin`, **Setup paid** reads "Yes, through Stripe"). Live Stripe doesn't know those
customers, and those accounts could send without a real payment. You decided on 2026-10-14 to
reset them. The app ignores test-mode notifications once the live key is in, so nothing puts a
test payment back afterwards.

- Where: `/admin` → Payments → **Check test payments** (asks Stripe, changes nothing). The card
  then reads "Test payments: N accounts still carry a test-mode payment." Then **Reset test
  payments** → **Yes, reset test payments**.
- What it does: clears the test-mode Stripe details from those accounts and puts a setup paid with
  a test card back to unpaid, so they keep their data, can't send, and pay the setup fee for real
  at their next checkout (your own test account keeps sending). An account that was past due is
  switched back on: its new mail is sorted and drafted again (on your AI bill), but it still can't
  send until it pays. ([Step 13](#13-decisions-waiting-on-you) asks whether that's okay.)
- Worked when: the notice says "Test payments reset for N accounts." and the card reads "Test
  payments: none left."; those accounts' cards now say **Setup paid**: Not yet. If it adds
  "Couldn't check M accounts. Tap again.", Stripe didn't answer for those: tap again (it's safe to
  tap again). For a count from the database (Neon → project `autumn-term-70302192` (not
  `sa-preview`) → SQL Editor, branch `production`), before any real customer has paid all three
  read 0:

  ```sql
  select
    count(*) filter (where stripe_customer_id is not null) as with_stripe_customer,
    count(*) filter (where stripe_subscription_id is not null) as with_subscription,
    count(*) filter (where setup_paid_via = 'stripe') as paid_via_stripe
  from workspaces;
  ```

- Then, optional tidy-up: the accounts you reset no longer point at their test subscriptions, so
  cancel those in Stripe's test mode → Customers too.

**7d. Cancellation setting and terms link.**

- Where: Stripe (live) → Settings → Billing → **Customer portal** → Cancellations.
- Set: cancel **at the end of the billing period**. The terms promise that; Connect Stripe only
  sets it when live mode had no portal settings yet.
- Worked when: the portal page shows that option saved.
- Then, with **Test mode** off: Stripe → Settings → Business → **Public details** → Terms of
  service URL `https://<production address>/terms` and Privacy policy URL
  `https://<production address>/privacy` (as in
  [Add your terms link in Stripe](#add-your-terms-link-in-stripe-right-after-step-1); add them if live mode
  doesn't show them already, and use your own domain once it's set up).
- Worked when: both are saved; then at 7f's real purchase Stripe's page shows the "I agree" tick
  box, and afterwards `/admin` → Payments does **not** show "Terms box at checkout: off. Add your
  terms link in Stripe → Settings → Business → Public details."

**7e. Sales tax (Stripe Tax).** You decided on 2026-10-14 to turn it on. Stripe works out the tax
and adds it at checkout. Registering with the state and filing the returns are yours: Stripe can't
register you in your home state, and on its pay-as-you-go plan it doesn't file. The app sets
nothing up for tax; it turns tax on at checkout whenever Stripe's tax settings read "active". Live
mode and test mode are set up separately. In this order:

1. **Register with Massachusetts first.** You started this on MassTaxConnect at the top of this
   page ([Start your sales tax registration now](#start-your-sales-tax-registration-now-it-takes-days)).
   Worked when: you have its registration certificate (Form ST-1).

   If the certificate hasn't come yet, do items 2–4 and 6 anyway: they charge no tax by
   themselves, and a subscription that starts after item 3 has Stripe's automatic tax on, so it
   picks up Massachusetts tax once item 5 is done instead of needing a change by hand. Do item 5
   the day the certificate arrives. Until then, still don't ask anyone to pay: a payment taken
   before item 5 has no tax added, and you'd likely still owe the state that tax.

2. **Fix the prices:** `/admin` → Payments → **Connect Stripe again** (safe even if you just did in
   7b). It makes the prices add tax on top whether or not tax is on yet, so do it before Stripe's
   tax settings.
3. **Stripe's tax settings.** Stripe (live) → Settings → **Tax**:
   - Head office: your Concord business address.
   - Preset product tax code: **Software as a service (SaaS) - business use** (`txcd_10103001`).
   - Include tax in prices: **Exclusive** (tax on top, as the terms and "Plus sales tax where it
     applies." say).

   Stripe calls tax "active" as soon as the head office is saved. That only means it can work tax
   out, not that it charges any.

4. **The setup fee's own code.** Stripe (live) → Product catalog → **Squared Away — Setup** → Edit
   → Product tax code → **SaaS Implementation and Setup Services - Mandatory** (`txcd_20120002`),
   unless your accountant says otherwise. The setup is required before sending turns on, and
   Massachusetts' rules tax a service that is a required part of a software sale. The three plan
   products keep the preset code. If that code isn't in Stripe's list, leave the preset and tell
   your accountant.
5. **Add Massachusetts in Stripe.** Stripe (live) → Tax → **Locations** (the `/admin` card calls
   this page Tax → Registrations) → **Add registration** → United States → Massachusetts → **I've
   already registered** → start collecting now, or schedule it for the date your state
   registration starts → check the rate (6.25%) → **Start collecting**. Without this step Stripe
   charges **$0 tax and warns about nothing**: its alerts only watch other states, never your home
   state.
6. **Customer portal.** Stripe → Settings → Billing → **Customer portal** → **Billing information**
   → make sure **Billing address** is on, so an owner can correct the address their tax is worked
   out from. (Connect Stripe only sets it when it creates the portal settings.)
7. **A test checkout (optional, and only before 7a).** While production still has the test key,
   you can set up test mode the same way: Test mode on, items 2–6 again (with a test Massachusetts
   registration). Then, as a test owner, Choose a plan with Stripe's test card and a Massachusetts
   billing address. Stripe's page should show 6.25% tax on top (for example $6.19 on Solo). An
   address in a state you aren't registered in shows $0 tax: that's expected. After the key swap,
   7f's real purchase is the check.

- Worked when: `/admin` → Payments reads "Sales tax: on (Stripe Tax is set up)." **and** Stripe →
  Tax → Locations shows Massachusetts as "Collecting tax". "On" alone doesn't prove tax is charged
  anywhere. "Sales tax: couldn't check." means Stripe didn't answer: reload in a minute. If it
  still says that, check `STRIPE_SECRET_KEY` is the standard secret key (not a restricted one):
  while Stripe can't be asked, every checkout fails rather than going through without tax. More
  in [SETUP.md](SETUP.md) §7c.
- Cost: Stripe Tax Basic has no monthly fee. It takes 0.5% of each taxed payment, tax included,
  and only in states where you're registered: about 53 cents on a Solo renewal in Massachusetts.
- Subscriptions that started before tax was on keep running without tax. Find them: Stripe →
  Subscriptions → Filter → Automatic tax → Disabled. Turn automatic tax on in each one; it applies
  from the next billing period.
- **Filing (yours).** Massachusetts sets how often you file from the tax you expect to owe in a
  year: once a year if $100 or less, every 3 months from $101 to $1,200, monthly above that. Each
  return is due within 30 days after its period ends, usually the 30th of the next month (some
  guides still say the 20th; that changed in 2021). Each time: take the numbers from Stripe's
  Massachusetts tax report (under Stripe → Tax), then file and pay on MassTaxConnect. File even
  when nothing is due, and keep the records at least 3 years. Stripe's Tax Complete plan (from $90
  a month on a one-year contract) would file for you; it isn't needed while you only collect in
  Massachusetts.
- Other states: register nowhere else until Stripe tells you to. It emails you when your sales in
  another state get near that state's limit (most states: $100,000 a year).
- Questions for your accountant: does Squared Away count as taxable software in Massachusetts
  (most guides say yes)? Is the setup fee taxable? Are you set up as a sole owner or an LLC? What
  start date should the Massachusetts registration use?

**7f. One real purchase.**

- Invite a second address of yours in `/admin`, sign in with it, Settings → Plan & billing →
  Choose a plan, pay with your own card. With sales tax on, Stripe's page asks for a billing
  address and, for an address in a state you registered, shows the tax on top.
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

- Where: [SETUP.md](SETUP.md) §6e (one command makes the key pair; free, no account). If you'd
  rather not, say so and the engineers make the pair and add it for you.
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

### Decided on 2026-10-15

- **#47 referral reward: offer A, a free month one plan up** (built and tested behind
  `FEATURE_REFERRALS`, still off). Once someone you referred has paid (setup and first month) and
  had their setup call, the referrer only gets their next month free on the plan above theirs:
  Solo → Crew, Crew → Company, Company → Company. Afterwards they go back to their own plan by
  itself, unless they tap **Keep Crew** at its normal price; nothing ever charges more without
  that tap. The same-domain block stays. In Stripe it is a one-time 100%-off coupon on their next
  renewal (the plan keeps billing as before), and the app gives the plan above for exactly that
  month. Your answers (2026-10-16):
  1. One free month at a time (free, paid, free), no yearly cap.
  2. Moving down a plan on Stripe's page pauses the extra inboxes too, as at the end of a free
     month: the oldest-created stay on, nothing is deleted, the owner can switch which one.
  3. During the free month, Stripe's page offers only card, invoices and cancel; plan changes
     happen in the app. Its terms line waits in [SETUP.md](SETUP.md) §6d until the switch goes on.
  4. A free month of Company includes priority support (the share card says so).
  5. A free month that can't start yet waits, with no expiry.
  6. Refunding the new contractor doesn't take back the referrer's free month (you can remove a
     waiting one by hand).
  7. No reminder email; the banner says what changes three days before the end.

- **"I agree to the Terms": yes, built** (live with the second merge, after step 1's; see
  [Add your terms link in Stripe](#add-your-terms-link-in-stripe-right-after-step-1)).
  Massachusetts' top court said
  online terms only bind people who were properly shown them and agreed to them (Kauders v. Uber,
  2021), and that a tick box plus a button is enough (Good v. Uber, 2024). So:
  - **Sign-in:** an unticked "I agree to the Terms of Service and the Privacy Policy" box (both
    linked) above **Sign in with Google**. Without it the button only says to tick the box; the
    server checks, not just the phone. This covers trial owners, who never see Stripe.
  - **Everyone already signed in** (you included) sees "one thing first, the fine print." with the
    same box and **Agree and continue** the first time they open the app after that second
    merge, then goes on to the screen they were opening. Whenever the terms' "Last updated" date
    changes, the engineers change the version in the app with it and everyone is asked again
    ("we've updated our terms."). Someone who doesn't agree can still leave from that same
    screen, as the terms and privacy policy they agreed to promise: **Manage billing** (Stripe's
    page, to cancel the plan), **Disconnect Gmail**, **Delete my account** (each with the same
    one confirmation as in Settings) or **Sign out**. Until they agree or leave, the app keeps
    checking their mail in the background (the screen only stops them using the app).
  - **Stripe's checkout page:** a required "I agree" box too. It needs your terms link in Stripe
    ([Add your terms link in Stripe](#add-your-terms-link-in-stripe-right-after-step-1)); until then
    checkout works without it and `/admin` → Payments says so.
  - The privacy policy now says we keep when each person agreed and to which version.
- **Demo video: option B**, a separate demo account, invited from `/admin` and paid with Stripe's
  test card while Stripe is still in test mode, so it can send; nothing of yours is touched. An
  engineer tries it once on production first, with the demo Gmail, while Stripe is still in test
  mode (a preview can't: it never reads mail, drafts, takes a payment or sends). It can send only
  until Stripe goes live: delete it before step 7, or **Reset test payments** clears it in step
  7c. After that, filming a send again needs option A (your own workspace as the house account) or
  a payment with a real card. Details under "Reviewer test account" in
  [google-verification.md](google-verification.md). It's recorded after the live check in the
  next item.
- **Drop `gmail.send`: yes, built** (live with the second merge, after step 1's). Connect Gmail now
  asks Google for two permissions, which Google's screen calls "View your email messages and
  settings" (`gmail.readonly`) and "Manage drafts and send emails" (`gmail.compose`). Google's own
  reference says `gmail.compose` can send a draft and a new email, which covers every reply and the
  trial's practice copies, while `gmail.send` couldn't even send a draft. Nothing changes for
  owners: every reply still waits for their **Send reply** tap, unless they switched on autopilot
  for that kind of email (that was always the app's own rule, not `gmail.send`'s, as you asked on
  2026-10-15). Owners who already connected keep working and nobody reconnects; Google may keep
  listing the old permission on their account until they disconnect. It doesn't avoid the CASA test. Yours: remove `gmail.send` under Google Auth
  Platform → Data Access before you submit ([0e](#0-start-now-google-verification-takes-weeks)).
  A preview can't send, so the engineers check it on production with the demo Gmail right after
  it goes live (a practice copy during its trial, then a real reply after a test-card payment,
  while Stripe is still in test mode) and put `gmail.send` back at once if either fails. **Before
  that check they clear the demo Gmail's old access.** A connection made while the app still
  asked for `gmail.send` keeps it (Google even adds it back on a reconnect), and it could send the
  practice copy on its own, so the check would prove nothing. On every Squared Away account where
  the demo Gmail is connected (the dry-run account, for one): Settings → **Disconnect Gmail** →
  **Yes, disconnect Gmail**, which also removes the access at Google. Then
  myaccount.google.com/permissions, signed in as the demo Gmail, must show no Gmail access for
  Squared Away (if it still does, remove it there). Then they connect it again and confirm Google
  kept only the two: that mailbox's saved permissions (`mailboxes.scopes`) have no `gmail.send`,
  and Google's page doesn't list "Send email on your behalf". Only then the practice copy and the
  real reply.

### Decided on 2026-10-14

Recorded here so nobody asks again.

- **Merge and deploy** ([step 1](#1-merge-the-launch-branch)): okay. The engineers open the pull
  request once every check is green; you press Merge (the production deploy).
- **Preview database** ([step 2](#2-give-previews-their-own-database)): a separate, empty Neon
  project, `sa-preview`. Yours: create it, copy its pooled string, and add it in Vercel (2a, 2b,
  2d). The engineers do the rest.
- **Test-mode Stripe accounts** ([step 7c](#7-stripe-live-mode)): reset them. After the live key
  is in and Stripe is connected again, tap **Reset test payments** in `/admin`: those accounts keep
  their data and pay the setup fee for real.
- **Sales tax:** charged with Stripe Tax, starting with Massachusetts. Register with the state
  first ([start it now](#start-your-sales-tax-registration-now-it-takes-days): it takes days),
  then set Stripe up ([step 7e](#7-stripe-live-mode); the questions for your accountant are
  there).
- **#26 closing question** ("Want to ask if they went another way?"): on. At your request the
  engineers set `FEATURE_CLOSING_QUESTION` to `1` in Vercel (Production and Preview) on
  2026-10-14; it starts working with the next deploy, the merge. Turning it off again:
  [SETUP.md](SETUP.md) §6d.
- **Growth:** all seven services are offered today, and the ground rules stand (no fake reviews,
  price before any work, Growth never touches the inbox).
- **Homepage:** the "Big words" switch, and it plays every time (scrolling from the app into
  Growth, and every tap on a Growth link on the app side). Built; it goes live with the merge.

### Still open

Nothing below is switched on or changed until you say so.

- **Your Neon plan** ([check it this week](#check-your-neon-plan-now-this-week)): stay on Free
  (production may pause mid-month) or move to Launch (about $19–20 a month).
- **Terms: the three [To confirm] items.** The wording in `docs/terms.md` stays as it is until
  you pick. Recommended (option A for each):
  - Refunds: monthly plans can be cancelled any time and stay on to the end of the paid month, with
    no refund for part of a month. The setup fee is refunded in full if they cancel before the
    setup call, and not after it. Delete my account ends the plan at once, with no refund for the
    rest of that month (that's what the app does today; the terms should say so). If you stop the
    service, or close an account that broke no rules, refund the unused part of the month (and
    the setup fee if the call hasn't happened).
  - Liability cap, both ways: at most the greater of $100 or what they paid you in the 12 months
    before the problem. No lost profits, lost jobs or other knock-on losses. It repeats that the
    owner approves every send and that autopilot is their choice. It doesn't cover unpaid fees,
    fraud, harm done on purpose or gross negligence.
  - Law and courts: Massachusetts law. Contact us first and try for 30 days to sort it out; after
    that, the state courts in Middlesex County or the federal court for Massachusetts. Either side
    may use small claims court. No arbitration (with the usual group, AAA, a claim under
    $75,000 costs $1,450 to file plus $1,150 if it reaches a hearing, before the arbitrator's pay).
- **A lawyer's review** of the terms and privacy policy before launch: roughly $750–$2,500 (an
  estimate from published averages). A cheap first step: the Boston Bar Association's lawyer
  referral service gives a first 30-minute talk for $25 at most. Questions to bring: the three
  options above; whether the "I agree" boxes make the terms binding; whether to form an LLC (the
  terms name you personally; a Massachusetts LLC costs about $500 to start and $500 a year);
  whether any insurance is worth having; and whether the homepage's "Month to month, no contract."
  should say "no long-term contract".
- **The Google security test (CASA):** no decision yet. Don't pay until Google's email names the
  level ([0g](#0-start-now-google-verification-takes-weeks)).

- **#47 turning referrals on:** the reward is decided (a free month, one plan up; see "Decided on
  2026-10-15") and built and tested, off (`FEATURE_REFERRALS`). Nothing else to choose; turning it
  on is yours, in the order in [SETUP.md](SETUP.md) §6d: the live Stripe key, Connect Stripe and
  Reset test payments; then the terms line, the privacy lines and the referral-fingerprint line
  (all waiting in §6d, so the terms version doesn't change before then); then an engineer's local
  Stripe Test Clock check; only then the switch. `AUTH_SECRET` must not be changed once referrals
  have been paid. Also your call: a referrer who deletes their account before the new owner is
  active voids the referral.
- **The homepage's About section.** It used to say "a working builder." and "He built the tool he
  needed", which broke the site's own rules (no "builder", no pronouns for you). Since 2026-10-15
  the heading reads "who's behind this, someone in the trades." and the text ends "It began as
  the tool for A&C Construction's own inbox." Keep that, or tell the engineers what it should say.
  Unlike the rest of this list, it goes live with the merge ([step 1](#1-merge-the-launch-branch)).
  Your photo and the license line are separate (under "Still needed from you").
- **Reset test payments and past-due accounts.** As built, an account whose test-card renewal had
  failed (past due: nothing new is read or drafted) is switched back on by the reset: its new mail
  is sorted and drafted again, on your AI bill, though it still can't send until it pays. Okay?
  The other way is to keep it read-only until it pays (a small code change). It only matters if a
  test account is past due when you reach [step 7c](#7-stripe-live-mode).
- **Deleted owners:** Delete my account also removes their invite, so someone who deletes their
  account needs a new invite from `/admin` to come back (if they were invited from their
  waitlist entry, that card then says the invite is gone and shows "Invite … again"; otherwise
  use Invite an owner). Okay?
- **PDF quotes:** a quote sent only as an attached PDF (no `$` in the email) isn't counted as a
  price given, so "Let's do it" isn't marked Won automatically and gets no deposit draft. You can
  still tap Won. Change it only if you want it.
- **Growth, still open:** a written agreement (Growth terms of service); a Settings link to
  `/growth` for signed-in owners; a Remove button in `/admin` for waitlist entries and Growth call
  requests (Delete my account keeps them, as a separate service, and removing one on request is
  done by hand in the database for now; the policy says "ask us and we'll delete it"); and whether
  a Growth call request should ever carry a referral (today only an app waitlist sign-up from the
  link does). No tracking pixels on `/growth` without a privacy-policy change.
- **Gmail draft check (counts only, for the engineers):** whether Gmail keeps a draft's id when
  it's sent. The app is safe either way. The query is in [step 1](#1-merge-the-launch-branch);
  run it **before merging**: after the merge it always reads 0.

### Still needed from you

- The production domain and `SUPPORT_EMAIL` ([step 5](#5-support-email-and-the-production-domain)).
- The icon pack, and for the homepage's About section (PR #9) your photo and the exact license
  wording.
- The `ANTHROPIC_API_KEY` repository secret for the "Prompt evals" GitHub action.
- Your Massachusetts sales tax registration: start it now (it takes days;
  [details](#start-your-sales-tax-registration-now-it-takes-days)), then [step 7e](#7-stripe-live-mode).
- The Neon plan check ([this week](#check-your-neon-plan-now-this-week)).
- The `sa-preview` Neon project and its pooled string ([step 2](#2-give-previews-their-own-database)).
- The phone-notification keys ([step 9](#9-phone-notifications-vapid-keys)); the engineers can make
  and add them if you say so.
