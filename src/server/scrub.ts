/**
 * Check 24 P4: the code-side guard on everything stored about the owner's voice (greeting,
 * sign-off, phrases, summary, sample replies). The prompt already asks for placeholders; these
 * named rules replace any email address, phone number, price or street address the model wrote
 * anyway. Pure: no database, no logging.
 *
 * Numbers that are labels stay: anything after "invoice", "inv", "#", "serial", "model", "part",
 * "permit", or glued to letters and a dash ("RH-1234567890"). The business's own phone numbers and
 * website (read from its signature) stay too.
 */

export type ScrubAllow = {
  /** Last 10 digits of phone numbers that may stay. */
  phones: string[];
  /** Lower-case host names (no "www.") whose URLs and email addresses may stay. */
  hosts: string[];
};

const NO_ALLOW: ScrubAllow = { phones: [], hosts: [] };

type Rule = {
  name: string;
  re: RegExp;
  token: "[email]" | "[phone]" | "[price]" | "[address]";
  /** Leave this match alone (labels, the business's own details). */
  keep?: (match: string, before: string, allow: ScrubAllow) => boolean;
};

const NUMBER_WORD =
  "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|a\\s+couple(?:\\s+of)?|a\\s+few)";
const NUM = "\\d[\\d,]*(?:\\.\\d+)?";
const STREET_SUFFIX =
  "(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Way|Blvd|Boulevard|Pl|Place|Ter|Terr|Terrace|Cir|Circle|Pkwy|Parkway|Sq|Square|Hwy|Highway)";
/** Words that never sit between a house number and its street suffix ("2 coats on the way"). */
const NOT_STREET_WORD =
  "(?!(?:the|a|an|on|of|in|to|for|by|at|and|or|more|my|your|our|their|this|that|these|those|all|other|same|whole|hours?|days?|weeks?|minutes?|coats?|times?)\\b)";
