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
