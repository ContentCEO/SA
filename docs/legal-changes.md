# What changed in the terms and privacy policy

One `## <version>` section per `TERMS_VERSION` (the documents' "Last updated" date, newest first),
with two to five plain bullets. When an owner who agreed to an older version is asked to agree
again, `/welcome/terms` shows the bullets of every version newer than theirs under "What changed",
rendered with the same Markdown as the documents. Written for owners, not lawyers: plain words,
no legal terms, no email content. `tests/unit/legal-changes.test.ts` checks that the current
version has an entry and that every section is this shape.

## 2026-10-16

- Google now asks you for two Gmail permissions instead of three; we dropped the separate "send"
  one, because drafts are sent through the drafts permission.
- The trial section says what the app does today: it won't send anything to a customer, you can
  send yourself practice copies, and your drafts are in your Gmail Drafts folder too.
- New optional features are described: trial emails (with a stop link), paused Gmail addresses on
  a smaller plan, warm first replies, money totals in the morning email, emergency alerts at
  night, text delivery reports, and the Squared Away Growth dashboard as a separate service.
- The policy now says the AI sees each email's sender and subject as well as its text, that the
  one-line "needs you" reasons are kept, that everything runs in the United States, and how we
  tell you about a security breach.

## 2026-10-15

- The first version everyone agrees to: an "I agree" box at sign-in, on this screen when the
  terms change, and on Stripe's checkout page.
- The privacy policy lists each Gmail permission with the reason for it, and what happens if you
  untick one.
- Both documents say Squared Away is run by Davi Chaves in Massachusetts and how to reach us.
