/**
 * US phone numbers found in an email's text (leads package, B4), in code only — never the AI.
 * Used for the Call / Text buttons, which are plain `tel:` / `sms:` links: the call or text
 * goes from the owner's own phone. Squared Away never calls or texts customers.
 */

/** "+15085551234". */
export type E164 = `+1${string}`;

const LABEL = /\b(phone|cell|mobile|tel|call|text|ph)\b|(^|\s)[cmt]:/i;
/**
 * Machine mail (a lead website's notice) names the customer's number on a field line —
 * "Phone: …", "Customer phone number: …" — while "Call us at …" is the site's own line.
 */
const FIELD_LABEL = /\b(phone|cell|mobile|tel|telephone)(\s+(number|no\.?|#))?\s*:/i;
/** (508) 555-1234, 508-555-1234, 508.555.1234, 508 555 1234, +1 508 555 1234, 1-508-555-1234. */
const FORMATTED =
  /(?<![\d+])(?:\+?1[\s.-]*)?(?:\((\d{3})\)\s*|(\d{3})[\s.-])(\d{3})[\s.-](\d{4})(?!\d)/g;
/** 5085551234 or 15085551234 — only after a label on the same line. */
const BARE = /(?<![\d+-])\+?1?(\d{3})(\d{3})(\d{4})(?![\d-])/g;

/**
 * Every US number in the text, in order, de-duplicated. Extensions are dropped. A bare run of
 * 10 digits counts only on a line with a label (phone, cell, mobile, tel, call, text, c:, m:);
 * with `labelledOnly`, every number needs a field label ("Phone: …"; mail written by a machine).
 */
export function findUsPhones(
  text: string,
  /**
   * `anyBare`: bare digit runs count without a label too — only for finding the OWNER's own
   * numbers to skip (skipping more is the safe side).
   */
  opts: { labelledOnly?: boolean; anyBare?: boolean } = {},
): E164[] {
  const out: E164[] = [];
  const add = (a: string, b: string, c: string) => {
    const e = `+1${a}${b}${c}` as E164;
    if (!out.includes(e)) out.push(e);
  };
  for (const line of text.slice(0, 20_000).split(/\r?\n/)) {
    const labelled = LABEL.test(line);
    if (opts.labelledOnly && !FIELD_LABEL.test(line)) continue;
    const found: { at: number; n: [string, string, string] }[] = [];
    for (const m of line.matchAll(FORMATTED))
      found.push({ at: m.index ?? 0, n: [m[1] ?? m[2]!, m[3]!, m[4]!] });
    if (labelled || opts.anyBare)
      for (const m of line.matchAll(BARE))
        found.push({ at: m.index ?? 0, n: [m[1]!, m[2]!, m[3]!] });
    found.sort((x, y) => x.at - y.at);
    for (const f of found) add(...f.n);
  }
  return out;
}

const TOLL_FREE = new Set(["800", "833", "844", "855", "866", "877", "888"]);

/**
 * A number worth offering as the customer's: a real-shaped US number (area code and exchange
 * start 2–9), not toll-free (a company's line), not an N11 code (911, 411…) and not a
 * 555-01xx number (reserved for fiction).
 */
export function isCallableCustomerNumber(e164: string): boolean {
  const m = /^\+1([2-9]\d{2})([2-9]\d{2})(\d{4})$/.exec(e164);
  if (!m) return false;
  const [, area, exchange, line] = m as unknown as [string, string, string, string];
  if (TOLL_FREE.has(area)) return false;
  if (area.slice(1) === "11" || exchange.slice(1) === "11") return false;
  if (exchange === "555" && line.startsWith("01")) return false;
  return true;
}

/**
 * The number an email-to-text gateway address carries: 5085551234@vtext.com. Only a local part
 * that is exactly the number (10 digits, or 11 starting with 1). Google Voice's own text
 * addresses carry two numbers and an id, so they are not read here (its subject names the
 * sender instead).
 */
export function numberFromTextAddress(address: string | null | undefined): E164 | null {
  const s = (address ?? "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at <= 0) return null;
  const m = /^1?(\d{10})$/.exec(s.slice(0, at));
  return m ? (`+1${m[1]}` as E164) : null;
}

/** "(508) 555-1234". */
export function formatUsPhone(e164: string): string {
  const d = e164.replace(/\D/g, "").slice(-10);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export const telHref = (e164: E164) => `tel:${e164}`;

/** Opens the phone's own messages app with the text filled in (iPhone and Android both read `?&body=`). */
export const smsHref = (e164: E164, body?: string) =>
  body ? `sms:${e164}?&body=${encodeURIComponent(body)}` : `sms:${e164}`;
