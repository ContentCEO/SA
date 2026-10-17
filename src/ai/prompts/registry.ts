/**
 * Check 50 P2: the prompt version each kind uses today, in one place. Prompts are versioned with
 * one new file per change (`<kind>.v<N>.ts`, constant `"<kind>.v<N>"`); a new version is a new
 * file plus one line here. tests/unit/prompt-versions.test.ts checks that each file's constant
 * matches its name, that no two files share a version, that versions have no gaps, that ACTIVE
 * names the newest file of each kind, and that the code which records a version imports it from
 * that file.
 *
 * Before writing a new version, check docs/BUILD-ORDER.md (and docs/notes/) for which review
 * prompts belong in it, so each version is written once.
 */
import { CLASSIFY_PROMPT_VERSION } from "./classify.v5";
import { DRAFT_PROMPT_VERSION } from "./draft.v8";
import { EDIT_TONE_PROMPT_VERSION } from "./edit-tone.v1";
import { FOLLOWUP_PROMPT_VERSION } from "./followup.v4";
import { OPENING_TWEAKS_PROMPT_VERSION } from "./opening-tweaks.v1";
import { PURPOSE_PROMPT_VERSION } from "./purpose.v2";
import { REVISE_PROMPT_VERSION } from "./revise.v2";
import { VOICE_PROMPT_VERSION } from "./voice.v2";

export const ACTIVE = {
  classify: CLASSIFY_PROMPT_VERSION,
  draft: DRAFT_PROMPT_VERSION,
  followup: FOLLOWUP_PROMPT_VERSION,
  voice: VOICE_PROMPT_VERSION,
  revise: REVISE_PROMPT_VERSION,
  purpose: PURPOSE_PROMPT_VERSION,
  editTone: EDIT_TONE_PROMPT_VERSION,
  /** "Other ways to reply" asks, run through revise (stored as `revise.vN+opening-tweaks.vN`). */
  openingTweaks: OPENING_TWEAKS_PROMPT_VERSION,
} as const;

export type PromptKind = keyof typeof ACTIVE;
