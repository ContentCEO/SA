import { z } from "zod";

/** Check 41 P4: "Which trade?" when someone picks "Another trade" / "Something else". */
export const TRADE_OTHER_MAX = 60;

/** One plain line: no newlines, tabs or angle brackets, spaces collapsed; "" reads as none. */
export function cleanTradeOther(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s || null;
}

/** The form field, optional; kept only when the trade is "other" (`tradeOtherFor`). */
export const tradeOtherField = z.preprocess(
  cleanTradeOther,
  z.string().max(TRADE_OTHER_MAX, `Keep it under ${TRADE_OTHER_MAX} characters.`).nullable(),
);

/** What gets stored: the typed name only for "other", never for a listed trade. */
export function tradeOtherFor(trade: string | null | undefined, typed: string | null | undefined) {
  return trade === "other" ? (typed ?? null) : null;
}
