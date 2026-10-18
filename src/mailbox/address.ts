/**
 * A plain email-address parser, shared by every provider (Check 47 P2: not Gmail's own).
 */

/** "Dana Ruiz <dana@x.com>, b@y.com" → [{name, email}] (lowercased emails). */
export function parseAddressList(value: string | undefined): { name?: string; email: string }[] {
  if (!value) return [];
  const out: { name?: string; email: string }[] = [];
  // Split on commas that are not inside quotes.
  for (const raw of value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const part = raw.trim();
    if (!part) continue;
    const angle = part.match(/^(.*)<([^>]+)>$/);
    if (angle) {
      const name = angle[1]!.trim().replace(/^"|"$/g, "").trim();
      out.push({ name: name || undefined, email: angle[2]!.trim().toLowerCase() });
    } else if (part.includes("@")) {
      out.push({ email: part.toLowerCase() });
    }
  }
  return out;
}
