/**
 * Leads package (B4): which number the Call / Text buttons offer, as pure rules. Code only —
 * the AI never picks a number. Nothing here is stored or logged.
 */
import {
  findUsPhones,
  isCallableCustomerNumber,
  numberFromTextAddress,
  type E164,
} from "@/lib/phone-numbers";

export type ContactMessage = { subject: string | null; body: string | null };

/** The customer's own words: quoted replies ("On … wrote:", "> …") left out. */
export function ownWords(body: string): string {
  const out: string[] = [];
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const t = line.trim();
    if (/^On .+wrote:\s*$/.test(t) || /^-{2,}\s*Original Message\s*-{2,}/i.test(t)) break;
    if (t.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * The customer's number: an email-to-text gateway's own number first, then the newest email,
 * then up to two earlier ones; in each the subject first, then their own words. The owner's
 * own numbers and anything `isCallableCustomerNumber` refuses are skipped. Mail written by a
 * machine (a lead website, a no-reply sender) needs a labelled number ("Phone: …").
 */
export function customerPhone(c: {
  /** Newest first. */
  messages: readonly ContactMessage[];
  ownerNumbers: ReadonlySet<string>;
  machine: boolean;
  /**
   * A voicemail / text-message email's subject names the caller ("New voicemail from (508)
   * 555-1234"): its subject counts without a label, its body still needs one.
   */
  subjectNamesCaller?: boolean;
  textAddress?: string | null;
}): E164 | null {
  const ok = (n: string) => !c.ownerNumbers.has(n) && isCallableCustomerNumber(n);
  const fromAddress = numberFromTextAddress(c.textAddress);
  if (fromAddress && ok(fromAddress)) return fromAddress;
  for (const m of c.messages.slice(0, 3)) {
    const tries: [string, boolean][] = [
      [m.subject ?? "", c.machine && !c.subjectNamesCaller],
      [ownWords(m.body ?? ""), c.machine],
    ];
    for (const [text, labelledOnly] of tries) {
      const found = findUsPhones(text, { labelledOnly }).find(ok);
      if (found) return found;
    }
  }
  return null;
}

/** "Dana Ruiz" / "Ruiz, Dana" → "Dana"; nothing usable → null. */
export function firstNameOf(name: string | null | undefined): string | null {
  const s = (name ?? "").trim();
  if (!s || s.includes("@")) return null;
  const parts = s.includes(",") ? s.split(",").map((p) => p.trim()) : [s];
  const first = (parts.length > 1 ? parts[1]! : parts[0]!).split(/\s+/)[0] ?? "";
  return /^[A-Za-z][A-Za-z'’-]{0,29}$/.test(first) ? first : null;
}

/**
 * The text the owner's messages app opens with: "Hi Dana, this is Ruiz Plumbing. I got your
 * message." Parts drop out when missing. No promise, no price, no AI text.
 */
export function textPrefill(p: { firstName: string | null; businessName: string | null }): string {
  const hi = p.firstName ? `Hi ${p.firstName}, ` : "Hi, ";
  const who = p.businessName?.trim() ? `this is ${p.businessName.trim()}. ` : "";
  return `${hi}${who}I got your message.`;
}
