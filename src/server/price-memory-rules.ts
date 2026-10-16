/**
 * Plan #15 price memory — the pure part. What the owner quoted before for a
 * similar kind of job, matched in code (never by the model): the owner sees
 * the figures on a quote-request draft and can tap one into a {{price}} gap.
 * Nothing here ever goes into a prompt.
 */
import { formatCents } from "./quote-rules";

/**
 * Words that don't say what the job is. Besides the plan's list, the everyday
 * verbs ("install", "replace", "repair", …) are dropped too, so "fan install" and
 * "water heater install" don't look alike just because both are installs.
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "for",
  "of",
  "to",
  "and",
  "my",
  "our",
  "new",
  "please",
  "quote",
  "estimate",
  "job",
  "work",
  "price",
  "pricing",
  "cost",
  "project",
  "install",
  "installation",
  "installing",
  "replace",
  "replacement",
  "replacing",
  "repair",
  "fix",
  "fixing",
  "service",
  "servicing",
]);

/** The words that say what the job is: lowercased, no stopwords, simple plurals folded, de-duped. */
export function serviceTokens(s: string): string[] {
  const out: string[] = [];
  for (const raw of (s ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    const word =
      raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    if (STOPWORDS.has(word)) continue;
    if (!out.includes(word)) out.push(word);
  }
  return out;
}

/** Two multi-word jobs must share at least this many job words to count as alike. */
export const MIN_SHARED_WORDS = 2;

/**
 * Overlap coefficient |A∩B| / min(|A|,|B|); 0 when either side has no job words.
 * When both sides have two or more job words, one shared word isn't enough (0):
 * it's usually a generic one — "kitchen faucet" vs "kitchen remodel", "lighting
 * upgrade" vs "panel upgrade" — and the owner would be offered a price for a very
 * different job. A one-word job still matches on its one word ("gutter").
 */
export function serviceSimilarity(a: string, b: string): number {
  const A = serviceTokens(a);
  const B = serviceTokens(b);
  if (!A.length || !B.length) return 0;
  const shared = A.filter((w) => B.includes(w)).length;
  if (shared < Math.min(MIN_SHARED_WORDS, A.length, B.length)) return 0;
  return shared / Math.min(A.length, B.length);
}

/** At or above this, two kinds of job count as similar. */
export const SIMILAR_AT = 0.5;
/** How many past prices the owner sees at most. */
export const PRICE_MEMORY_LIMIT = 3;

export type PastPrice = {
  service: string;
  amountCents: number;
  quotedAt: Date;
  threadId: string;
};

/**
 * The owner's past prices for jobs like `service`: similar enough, best match
 * first, then newest; never the thread being answered.
 */
export function similarPrices(
  service: string,
  history: PastPrice[],
  opts: { excludeThreadId?: string; limit?: number } = {},
): { amountCents: number; quotedAt: Date }[] {
  const limit = opts.limit ?? PRICE_MEMORY_LIMIT;
  return history
    .filter((h) => h.threadId !== opts.excludeThreadId && h.amountCents > 0)
    .map((h) => ({ h, score: serviceSimilarity(service, h.service) }))
    .filter((x) => x.score >= SIMILAR_AT)
    .sort((x, y) => y.score - x.score || y.h.quotedAt.getTime() - x.h.quotedAt.getTime())
    .slice(0, limit)
    .map(({ h }) => ({ amountCents: h.amountCents, quotedAt: h.quotedAt }));
}

const DEFAULT_ZONE = "America/New_York";

function inZone(timeZone: string, opts: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone });
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: DEFAULT_ZONE });
  }
}

/**
 * "$1,800" and "Mar" (in the owner's time zone) — with the year when it isn't
 * this year's, so last March's price doesn't read as this March's.
 */
export function priceMemoryLabel(
  p: { amountCents: number; quotedAt: Date },
  timeZone: string,
  now: Date = new Date(),
): { value: string; month: string } {
  const year = inZone(timeZone, { year: "numeric" });
  const month = inZone(timeZone, { month: "short" }).format(p.quotedAt);
  const sameYear = year.format(p.quotedAt) === year.format(now);
  return {
    value: formatCents(p.amountCents),
    month: sameYear ? month : `${month} ${year.format(p.quotedAt)}`,
  };
}
