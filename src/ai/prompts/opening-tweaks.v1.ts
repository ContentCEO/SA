/**
 * "Other ways to reply" (replies package, 2026-10-16): three fixed rewrites offered on a first
 * reply to a new lead (a draft.v7 draft whose `opening` is a first-contact shape). They run
 * through the ordinary revise flow — revise.v2's instructions, schema, checks and limits
 * (5 per draft, 40 an hour) — with these asks in place of a tweak chip's. The owner taps one,
 * reads the new version, and nothing is sent. Logged as `revise.v2+opening-tweaks.v1`.
 */
export const OPENING_TWEAKS_PROMPT_VERSION = "opening-tweaks.v1";

export const OPENING_TWEAKS = {
  questions: {
    label: "Ask a few questions",
    ask: "Rewrite it as a warm first reply that thanks them and asks two or three short, simple questions about the job — only what's missing from their email (the business block's \"Before quoting, find out\" list helps). Never ask for anything they already told you. No price, day or time.",
  },
  visit: {
    label: "Offer to come take a look",
    ask: "Rewrite it as a warm first reply that thanks them and offers to come out and take a look in person. Don't name a day, a date or a time — ask what works for them, or leave a {{date}} gap. Ask for the job's address if they didn't give it. No price unless it's on the price list exactly as written.",
  },
  short: {
    label: "Short and friendly",
    ask: "Rewrite it as a short, friendly first reply: two or three sentences in the owner's voice, thanking them and asking the one question that matters most to move the job forward. No price, day or time that isn't already in the draft.",
  },
} as const;
export type OpeningTweak = keyof typeof OPENING_TWEAKS;
export const isOpeningTweak = (v: unknown): v is OpeningTweak =>
  typeof v === "string" && Object.hasOwn(OPENING_TWEAKS, v);
