# Prompt lines waiting for the Prompt versions group

Wave 2 groups that may not write prompt files leave the exact prompt changes here. The Prompt
versions group (wave 2, `docs/BUILD-ORDER.md`) folds each into the next free version (after
wave 1: draft.v9, classify.v6, followup.v5, voice.v4; new prompts start at v1), extends
`tests/evals/cases.ts` for each, points `src/ai/prompts/registry.ts` at it, and deletes the item
here. The integrator keeps this file until it is empty.

## From `w2-settings` (Check 24 P11): voice notes (optional)

Check 43 P8's draft.v9 and followup.v5 parts are written (Prompt versions steps 2 and 4). Still
open, optional: with a ready voice and a null greeting / sign-off, the voice block prints "Usual
greeting: not given"; it could say "none — they jump straight in" / "none — they don't sign
off". That block is draft.v6's `workspaceBlock` (shared by every later version); changing its
wording means a new draft version, so it waits for the next one.
