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
/** "1.500" / "1.500,00" (Spanish and Portuguese thousands) or "1,500.00". */
const localeNum = (s: string) =>
  /^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(s)
    ? Number(s.replace(/\./g, "").replace(",", "."))
    : num(s.replace(/,(\d{1,2})$/, ".$1"));

/** A number written in words up to ninety-nine: "seven", "fifteen", "ninety-five". */
const ONES_ALT = Object.keys(SMALL).slice(0, 9).join("|");
const NUM_WORD = `(?:(?:${Object.keys(TENS).join("|")})(?:[- ](?:${ONES_ALT}))?|${Object.keys(SMALL).join("|")})`;
function wordValue(w: string | undefined): number {
  if (!w) return 0;
  const [a, b] = w.toLowerCase().split(/[- ]/);
  return (TENS[a!] ?? SMALL[a!] ?? 0) + (b ? (SMALL[b] ?? 0) : 0);
}

/** Spanish hundreds for "mil quinientos" (Check 20 P11). */
const ES_HUNDREDS: Record<string, number> = {
  cien: 100,
  ciento: 100,
  doscientos: 200,
  trescientos: 300,
  cuatrocientos: 400,
  quinientos: 500,
  seiscientos: 600,
  setecientos: 700,
  ochocientos: 800,
  novecientos: 900,
};
const ES_SMALL: Record<string, number> = {
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
};

/**
 * Words before a spoken price ("it's fourteen fifty"). For one to twelve ("nine thirty",
 * "twelve forty-five") a time reads the same, so only the clearly-price words count there.
 */
const PRICE_BEFORE =
  /\b(?:is|was|it's|its|that's|runs?|ran|costs?|for|about|around|roughly|ballpark|price(?: is)?|quote(?: is| was)?|charges?|total(?: is)?)\s+(?:(?:about|around|roughly|like|just|only)\s+)?$/i;
const PRICE_BEFORE_STRICT =
  /\b(?:runs?|ran|costs?|ballpark|price(?: is)?|quote(?: is| was)?|charges?|total(?: is)?)\s+(?:(?:about|around|roughly|like|just|only)\s+)?$/i;
const PRICE_AFTER =
  /^\s*(?:for (?:the|a|an|your)\b|installed\b|total\b|plus\b|all in\b|to come out\b|bucks\b|dollars\b)/i;

/**
 * Check 23 P1: money named without a number — "low four figures", "a few bucks", "a couple
 * hundred bucks". Each makes autopilot wait, and the draft check asks the owner about it.
 */
export function vagueMoney(text: string): string[] {
  return [
    ...(text ?? "").matchAll(
      /\b(?:low|mid|high)[- ](?:three|four|five|six)[- ]figures?\b|\ba few bucks\b|\b(?:a )?couple(?: of)? hundred bucks\b/gi,
    ),
  ].map((m) => m[0]);
}

