import type { TradePrompt } from "./types";

/**
 * Check 37 P4 / 41 P4 (wave 2): no trade file asks the customer whether a permit is involved —
 * the owner knows, the customer doesn't (a house cleaner was being asked it).
 */
export const other: TradePrompt = {
  name: "trade work",
  vocabulary: ["service call", "estimate", "change order", "punch list", "permit and inspection"],
  quoteQuestions: [
    "the job address",
    "what exactly they want done",
    "photos of the area or item",
    "when they'd like it done",
  ],
};
