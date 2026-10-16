/**
 * The trades we serve. One list: the database enum, every form, the invite
 * script and the per-trade prompt files (src/ai/prompts/trades/) all read it.
 * "other" stays last.
 */
export const TRADES = [
  "carpentry",
  "plumbing",
  "electrical",
  "hvac",
  "roofing",
  "painting",
  "landscaping",
  "remodeling",
  "other",
] as const;
export type Trade = (typeof TRADES)[number];

export const tradeLabel: Record<Trade, string> = {
  carpentry: "Carpentry",
  plumbing: "Plumbing",
  electrical: "Electrical",
  hvac: "HVAC (heating & cooling)",
  roofing: "Roofing",
  painting: "Painting",
  landscaping: "Landscaping",
  remodeling: "Remodeling",
  other: "Something else",
};

export const isTrade = (v: unknown): v is Trade =>
  typeof v === "string" && (TRADES as readonly string[]).includes(v);

/** A shop's extra trades (round 2, TW A4): at most this many besides the main one. */
export const MAX_EXTRA_TRADES = 2;

/**
 * Extra trades as stored: real trades only, never "other" or the main trade, once each, at
 * most MAX_EXTRA_TRADES, in the list's own order.
 */
export function cleanExtraTrades(values: readonly unknown[], main: Trade | null): Trade[] {
  const picked = new Set(values.filter(isTrade));
  return TRADES.filter((t) => t !== "other" && t !== main && picked.has(t)).slice(
    0,
    MAX_EXTRA_TRADES,
  );
}

/** For <select>s. */
export const TRADE_OPTIONS = TRADES.map((value) => ({ value, label: tradeLabel[value] }));
