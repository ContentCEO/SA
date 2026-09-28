/**
 * The only place model IDs live.
 * Verified against the Anthropic model list on 2026-09-28.
 * `claude-haiku-4-5-20251001` is the dated snapshot of the `claude-haiku-4-5` alias.
 */
export const models = {
  /** Classification and extraction — cheap, fast. */
  classify: "claude-haiku-4-5-20251001",
  /** Drafting replies and learning the owner's voice. */
  draft: "claude-sonnet-5",
  voice: "claude-sonnet-5",
} as const;

export type ModelRole = keyof typeof models;
