# Google OAuth verification — why we ask for each permission

Google treats Gmail read and compose access as **restricted scopes**. Until Squared Away passes
Google's OAuth verification (including a yearly third-party security assessment, CASA), Google
shows its "unverified app" warning and allows at most 100 new users **in total, for the life of
the project** (Google says the cap can't be reset or changed), so sign-up stays invite-only until
then; while the app's publishing status is still **Testing**, only test users added by hand can
connect at all. This document is the plain-language answer we give Google, and it has to match what
the code does. Code references are included so a reviewer (or we) can check.

**What goes to Google:** the sections "Two separate consent steps", "Scopes", "Google API Services:
Limited Use" and "Data handling" are the answer pasted into Google's verification form; the demo
video is recorded from "Demo video script" and only its link is sent; the reviewer's sign-in comes
from "Reviewer test account". "Before submitting" and "Keep this file honest" are for Davi only and
are **never** pasted into Google's form.

## Two separate consent steps

1. **Sign in** asks only for `openid email profile` — who you are. (`src/auth.ts`)
2. **Connect Gmail** happens later, after a screen that explains what Squared Away will and won't do
   (`src/app/(app)/connect/page.tsx`). Only then do we ask for Gmail access: `openid email profile`
   plus the three Gmail scopes below, with `access_type=offline`, `prompt=consent` and
   `include_granted_scopes=true` (`src/mailbox/gmail/connector.ts`, `src/mailbox/gmail/scopes.ts`).

If the owner unticks any Gmail permission on Google's consent screen, we revoke what was granted and
save nothing, and we explain why all three are needed.

## Scopes

| Scope                        | What we use it for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | What we do not do with it                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `openid`, `email`, `profile` | Identify the signed-in owner and which Gmail address was connected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Nothing else.                                                             |
| `gmail.readonly`             | Read incoming business email so we can sort it (quote request, customer question, scheduling, invoice/payment, complaint, supplier, noise) and draft a reply: the mailbox profile, the message list, single messages, the change history and Gmail's `watch` notifications. Read up to 200 **sent** emails from the last year to learn how the owner writes. Before autopilot sends, look up which draft ids sit on that one conversation (we ask Google for message ids and labels only, so no headers, preview or text come back), so an owner's half-written reply in Gmail stops it. | We never delete, archive, move or label mail. We have no permission to.   |
| `gmail.compose`              | Create reply drafts **in the owner's own Gmail Drafts folder**, threaded to the right conversation, so the owner can read and edit them in Gmail too; read back, update or delete a draft we created; and send a draft the owner approved (Send reply) or one autopilot sends (`drafts.send`, which Google authorizes under this scope).                                                                                                                                                                                                                                                 | We don't touch drafts we didn't create.                                   |
| `gmail.send`                 | Send a new message (`messages.send`). We use it for one thing: during the three-day trial, the owner can send a **practice copy** of a draft to their own address, marked "[Practice]", never threaded and never to anyone else (checked on the finished email before Google sees it).                                                                                                                                                                                                                                                                                                   | Nothing is ever sent to a customer through it, and nothing without a tap. |

For reading, `gmail.readonly` is the narrowest scope (no change rights at all); for creating,
updating and sending our own drafts, `gmail.compose` is. `gmail.send` is send-only (it can't read
or change any mail), and we request it only for practice copies to the owner's own address during
the trial. We deliberately do **not** request `gmail.modify` or full `https://mail.google.com/` access. A test
(`tests/unit/gmail-connector.test.ts`) fails if either is added.

## Google API Services: Limited Use

Squared Away's use and transfer to any other app of information received from Google APIs will
adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

In practice:

- Gmail data is used only for the features the owner sees in the app and that are described here.
- It is transferred only as needed to provide those features (to Anthropic, to sort and write), to
  comply with the law, or, if the business is merged or sold, only after asking for the owner's
  explicit permission first.
- It is never used for advertising, never sold, and never used to train AI models (Anthropic
  doesn't use API data for training). It is never used for Squared Away Growth.
- People don't read it, unless the owner asks us to (for example for support), it is needed for
  security or to investigate abuse, or the law requires it.

## Data handling

- **Where email content goes:** our database, and the Anthropic API, only for the task at hand:
  sorting a message, learning the owner's writing style, writing a reply, follow-up, deposit or
  review note or closing question, rewording a draft when the owner asks, or comparing a reply
  before and after the owner edited it to learn the change in tone
  (`src/server/edit-learning.ts`). Nowhere else.
- **What we store:** who each message is from and to, the subject and the date. When a mailbox is
  connected we read the last 30 days; after that, new mail is added as it arrives, and this
  metadata stays until the owner disconnects that Gmail address or deletes the account. Body text is
  downloaded only for conversations in the inbox and only within the retention window
  (`src/server/sync.ts`). Mail outside the inbox (archived newsletters) is never downloaded with its
  body. Unsent Gmail drafts (ours included) are not stored as mail.
- **Promotions and Social tabs:** that mail is still in the inbox (it carries Gmail's `INBOX` label),
  so its body **is** read within the 30 days like any inbox mail. It is sorted as noise in code
  **without** being sent to the AI, unless the sender looks like a building department
  (`src/server/classification.ts`).
- **Retention:** a daily job (`purgeExpiredBodies` in `src/server/sync.ts`, tested in
  `tests/unit/sync.test.ts` and `tests/unit/data-lifecycle.test.ts`) deletes, after 30 days
  (`RETENTION_BODY_DAYS`): message bodies and Gmail's preview snippet; draft text, the original
  draft text and the check notes on drafts (they quote it); and the email's own words pulled out by
  the classifier (street address, dates, an inspector's corrections) once the conversation's newest
  email is past the window. Pending drafts that old expire. Mail already older than that is never
  stored with a body in the first place.
- **Kept until disconnect or account deletion:** metadata, one-line summaries and categories, and
  content-free facts the product still needs: the kind of job, amounts mentioned, invoice number /
  amount / due date / paid or not, permit number / issuing body / inspection time / result, quote
  won/lost marks, invoice paid marks, complaint markers, review-request records, and the counts and
  tone label of edited replies.
- **Learning the owner's writing style:** up to 200 _sent_ emails from the last year are read into
  memory and never written to our database (`src/server/voice.ts`, tested in
  `tests/unit/voice.test.ts`). They are read when the mailbox is connected, again weekly (skipped if
  the owner edited their style), when the owner taps "Re-learn from my sent mail", and again
  automatically if a read stops part-way. We store only a description of the style (greeting,
  sign-off, length, phrases) plus five short sample replies the model writes in that style, with
  placeholders instead of names, addresses, phone numbers, emails or prices — scrubbed again in code.
  The style description and samples are kept until the owner deletes the account (disconnecting a
  Gmail address doesn't remove them; the next learn replaces them). Style suggestions are worked out
  in code from counts of the owner's edits and the tone-change label the AI gave each one; only the
  owner's "yes" changes the style.
- **Drafts:** reply drafts are created in the owner's Gmail Drafts folder and a copy of the text is
  kept in our database so the owner can review it in the app (purged as above). If the owner edits
  or deletes the draft in Gmail, we follow Gmail (`reconcileDrafts` in `src/server/drafts.ts`).
- **Deposit and review notes, and the closing question:** a note asking for the deposit after a
  customer accepts a quote; a review request only when the owner taps "Ask for a review" (never to
  someone who complained); and, once a quote has had both follow-ups and a week of quiet, a short
  note asking whether the customer went another way, only when the owner taps "Want to ask if
  they went another way?" (once per conversation, never after a complaint). All are ordinary
  drafts that wait for the owner; they never go out by autopilot (`src/server/drafts.ts`,
  `src/server/offers.ts`).
- **Quotes and money owed:** won/lost and paid marks come from the owner's taps or from what the
  classifier already returned for an email; nothing extra is sent anywhere.
- **Price memory:** the amounts the owner quoted (amount, kind of job, date) are kept so the owner
  can reuse them. They are **never sent to the AI**, nor put in any email, text or notification (a
  boundary test in `tests/unit/price-memory.test.ts` lists the only files that may read them).
- **Autopilot (opt-in):** only for owners on a plan that includes it, after their setup call, one
  kind of email at a time, and only after they've sent 10 of that kind exactly as drafted. Never for
  complaints, money, flagged emails, follow-ups, deposit or review notes, closing questions, quote
  acceptances, or people the owner hasn't written to before. Each autopilot reply sits in the
  owner's queue for 10 minutes with a "Hold it" button, and every check runs again just before
  sending (`src/server/autopilot.ts`, tested in `tests/unit/autopilot.test.ts`).
- **Sending:** customer replies go out only through Gmail's `drafts.send`, either after the owner
  taps "Send reply" (then a 20-second undo window) or by autopilot as above, and only when the
  account's setup fee has been paid (or it is our own house account) — checked in code before any call to Google (`src/server/lifecycle.ts`,
  tested in `tests/unit/drafts.test.ts` and `tests/unit/send-route.test.ts`). During the three-day
  trial the only send is a practice copy to the owner's own address through `messages.send`
  (`src/server/practice.ts`, tested in `tests/unit/practice-send.test.ts`). If a draft changed in
  Gmail since the owner last saw it, we don't send; we show the new text and ask again.
- **Emails we send the owner** (through Resend): the morning summary lists the kinds of email
  waiting and how long they have waited, with links into the app; the monthly summary has counts,
  the most common kinds of job and where requests came from (our fixed labels, never an address);
  the "Gmail access lost" email (plus one reminder two days later) names only the owner's own Gmail
  address. None contain a customer's name, subject or words (`src/server/digest.ts`,
  `src/server/monthly-summary.ts`, `src/server/alerts.ts`).
- **Text alerts** (Twilio, only if the owner turns them on): to the owner's own confirmed mobile,
  counts and a link only (`src/server/sms-alerts.ts`).
- **Phone notifications** (only if turned on): an **empty** web push; the phone then asks us for the
  counts, so the push service sees nothing (`src/lib/web-push.ts`).
- **Gmail instant notifications:** Gmail `watch` sends only "this address changed" through Google
  Pub/Sub; we then fetch changes ourselves. The push endpoint rejects requests without a shared
  secret.
- **Error reports** (Sentry, only if switched on): errors only, with request data, cookies, headers
  and query strings removed, email addresses masked and the user reduced to an id
  (`src/lib/sentry.ts`, tested in `tests/unit/sentry.test.ts`).
- **Squared Away Growth:** a separate service whose requests come from a form on our website. It
  never uses anyone's Gmail data.
- **Tokens:** Google refresh tokens are encrypted with AES-256-GCM before storage
  (`src/lib/crypto.ts`) and never logged or sent to the browser.
- **Disconnect:** revokes our token at Google and deletes what was stored from that mailbox:
  messages, conversations, drafts, the counts of edits to those drafts, and price memory
  (`src/server/mailboxes.ts`). Kept until the owner taps Delete my account: the writing style and
  any style suggestions waiting for them, the business details, the activity history and the AI
  usage counts (these belong to the account, not to one mailbox).
- **Delete my account** (Settings, one confirmation): cancels the subscription, revokes the Google
  token for each mailbox, and deletes the account and everything in it, including the invite
  (`src/server/account-deletion.ts`). Drafts already in the owner's Gmail stay there.
- **Admin view:** shows only operational health (status, counts, cost). No email content or
  customer names — the query selects none (`adminOverview` in `src/server/admin.ts`, tested in
  `tests/unit/lifecycle.test.ts`).
- **After the three-day trial:** if the owner doesn't continue, the account becomes read-only — we
  stop reading their mailbox and stop sending anything to the AI (`src/server/lifecycle.ts`).
- **Logs:** never contain tokens, email bodies, or customer personal details.

## Demo video script

Google wants a video that shows the real Google consent screen and each Gmail permission in use.
Record it on a **dedicated demo Gmail account filled with invented emails** (a made-up customer,
Dana, asking for a quote), never on a mailbox with real customers in it. Speak or caption each step
in plain words. Upload it as an unlisted video and paste the link into the verification form.

**Before recording: fill the demo Gmail** (or steps 7–8 fail on camera):

- At least **5 invented sent emails** of a few sentences each, from the demo Gmail to made-up
  addresses (voice learning needs 5; with fewer it stops at "not enough sent mail").
- Dana's quote request, sent to the demo Gmail **a day or two before recording** so it lands in the
  inbox's **Primary** tab (Promotions and Social mail is sorted as noise and gets no draft). Keep it
  an ordinary small job: no dollar amount over the owner's threshold ($2,500 by default), not a
  complaint, nothing about a dispute or a lawyer, and not described as a large job (a first-time
  sender asking about a big job is held for the owner with no draft).
- A second invented quote request from another made-up customer, in its own conversation, sent
  after Part 1 is recorded: Part 2 needs a fresh email to draft, because Dana's was answered in
  Part 1.

**Before recording Part 1 on the house account** (option A: Davi's own workspace, the only one
that can send without a Stripe payment; whether to record this way is Davi's decision, see
"Reviewer test account", which also has option B, a separate demo account):

- **Make your workspace the house account** (once; without it the draft card at step 9 has no
  **Send reply** button: it says "Sending is off during your three days" or "Waiting on your setup
  payment", and may offer a practice copy instead): `/admin` → your own
  card (always shown first) → **Use as my own test account** → **Yes, this is my account**. The
  button only shows on your own card, and the server refuses it for any other account. Worked
  when: the notice says "Your account can send now (marked as your own test account)." and your
  card's **Setup paid** line reads "Your own test account". If it already reads that, the button
  isn't shown and there's nothing to do.
- **Clear your Queue first.** Disconnecting deletes our copy of your drafts but **not** the drafts
  themselves in your Gmail, so every reply still waiting would stay behind in Gmail → Drafts, inside
  real customer conversations, and a stale one could later be sent from Gmail by mistake. Send or
  Discard every waiting reply (Discard deletes its Gmail draft too), tap "Hold it" on any autopilot
  countdown and send or discard that reply, and wait until no send is still in its undo window
  (a send or an autopilot countdown still running when you disconnect is dropped). Then open Gmail →
  Drafts and delete by hand any Squared Away draft still there. When you reconnect your own Gmail,
  replies are drafted fresh.
- **Then disconnect your own Gmail** (Settings → Disconnect Gmail). Without a plan (or on Solo)
  the account holds one Gmail address, and with yours still connected the Queue, Inbox and Activity would show
  your real customers on camera. Disconnecting **deletes what was stored from your mailbox**:
  messages, conversations, drafts and their edit counts, price memory, and quote and invoice marks.
  Reconnecting later reads only the last 30 days again; anything older is not brought back.
- Your writing style is re-learned from the demo mailbox's sent mail once it connects (if you edited
  your style by hand, the automatic learn skips it: tap "Re-learn from my sent mail" in Settings,
  which replaces your edits). It is re-learned from your own mail when you reconnect.
- Before you press record, open the Queue, Inbox, Quotes, Money and Activity and check that nothing
  real is on screen. Activity keeps your history lines (without customer names once your mailbox
  is gone); start filming Activity at the new line for Dana, or don't scroll past it.
- Your business details are already saved, so step 6 looks different (it says how below). The
  Business profile box in Settings lists your "Always send me" addresses, which are real customers:
  keep that line out of shot.
- Afterwards, disconnect the demo Gmail (step 14) and reconnect your own Gmail.

**Part 1 — a business that can send** (the demo Gmail connected to Davi's house account; with
option B, the separate demo account after its test-card payment):

1. **Sign in.** Open the production site, tap Sign in, tick "I agree to the Terms of Service and
   the Privacy Policy" and sign in as Davi (the `ADMIN_EMAIL` account; the house account is his),
   or with option B as the demo Gmail's own Google account. Point out that sign-in asks only for
   name and email.
2. **Settings → Connect Gmail.** Show that no Gmail is connected yet and tap Connect Gmail.
3. **The explainer.** Scroll the "before you connect" screen, including "What it won't do", then
   tap Connect Gmail.
4. **Google's real consent screen.** Google suggests the signed-in address; choose the **demo
   Gmail** instead (tap the address at the top, or "Use another account") and check that the demo
   address shows before going on. Until verification passes, Google first shows its "Google hasn't
   verified this app" screen: that is expected in the verification video. With the app In
   production (launch checklist step 0c), tap **Advanced**, then the "Go to … (unsafe)" link.
   (Only while the app is still in Testing does a test user see a **Continue** button there
   instead.) Then, on the permissions screen, pause here. Show the app name, the three Gmail permissions
   (`gmail.readonly`, `gmail.compose`, `gmail.send`), and click into the address bar so the
   `client_id=` in the URL is readable. Tap Allow (Continue).
5. **Connected.** Back in Squared Away, Settings shows the demo Gmail address as connected. Say that
   Google's key is stored encrypted and never shown.
6. **Business details.** On a brand-new account Squared Away asks next for the business name and
   the work it takes on (Save and continue). On the house account those are already saved, so open
   Settings → Business profile instead and show what the drafts are based on.
7. **Reading and learning (`gmail.readonly`).** The learning screen (on the house account, open
   `/welcome/learning` from the address bar) reads the last 30 days of email and learns the writing
   style from sent mail, then says it's all set.
8. **Sorted, with a real Gmail draft (`gmail.compose`).** Open the Queue: Dana's email is sorted
   with a one-line summary of what she wants, and a reply is ready. Switch to Gmail → Drafts and show
   the same reply sitting in Dana's conversation. Back on the Queue, the card is still waiting: a
   draft is not counted as the owner's answer.
9. **Send reply.** Tap Send reply. Show the countdown and the Undo button.
10. **Sent.** When the countdown ends the screen says "squared away."
11. **Activity.** Open Activity: "You sent a reply to Dana".
12. **The reply in Gmail (`gmail.compose`, `drafts.send`).** Switch to Gmail → Sent and open Dana's
    conversation: one reply, to Dana only, in the same conversation, and the draft is gone.
13. **Nothing more to do.** Back in the app, the conversation shows the owner wrote last and no new
    draft appears for it.
14. **Removing access.** Settings → Disconnect Gmail (or Delete my account on a demo-only account),
    then open myaccount.google.com/permissions (signed in to Google as the demo account) and show
    Squared Away no longer has access.

**Part 2 — the three-day trial** (what an invited reviewer sees):

15. **A trial account connects.** Sign in to an invited account that hasn't paid, connect the demo
    Gmail the same way (steps 2–7). The banner shows day 1 of 3.
16. **Sending to customers is off.** On the Queue the draft card says sending is off during the trial
    and has no Send reply button. Say that our server refuses a send too, not just the screen.
17. **Practice copy (`gmail.send`, `messages.send`).** Tap "Send it to yourself instead". Switch to
    Gmail → Inbox: a new email marked "[Practice]" arrived from the owner to the owner. Dana got
    nothing.

### Which test checks each step

`tests/e2e/full-flow.spec.ts` runs this same journey against local stand-ins for Google, Gmail and
the AI (it signs in with a test cookie instead of step 1). Each of its steps matches a step above:

| Step in the end-to-end test                                                     | Script step |
| ------------------------------------------------------------------------------- | ----------- |
| The owner opens Settings and taps Connect Gmail                                 | 2           |
| Squared Away explains what it will and won't do before asking Google            | 3           |
| Google's consent screen lists the three Gmail permissions; the owner taps Allow | 4           |
| Back in Squared Away, Gmail is connected and its key is stored encrypted        | 5           |
| The owner says what the business does                                           | 6           |
| Squared Away reads the last 30 days of email and learns how the owner writes    | 7           |
| It sorts the new email and writes a reply as a real Gmail draft                 | 8           |
| A later sync doesn't mistake the Gmail draft for the owner's reply              | 8           |
| The draft waits on the Queue with what the customer wants                       | 8           |
| The owner taps Send reply and gets a few seconds to undo it                     | 9           |
| When the window ends the reply goes, and the screen says squared away.          | 10          |
| Activity says the reply was sent                                                | 11          |
| Gmail sent exactly one email: the reply, to the customer, in their conversation | 12          |
| The next sync sees the owner answered, so nothing new is drafted                | 13          |
| Delete my account: Google access is revoked and nothing of theirs is left       | 14          |
| Connecting Gmail starts the three-day trial                                     | 15          |
| On the trial account the draft waits on the Queue                               | 16          |
| During the trial the card says sending is off, and there's no Send reply        | 16          |
| Asking the server to send anyway is refused (403)                               | 16          |
| The owner sends a practice copy to their own inbox instead                      | 17          |
| Gmail sent only the practice copy, to the owner; the customer got nothing       | 17          |

`tests/unit/verification-doc.test.ts` fails if a test step is added or renamed without a row here.

## Reviewer test account

Sign-in is invite-only, so the reviewer needs an invite: Davi enters the reviewer's Google address
in `/admin` → Invite an owner. (Once the app's publishing status is "In production", Google's test
user list no longer gates anything; while it is still "Testing", the reviewer must also be added
there.) The reviewer then signs in, connects their own Gmail and sees their mail sorted and drafts
written. Their account is on the three-day trial, so sending to customers is blocked; they can send
practice copies to themselves, and Davi can give them more days from `/admin` (Give 3 more days).

**For Davi (not pasted into Google's form).** How to show the send part is **Davi's decision** (it
is listed for him in the launch checklist, step 13; he chose option B on 2026-10-15). Google's page asks
the video to show what each permission is used for; it doesn't say a send must be filmed, but the
app sends replies with `gmail.compose`, so filming one is the safer choice. A trial account can't
send. Two kinds of account can send without real money today: the house account (his own
workspace, with his real Gmail connected) and any account that paid with Stripe's test card while
production Stripe is still in test mode.

- **Option A** (the house account): record Part 1 of the video on the house account with the
  dedicated demo Gmail as the **only** mailbox on it while filming (see "Before recording Part 1 on
  the house account"); the reviewer gets an invite and sees Part 2 for themselves. The cost: his Queue has to be cleared
  first (every waiting reply sent or discarded, any autopilot countdown held, any leftover Squared
  Away draft deleted by hand in Gmail → Drafts, since disconnecting leaves Gmail drafts behind in
  customer conversations); his own Gmail is then disconnected, which deletes what was stored from it (messages, conversations, drafts and their edit
  counts, price memory, quote and invoice marks); reconnecting afterwards reads only the last 30
  days again; and his writing style is re-learned from the demo mailbox, then from his own mail
  again. This costs least if it is recorded before his own mailbox's history matters.
- **Option B** (Davi's choice, 2026-10-15; it still needs an engineer's dry run on production first):
  a separate demo-only account. Invite the demo Gmail in `/admin` → Invite an owner (while the
  app is still in Testing, also add it as a Google test user; after publishing it uses one of the
  100 places). It signs in as its own account and connects the demo Gmail, so nothing of Davi's is
  touched: his Gmail, Queue and stored mail stay as they are. Film the trial part while it is on
  its three days (sending off, a practice copy to itself), then Settings → Plan & billing → Choose
  a plan and pay with Stripe's test card. That works only while production Stripe is still in test
  mode; no real money moves, and the account can then send, so film the send. The dry run settles
  the recording order (a practice copy leaves the draft waiting, so one quote request can serve
  both parts). It runs on production with the demo Gmail while production Stripe is still in test
  mode, and that account can stay as the demo account. A preview can't run it: after the preview
  database split, background jobs and Stripe only reach production, so a preview never reads mail,
  drafts, takes a payment or sends. Keep the account until Google approves, in case they ask for a new recording. It
  carries a test payment, so it can send only until Stripe goes live: either delete it before
  Stripe goes live (launch checklist step 7; Delete my account), or let **Reset test payments**
  clear it in step 7c, right after the live key swap (that button only exists with the live key).
  After that it can't send. If Google asks for a new recording of a send once Stripe is live,
  film that part with option A (the house account) or pay for the demo account with a real card.
- Or put the house account on a plan with more than one mailbox and connect the demo Gmail next to
  his own. The Queue, Inbox and Activity then mix both mailboxes, so real customer mail would be
  filmed: **not acceptable** for the video.
- Or ask the reviewer to rely on the video for sending, with no account of their own (the video
  still has to be recorded on a workspace that can send, so this doesn't avoid the first choice).

## Before submitting (for Davi only; never pasted into Google's form)

- **Is `gmail.send` needed?** Recommended: drop it (still Davi's call on 2026-10-14; the
  original brief listed it). Google's API reference lists `gmail.compose` as enough for both
  `drafts.send` (every customer reply) and `messages.send` (practice copies), while `drafts.send`
  doesn't accept `gmail.send` at all, so reviewers may ask why we also ask for it (Google's form
  asks why fewer permissions wouldn't do). Dropping it doesn't remove CASA: `gmail.readonly` and
  `gmail.compose` are restricted, `gmail.send` only sensitive. It is a small change to the
  requested scopes (code, the connect explainer, the privacy policy, this document, the launch
  checklist and their tests, plus removing it under Google Auth Platform → Data Access). Owners
  already connected should keep working with no reconnect: the granted scopes are stored at connect and
  never checked again, and both send calls work with `gmail.compose` (not yet tried live). A
  preview can't try it (it never sends), so the engineers check it on production with the demo
  Gmail right after the change goes live: a practice copy during its trial, then a real reply
  after a test-card payment while Stripe is still in test mode; if either fails, `gmail.send` goes
  back at once. Decide before filming: the video shows the permission list. Until then this
  document describes exactly what is requested today. It is listed for him in the launch checklist's
  decisions ("drop `gmail.send`?").
- Verify the production domain in Google Search Console, add it under Google Auth Platform →
  Branding → Authorized domains, and point the homepage, privacy policy and terms links there.
- Switch Audience → Publishing status to **In production** before real owners connect: in Testing,
  Google's refresh tokens for Gmail scopes expire after 7 days (every owner would have to reconnect
  weekly) and only hand-added test users (at most 100) can connect. Access given while the app was
  still in Testing keeps its 7-day end, so everyone who connected then reconnects once after the
  switch (launch checklist step 0c).
- The restricted-scope security assessment (CASA) is required and renews every 12 months,
  counted from the lab's letter (Google's team gets in touch when it's due). Google assigns the
  level, AL1 or AL2 (older pages say Tier 2 / Tier 3), from user count, scopes and other signals;
  its email says which. **Don't pay a lab until that email names the level**, then get written
  quotes from two labs on the App Defense Alliance's authorized list (for example TAC Security,
  NetSentries, Bishop Fox, DEKRA; Google's own pages name none) and ask whether the price covers
  the yearly renewal. TAC Security's posted prices (checked 2026-10-14): $675 or $855 for AL1,
  $5,400 for AL2. Budget about $700–$1,000 a year for AL1, about $4,500–$5,400 or more for AL2.
  Allow 2–6 weeks for the lab and 1–3 months for the whole review (Google says "several weeks";
  the range is our planning figure from Google's and the labs' pages).

## Keep this file honest

Any change to requested scopes, where email content goes, or retention must update this file and the
privacy policy (`docs/privacy-policy.md`, served at `/privacy`) in the same commit.
`tests/unit/verification-doc.test.ts` checks the scopes, the cited file paths, the Limited Use
sentence and the demo-script mapping against the code.
