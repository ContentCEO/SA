import type { Trade } from "@/config/trades";

/**
 * Check 44 P1 + 45 P2: words a state's customers and officials use, keyed by trade (or "all").
 * Data only: the drafter is told to understand them and to mention a license or registration
 * only when the owner listed it in their profile.
 */
export type StatePrompt = {
  vocabulary: Partial<Record<Trade | "all", readonly string[]>>;
};
