import type { TradePrompt } from "./types";

export const plumbing: TradePrompt = {
  name: "plumbing",
  vocabulary: [
    "service call",
    "shutoff valve",
    "water heater (tank / tankless)",
    "gallons (40 / 50 gal)",
    "PEX vs. copper",
    "drain cleaning / snaking",
    "sewer line camera",
    "rough-in and trim-out",
    "backflow",
    "permit and inspection",
  ],
  quoteQuestions: [
    "the job address",
    "what's happening (leak, clog, no hot water, new install)",
    "photos of the fixture, pipe or water heater label",
    "age and size of the water heater, if it's involved",
    "whether water is actively leaking (and whether it's shut off)",
    "access: basement, crawlspace, slab",
    "whether a permit is involved",
  ],
};
