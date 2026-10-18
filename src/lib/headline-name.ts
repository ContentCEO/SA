/**
 * Check 13 P7: the serif line of a customer page's headline ("dana," over "every email."). The
 * first name, lowercased — but titles are skipped, "Last, First" gives First, and a company or a
 * name of three or more words is shown whole. No name: "this customer". The address is never
 * the headline. Pure.
 */
const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr"]);
const COMPANY_WORDS =
  /\b(llc|inc|group|property|properties|mgmt|management|supply|dept|department|town|city)\b/i;

export function headlineName(name: string | null | undefined, address?: string | null): string {
  void address;
  let n = (name ?? "").replace(/\s+/g, " ").trim();
  if (!n || n.includes("@")) return "this customer";
  if (COMPANY_WORDS.test(n)) return n.toLowerCase();
  // "O'Connor, Kevin" → "Kevin".
  if (n.includes(",")) {
    const [last, ...rest] = n.split(",");
    const first = rest.join(",").trim();
    n = first || (last ?? "").trim();
  }
  const words = n.split(" ").filter((w) => !TITLES.has(w.toLowerCase().replace(/\.$/, "")));
  if (!words.length) return "this customer";
  if (words.length >= 3) return words.join(" ").toLowerCase();
  return words[0]!.toLowerCase();
}
