import type { TradePrompt } from "./types";

export const other: TradePrompt = {
  name: "trade work",
  vocabulary: ["service call", "estimate", "change order", "punch list", "permit and inspection"],
  quoteQuestions: [
    "the job address",
    "what exactly they want done",
    "photos of the area or item",
    "when they'd like it done",
    "whether a permit is involved",
  ],
};
