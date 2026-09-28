import { modelPricing, type ModelId } from "@/config/models";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/** Estimated cost in hundredths of a cent (1 centicent = $0.0001). */
export function estimateCostCentiCents(model: ModelId, u: TokenUsage): number {
  const p = modelPricing[model];
  // $/MTok → centicents per token: $1/MTok = 1e4 centicents / 1e6 tokens = 0.01 centicents/token.
  const perIn = p.inputPerMTok * 0.01;
  const perOut = p.outputPerMTok * 0.01;
  const cost =
    u.inputTokens * perIn +
    u.cacheWriteTokens * perIn * 1.25 +
    u.cacheReadTokens * perIn * 0.1 +
    u.outputTokens * perOut;
  return Math.round(cost);
}
