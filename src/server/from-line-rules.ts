/**
 * Who a reply comes from, as the customer sees it (wave 2, "Mail format"). Pure: no database,
 * no `server-only`, so the queue card and the tests read the same rules.
 */

/** Check 43 P3: the longest name we put in a From line (the Settings field's limit too). */
export const FROM_NAME_MAX = 80;

/**
 * Check 43 P3: the name in the From line. The owner's own choice in Settings, else the Google
 * account name we got at sign-in, else the business name; null = the bare address.
 */
export function pickSenderName(p: {
  fromName?: string | null;
  userName?: string | null;
  businessName?: string | null;
}): string | null {
  for (const v of [p.fromName, p.userName, p.businessName]) {
    const n = (v ?? "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (n) return n.slice(0, FROM_NAME_MAX).trim();
  }
  return null;
}

/**
 * Check 42 P4: the address a reply goes out from. The first of Gmail's send-as addresses that
 * the customer's newest email was sent to (To, then Cc), so a customer who wrote to office@
 * hears back from office@. Anything else — no aliases read yet, an alias Gmail hasn't verified,
 * the customer wrote to the connected address — is the connected address.
 */
export function pickFromAddress(p: {
  mailboxEmail: string;
  sendAs: readonly string[] | null | undefined;
  to: readonly string[] | null | undefined;
  cc: readonly string[] | null | undefined;
}): string {
  const own = p.mailboxEmail.trim().toLowerCase();
  const allowed = new Set((p.sendAs ?? []).map((a) => a.trim().toLowerCase()));
  for (const a of [...(p.to ?? []), ...(p.cc ?? [])]) {
    const addr = a.trim().toLowerCase();
    if (addr === own) return p.mailboxEmail;
    if (allowed.has(addr) && !/[\r\n]/.test(addr)) return addr;
  }
  return p.mailboxEmail;
}
