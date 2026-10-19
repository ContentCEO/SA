# A week without Davi

For Davi, and for the person who covers while Davi can't be reached. Today every door has one key:
the Vercel team, the GitHub repository (`ContentCEO/SA`) and `/admin` all sit behind Davi's own
logins, and every notice the app sends about itself goes to `ADMIN_EMAIL`. This page says what
carries on without anyone, what waits, and what to do before and after time away.

This page names settings only; no key, password or token is ever written here.

## What keeps working

As long as the background-job plan (Inngest) and the database plan (Neon) have room left
([LAUNCH.md "Check your free plans now"](LAUNCH.md#check-your-free-plans-now-this-week)):

- New mail is read, sorted and drafted for every connected shop, as Gmail drafts waiting in the
  Queue.
- Owners whose setup is paid send their own replies with **Send reply**, and autopilot keeps
  sending for owners who switched it on (it needs a finished setup call, so nobody new gets it).
- Follow-up nudges are drafted, and the morning and monthly emails, trial emails and alerts go out
  (once Resend is set up, [LAUNCH.md step 6](LAUNCH.md#6-morning-emails-from-your-own-domain-resend)).
- An owner can choose a plan and pay on Stripe's page: Stripe's signed notice turns sending on with
  nobody tapping anything.
- Trials end on their own after three days and the account becomes read-only. Nothing is deleted.

## What stops or waits

- **New owners can't connect Gmail** while the Google app is in Testing, until someone adds them
  as test users (Google Auth Platform → Audience). Invites themselves are sent from `/admin` only.
- **Paid owners wait for their setup call.** Their account stays "setup paid": they can send, but
  autopilot needs the setup call marked done in `/admin`.
- **Growth requests aren't called back**, and Growth clients get no monthly numbers or updates
  (those are typed by hand in `/admin/growth`).
- **Gmail access in Testing ends 7 days after it was given.** Owners get "Squared Away lost access
  to your Gmail", then one reminder two days later (`src/server/alerts.ts`), and can reconnect
  themselves with **Reconnect Gmail**. Nobody calls the ones who don't.
- **An outage goes unseen** until someone opens `/admin`, unless the uptime monitor is set up
  ([SETUP.md](SETUP.md) §6g); even then its email goes only to `ADMIN_EMAIL`.
- **Support questions:** until `SUPPORT_EMAIL` is set, the screens offer only the phone number in
  `src/config/site.ts`, so calls go unanswered.

## Before you leave

- [ ] Go through [VENDORS.md](VENDORS.md)'s "Where to look on Monday" column, account by account.
- [ ] Check the free plans ([LAUNCH.md, first section](LAUNCH.md#check-your-free-plans-now-this-week)):
      Neon's compute hours, Inngest's executions, Resend's sends and Anthropic's credit must last
      until you're back.
- [ ] Add every pending invitee as a Google test user (Google Auth Platform → Audience), while
      the app is in Testing.
- [ ] Tell Growth clients when you're away and when you're back.
- [ ] Set spending limits you're comfortable with (Anthropic's monthly limit; any paid plan's
      cap), and auto-reload or a reminder so the AI credit doesn't run out.
- [ ] Tell the backup person, and give them this page and [RUNBOOK.md](RUNBOOK.md).

## For the backup person

Fill this in before you leave:

```
Backup person:
Phone:
Away from (date):           Back on (date):
How to reach Davi in a real emergency:
```

What the backup person may do:

- Call owners back, and tell them when Davi is back.
- Read [RUNBOOK.md](RUNBOOK.md) and check the companies' status pages it lists.
- Tell owners whether a problem is on Squared Away's side or a company the app runs on.

What the backup person must never do:

- Sign in as Davi, or use Davi's Google, Vercel, GitHub, Stripe or Neon logins.
- Open `/admin`.
- Read any owner's mail, or ask an owner to forward or show any.

## Coming back

1. Open `/admin`: the first box should say **System**. If it says "Background jobs look stopped"
   or "… is stopped", start with [RUNBOOK.md](RUNBOOK.md).
2. On `/admin`, read the **Needs you** box (Growth calls to return, new sign-ups to invite, inboxes
   stuck, payments failed, trials ending), then the accounts whose setup is paid and waiting for
   their setup call, and the System box's count of mailboxes that need reconnecting.
3. Check the plans again ([LAUNCH.md, first section](LAUNCH.md#check-your-free-plans-now-this-week)).
4. Read your inbox for the app's own notices (jobs stopped, a model stopped, cost alerts, Stripe
   disputes) and the backup person's notes.
5. Call back every owner who called while you were away.
