# Google OAuth verification — why we ask for each permission

Google treats Gmail read access as a **restricted scope**. Until Squared Away passes Google's OAuth
verification (including a third-party security assessment), only up to 100 test users added by hand
in Google Cloud Console can connect. This document is the plain-language answer we give Google, and
it has to match what the code does. Code references are included so a reviewer (or we) can check.

## Two separate consent steps

1. **Sign in** asks only for `openid email profile` — who you are. (`src/auth.ts`)
2. **Connect Gmail** happens later, after a screen that explains what Squared Away will and won't do
   (`src/app/(app)/connect/page.tsx`). Only then do we ask for Gmail access.
   (`src/mailbox/gmail/connector.ts`, `src/mailbox/gmail/scopes.ts`)

If the owner unticks any Gmail permission on Google's consent screen, we revoke what was granted and
save nothing, and we explain why all three are needed.

## Scopes

| Scope                        | Why we need it                                                                                                                                                                                                                               | What we do not do with it                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `openid`, `email`, `profile` | Identify the signed-in owner and which Gmail address was connected.                                                                                                                                                                          | Nothing else.                                                                   |
| `gmail.readonly`             | Read incoming business email so we can sort it (quote request, customer question, scheduling, invoice/payment, complaint, supplier, noise) and draft a reply. Read up to 200 recent **sent** emails to learn how the owner writes.           | We never delete, archive, move, or label mail. We have no permission to.        |
| `gmail.compose`              | Create reply drafts **in the owner's own Gmail Drafts folder**, threaded to the right conversation, so the owner can read and edit them in Gmail too. Update or delete a draft we created if the owner edits or discards it in Squared Away. | We don't touch drafts we didn't create.                                         |
| `gmail.send`                 | Send a draft **only after the owner taps "Send reply"**, or — only if the owner explicitly turns it on for a specific low-risk category — autopilot. Sending is blocked in code during the three-day evaluation.                             | Nothing is ever sent without the owner's approval or explicit autopilot opt-in. |

We deliberately do **not** request `gmail.modify` or full `https://mail.google.com/` access. A test
(`tests/unit/gmail-connector.test.ts`) fails if either is added.

## Data handling

- **Where email content goes:** our database, and the Anthropic API, only for the specific task
  (sorting a message, learning writing style, drafting a reply). Nowhere else. Anthropic does not use
  API data to train models.
- **What we store:** for the last 30 days, sender/recipients/subject/date for every message; body
  text only for conversations in the inbox (`src/server/sync.ts`). Mail outside the inbox (archived
  newsletters, promotions) is never downloaded with its body.
- **Retention:** email body text and Gmail's preview snippet are purged after 30 days
  (configurable, `RETENTION_BODY_DAYS`) by a daily job; mail already older than that is never
  stored with a body in the first place. Metadata and one-line summaries are kept.
  (`purgeExpiredBodies` in `src/server/sync.ts`, tested in `tests/unit/sync.test.ts`.)
- **Learning the owner's writing style:** up to 200 recent _sent_ emails are read into memory for a
  single Anthropic call and are never written to our database (`src/server/voice.ts`, tested in
  `tests/unit/voice.test.ts`). We store only a description of the style (greeting, sign-off, length,
  phrases) plus five short sample replies the model writes in that style, with placeholders instead
  of names, addresses, phone numbers, emails or prices — scrubbed again in code.
- **Drafts:** reply drafts are created in the owner's Gmail Drafts folder and a copy of the text is
  kept in our database so the owner can review it in the app. Draft text is purged on the same
  retention schedule as email bodies (`purgeExpiredBodies`). If the owner edits or deletes the draft
  in Gmail, we follow Gmail (`reconcileDrafts` in `src/server/drafts.ts`).
- **Autopilot (opt-in):** only for owners on a plan that includes it, after their setup call, one
  kind of email at a time, and only after they've sent 10 of that kind exactly as drafted. Never for
  complaints, money, flagged emails, follow-ups, or people the owner hasn't written to before. Each
  autopilot reply sits in the owner's queue for 10 minutes with a "Hold it" button, and every check
  runs again just before sending (`src/server/autopilot.ts`, tested in `tests/unit/autopilot.test.ts`).
- **Sending:** only through Gmail's `drafts.send`, only after the owner taps "Send reply", and only
  when the workspace's status allows it — checked in code before any call to Google
  (`src/server/lifecycle.ts`, tested in `tests/unit/drafts.test.ts`). If the draft changed in Gmail
  since the owner last saw it, we don't send; we show the new text and ask again.
- **Morning summary email:** contains counts and categories only ("2 emails need you: a complaint,
  a question") — no customer names, subjects or email text — so no Gmail content reaches our email
  provider (`buildDigest` in `src/server/digest.ts`, tested in `tests/unit/digest-activity.test.ts`).
- **Push notifications:** Gmail `watch` sends only "this address changed" through Google Pub/Sub;
  we then fetch changes ourselves. The push endpoint rejects requests without a shared secret.
- **Tokens:** Google refresh tokens are encrypted with AES-256-GCM before storage
  (`src/lib/crypto.ts`) and never logged or sent to the browser.
- **Disconnect:** revokes our token at Google (`oauth2.googleapis.com/revoke`) and deletes the
  mailbox record. (`src/server/mailboxes.ts`)
- **Delete my data:** wipes the workspace and revokes the Google token. _(Milestone 11.)_
- **Admin view:** shows only operational health (status, counts, cost). No email content or
  customer names — the query selects none (`adminOverview` in `src/server/admin.ts`, tested in
  `tests/unit/lifecycle.test.ts`).
- **After the three-day evaluation:** if the owner doesn't continue, the account becomes read-only —
  we stop reading their mailbox and stop sending anything to the AI (`src/server/lifecycle.ts`).
- **Logs:** never contain tokens, email bodies, or customer personal details.

## Keep this file honest

Any change to requested scopes, where email content goes, or retention must update this file and the
privacy policy in the same commit.
