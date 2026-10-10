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
  other: "Something else",
};

export const isTrade = (v: unknown): v is Trade =>
  typeof v === "string" && (TRADES as readonly string[]).includes(v);

/** For <select>s. */
export const TRADE_OPTIONS = TRADES.map((value) => ({ value, label: tradeLabel[value] }));
