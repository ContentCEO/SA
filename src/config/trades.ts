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

/**
 * Check 15 P11: the example under "What work do you take on?", one per trade, so a plumber
 * isn't shown an electrician's jobs. "other" keeps a general one.
 */
export const servicesExample: Record<Trade, string> = {
  carpentry: "Decks, trim and doors, stair repairs. No new framing.",
  plumbing: "Leaks, water heaters, drain clearing. No new construction.",
  electrical: "Service calls, panel upgrades, EV chargers. No new construction.",
  hvac: "Furnace and AC repair, heat pumps, tune-ups. No ductwork in new builds.",
  roofing: "Leak repairs, shingle roofs, gutters. No flat commercial roofs.",
  painting: "Interior rooms, exterior trim, cabinets. No commercial jobs.",
  landscaping: "Mowing, spring cleanups, patios. No tree removal.",
  remodeling: "Kitchens, bathrooms, basements. No additions.",
  other: "Repairs, installs, small jobs. No big projects.",
};

/** "“Leaks, water heaters…”" for a trade, or the general example. */
export function servicesExampleFor(trade: string | null | undefined): string {
  return servicesExample[isTrade(trade) ? trade : "other"];
}

/** For <select>s. */
export const TRADE_OPTIONS = TRADES.map((value) => ({ value, label: tradeLabel[value] }));

/**
 * Check 38 P3: trades where almost every job email names a big number. For these, setup shows
 * the "send me anything over" amount up front (not folded away), with suggested amounts. The
 * stored default stays the same for everyone ($2,500, `DEFAULT_AMOUNT_THRESHOLD_DOLLARS`).
 * The remodeling amounts are the review's examples, waiting on Davi's own numbers.
 */
export const AMOUNT_SUGGESTIONS: Partial<Record<Trade, readonly number[]>> = {
  remodeling: [10_000, 25_000],
};

/** The trades on this shop (main + extra) that want the amount asked up front, if any. */
export function amountSuggestionsFor(
  trade: string | null | undefined,
  extraTrades: readonly string[] = [],
): readonly number[] | null {
  for (const t of [trade, ...extraTrades]) {
    if (isTrade(t) && AMOUNT_SUGGESTIONS[t]) return AMOUNT_SUGGESTIONS[t]!;
  }
  return null;
}
