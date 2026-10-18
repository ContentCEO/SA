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

## Davi to-dos

- Check 43 P3 is not verified live: send one reply from the preview to a second address and
  look at the From line in Gmail web, Gmail on a phone and Apple Mail.

## Questions for Davi

(none yet)
