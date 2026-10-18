# Prompt lines waiting for the Prompt versions group

Wave 2 groups that may not write prompt files leave the exact prompt changes here. The Prompt
versions group (wave 2, `docs/BUILD-ORDER.md`) folds each into the next free version (after
wave 1: draft.v9, classify.v6, followup.v5, voice.v4; new prompts start at v1), extends
`tests/evals/cases.ts` for each, points `src/ai/prompts/registry.ts` at it, and deletes the item
here. The integrator keeps this file until it is empty.

## From `w2-voice` (Check 24 P8): new prompt `voice-examples.v1` and its job

The code already sets `voice_profile.examples_stale` and drafts stop using stale samples
(`workspaceContext` passes `examples: []`); nothing writes new ones yet.

- Event `voice/examples.requested` `{ workspaceId }`; function `voice-examples` (singleton per
  workspace, skip; retries 3; `jobsAllowed` + AI cap like `learnVoice`). Enqueue it from
  `saveVoiceEditsAction` and `decideVoiceIdeaAction` when the save set the flag, and from
  `learnVoice` when it stored `examplesStale: true`.
- Server function `rewriteVoiceExamples(workspaceId)` in `src/server/voice.ts`: read the stored
  row only (no sent mail), one `callStructured` (role "voice", Sonnet, maxTokens 1500, one
  retry), run every sample through `scrubText(…, scrubAllowFrom(signature))`, cap 5 × 600 chars,
  then in one UPDATE … WHERE `updated_at` = the value read (so an edit made meanwhile wins and
  re-flags): `examples = …, examples_stale = false`. Unusable output twice → leave the flag set.
- Prompt `src/ai/prompts/voice-examples.v1.ts` (constant `VOICE_EXAMPLES_PROMPT_VERSION` set to
  "voice-examples.v1", registry line, prompt-versions test). The builder's text:

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

  **Integrator note:** the builder's branch was based before wave 1. `voice.v3` (Check 23 P7)
  switched the samples to the drafter's own gaps — `{{custom:name}}`, `{{custom:address}}`,
  `{{date}}`, `{{time}}`, `{{price}}` — instead of "[name]" blanks. Use voice.v3's placeholders in
  this prompt too, so stored samples have one style.

- Eval cases: three voice settings (casual "Hey" / "Thanks, Sam", 40 words; formal "Good
  morning" / "Best regards", 120 words; one with a never-say phrase). Pass = 5 samples, each
  starts with the greeting and ends with the sign-off, the avoided phrase absent, no digits
  except in placeholders, length within ±50% of the average.

## From `w2-inbox` (Check 10 P10): classify.v6 reason wording

- The `needs_owner_reason` example "Mentions a $14,000 remodel — you'll want to price this
  yourself." becomes "Mentions a $14,000 remodel. You'll want to price this yourself."
- Add the line: "Write needs_owner_reason in one or two short sentences with no dashes." (Model
  reasons still show on Inbox cards.)
- Extend `tests/evals/cases.ts` accordingly.

## From `w2-sync` (Check 21 P1): acknowledgements

The code is in place and inert until the signal exists: `src/ai/classify.ts` maps
`signals.acknowledgment_only` to `extracted.acknowledgment_only`, which classification writes to
`messages.ack_only` (the current schema strips the unknown key).

- classify (next version): add to `signals` `acknowledgment_only: z.boolean()` with the line:
  "acknowledgment_only: true only when the email just thanks or acknowledges (\"Thanks, got it.
  We'll look it over and get back to you.\"), says they will decide or get back to you, asks no
  question and needs no answer. False if it asks anything, changes anything or needs a reply."
- followup (next version): when the customer's newest email is an acknowledgement, add to the
  task: "The customer said they'd look it over on <weekday, Month D>." (`drafts.ts` knows it:
  `last` is the acknowledgement when `onlyAcksSince` is true; pass `last.sentAt` in the owner's
  zone.)
- Eval cases, scored on `acknowledgment_only`:
  - true: "Thanks, got it. We'll look it over and get back to you." / "Thanks! We'll talk it
    over this weekend and let you know." / "Got the estimate, appreciate it. Will be in touch."
  - false: "Thanks — does that include the permit?" / "Got it. Can you start before the 15th?"

## From `w2-sync` (Check 40 P2): photos and files the customer attached

Counts are stored and shown (`messages.attachment_*`, `attachmentWords()` in
`src/server/attachment-rules.ts` gives "3 photos, 1 PDF"); the prompts don't see them yet.

- classify `emailBlock` and the draft conversation block, one line per email with attachments:
  `Attached: ${attachmentWords(counts)} (the assistant can't see them)`.
- draft rule: "If the customer attached photos, don't ask for photos again; ask only for an
  angle that's missing, or say you'll look at them."
- An email whose only content is attachments is classified with that line as its text instead
  of being treated as having no text (the `Attached:` line makes the body non-empty). The drafts
  test "the draft prompt carries 'Attached: 3 photos'" goes with that change.
