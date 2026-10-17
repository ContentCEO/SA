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

/**
 * Check 48 P3: an approved stand-in per role, used only when the role's model is missing (404 /
 * "model not available") or still overloaded (529) after the SDK's retries, at most once per
 * call. Anthropic models only, none of the 30-day-retention "Covered Models"
 * (tests/unit/data-paths.test.ts). Each stays OFF (`fallbackApproved: false`) until Davi has run
 * the prompt evals against it (`pnpm eval`) and switches it on here.
 */
export const modelFallbacks = {
  classify: { model: "claude-haiku-5-5", fallbackApproved: false },
  draft: { model: "claude-sonnet-5-5", fallbackApproved: false },
  voice: { model: "claude-sonnet-5-5", fallbackApproved: false },
} as const satisfies Record<ModelRole, { model: string; fallbackApproved: boolean }>;

export type ModelId = (typeof models)[ModelRole] | (typeof modelFallbacks)[ModelRole]["model"];

/**
 * US dollars per million tokens. Cache writes bill at 1.25x input, reads at 0.1x.
 * Haiku 5.5's price is for prompts up to 100K tokens (ours are far smaller).
 */
export const modelPricing: Record<ModelId, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
};

/** Per-workspace daily ceiling on model calls, so a runaway loop can't run up the bill. */
export function dailyAiCallCap(): number {
  const n = Number(process.env.AI_DAILY_CALL_CAP ?? 500);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
}

/**
 * Check 48 P7: where email text may go. Today every model call is one synchronous
 * `messages.create` request (src/ai/client.ts), which the privacy policy covers ("Where your
 * information goes" → Anthropic). Anthropic's Message Batches API stores jobs and results, and its
 * Files API keeps files until deleted, so neither may be used until this switch is turned on
 * together with a privacy-policy update and a TERMS_VERSION bump (src/config/legal.ts).
 * tests/unit/data-paths.test.ts enforces it.
 */
export const ALLOWED_DATA_PATHS = {
  /** Anthropic's Message Batches API (`messages.batches`). */
  batch: false,
  /** Anthropic's Files API (`files.upload`, `beta.files`). */
  files: false,
} as const;
