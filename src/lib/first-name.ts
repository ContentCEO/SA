/**
 * Check 14 P10: a person's first name from an email display name, carefully. Null when the
 * name isn't a person's (an address, a business, too long), so a sentence goes without a name
 * rather than say "Smith", "Dr." or "The". Pure.
 */
const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr"]);
const BUSINESS_WORDS = new Set([
  "llc",
  "inc",
  "co",
  "company",
  "supply",
  "depot",
  "dept",
  "department",
  "services",
  "office",
  "team",
  "support",
  "town",
  "city",
]);

export function firstNameOf(name: string | null | undefined): string | null {
  if (!name) return null;
  let s = name.trim().replace(/^["'\s]+|["'\s]+$/g, "");
  if (!s || s.includes("@")) return null;
  // "Last, First" → "First".
  const comma = s.indexOf(",");
  if (comma >= 0) s = s.slice(comma + 1).trim();
  let words = s.split(/\s+/).filter(Boolean);
  const bare = (w: string) => w.toLowerCase().replace(/[.,]/g, "");
  if (words.some((w) => BUSINESS_WORDS.has(bare(w)))) return null;
  if (words.length > 4) return null;
  while (words.length && TITLES.has(bare(words[0]!))) words = words.slice(1);
  return words[0] ?? null;
}
