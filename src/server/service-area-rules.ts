/**
 * Leads package (B9): "Outside the towns you work in", as pure rules. The town is read in code
 * from the job address the classifier already extracts ("12 Elm St, Lowell, MA 01852" →
 * "Lowell, MA"), conservatively: no recognisable town, no line. Never sent anywhere (no map or
 * distance service), never stored apart from the address the thread already keeps.
 */

export const OUTSIDE_AREA_REASON = "Outside the towns you work in.";

const STATES =
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(
    " ",
  );
const STREET =
  /\b(st|street|rd|road|ave|avenue|ln|lane|dr|drive|ct|court|blvd|way|pl|place|ter|terrace|cir|circle|hwy|highway|pkwy|apt|unit|suite|ste)\.?$/i;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The town of a job address, "Town, ST" when the state is given, else "Town". Only from a
 * comma-separated address whose town part has no digits and doesn't look like a street.
 */
export function townFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address.slice(0, 200).split(",").map(clean).filter(Boolean);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1]!;
  const stateZip = /^([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/.exec(last);
  let town: string | undefined;
  let state: string | null = null;
  if (stateZip && STATES.includes(stateZip[1]!.toUpperCase())) {
    state = stateZip[1]!.toUpperCase();
    town = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  } else if (parts.length >= 2) {
    town = last;
  }
  if (!town || /\d/.test(town) || STREET.test(town) || town.length > 40) return null;
  if (!/^[A-Za-z][A-Za-z .'-]*$/.test(town)) return null;
  const pretty = town.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return state ? `${pretty}, ${state}` : pretty;
}

/** "Lowell, MA" → { name: "lowell", state: "ma" }; "St. Paul" → "saint paul". */
export function normalizeTown(t: string): { name: string; state: string | null } {
  const raw = clean(t.toLowerCase());
  const m = /^(.*?)(?:,\s*|\s+)([a-z]{2})$/.exec(raw);
  const hasState = !!m && STATES.includes(m[2]!.toUpperCase());
  const name = (hasState ? m![1]! : raw)
    .replace(/^st\.?\s+/, "saint ")
    .replace(/^mt\.?\s+/, "mount ")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { name, state: hasState ? m![2]! : null };
}

/** On the list: same town name, and the same state when both say one. */
export function townOnList(town: string, towns: readonly string[]): boolean {
  const t = normalizeTown(town);
  if (!t.name) return true;
  return towns.some((entry) => {
    const e = normalizeTown(entry);
    return e.name === t.name && (!e.state || !t.state || e.state === t.state);
  });
}

/**
 * The town to show when a quote request names one that isn't on the owner's list; null when
 * the list is empty, there's no town, or it's on the list.
 */
export function outsideArea(t: {
  category: string | null;
  address: string | null | undefined;
  towns: readonly string[];
}): string | null {
  if (t.category !== "quote_request" || t.towns.length === 0) return null;
  const town = townFromAddress(t.address);
  return town && !townOnList(town, t.towns) ? town : null;
}

/** A first suggestion for the towns list, from the free-text service area (never saved alone). */
export function suggestTowns(serviceArea: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (serviceArea ?? "").split(/[,\n;]+/)) {
    const t = clean(part);
    if (
      !t ||
      STATES.includes(t.toUpperCase()) ||
      /\d/.test(t) ||
      t.length > 60 ||
      /\b(and|area|surrounding|towns?|miles?)\b/i.test(t)
    )
      continue;
    const key = normalizeTown(t).name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.slice(0, 30);
}
