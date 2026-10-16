import type { Tweak } from "@/ai/prompts/revise.v1";

/** Plan #3 chip labels. `Record<Tweak, …>` makes a tweak without a label a compile error. */
export const TWEAK_LABELS: Record<Tweak, string> = {
  shorter: "Shorter",
  warmer: "Warmer",
  formal: "More formal",
  photos: "Ask for photos",
  availability: "Add my availability",
};
