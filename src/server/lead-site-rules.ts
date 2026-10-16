/**
 * Leads package (B2): the few facts a lead website's notice states on labelled lines, read in
 * code at render time, conservatively — a line that doesn't look exactly right gives nothing,
 * and the card falls back to the classifier's summary. Nothing here is stored or sent.
 *
 * Samples in tests/unit/leads-rules.test.ts are invented in the shape these notices take
 * ("Customer: …", "Location: …"); real samples (Waiting on Davi) may add subject patterns.
 */

export type LeadSiteFacts = {
  customerName: string | null;
  service: string | null;
  town: string | null;
};

const NAME_LABEL = /^(?:customer(?:\s+name)?|name|client|homeowner|from)\s*:\s*(.+)$/i;
const SERVICE_LABEL =
  /^(?:service(?:\s+requested)?|job(?:\s+type)?|project(?:\s+type)?|category|request(?:ed)?|type of work)\s*:\s*(.+)$/i;
const TOWN_LABEL = /^(?:location|city|town|job location|project location|area)\s*:\s*(.+)$/i;

/** "Dana R." / "Dana Ruiz" / "Dana" — letters, at most three words, no digits or @. */
function cleanName(s: string): string | null {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length > 40 || /[@\d<>]/.test(t)) return null;
  return /^[A-Za-z][A-Za-z'’-]*(?: [A-Za-z][A-Za-z'’.-]*){0,2}$/.test(t) ? t : null;
}

function cleanService(s: string): string | null {
  const t = s.replace(/\s+/g, " ").trim();
  if (!t || t.length > 60 || /[@<>]|https?:/i.test(t)) return null;
  return /^[A-Za-z0-9][A-Za-z0-9 ,&/()'’+-]*$/.test(t) ? t : null;
}

/** "Lowell, MA", "Lowell, MA 01852", "Lowell MA" → "Lowell, MA"; a street address gives null. */
function cleanTown(s: string): string | null {
  const t = s.replace(/\s+/g, " ").trim();
  const m = /^([A-Za-z][A-Za-z .'-]{1,38}?),?\s+([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/.exec(t);
  if (!m) return null;
  const town = m[1]!.trim();
  return /\d/.test(town) ? null : `${town}, ${m[2]}`;
}

export function parseLeadSite(m: { subject: string | null; body: string | null }): LeadSiteFacts {
  const facts: LeadSiteFacts = { customerName: null, service: null, town: null };
  const lines = `${m.subject ?? ""}\n${m.body ?? ""}`.slice(0, 8_000).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/^[\s*•-]+/, "").trim();
    let x: RegExpExecArray | null;
    if (!facts.customerName && (x = NAME_LABEL.exec(line))) facts.customerName = cleanName(x[1]!);
    else if (!facts.service && (x = SERVICE_LABEL.exec(line))) facts.service = cleanService(x[1]!);
    else if (!facts.town && (x = TOWN_LABEL.exec(line))) facts.town = cleanTown(x[1]!);
  }
  return facts;
}