export function moneyMentions(raw: string): MoneyMention[] {
  const text = raw ?? "";
  const out: MoneyMention[] = [];
  const add = (amount: number, strong: boolean) => {
    if (Number.isFinite(amount) && amount > 0) out.push({ amount, strong });
  };

  // "R$ 1.500,00" (Portuguese), before the plain "$" so it isn't read as "$ 1.50".
  for (const m of text.matchAll(/R\$\s?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?)/g))
    add(localeNum(m[1]!), true);
  // "$1,450", "$95.00", "$ 1.2k".
  for (const m of text.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)(\s?k\b)?/gi)) {
    if (text[m.index! - 1] === "R") continue;
    add(num(m[1]!) * (m[2] ? 1000 : 1), true);
  }
  // "€450", "£1,200" (Check 20 P11).
  for (const m of text.matchAll(/[€£]\s?(\d[\d,]*(?:\.\d{1,2})?)/g)) add(num(m[1]!), true);
  // "450 dollars", "450 bucks", "450 dólares", "1.500 reais" (Check 23 P1).
  for (const m of text.matchAll(
    /(?<![\w.,])(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars|bucks|d[óo]lares|reais|pesos|euros)(?![\p{L}])/giu,
  ))
    add(localeNum(m[1]!), true);
  // "ninety-five bucks", "fifty dollars" (Check 20 P11). Not the tail of a longer spoken
  // number ("fourteen fifty bucks" is read whole below).
  for (const m of text.matchAll(new RegExp(`\\b(${NUM_WORD})\\s+(?:bucks|dollars)\\b`, "gi"))) {
    if (new RegExp(`(?:${NUM_WORD}|hundred|thousand|buck)[- ]$`, "i").test(text.slice(0, m.index!)))
      continue;
    add(wordValue(m[1]), true);
  }
  // "3-4k", "3 to 4k": both ends are thousands (Check 23 P1). Not "model 3-4K".
  for (const m of text.matchAll(
    /(\d{1,3}(?:\.\d{1,2})?)\s?(?:-|–|to)\s?(\d{1,3}(?:\.\d{1,2})?)\s?k\b/gi,
  )) {
    const start = m.index!;
    if (precededByDigitish(text, start)) continue;
    if (/\b(?:model|part|series|item|no\.?|#|size)\s*$/i.test(text.slice(0, start))) continue;
    if (!followsAsMoney(text, start + m[0].length)) continue;
    const [a, b] = [num(m[1]!), num(m[2]!)];
    if (!(b > a)) continue;
    add(Math.round(a * 1000), true);
    add(Math.round(b * 1000), true);
  }
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
  // Check 36 P10: "seven hundred fifty" → 750, "two thousand five hundred" → 2500.
  const tail = `(?:,?\\s+(?:and\\s+)?(${NUM_WORD})\\s+hundred)?(?:,?\\s+(?:and\\s+)?(${NUM_WORD})(?!\\s+(?:hundred|thousand)))?`;
  for (const m of text.matchAll(
    new RegExp(`\\b${word}\\s+(hundred|thousand|grand)${tail}\\b`, "gi"),
  )) {
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
    const isGrand = m[5]!.toLowerCase() === "grand";
    const extra =
      isGrand || (scale === 100 && m[6])
        ? 0
        : (m[6] ? wordValue(m[6]) * 100 : 0) + (m[7] ? wordValue(m[7]) : 0);
    // "a hundred" on its own is often a figure of speech; "a grand" never is.
    if (m[4] && scale === 100 && !/couple|few/i.test(m[4]) && !extra) continue;
    add(n * scale + extra, true);
  }
  // "a hundred and a quarter" (125), "a hundred and a half" (150) (Check 20 P11).
  for (const m of text.matchAll(/\ba hundred and a (quarter|half)\b/gi))
    add(m[1]!.toLowerCase() === "quarter" ? 125 : 150, true);
  // "a buck fifty" (150).
  for (const m of text.matchAll(new RegExp(`\\ba buck[- ](${NUM_WORD})\\b`, "gi")))
    add(100 + wordValue(m[1]), true);
  // Spoken prices (Check 23 P1, Check 20 P11): "fourteen fifty", "twelve-fifty", "nineteen
  // ninety-nine", "one fifty to come out". Only with a price word before or after, so "twenty
  // twenty" or the time "nine thirty" never count.
  for (const m of text.matchAll(
    new RegExp(
      `\\b(${Object.keys(SMALL).join("|")})[- ]((?:${Object.keys(TENS).join("|")})(?:[- ](?:${ONES_ALT}))?)\\b(?!\\s+(?:hundred|thousand|grand)\\b)`,
      "gi",
    ),
  )) {
    const first = SMALL[m[1]!.toLowerCase()]!;
    const before = text.slice(0, m.index!);
    const after = text.slice(m.index! + m[0].length);
    const ok =
      PRICE_AFTER.test(after) ||
      (first > 12 ? PRICE_BEFORE.test(before) : PRICE_BEFORE_STRICT.test(before));
    if (!ok || /\b(?:a|the)\s+$/i.test(before)) continue;
    if (UNIT.test(after) && !PRICE_AFTER.test(after)) continue;
    add(first * 100 + wordValue(m[2]), true);
  }
  // "mil quinientos" (1500), "dos mil" with a price word (Check 20 P11).
  for (const m of text.matchAll(
    new RegExp(
      `\\b(?:(${Object.keys(ES_SMALL).join("|")})\\s+)?mil(?:\\s+(${Object.keys(ES_HUNDREDS).join("|")}))?\\b`,
      "gi",
    ),
  )) {
    const after = text.slice(m.index! + m[0].length);
    const before = text.slice(0, m.index!);
    if (
      !m[2] &&
      !/^\s*(?:d[óo]lares|pesos|reais)/i.test(after) &&
      !/\b(?:cuesta|cuestan|es|son|precio|custa|fica em)\s+$/i.test(before)
    )
      continue;
    add(
      (m[1] ? ES_SMALL[m[1].toLowerCase()]! : 1) * 1000 +
        (m[2] ? ES_HUNDREDS[m[2].toLowerCase()]! : 0),
      true,
    );
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
    /\b(?:is|was|be|runs?|ran|costs?|price[ds]?|charge[sd]?|totals?|quoted?|for|about|around|roughly|approx(?:imately)?|ballpark|only|just|at|it's|its|that's|thats|es|cuesta(?: unos)?|custa|fica em)\s+(?:(?:about|around|roughly|approximately|only|just|like)\s+)?(\d{1,3}(?:,\d{3})+|\d{2,6})(?:\.\d{2})?\b/gi,
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
  return /\$\s?\d/.test(text) || moneyMentions(text).length > 0 || vagueMoney(text).length > 0;
}

/** Every number written in a text, for an owner's own instruction ("Thursday works, 450"). */
export function allNumbers(text: string | null | undefined): number[] {
  return [...(text ?? "").matchAll(/\d[\d,]*(?:\.\d{1,2})?/g)]
    .map((m) => num(m[0]))
    .filter((n) => Number.isFinite(n) && n > 0);
}
