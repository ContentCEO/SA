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
- **Voice learning skips the app's own replies (Check 24 P3):** before fetching bodies,
  `learnVoice` drops sent-folder ids that match `drafts.sent_gmail_message_id` with status
  `sent` (sent exactly as drafted, by a tap or autopilot) on any of the workspace's mailboxes;
  `edited_and_sent` ones stay (the owner's edits are his words). The count is logged as
  `appSentSkipped` in `voice_learn`. Fewer than 5 left → not_enough_mail (a stored voice stays in
  use, P1).
- **Voice scrub (Check 24 P4):** `src/server/scrub.ts` (pure) — named rules `SCRUB_RULES`
  (email, email_spelled, phone (10/11 digits, any separators, inside wa.me / tel: links),
  phone_local, price_dollar_sign, price_thousands, price_words_after (bucks / dollars / dólares /
  reais / grand), price_rate (/hr, ea, /sq ft, per sq ft), price_spelled, po_box, street_route,
  street (case-insensitive, more suffixes), street_romance_number_first / _name_first, unit,
  us_zip_after_state, canadian_postal_code). Numbers after invoice / inv / # / serial / model /
  part / permit (and order / ref / job / po) or glued to letters and a dash stay. The business's
  own phone numbers and website hosts are read from `business_profile.signature` (there's no
  separate phone/website column) and stay. `learnVoice` scrubs every stored field (summary,
  greeting, sign-off, phrases used/avoided, examples). Owner-typed voice edits are not scrubbed
  (the owner's own words).

## For docs/privacy-policy.md (Check 24 P4)

- The sentence "replaces any email addresses, phone numbers, prices and street addresses it
  finds" is now backed by the rules above for all stored voice fields, not just examples.
  Davi's call ("Your call" on the Check 24 page) whether to soften it to "replaces the email
  addresses, phone numbers, prices and street addresses it recognizes" — pattern rules can't
  catch every way people write an address (e.g. "the yellow house past the church").
- **Voice inbox (Check 24 P6, migration `voice_learned_from`):** `voiceMailbox()` picks, among
  running mailboxes (`mailboxRunning()`), the owner's sign-in address (`users.email`) if it's one
  of them, else the oldest by `created_at` (not `connected_at`, which a reconnect resets, so the
  choice would jump). `no_mailbox` only when none is running (already true at the base; the
  backstop uses the same filter, so no 15-minute re-queue). `voice_profile.learned_from_mailbox_id`
  (FK, set null) → Settings → Your voice shows "Learned from mike@shop.com".
- **Accepted voice ideas don't stop the weekly refresh (Check 24 P7):** `decideSuggestion` no
  longer sets `source = edited`; the change itself comes from `ideaChanges`
  (`edit-learning-rules.ts`, pure; `SUMMARY_ADDS` moved there), and `learnVoice` re-applies every
  accepted idea oldest first (`acceptedIdeas`) after building its values, so the newest
  shorter/longer and more_formal/more_casual win and warmer/skip_opener lines are added once.
  **Existing rows** marked edited only because of an accepted idea are **left alone** (no
  one-off script): an "edited" row could also hold the owner's own typed edits, and the
  activity log can't always tell which came last without guessing. They keep working as before
  (weekly refresh skips them; "Re-learn" brings them back). Davi can ask for a script if wanted.
- **Stale sample replies (Check 24 P8, migration `voice_examples_stale`; adapted):**
  `voice_profile.examples_stale` is set when greeting, sign-off, formality or length change
  through `saveVoiceEdits` (decided in SQL against the stored row; "or"-ed, so changing back
  doesn't revive old samples) or `decideSuggestion` (formality/length), and by `learnVoice` when a
  re-applied accepted idea moved the model's length or formality; a learn whose ideas change
  nothing clears it. While stale, `workspaceContext` passes `examples: []` and Settings hides the
  samples. **Not built (needs the Prompt versions group):** the `voice/examples.requested` job and
  its prompt `voice-examples.v1` (this group may not write prompt files). Until then stale samples
  stay unused until the next successful learn (never for a hand-edited voice unless the owner
  taps Re-learn). Spec for the integrator / Prompt versions group:
  - Event `voice/examples.requested` `{ workspaceId }`; function `voice-examples`
    (singleton per workspace, skip; retries 3; `jobsAllowed` + AI cap like `learnVoice`); enqueue
    it from `saveVoiceEditsAction` and `decideVoiceIdeaAction` when the save set the flag, and from
    `learnVoice` when it stored `examplesStale: true`.
  - Server function `rewriteVoiceExamples(workspaceId)` in `src/server/voice.ts`: read the stored
    row only (no sent mail), one `callStructured` (role "voice", Sonnet, maxTokens 1500, one
    retry), run every sample through `scrubText(…, scrubAllowFrom(signature))`, cap 5 × 600 chars,
    then in one UPDATE … WHERE `updated_at` = the value read (so an edit made meanwhile wins and
    re-flags): `examples = …, examples_stale = false`. Unusable output twice → leave the flag set.
  - Prompt `src/ai/prompts/voice-examples.v1.ts` (`VOICE_EXAMPLES_PROMPT_VERSION =
    "voice-examples.v1"`, registry line, prompt-versions test), exact lines:
    ```
    // Check 24 P8: five sample replies written from the owner's stored voice settings only.
    export const VOICE_EXAMPLES_INSTRUCTIONS = `You write five short sample email replies for a small trade contractor, in their own voice, so an assistant can copy the style.
    Use only the voice settings given. Follow them exactly:
    - Open with the greeting style given (or no greeting if none is given).
    - End with the sign-off given (or none).
    - Keep each reply close to the average length given, in words.
    - Match the formality given (casual, neutral or formal).
    - Use the phrases they use where they fit naturally; never use the phrases they avoid.
    Write five different everyday situations: answering a quote request, confirming a visit, a schedule change, a payment reminder, and a quick thank-you.
    Never write a real name, email address, phone number, street address, price or date. Use placeholders instead: [name], [email], [phone], [address], [price], [date], [time].
    Return JSON only.`;
    export const voiceExamplesSchema = z.object({ examples: z.array(z.string().min(1).max(800)).length(5) });
    export function voiceSettingsBlock(v) — "<voice_settings>\nGreeting: …\nSign-off: …\nAverage length: N words\nFormality: …\nPhrases they use: …\nPhrases they avoid: …\nSummary: …\n</voice_settings>" (owner-typed text passed through `untrusted()`).
    ```
  - Eval cases: three voice settings (casual "Hey"/"Thanks, Sam" 40 words; formal "Good morning"
    / "Best regards" 120 words; one with a never-say phrase) — pass = 5 samples, each starts with
    the greeting and ends with the sign-off, avoided phrase absent, no digits except in
    placeholders, length within ±50% of the average.
- **Failed first learn retried the same day (Check 24 P12, migration `voice_retries`):**
  `voice_profile.retry_day` (UTC date) / `retries_that_day`. The 15-minute backstop also restarts
  a row whose newest attempt is failed or capped, older than 1 hour, with **no stored voice**, not
  given up by the stuck backstop (restart_count < 2), at most 3 times a UTC day (claimed in a
  conditional UPDATE). A failed refresh of a stored voice waits for the weekly run, as before
  (drafts keep the stored voice). Copy: welcome/learning "Couldn't learn your style this time.
  We'll try again within the hour, and you can set it by hand in Settings."; Settings list "Not
  learned yet: not enough sent mail" / "Not learned yet: we'll try again soon".
