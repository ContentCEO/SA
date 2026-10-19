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

## From `w2-settings` (Check 24 P11): voice notes (optional)

Check 43 P8's draft.v9 and followup.v5 parts are written (Prompt versions steps 2 and 4). Still
open, optional: with a ready voice and a null greeting / sign-off, the voice block prints "Usual
greeting: not given"; it could say "none — they jump straight in" / "none — they don't sign
off". That block is draft.v6's `workspaceBlock` (shared by every later version); changing its
wording means a new draft version, so it waits for the next one.
