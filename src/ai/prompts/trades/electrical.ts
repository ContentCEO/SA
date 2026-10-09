import type { TradePrompt } from "./types";

export const electrical: TradePrompt = {
  name: "electrical",
  vocabulary: [
    "panel upgrade",
    "service size (100 / 200 amp)",
    "breaker vs. fuse box",
    "GFCI / AFCI",
    "circuit and dedicated circuit",
    "EV charger",
    "rough-in and trim-out",
    "knob and tube",
    "permit and inspection",
    "callback",
  ],
  quoteQuestions: [
    "the job address",
    "what they want done (outlets, lights, panel, EV charger…)",
    "a photo of the panel with the door open",
    "current service size (100 or 200 amp), if they know",
    "age of the house",
    "access: attic, basement, finished walls",
    "whether a permit or inspection is involved",
  ],
};
