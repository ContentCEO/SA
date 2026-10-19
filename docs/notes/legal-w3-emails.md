# Legal sentences from `w3-emails` (for the one legal release)

Each sentence word for word, with the reason and the prompt id. Nothing here is applied on this
branch; `docs/privacy-policy.md`, `docs/terms.md` and `TERMS_VERSION` are untouched.

## Check 47 P3 — waitlist mail host

Where: `docs/privacy-policy.md`, the waitlist part (what we store when you join the list).

Sentence: "We look up which company hosts your email domain, to know if Squared Away can connect
to it yet."

Why: `joinWaitlist` now reads the domain's MX records (`node:dns/promises`, the domain only,
2 seconds at most, any error → "unknown") and stores one of `google` / `microsoft` / `other` /
`unknown` in `waitlist.mail_host`, so /admin can count Outlook demand and warn before inviting an
address that can't connect. Needs Davi's okay before the policy text or `TERMS_VERSION` change.
