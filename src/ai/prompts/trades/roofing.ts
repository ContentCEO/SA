import type { TradePrompt } from "./types";

export const roofing: TradePrompt = {
  name: "roofing",
  vocabulary: [
    "asphalt shingles / architectural shingles",
    "metal roof",
    "flat roof (EPDM / TPO)",
    "tear-off vs. layover",
    "squares",
    "pitch",
    "flashing",
    "ice and water shield",
    "gutters and fascia",
    "insurance claim / adjuster",
  ],
  quoteQuestions: [
    "the job address",
    "repair or full replacement",
    "whether it's leaking now (and where inside)",
    "roof material and roughly how old it is",
    "photos from the ground or inside the attic",
    "number of stories / how steep",
    "whether insurance is involved",
  ],
};