const STREET_WORD = `${NOT_STREET_WORD}[A-Za-z][\\w'.-]*`;
const US_STATES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
const LABEL_BEFORE =
  /(?:invoice|inv|serial|model|part|permit|order|ref|job|po)\s*(?:no\.?|number)?\s*[:#]?\s*$|#\s*$|[A-Za-z]+-$/i;

const digitsOf = (s: string) => s.replace(/\D/g, "");
const isLabel = (_m: string, before: string) => LABEL_BEFORE.test(before);
const ownPhone = (m: string, before: string, allow: ScrubAllow) =>
  isLabel(m, before) || allow.phones.includes(digitsOf(m).slice(-10));

export const SCRUB_RULES: Rule[] = [
  // Emails first, so their digits and dots aren't read as phones or prices.
  {
    name: "email",
    re: /[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g,
    token: "[email]",
    keep: (m, _b, allow) => allow.hosts.includes(m.split("@")[1]!.toLowerCase()),
  },
  {
    name: "email_spelled",
    re: /\b[\w.+-]+\s*(?:\(at\)|\[at\]|\bat\b)\s*[\w-]+(?:\s*(?:\(dot\)|\[dot\]|\bdot\b)\s*[\w-]+)*\s*(?:\(dot\)|\[dot\]|\bdot\b)\s*(?:com|net|org|edu|gov|us|co|io|biz|info|ca|me)\b/gi,
    token: "[email]",
  },
  // Phones: 10 or 11 digits with any separators (also inside wa.me / tel: links), then 7-digit
  // local numbers with a dash.
  {
    name: "phone",
    re: /(?<![\d])(?:\+?1[\s.-]?)?\(?\d{3}\)?(?:[\s.-]?\d){7}(?![\d])/g,
    token: "[phone]",
    keep: ownPhone,
  },
  {
    name: "phone_local",
    re: /(?<![\d-])\d{3}-\d{4}(?![\d-])/g,
    token: "[phone]",
    keep: ownPhone,
  },
  // Prices.
  {
    name: "price_dollar_sign",
    re: new RegExp(`\\$\\s?${NUM}(?:\\s?[kK]\\b)?|${NUM}\\s?\\$`, "g"),
    token: "[price]",
  },
  {
    name: "price_thousands",
    re: new RegExp(`(?<![\\w.])${NUM}\\s?[kK](?![\\w])`, "g"),
    token: "[price]",
  },
  {
    name: "price_words_after",
    re: new RegExp(`(?<![\\w.])${NUM}\\s*(?:bucks|dollars?|d[oó]lares|reais|usd|grand)\\b`, "gi"),
    token: "[price]",
  },
  {
    name: "price_rate",
    re: new RegExp(
      `(?<![\\w.])${NUM}\\s*(?:\\/\\s?(?:hr|hour|h|sq\\.?\\s?ft|sf|ft|lf)\\b|ea\\b|per\\s+(?:sq\\.?\\s?ft|square\\s+(?:foot|feet)|hour|hr|foot|ft)\\b)`,
      "gi",
    ),
    token: "[price]",
  },
  {
    name: "price_spelled",
    re: new RegExp(
      `\\b${NUMBER_WORD}(?:[\\s-]+${NUMBER_WORD})*\\s+(?:hundred|thousand|grand)(?:\\s+(?:bucks|dollars))?\\b`,
      "gi",
    ),
    token: "[price]",
  },
  // Addresses.
  {
    name: "po_box",
    re: /\bP\.?\s*O\.?\s*Box\s+\d+\b/gi,
    token: "[address]",
  },
  {
    name: "street_route",
    re: /\b\d{1,5}\s+(?:Route|Rte|Rt|Hwy|Highway|US)\.?\s*\d{1,4}[A-Za-z]?\b/gi,
    token: "[address]",
  },
  {
    name: "street",
    re: new RegExp(`\\b\\d{1,5}[A-Za-z]?\\s+(?:${STREET_WORD}\\s+){0,3}${STREET_SUFFIX}\\b`, "gi"),
    token: "[address]",
    keep: isLabel,
  },
  {
    name: "street_romance_number_first",
    re: /\b\d{1,5}\s*,?\s+(?:rue|calle|rua|avenida|av\.|chemin|boul\.|boulevard)\s+\p{Lu}[\p{L}'-]*(?:\s+\p{Lu}[\p{L}'-]*){0,3}/giu,
    token: "[address]",
  },
  {
    name: "street_romance_name_first",
    re: /\b(?:Calle|Rue|Rua|Avenida|Av\.)\s+(?:\p{Lu}[\p{L}'-]*\s+){1,4}(?:n[º°o]\.?\s*)?\d{1,5}\b/gu,
    token: "[address]",
  },
  {
    name: "unit",
    re: /\b(?:Unit|Apt|Apartment|Suite|Ste)\.?\s*#?\s*\d+[A-Za-z]?\b/gi,
    token: "[address]",
  },
  {
    name: "us_zip_after_state",
    re: new RegExp(`\\b(${US_STATES})\\.?,?\\s+\\d{5}(?:-\\d{4})?\\b`, "g"),
    token: "[address]",
  },
  {
    name: "canadian_postal_code",
    re: /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/g,
    token: "[address]",
  },
];

function applyRule(text: string, rule: Rule, allow: ScrubAllow): string {
  return text.replace(rule.re, (...args) => {
    const match = args[0] as string;
    const named = typeof args[args.length - 1] === "object";
    const offset = args[args.length - (named ? 3 : 2)] as number;
    if (rule.keep?.(match, text.slice(Math.max(0, offset - 24), offset), allow)) return match;
    return rule.token;
  });
}

/** Replace every email, phone, price and street address in one stored voice text. */
export function scrubText(text: string, allow: ScrubAllow = NO_ALLOW): string {
  let out = text;
  for (const rule of SCRUB_RULES) out = applyRule(out, rule, allow);
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

/** The business's own phone numbers and website hosts, read from its email signature. */
export function scrubAllowFrom(signature: string | null | undefined): ScrubAllow {
  if (!signature) return NO_ALLOW;
  const phones = [...signature.matchAll(/(?:\+?1[\s.-]?)?\(?\d{3}\)?(?:[\s.-]?\d){7}/g)].map((m) =>
    digitsOf(m[0]).slice(-10),
  );
  const hosts = [
    ...signature.matchAll(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi),
  ]
    .filter((m) => !m[0].includes("@") && !signature[(m.index ?? 0) - 1]?.match(/[@\w]/))
    .map((m) => m[1]!.toLowerCase());
  return { phones, hosts };
}
