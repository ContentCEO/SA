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
