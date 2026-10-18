import type { OpeningTweak } from "@/ai/prompts/opening-tweaks.v1";
import type { Tweak } from "@/ai/prompts/revise.v2";

/** Plan #3 chip labels. `Record<Tweak, …>` makes a tweak without a label a compile error. */
export const TWEAK_LABELS: Record<Tweak, string> = {
  shorter: "Shorter",
  warmer: "Warmer",
  formal: "More formal",
  photos: "Ask for photos",
  availability: "Add my availability",
};

/**
 * Replies package: "Other ways to reply" on a first reply to a new lead. Same words as
 * OPENING_TWEAKS' labels (a test keeps them equal); `Record<OpeningTweak, …>` makes a missing
 * label a compile error.
 */
export const OPENING_TWEAK_LABELS: Record<OpeningTweak, string> = {
  questions: "Ask a few questions",
  visit: "Offer to come take a look",
  short: "Short and friendly",
};
