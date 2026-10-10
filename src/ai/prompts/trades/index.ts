import type { Trade } from "@/config/trades";
import { carpentry } from "./carpentry";
import { electrical } from "./electrical";
import { hvac } from "./hvac";
import { landscaping } from "./landscaping";
import { other } from "./other";
import { painting } from "./painting";
import { plumbing } from "./plumbing";
import { roofing } from "./roofing";
import type { TradePrompt } from "./types";

/** Every trade must have a prompt file — the Record type makes a missing one a compile error. */
export const tradePrompts: Record<Trade, TradePrompt> = {
  carpentry,
  plumbing,
  electrical,
  hvac,
  roofing,
  painting,
  landscaping,
  other,
};

export function tradePromptFor(trade: string | null | undefined): TradePrompt {
  return (trade && tradePrompts[trade as Trade]) || other;
}

export type { TradePrompt };
