# Notes from `w2-voice` (wave 2 group "Voice")

## For CLAUDE.md (Decisions)

- **Voice: what's stored vs. how the last learn went (Check 24 P1 + Check 29 P2, migration
  `voice_attempts`):** `voice_profile.last_attempt` (learning | ready | not_enough_mail | failed |
  capped | reconnect_needed) + `last_attempt_at` record every learn; `status` only becomes "ready"
  on success, and a row that already holds a voice (summary, greeting, sign-off or examples) stays
  "ready" whatever an attempt says (decided in SQL in `recordAttempt`, so an owner's save made
  meanwhile counts). `workspaceContext` uses the voice whenever the row has content
  (`hasVoiceContent`, `src/server/voice-rules.ts`). Settings → Your voice shows "The last update
  didn't finish (Oct 13). We're still using this voice." when a voice is stored and the newest
  attempt didn't finish; the Settings list line reads from content. The welcome/learning screen
  still treats not_enough_mail / failed as done for a first learn (status-based, unchanged).
  Stuck = `last_attempt` (else legacy `status`) "learning" for 30+ minutes.
  `voice_profile.restart_count`: the 15-minute `voice` step (`restartVoiceLearns`) counts each
  restart of a stuck learn (conditional UPDATE); at 2 it stops restarting, records "failed" and
  emails ADMIN_EMAIL once per workspace per day ("Voice learning failed twice for this account",
  business name or owner email only; marker `voice_failed_alert:<ws>:<day>`, purged daily). Reset
  to 0 on a successful learn and on the owner's "Re-learn from my sent mail". Any unexpected error
  after "learning" records "failed" and rethrows (job retries unchanged).
- **Voice learning reads only the owner's own words (Check 24 P2):** `ownWords` /
  `splitOwnWords` (`src/server/voice-text.ts`, pure) replace `prepareBody` in `learnVoice`. Cuts
  at reply headers ("On/El/Em/Le … wrote / escribió / escreveu / a écrit", also wrapped over up
  to 3 lines; only when quoted text follows, the email ends, or the header names an address, a
  year or a clock time — so "On Friday the inspector wrote:" in the owner's text stays), Gmail
  and Apple Mail forwards, Outlook's underscore rule or From/Sent|Date/Subject block,
  "Original Message"; drops ">" lines, phone/app footers, an RFC "-- " signature and, in the last
  block of 2+ short lines, everything from the first line that is mostly a phone, link or
  license number (the sign-off above it stays). Any email with one word left counts ("Sounds
  good"); a forward with under 5 own words is skipped and counted. `console.info("voice_learn",
  {workspaceId, outcome, emailsRead, forwardsSkipped})` — counts only. Classification's
  `prepareBody` is unchanged (separate decision).
  The review's Check 24 script wasn't available to this builder: the 36 cases in
  `tests/unit/voice-text.test.ts` were re-invented to cover every category the review lists.
