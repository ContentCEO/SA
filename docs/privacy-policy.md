> **Draft — not yet reviewed.** This policy has not been reviewed by a lawyer yet. It describes
> what the Squared Away software does today, as checked against the code.

# Privacy Policy

_Last updated: October 12, 2026_

Squared Away is run by {{OPERATOR}}, {{LOCATION}}. It helps small trade businesses answer their
email: it sorts incoming business email, writes reply drafts in the owner's own voice, and holds
every draft until the owner approves it. This policy explains what we collect, why, where it goes,
and how to make us delete it.

The short version:

- We read your Gmail only to sort your business email and write your reply drafts.
- Email text is sent to one outside service, Anthropic (the company behind the Claude AI), only to
  do that work. It is not used to train AI models.
- We delete email body text after 30 days.
- Nothing is sent from your Gmail unless you tap **Send reply**, or you have switched on autopilot
  for a kind of email yourself.
- You can disconnect Gmail or delete your account at any time from Settings.

## Who this policy covers

This policy covers the owners and staff who sign in to Squared Away ("you"), and people who join
our waitlist or book a free Squared Away Growth call on our website. It also explains how we handle
information about the people who email your business (your customers and suppliers), because their
messages pass through Squared Away.

Squared Away is a tool for businesses. It is not meant for children, and we don't knowingly
collect information from anyone under 16.

## What we collect

**When you join the waitlist:** your name, email address, trade, team size, and anything you choose
to add (phone number, a note). To stop spam, we briefly keep a scrambled (hashed) version of your
IP address to limit how many times a form can be sent; it can't be turned back into your IP
address and is deleted within three days.

**When you book a free Growth call:** your name, phone number, email address, trade, the services
you want help with (for example Google ads or reviews), when you asked, and anything you add in the
note. We use it only to contact you about Squared Away Growth. If you're already on the app
waitlist, we add your request to that entry and keep everything you gave us before. Booking a call
doesn't sign you up for the app or let you sign in. The same scrambled IP address limit applies to
this form.

**When you sign in with Google:** your name and email address. Sign-in asks Google only for "who you are" (`openid`, `email`, `profile`). It does not give us
access to your email.

**When you connect Gmail:** this is a separate step, after a screen that explains what Squared Away
will and won't do. We ask Google for three Gmail permissions:

| Permission                         | Why we need it                                                                                                                                             | What we never do with it                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Read your email (`gmail.readonly`) | To sort incoming business email and write a reply, and to read up to 200 of your recent sent emails once, so drafts sound like you.                        | We never delete, archive, move or label your mail.          |
| Manage drafts (`gmail.compose`)    | To put reply drafts in your own Gmail Drafts folder, in the right conversation, and to update or remove drafts we created when you change them in the app. | We don't touch drafts we didn't create.                     |
| Send email (`gmail.send`)          | To send a draft when you tap **Send reply** — or, only if you switch it on for a kind of email, autopilot (see below).                                     | We never send anything you haven't approved or switched on. |

If you untick any of these on Google's screen, we remove what was granted and save nothing.

**What we store from Gmail:**

- For the last 30 days of mail: who each message is from and to, the subject, and the date.
- For conversations in your inbox: the text of the messages, so we can sort them and write replies.
  We don't download the text of mail outside your inbox (for example archived newsletters).
- A one-line summary of what each conversation is about (for example "Wants a quote for a deck
  repair"), the category we sorted it into, and facts pulled from it, such as an address, a date
  or an amount mentioned.
- The reply drafts we write, so you can review them in the app.
- A description of how you write (your usual greeting, sign-off, length and common phrases) and up
  to five short example replies in your style. These examples are written by the AI with
  placeholders in place of names, addresses, phone numbers, emails and prices. The sent emails
  used to learn your style are read once and never stored.

**What you tell us:** your business details (business name, trade, services, service area, hours,
price list, payment terms, policies, things you never promise, words you never use), your
settings, and, if you turn on text alerts, your own mobile number.

**Payments:** card details are handled by Stripe and never reach us. We keep your Stripe customer
and subscription IDs and your plan.

**What happens in the app:** a record of actions (for example "draft created", "reply sent",
"Gmail connected"), whether you edited a reply before sending it, and daily counts of AI use and
estimated cost. These records hold IDs and counts, not email text.

**Cookies:** we use only the cookies needed to keep you signed in and to protect the Gmail
connection step from forgery. We don't use advertising or tracking cookies, and we don't run
analytics that follow you.

## How we use it

- To sort your business email and put what needs you first.
- To write reply drafts and follow-up drafts (at most two per conversation, ever) for you to
  approve.
- To send a reply when you tap **Send reply**.
- To send you your morning summary and, if you turn them on, text alerts — both contain counts and
  categories only, never a customer's name or words.
- To run your account: billing, support, keeping the service working and secure.

We don't sell your information or your customers' information. We don't use it for advertising.

## Sending and autopilot

Every reply waits in your queue until you tap **Send reply**. During your three-day trial, sending
to customers is switched off in the code.

Autopilot is off unless you turn it on, one kind of email at a time, and only on plans that
include it after your setup call. It only becomes available for a kind of email after you have
sent ten of those replies exactly as drafted. It never answers complaints, bills with an amount on
them, anything flagged for you, or someone you haven't written to before, and it never sends a
reply that mentions a price or an amount. Every autopilot reply waits in
your queue for 10 minutes with a **Hold it** button before it is sent, and every check runs again
just before sending.

## Squared Away Growth

Squared Away Growth is a separate, one-on-one service: we help trade businesses with ads, social
media posts, their Google Business Profile, reviews and websites. Growth never uses Squared Away's
access to anyone's Gmail. Nothing from your email, or your customers' email, is used for Growth
work, ads or posts. Gmail data we receive through Google's APIs is never used for Growth (see
Limited Use below). If you hire us for Growth, what we need from you (such as photos or access to
your ad accounts) is agreed with you directly, outside this app.

