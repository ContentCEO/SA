import type { TradePrompt } from "./types";

export const painting: TradePrompt = {
  name: "painting",
  vocabulary: [
    "interior / exterior",
    "prep (scraping, sanding, patching)",
    "primer",
    "finish (flat, eggshell, satin, semi-gloss)",
    "trim and doors",
    "cabinet painting",
    "power washing",
    "caulking",
    "lead-safe (pre-1978 homes)",
    "coats",
  ],
  quoteQuestions: [
    "the job address",
    "interior or exterior, and which rooms or sides",
    "rough size (rooms, ceiling height, or square feet)",
    "photos of the surfaces",
    "condition: peeling, stains, repairs needed",
    "colors chosen, and who supplies paint",
    "whether the home was built before 1978",
  ],
};
