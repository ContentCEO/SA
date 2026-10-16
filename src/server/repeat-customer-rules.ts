/**
 * Leads package (B14): "Repeat customer: …", one line on a card, as pure rules. What it claims
 * is exactly what the records show: "they said yes" only for a Won quote, "you quoted" only
 * when the owner gave a price or really wrote back, else "they asked about". No price shown.
 */
import { usableTimeZone } from "./snooze-rules";

export type RepeatKind = "won" | "quoted" | "asked";
const RANK: Record<RepeatKind, number> = { won: 3, quoted: 2, asked: 1 };

export type EarlierJob = { kind: RepeatKind; service: string | null; at: Date };

/** Won beats quoted beats asked; the newest within each. */
export function bestEarlier(jobs: readonly EarlierJob[]): EarlierJob | null {
  let best: EarlierJob | null = null;
  for (const j of jobs) {
    if (
      !best ||
      RANK[j.kind] > RANK[best.kind] ||
      (RANK[j.kind] === RANK[best.kind] && j.at > best.at)
    )
      best = j;
  }
  return best;
}

/** The kind of job, as words for the line: lower-cased, short, plain. */
export function serviceWords(s: string | null | undefined): string | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!t || t.length > 60 || /[@<>]|https?:/.test(t)) return null;
  return t;
}

/** "March", or "March 2025" when it isn't this year (the owner's time zone). */
export function monthWords(at: Date, now: Date, timeZone: string): string {
  const tz = usableTimeZone(timeZone);
  const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: tz }).format(at);
  const year = (d: Date) =>
    new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: tz }).format(d);
  return year(at) === year(now) ? month : `${month} ${year(at)}`;
}

export function repeatLine(job: EarlierJob, now: Date, timeZone: string): string {
  const when = monthWords(job.at, now, timeZone);
  const s = serviceWords(job.service);
  switch (job.kind) {
    case "won":
      return s
        ? `Repeat customer: they said yes to your quote for their ${s} in ${when}.`
        : `Repeat customer: they said yes to a quote from you in ${when}.`;
    case "quoted":
      return s
        ? `Repeat customer: you quoted their ${s} in ${when}.`
        : `Repeat customer: you quoted them in ${when}.`;
    case "asked":
      return s
        ? `Repeat customer: they asked about ${s} in ${when}.`
        : `Repeat customer: they asked you for a quote in ${when}.`;
  }
}
