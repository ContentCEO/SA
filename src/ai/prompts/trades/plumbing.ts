import type { TradePrompt } from "./types";

/**
 * Check 36 P8 (wave 2): the words eastern plumbers and their customers use daily, and quote
 * questions that never ask the customer whether a permit is involved (they can't know; in
 * Massachusetts nearly all plumbing and gas work needs one). Massachusetts-only words (Mass Save)
 * live in prompts/states/ma.ts.
 */
export const plumbing: TradePrompt = {
  name: "plumbing",
  vocabulary: [
    "service call",
    "shutoff valve",
    "water heater (tank / tankless / heat pump water heater)",
    "gallons (40 / 50 gal)",
    "boiler and indirect tank",
    "expansion tank",
    "T&P valve",
    "pressure reducing valve",
    "sump pump and ejector pump",
    "frost-free sillcock",
    "well pressure tank",
    "PEX vs. copper",
    "drain cleaning / snaking",
    "sewer line camera",
    "rough-in and trim-out",
    "RPZ / backflow test",
    "permit and inspection",
  ],
  quoteQuestions: [
    "the job address",
    "what's happening (leak, clog, no hot water, new install)",
    "photos of the fixture, pipe or water heater label",
    "age and size of the water heater, if it's involved",
    "for a water heater: gas, propane, oil or electric, and a photo of the vent pipe on top",
    "whether water is actively leaking (and whether it's shut off)",
    "town water or a well",
    "access: basement, crawlspace, slab",
    "whether they own the home, or who approves and pays (landlord, property manager, condo association)",
  ],
};
