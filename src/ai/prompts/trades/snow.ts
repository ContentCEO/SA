import type { TradePrompt } from "./types";

/**
 * Check 41 P3 (wave 2): snow plowing. A pre-season sign-up needs the driveway's size and surface,
 * the walks, salt, per push or a season price, and where the snow can go — none of which the
 * landscaping questions ask.
 */
export const snow: TradePrompt = {
  name: "snow plowing",
  vocabulary: [
    "plowing, per push or per season",
    "trigger depth (plow after 2 or 3 inches)",
    "salting and sanding",
    "shoveling walks and steps",
    "snow stakes",
    "piling and hauling",
    "roof rakes",
    "ice melt",
  ],
  quoteQuestions: [
    "the property address",
    "driveway length and width, paved or gravel",
    "walks, steps and paths to clear",
    "salt or sand wanted",
    "per push or a season price",
    "where snow can be piled",
    "anything to watch for (curbs, stone edges, a car that stays out)",
  ],
};
