# Notes from w2-mail (wave 2, "Mail format")

## For CLAUDE.md (Decisions)

- **Mail format (wave 2):** every outgoing reply is built in `src/mailbox/mime.ts`; headers
  stay CR/LF-safe and threaded (In-Reply-To / References unchanged).
  - **From name (Check 43 P3):** `business_profile.from_name` (max 80, Settings → Your business
    "Name customers see on your emails"). Empty → the owner's Google name (`users.name`), else the
    business name (`pickSenderName` in `src/server/from-line-rules.ts`, read live by
    `senderNameFor` in `src/server/from-line.ts`). `formatAddress`: ASCII name → `"Name" <email>`
    (quotes and backslashes escaped), anything else → RFC 2047 word. Every rewrite of a stored
    draft goes through `draftRaw()` (drafts.ts), so an edit, a revise, a send with edits and the
    Reply-To backfill all carry the current name. The card shows "From: Mike Rossi" above To.
  - **Send-as (Check 42 P4):** `listSendAs()` (gmail.readonly, field mask: address + status
    only) → `mailboxes.send_as` (verified aliases and the primary, lowercased, max 50), read
    in the backfill job's first step (every connect and reconnect) and daily in
    `renew-gmail-watches` (`refreshAllSendAs`). Best effort: a failure keeps the stored list and
    is logged by error name only. `pickFromAddress` (from-line-rules.ts): the first send-as
    address in the customer's newest email's To, then Cc; else the connected address. Stored on
    `drafts.from_address` (null = connected address), used by every rewrite (`mimeFor`). The
    card says "From: Name · office@…" only when it differs. Practice sends stay from the
    connected address (they go to the owner).
  - **Signature (Check 43 P4):** the form says Gmail's own signature isn't added (Google adds it
    only in Gmail's web app). With `business_profile.signature` empty, the queue's first draft
    card shows "No signature. Customers won't see your phone number." + "Add a signature"
    (`/settings/profile#signature`). Read live from the profile, no table; shown on every visit
    (not once a day: no table to remember it). "Show full draft" already removes the clamp.
  - **Form-lead subject (Check 43 P5):** when the reply goes to a Reply-To that isn't the sender
    (a website form), `formReplySubject` (mime.ts) turns a robot subject (form submission, new
    entry, new lead/message/inquiry/request from, contact form, website form/inquiry, request a
    quote) into "Your request to <business>" ("Your request" with no name); other subjects keep
    "Re: …". Threading headers unchanged. Nudges on those threads go through the same code
    (a nudge after "Your request to X" reads "Re: Your request to X"). Every draft card shows
    "Subject: …" above the reply. The Reply-To backfill's re-pointed old drafts keep their
    stored subject (not changed here).
  - **HTML part (Check 43 P6):** `buildReplyMime` writes multipart/alternative: the text/plain
    part exactly as before plus a text/html part made by `textToHtml` (every character escaped,
    line breaks → `<br>`, blank lines → `<p>`, one `<div dir="auto" style="font-family:inherit">`;
    no links, images, colours or tracking). Random boundary checked against both parts; both
    base64 UTF-8. Gmail's parser (`extractBodyText`) prefers text/plain, so `sameText` checks
    are unchanged. `FakeWriter.bodyOf` reads the text/plain part (`partOf` for either) and the
    e2e fake's `parseRaw` reads multipart. Not verified in classic Outlook.
  - **Header folding (Check 43 P10):** `encodeHeader` splits non-ASCII text into encoded
    words of at most 42 UTF-8 bytes (68 characters, under RFC 2047's 75; "Subject: " + a word
    fits a 78-character line), never inside a character, folded with CRLF + space (the input is
    CR/LF-stripped first, so folding is the only line break). `replySubject` collapses a leading
    run of reply prefixes (Re, RE, Res, RES, Re[2], Re(2)) into one "Re: "; forward prefixes
    (Fwd, FW, RV, Enc) stay after it. "RE: x" is now "Re: x". The e2e Gmail fake joins adjacent
    encoded words (RFC 2047 §6.2).
  - Known gaps: `workspaceMailboxEmails` (the "self" list for Reply-To picking and
    `answeredSince`'s "only to yourself" rule) doesn't include send-as aliases.

## Privacy policy (What we store)

- "Your Gmail "send mail as" addresses (like office@ or info@ on your account), so a reply goes
  out from the address your customer wrote to. Read with the Gmail access you already gave; we
  don't read their settings or signatures."

## Davi to-dos

- Check 42 P4 is not verified live: on an account with a verified "send mail as" alias, have a
  customer address write to the alias and check the reply goes out from it.
- Check 43 P6 is not verified live: open a reply with a one-line-per-item signature in classic
  Outlook for Windows and check the lines stay separate (and Gmail / Apple Mail look as before).
- Check 43 P3 is not verified live: send one reply from the preview to a second address and
  look at the From line in Gmail web, Gmail on a phone and Apple Mail.

## Integration notes

- Migrations (renumber at merge): `0044_from_name` (business_profile.from_name) and
  `0045_send_as` (mailboxes.send_as text[] default '{}', drafts.from_address). Additive only.
- No prompt files changed. The drafter is still told "(none — sign off with the first name
  only)" when the signature is empty; no prompt line needed for this group.
- `mimeFor` gained a required `fromName` argument; call sites now use `draftRaw(draft, mailbox,
  body)` (drafts.ts). Any group adding a new Gmail-draft rewrite should use `draftRaw`.
- `buildReplyMime` output is now multipart/alternative. Tests that read a draft body must use
  `FakeWriter.bodyOf` (reads text/plain) or `FakeWriter.partOf`; hand-built single-part raws
  still work. `editInGmail` writes a single text part.
- `replySubject("RE: x")` is now "Re: x".
- `QueueItem` gained `fromAddress` and `subject`; `DraftCardProps` gained `fromName`,
  `fromAddress`, `subject`, `noSignatureLine`.
- The e2e Gmail fake gained `gmail.settings.sendAs.list`, multipart parsing and joined encoded
  words; `tests/unit/e2e-fakes.test.ts` lists the new route.

## Questions for Davi

- The "No signature" line shows on the queue's first draft on every visit while the signature
  box is empty (the safe default; "once a day" would need somewhere to remember it). Is every
  visit fine, or should it be once a day?
- A form lead's reply subject reads "Your request to <business name>". OK, or would you prefer
  other words (e.g. "Your quote request")?
