# Legal sentences from `m12-outlook` (for the one legal release)

Plan #49, Outlook / Microsoft 365, built behind `FEATURE_OUTLOOK` (off). Each sentence word for
word, with where it goes and why. Nothing here is applied on this branch: `docs/privacy-policy.md`,
`docs/terms.md`, `TERMS_VERSION` and `LEGAL_DOCS_SHA256` are untouched. **These must be in the
published policy and terms before `FEATURE_OUTLOOK` is turned on** (docs/SETUP.md §8b step 6).
Needs Davi's okay, and a new `TERMS_VERSION` (every owner agrees again).

## Privacy policy

### "Where your information goes" — a new line after the Google line

Sentence:

- **Microsoft** — your Outlook or Microsoft 365 mailbox, if you connect one instead of (or as well
  as) Gmail, through the permissions below. We reach it only through Microsoft Graph, Microsoft's
  own service for this.

Why: `src/mailbox/outlook/` fetches `graph.microsoft.com` (mail, drafts, sending, change
notifications) and `login.microsoftonline.com` (sign-in tokens). The data-paths fence
(`tests/unit/data-paths.test.ts`, `FETCH_HOSTS_AWAITING_POLICY`) accepts these hosts from this note
until the line is in the policy; when it is, move both hosts into `FETCH_HOSTS` with "Microsoft".

### "What we collect" — after "When you connect Gmail" (a new paragraph and table)

Sentence:

**When you connect Outlook or Microsoft 365:** the same explainer screen comes first. We ask
Microsoft for four permissions (named as Microsoft's screen names them):

| Permission                                                             | Why we need it                                                                                                                                                                                                           | What we don't do                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Read and write access to your mail (`Mail.ReadWrite`)                  | To read new email so we can sort it, to read up to 200 of your sent emails to learn how you write, and to put reply drafts in your own Drafts folder, in the right conversation, and update or remove drafts we created. | We don't delete, archive or move your email, and we don't touch drafts we didn't create.              |
| Send mail as you (`Mail.Send`)                                         | To send a reply you approved (**Send reply**) or, only if you switch it on for a kind of email, one autopilot sends; and, only during the trial, a practice copy to your own address when you ask.                       | We never send anything you haven't approved or switched on. A practice copy never goes to a customer. |
| Maintain access to data you have given it access to (`offline_access`) | So the app can keep checking for new email while you're not using it.                                                                                                                                                    | It gives us nothing beyond the other permissions.                                                     |
| Sign you in and read your profile (`User.Read`)                        | To learn which email address you connected.                                                                                                                                                                              | We don't read your contacts, calendar or files.                                                       |

### "What we store" — one addition

Sentence: "For an Outlook mailbox we also keep a bookmark Microsoft gives us for where we got to
in your mail, and the id of Microsoft's change notifications for it (no email content)."

Why: `mailboxes.history_id` holds Graph delta links; `push_subscription_id` and a sha256 of the
subscription's `clientState` are stored for push.

### "How you can stop it" / disconnecting — one addition

Sentence: "Microsoft doesn't let an app remove its own access. When you disconnect an Outlook
mailbox, we delete our access keys and everything we stored from it straight away; to also take
Squared Away off your Microsoft account, go to account.microsoft.com, then Privacy, then Apps and
services (for a personal account), or myapps.microsoft.com (for a work or school account), and
remove Squared Away."

Why: Microsoft has no token revoke for one app's delegated grant
(`ProviderCannotRevokeError`); Disconnect logs `revokedAtProvider: false`, deletes the mailbox and
shows the same instructions on screen.

### Wherever the policy says "Gmail" generically

Sentence (a footnote under "Who this policy covers"): "Where this policy says Gmail, the same goes
for an Outlook or Microsoft 365 mailbox you connect, with Microsoft in Google's place."

The "Google API Services: Limited Use" section stays Google-only (it is Google's requirement).

## Terms

### "Your account" (after "the Gmail you connect must be one you…")

Sentence: "If you connect an Outlook or Microsoft 365 mailbox instead, the same applies: it must
be one you own or are allowed to use for the business, and Microsoft's own terms apply to your
Microsoft account."

### "What we rely on" (the sentence naming Google)

Sentence: change "Google, our AI provider or other services we rely on can change or stop
working." to "Google, Microsoft, our AI provider or other services we rely on can change or stop
working."
