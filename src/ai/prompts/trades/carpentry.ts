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
    // Check 37 P4 (wave 2): the owner knows about permits; ask for the town instead.
    "the town the job is in (for decks and structural work)",
    "when they'd like it done",
  ],
};
