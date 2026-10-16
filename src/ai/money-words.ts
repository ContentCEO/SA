/**
 * Every way a reply can name a price (review A1), as a pure finder shared by the draft checks
 * and autopilot's money test. "$1,450" was always caught; people (and models) also write
 * "1.2k", "twelve hundred", "a grand", "900 to 1100", "450/hr", "450 dollars" or a bare
 * "the swap is 1500".
 *
 * `strong` mentions are unmistakably money. A bare number after a word like "is" or "about"
 * is `weak`: it only counts as money when nothing else explains it (a unit, a time, a street).
 */

export type MoneyMention = { amount: number; strong: boolean };

const SMALL: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** Words after a number that make it something other than money. */
const UNIT =
  /^\s*(?:-\s*)?(?:%|°|percent|amps?|volts?|v\b|watts?|kw|kwh|btus?|tons?|gallons?|gal\b|gpm|psi|sq|square|ft|feet|foot|inch|inches|"|'|yards?|yds?|meters?|miles?|mi\b|lbs?|pounds?|years?|yrs?|months?|weeks?|days?|hours?|hrs?|minutes?|mins?|seconds?|am\b|pm\b|o'?clock|degrees?|st\b|nd\b|rd\b|th\b|series|model|people|units?|rooms?|windows?|doors?|outlets?|boards?|squares?|sheets?|pieces?|pcs|boxes|bags|rolls|circuits?|lights?|fixtures?|build|built|home|house|ranch|colonial|cape|split|times?|x\b|by\b|block|main|street|road|ave|avenue|lane|drive|way|court|place)/i;

const followsAsMoney = (text: string, end: number) => {
  const rest = text.slice(end);
  // A phone number, date, time or decimal goes on: "555-1234", "10/20", "9:30".
  if (/^[-/:.]\d/.test(rest) || /^\s?-\s?\d{3,4}\b/.test(rest)) return false;
  if (UNIT.test(rest)) return false;
  // "at 120 Elm St": a capitalised word straight after is a street or a name.
  if (/^\s+[A-Z][a-z]/.test(rest)) return false;
  return true;
};
const precededByDigitish = (text: string, start: number) =>
  /[\w$.,/:#-]$/.test(text.slice(0, start));

const num = (s: string) => Number(s.replace(/,/g, ""));

export function moneyMentions(raw: string): MoneyMention[] {
  const text = raw ?? "";
  const out: MoneyMention[] = [];
  const add = (amount: number, strong: boolean) => {
    if (Number.isFinite(amount) && amount > 0) out.push({ amount, strong });
  };

  // "$1,450", "$95.00", "$ 1.2k".
  for (const m of text.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)(\s?k\b)?/gi))
    add(num(m[1]!) * (m[2] ? 1000 : 1), true);
  // "450 dollars", "450 bucks".
  for (const m of text.matchAll(/\b(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars|bucks)\b/gi))
    add(num(m[1]!), true);
  // "1.2k", "5k" (not "10k BTU").
  for (const m of text.matchAll(/(\d{1,3}(?:\.\d{1,2})?)\s?k\b/gi)) {
    const start = m.index!;
    if (precededByDigitish(text, start)) continue;
    if (!followsAsMoney(text, start + m[0].length)) continue;
    add(Math.round(num(m[1]!) * 1000), true);
  }
  // "450/hr", "85 an hour", "12 per square foot".
  for (const m of text.matchAll(
    /(\d[\d,]*(?:\.\d{1,2})?)\s*(?:\/\s*(?:hr|hour|h|day|visit|sq\.? ?ft|sf|ft|foot)\b|(?:an|per|a) (?:hour|hr|day|visit|square foot|sq\.? ?ft|foot)\b)/gi,
  )) {
    if (precededByDigitish(text, m.index!)) continue;
    if (num(m[1]!) >= 10) add(num(m[1]!), true);
  }
  // "twelve hundred", "two thousand", "a grand", "a couple grand", "fifteen hundred".
  const word = `(?:(${Object.keys(TENS).join("|")})[- ]?(${Object.keys(SMALL)
    .slice(0, 9)
    .join("|")})?|(${Object.keys(SMALL).join("|")})|(a couple(?: of)?|couple|a few|a|an))`;
  for (const m of text.matchAll(new RegExp(`\\b${word}\\s+(hundred|thousand|grand)\\b`, "gi"))) {
    if (!followsAsMoney(text, m.index! + m[0].length)) continue;
    const n = m[1]
      ? TENS[m[1].toLowerCase()]! + (m[2] ? SMALL[m[2].toLowerCase()]! : 0)
      : m[3]
        ? SMALL[m[3].toLowerCase()]!
        : /couple/i.test(m[4]!)
          ? 2
          : /few/i.test(m[4]!)
            ? 3
            : 1;
    const scale = m[5]!.toLowerCase() === "hundred" ? 100 : 1000;
    // "a hundred" on its own is often a figure of speech; "a grand" never is.
    if (m[4] && scale === 100 && !/couple|few/i.test(m[4])) continue;
    add(n * scale, true);
  }
  // "900 to 1100", "1,200-1,500" (both 100 or more, the second bigger; never "2024-2025").
  for (const m of text.matchAll(
    /(\d{1,3}(?:,\d{3})+|\d{3,6})\s?(?:-|–|to)\s?\$?(\d{1,3}(?:,\d{3})+|\d{3,6})\b/gi,
  )) {
    if (precededByDigitish(text, m.index!)) continue;
    // "555-1234" is a phone number.
    if (/^\d{3}\s?-\s?\d{4}$/.test(m[0])) continue;
    const a = num(m[1]!);
    const b = num(m[2]!);
    if (!(b > a) || a < 100) continue;
    if (a >= 1900 && b <= 2100) continue;
    if (!followsAsMoney(text, m.index! + m[0].length)) continue;
    add(a, true);
    add(b, true);
  }
  // A bare number after a price word: "the swap is 1500 with the permit", "about 900".
  for (const m of text.matchAll(
    /\b(?:is|was|be|runs?|ran|costs?|price[ds]?|charge[sd]?|totals?|quoted?|for|about|around|roughly|approx(?:imately)?|ballpark|only|just|at|it's|its|that's|thats)\s+(?:(?:about|around|roughly|approximately|only|just|like)\s+)?(\d{1,3}(?:,\d{3})+|\d{2,6})(?:\.\d{2})?\b/gi,
  )) {
    const n = num(m[1]!);
    if (n < 50) continue;
    if (!followsAsMoney(text, m.index! + m[0].length)) continue;
    add(n, false);
  }
  return out;
}

/** The amounts, once each. */
export const moneyAmounts = (text: string) => [
  ...new Set(moneyMentions(text).map((m) => m.amount)),
];

/** Autopilot's money test (review A1): any way of naming a price at all. */
export function mentionsMoney(text: string): boolean {
  return /\$\s?\d/.test(text) || moneyMentions(text).length > 0;
}

/** Every number written in a text, for an owner's own instruction ("Thursday works, 450"). */
export function allNumbers(text: string | null | undefined): number[] {
  return [...(text ?? "").matchAll(/\d[\d,]*(?:\.\d{1,2})?/g)]
    .map((m) => num(m[0]))
    .filter((n) => Number.isFinite(n) && n > 0);
}
