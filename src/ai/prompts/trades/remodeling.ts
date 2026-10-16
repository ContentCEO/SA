import type { TradePrompt } from "./types";

/** Round 2 (TW D1): kitchens, baths, basements and additions — a general remodeler's words. */
export const remodeling: TradePrompt = {
  name: "remodeling",
  vocabulary: [
    "allowances and selections",
    "scope of work",
    "change order",
    "progress payments and lender draws",
    "lien waiver",
    "home improvement contract (HIC)",
    "construction supervisor license (CSL)",
    "demo, rough-in and finish",
    "permit and inspection",
    "punch list",
  ],
  quoteQuestions: [
    "the job address",
    "which rooms or areas, and what they want changed",
    "photos, and any plans or drawings they already have",
    "a rough budget range",
    "whether they'll be living there during the work",
    "when they'd like to start, and any date it must be done by",
    "the age of the house (before 1978 matters for lead paint)",
  ],
};