## Where your information goes

We use these service providers. Each gets only what it needs:

- **Google** — your Gmail, through the permissions above.
- **Anthropic** — the text of the emails being sorted or answered, your business details and your
  writing-style description, sent for the task at hand only (sorting a message, learning your
  style, or writing a draft). Under Anthropic's commercial terms, this data is not used to train
  their models. Anthropic may keep it for a limited time under its own policies, for example to
  prevent misuse.
- **Vercel** — hosts the website and app.
- **Neon** — hosts our database (in the United States).
- **Inngest** — runs our background jobs. It sees IDs and counts, not email text.
- **Stripe** — takes payments.
- **Resend** — delivers our emails to you (the morning summary and account alerts), which contain
  counts and categories only, and a short notice to us when someone books a Growth call, which says
  only that a request came in, with no name, number or email address.
- **Twilio** — only if you turn on text alerts: delivers texts to your own phone, with counts only.
- **Sentry** — only if switched on: receives error reports with email addresses masked and no
  email content.

We may also share information if the law requires it, or to protect the safety of people or the
service.

## Google API Services: Limited Use

Squared Away's use and transfer of information received from Google APIs to any other app will
adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

In plain words:

- We use Gmail data only to provide the features described in this policy, which you can see in
  the app.
- We transfer Gmail data to others only as needed to provide those features (to Anthropic, to
  write and sort), to comply with the law, or as part of a merger or sale of the business with
  your rights protected.
- We don't use Gmail data for advertising, and we don't sell it.
- We don't use Gmail data to train AI models, and our AI provider doesn't either.
- People don't read your Gmail data, unless you ask us to (for example when you need help), it is
  needed for security or to investigate abuse, or the law requires it.

## How long we keep it

- **Email text** (message bodies, Gmail's preview text, and draft text) is deleted after 30 days
  by a daily job. Mail older than 30 days is never stored with its text in the first place.
- **Who, when, subject, summaries and categories** are kept so your inbox, quotes and activity
  history keep working, until you disconnect that Gmail address or delete your account.
- **Waitlist entries** are kept until you ask us to remove them, or until we invite you.
- **Growth call requests** are kept until you ask us to remove them (call, text or email us). If
  you send another request from the same email address, the newest one replaces the one before;
  the name and trade from your first entry stay on it.
- If your trial ends or a payment fails, we stop reading your mailbox and stop using the AI, but
  we don't delete your data for that reason alone.

## Your choices

- **Disconnect Gmail** (Settings): removes our access at Google straight away and deletes
  everything we stored from that Gmail address — messages, conversations and drafts. Your writing
  style description and business details stay until you delete your account.
- **Delete my account** (Settings, one confirmation): cancels your subscription, removes our
  access at Google, and deletes your account and everything in it. Drafts already in your Gmail
  Drafts folder stay in your Gmail. Our database provider keeps short-term backups for recovery,
  so deleted data can remain in those backups for a short time before it is gone for good. This
  doesn't remove a waitlist entry or Growth call request you sent from our website; ask us and
  we'll delete it.
- You can also remove our access any time at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- To see, correct or delete what we hold about you — including if you are a customer of one of
  our users — contact us below.

## Security

Connections are encrypted (HTTPS). Google access tokens are encrypted before they are stored and
are never shown in the browser or written to logs. Our logs never contain email text, access
tokens or customers' personal details. Only the account owner can see their mail in the app; our
admin page shows account health and counts, plus the waitlist and Growth call requests people send
us from the website.

## Changes

If we change this policy, we'll update the date at the top and, for significant changes, tell
you in the app or by email before they take effect.

## Contact

{{OPERATOR}}, {{LOCATION}}\
Phone: {{PHONE}}\
{{SUPPORT_EMAIL_LINE}}
