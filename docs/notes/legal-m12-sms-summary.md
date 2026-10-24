# Legal sentences from `m12-sms-summary` (for the one legal release)

Nothing here is applied on this branch; `docs/privacy-policy.md`, `docs/terms.md` and
`TERMS_VERSION` are untouched. Needs Davi's okay.

## Plan #50 — the morning summary and waiting quote requests by text

Where: `docs/privacy-policy.md`, the list of emails, texts and notifications we send (the line
that already says "texts and notifications have counts only").

Sentence (add after "…if you turn them on, text alerts and phone notifications."): "If you turn
them on, the morning summary and a note when a quote request has waited over 4 work hours can
also come by text; those texts carry counts and a link only."

Where: `docs/privacy-policy.md`, "Text alerts" (what we keep).

Sentence (append): "This includes the morning summary and waiting-quote texts, and the date of
the last morning summary text, so it goes once a day."

Why: two new opt-in texts to the owner's own phone (Settings → Text alerts), content-free like
the existing ones; we store two on/off switches and the local date of the last summary text
(`business_profile.sms_summary_enabled`, `sms_at_risk_enabled`, `sms_summary_last_sent_on`).
No new outside service: the same texting provider (Twilio). The texts screen already carries the
carrier words (frequency, "Msg & data rates may apply", HELP/STOP) for both switches.
