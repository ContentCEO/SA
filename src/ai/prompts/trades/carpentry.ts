import type { TradePrompt } from "./types";

export const carpentry: TradePrompt = {
  name: "carpentry",
  vocabulary: [
    "framing",
    "sub-floor",
    "load-bearing wall",
    "trim and finish carpentry",
    "built-ins",
    "deck and railing",
    "pressure-treated vs. composite",
    "punch list",
    "change order",
    "T&M vs. fixed price",
  ],
  quoteQuestions: [
    "the job address",
    "what they want built or repaired, with rough sizes",
    "photos of the area",
    "materials they have in mind (e.g. pressure-treated, composite, hardwood)",
    "whether any wall involved might be load-bearing",
    "whether a permit is needed (decks, structural work)",
    "when they'd like it done",
  ],
};
