/**
 * The only place model IDs and model prices live.
 * `claude-haiku-4-5-20251001` is the dated snapshot of the `claude-haiku-4-5` alias.
 * Check 48 P2: each model's keep-until date is in `modelLifecycle` below, with the day it was
 * last checked against Anthropic's model deprecations page; tests/unit/model-lifecycle.test.ts
 * fails when a date is near or past and nobody has re-checked it (docs/SETUP.md "When Anthropic
 * emails about a model").
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
 * Check 48 P2: how long Anthropic says each pinned model stays. `notBefore` is the page's
 * "Tentative retirement date" ("Not sooner than …"), never a guess; `checkedOn` is the day
 * someone last read the page. A passed `notBefore` that was re-checked is fine (the model still
 * works, and Anthropic promises at least 60 days' notice by email before a retirement); a
 * forgotten one fails the lifecycle test. If a model ever shows no announced date, write that
 * plainly in `notBefore` ("none announced") rather than inventing one.
 */
export const MODEL_DEPRECATIONS_PAGE =
  "https://platform.claude.com/docs/en/about-claude/model-deprecations";
export const modelLifecycle: Record<
  ModelId,
  { notBefore: string; checkedOn: string; source: string }
> = {
  "claude-haiku-4-5-20251001": {
    notBefore: "2026-10-15",
    checkedOn: "2026-10-19",
    source: MODEL_DEPRECATIONS_PAGE,
  },
  "claude-sonnet-5": {
    notBefore: "2027-06-30",
    checkedOn: "2026-10-19",
    source: MODEL_DEPRECATIONS_PAGE,
  },
  "claude-haiku-5-5": {
    notBefore: "2027-10-07",
    checkedOn: "2026-10-19",
    source: MODEL_DEPRECATIONS_PAGE,
  },
  "claude-sonnet-5-5": {
    notBefore: "2027-09-28",
    checkedOn: "2026-10-19",
    source: MODEL_DEPRECATIONS_PAGE,
  },
};

/**
 * Check 48 P2: what each model accepts, so the request is built from the model and not from
 * comments. `effort`: whether `output_config.effort` may be sent (Haiku 4.5 rejects it).
 * `thinking`: what the request says about thinking — "omit" sends nothing (the model's own
 * default: none on Haiku 4.5, adaptive on Sonnet 5 and Sonnet 5.5), "disabled" sends
 * `{ type: "disabled" }`. Haiku 5.5 thinks by default (effort defaults to medium); a sorting trial
 * turns thinking off so the sorter's short answer limit holds (Haiku 5.5 accepts "disabled" at
 * effort high or below). Sonnet 5.5 refuses "disabled", so it stays "omit".
 */
export const modelCapabilities: Record<
  ModelId,
  { effort: boolean; thinking: "omit" | "disabled" }
> = {
  "claude-haiku-4-5-20251001": { effort: false, thinking: "omit" },
  "claude-sonnet-5": { effort: true, thinking: "omit" },
  "claude-haiku-5-5": { effort: true, thinking: "disabled" },
  "claude-sonnet-5-5": { effort: true, thinking: "omit" },
};

/** Check 48 P2: the only model ids `pnpm eval --model role=<id>` accepts. */
export const EVAL_MODEL_IDS: readonly ModelId[] = Object.keys(modelCapabilities) as ModelId[];

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

/**
 * Check 48 P4: how long one model call may take, so it ends inside the server's own limit (the
 * job route allows 300 s) and an owner's tap never hangs. Live sorting calls take about 2.5–10 s.
 * The SDK retries once (its default is twice, with a 10-minute timeout each).
 */
export const aiTimeouts = { interactiveMs: 45_000, jobMs: 90_000 } as const;
export const aiMaxRetries = 1;

const positiveCount = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * Daily ceiling on model calls per connected inbox (`AI_DAILY_CALL_CAP`, default 500), so a
 * runaway loop can't run up the bill. Check 29 P5: a shop's limit is this times its running
 * inboxes (at least one), up to `AI_DAILY_CALL_CAP_MAX` (default 3000).
 */
export function aiCallCapPerInbox(): number {
  return positiveCount(process.env.AI_DAILY_CALL_CAP, 500);
}
export function aiCallCapMax(): number {
  return positiveCount(process.env.AI_DAILY_CALL_CAP_MAX, 3000);
}
/** The day's limit for a shop with this many running inboxes. */
export function aiCallCapFor(runningInboxes: number): number {
  return Math.min(aiCallCapMax(), aiCallCapPerInbox() * Math.max(1, Math.floor(runningInboxes)));
}

/**
 * Check 29 P4: sorting may use at most this share of the day's limit, so a heavy first read
 * always leaves calls for drafts and voice learning. The overall limit is unchanged.
 */
export const SORT_SHARE = 0.8;
/** What sorting may use of a day's limit (at least one call). */
export function sortCallLimit(cap: number): number {
  return Math.max(1, Math.floor(cap * SORT_SHARE));
}

/** What a model call is for: sorting has its own share of the day's limit (Check 29 P4). */
export type AiPurpose = "sort" | "draft" | "voice" | "other";

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
