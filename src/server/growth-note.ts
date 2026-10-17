/**
 * Squared Away Growth requests live in the existing `waitlist` table (no
 * migration while previews share the production database). Two conventions in
 * text columns carry them, and every reader goes through describeWaitlistEntry:
 *
 * - `team_size = "growth-only"`: the row exists only because of a Growth call
 *   request. The app form's team sizes can never produce this value.
 * - The note holds the app note (if any) and then ONE "[Growth call]" block, the
 *   newest request. A new request replaces the block before it; the app note
 *   before it is always kept.
 *
 * Pure (no "server-only") so tests and the admin page can use it.
 */

export const GROWTH_MARK = "[Growth call]";
export const GROWTH_ONLY_TEAM_SIZE = "growth-only";
/** Only the newest request per email is kept (Davi, 2026-10-12). */
export const MAX_GROWTH_BLOCKS = 1;

const PHONE_FORMAT = /^\d{3}-\d{3}-\d{4}$/;

export type GrowthRequest = {
  /** "YYYY-MM-DD HH:MM", America/New_York (see localStamp). */
  at: string;
  /** Service labels, e.g. "Google ads". */
  services: string[];
  /** "617-555-0142", or null when the stored line isn't in that form. */
  phone: string | null;
  nameGiven?: string | null;
  tradeGiven?: string | null;
  note?: string | null;
};

/** Any "[Growth call]" (any case or spacing) typed by a person becomes "(growth call)". */
export function scrubMarker(s: string): string {
  return s.replace(/\[\s*growth\s*call\s*\]/gi, "(growth call)");
}

/** Every run of whitespace (newlines too) becomes one space. */
export function collapseLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const stampFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "2026-10-12 14:05" in America/New_York. Strings in this form sort correctly as text. */
export function localStamp(date: Date): string {
  const p = Object.fromEntries(stampFormat.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-12 14:05" → "Oct 12, 2:05 PM" (for the admin page). Anything else comes back as is. */
export function formatStamp(stamp: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(stamp);
  if (!m) return stamp;
  const month = MONTHS[Number(m[2]) - 1];
  const h = Number(m[4]);
  if (!month || h > 23) return stamp;
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${month} ${Number(m[3])}, ${hour}:${m[5]} ${h < 12 ? "AM" : "PM"}`;
}

const PREFIX = {
  services: "Help with: ",
  phone: "Phone: ",
  nameGiven: "Name given: ",
  tradeGiven: "Trade given: ",
  note: "Note: ",
} as const;

/** One request as text. Every input is already a single line. */
export function formatGrowthBlock(r: {
  at: string | Date;
  services: readonly string[];
  phone: string | null;
  nameGiven?: string | null;
  tradeGiven?: string | null;
  note?: string | null;
}): string {
  const at = typeof r.at === "string" ? r.at : localStamp(r.at);
  return [
    `${GROWTH_MARK} ${at}`,
    `${PREFIX.services}${r.services.join(", ")}`,
    `${PREFIX.phone}${r.phone ?? ""}`,
    r.nameGiven ? `${PREFIX.nameGiven}${r.nameGiven}` : null,
    r.tradeGiven ? `${PREFIX.tradeGiven}${r.tradeGiven}` : null,
    r.note ? `${PREFIX.note}${r.note}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

function parseBlock(lines: string[]): GrowthRequest {
  const first = (prefix: string) => {
    const line = lines.find((l) => l.startsWith(prefix));
    return line === undefined ? null : line.slice(prefix.length).trim();
  };
  const phone = first(PREFIX.phone);
  return {
    at: lines[0]!.slice(GROWTH_MARK.length).trim(),
    services: (first(PREFIX.services) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    phone: phone && PHONE_FORMAT.test(phone) ? phone : null,
    nameGiven: first(PREFIX.nameGiven) || null,
    tradeGiven: first(PREFIX.tradeGiven) || null,
    note: first(PREFIX.note) || null,
  };
}

/** The app note (text before the first block) and the Growth requests, newest first. */
export function splitWaitlistNote(note: string | null | undefined): {
  appNote: string | null;
  growth: GrowthRequest[];
} {
  if (!note) return { appNote: null, growth: [] };
  const lines = note.split("\n");
  const starts = lines.flatMap((l, i) => (l.startsWith(GROWTH_MARK) ? [i] : []));
  const appNote =
    lines
      .slice(0, starts[0] ?? lines.length)
      .join("\n")
      .trim() || null;
  const growth = starts.map((start, k) => parseBlock(lines.slice(start, starts[k + 1])));
  return { appNote, growth };
}

/** The note from the first Growth block on (empty when there is none). */
export function growthBlocksText(note: string | null | undefined): string {
  if (!note) return "";
  const lines = note.split("\n");
  const start = lines.findIndex((l) => l.startsWith(GROWTH_MARK));
  return start < 0 ? "" : lines.slice(start).join("\n").trim();
}

/**
 * The Growth block text (from growthBlocksText) with its "Trade given" line set to `tradeGiven`,
 * or removed when null. Every other line is kept exactly as written.
 */
export function withBlockTradeGiven(blocks: string, tradeGiven: string | null): string {
  if (!blocks) return blocks;
  const lines = blocks.split("\n").filter((l) => !l.startsWith(PREFIX.tradeGiven));
  if (tradeGiven) {
    const line = `${PREFIX.tradeGiven}${collapseLine(tradeGiven)}`;
    const noteAt = lines.findIndex((l) => l.startsWith(PREFIX.note));
    lines.splice(noteAt < 0 ? lines.length : noteAt, 0, line);
  }
  return lines.join("\n");
}

const sameRequest = (a: GrowthRequest, b: Omit<GrowthRequest, "at">) =>
  a.phone === b.phone &&
  (a.note ?? null) === (b.note ?? null) &&
  a.services.join("\n") === b.services.join("\n");

/**
 * Add a request: it replaces the previous block (MAX_GROWTH_BLOCKS = 1). An identical resubmit
 * (same services, phone and note) leaves the note exactly as it was. The app note is kept.
 */
export function withGrowthBlock(note: string | null | undefined, request: GrowthRequest): string {
  const { appNote, growth } = splitWaitlistNote(note);
  if (note && growth[0] && sameRequest(growth[0], request)) return note;
  const blocks = [request, ...growth].slice(0, MAX_GROWTH_BLOCKS).map(formatGrowthBlock);
  return [appNote, ...blocks].filter(Boolean).join("\n\n");
}

/**
 * The note with every Growth block taken out (admin "Remove", Davi 2026-10-16): only the app
 * note before the first block is left (trimmed), or null when there was none.
 */
export function withoutGrowthBlocks(note: string | null | undefined): string | null {
  return splitWaitlistNote(note).appNote;
}

export type WaitlistEntryFacts = {
  teamSize: string | null;
  note: string | null;
  createdAt: Date;
};

/** The ONLY reader of the Growth conventions: what a waitlist row is. */
export function describeWaitlistEntry(row: WaitlistEntryFacts) {
  const { appNote, growth } = splitWaitlistNote(row.note);
  const created = localStamp(row.createdAt);
  const newest = growth[0]?.at;
  return {
    /** A real app sign-up (legacy and seeded rows with no team size count). */
    app: row.teamSize !== GROWTH_ONLY_TEAM_SIZE,
    growth,
    appNote,
    latestStamp: newest && newest > created ? newest : created,
  };
}
