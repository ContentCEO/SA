# Notes from branch `wave1-send` (wave 1, group "Send path")

For the integrator to fold into `CLAUDE.md` (Decisions), `docs/LAUNCH.md` and the legal drafts.

## Decisions (CLAUDE.md)

- **Check 9 P1 (seen text):** every Send reply (card, Edit box) posts `seen` = `bodyHash` of the
  text the card showed; the review page posts `seen:<draftId>` / `seenTo:<draftId>` per row.
  `queueSend({ seenHash })` returns `changed_since_seen` when the stored text differs, and the
  queue write itself only lands while `drafts.body` is still the text that was checked. The
  server action refuses a tap with no fingerprint (an old page) the same way; the JSON route
  takes an optional `seen` for online sends (409 `changed_since_seen`). Notice:
  "That draft changed since you opened it, so nothing was sent. Here's the latest version. Read
  it, then tap Send reply again."
