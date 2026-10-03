/**
 * The only place model IDs and model prices live.
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
export type ModelId = (typeof models)[ModelRole];

/** US dollars per million tokens. Cache writes bill at 1.25x input, reads at 0.1x. */
export const modelPricing: Record<ModelId, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
};

/** Per-workspace daily ceiling on model calls, so a runaway loop can't run up the bill. */
export function dailyAiCallCap(): number {
  const n = Number(process.env.AI_DAILY_CALL_CAP ?? 500);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
}
