/**
 * Check 21 P4: an invoice the owner emails, found in code (no model call). Pure: no database, no
 * "server-only". Nothing here is logged; the result is one yes/no per email.
 */

/** How much of the owner's own words is read. */
export const OWNER_INVOICE_CHARS = 2_000;

/** "Fwd:", "Re: Fwd:", "FW:" — a forward is never the owner's own invoice. */
const FORWARD_SUBJECT = /^\s*((re|aw)\s*:\s*)*(fwd?|fw)\s*:/i;
/** "Invoice 1043", "invoice #1043", "Inv. 1043", "INV-1043", "Invoice no. A-77". */
const INVOICE_NUMBER =
  /\b(?:invoice|inv\.?)\s*(?:#|no\.?|number|num\.?)?\s*:?\s*#?\s*[a-z]{0,3}-?\d{2,}\b/i;
const INVOICE_WORD = /\binvoice\b/i;
const DOLLARS = /\$\s?\d[\d,]*(?:\.\d{2})?/;

/** The owner's new words: everything above the quoted reply ("On … wrote:", "> " lines). */
function ownWords(body: string): string {
  const out: string[] = [];
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const t = line.trim();
    if (/^On .+wrote:\s*$/.test(t) || /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(t))
      break;
    if (t.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").slice(0, OWNER_INVOICE_CHARS);
}

/**
 * The owner's email sends an invoice: its subject or the start of its own words names an
 * invoice number ("Invoice 1043 attached"), or says "invoice" with a dollar amount. Never a
 * forward. A customer's quoted "can you send the invoice for $400?" below the reply doesn't count.
 */
export function looksLikeOwnerInvoice(m: {
  subject: string | null;
  bodyText: string | null;
}): boolean {
  const subject = m.subject ?? "";
  if (FORWARD_SUBJECT.test(subject)) return false;
  const text = `${subject}\n${ownWords(m.bodyText ?? "")}`;
  if (INVOICE_NUMBER.test(text)) return true;
  return INVOICE_WORD.test(text) && DOLLARS.test(text);
}
