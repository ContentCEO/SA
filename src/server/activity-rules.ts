/**
 * Pure rules for the Activity screen (outside review K1: lead with money, group the feed by
 * day). No database here; activity.ts gathers the rows.
 */
import { formatCents } from "./quote-rules";
import { usableTimeZone } from "./snooze-rules";

/** A sum where some items had no amount we could see. */
export type MoneyTally = { count: number; cents: number; withoutAmount: number };

export type MonthMoney = {
  /** Quotes marked won this month (by the owner, or our guess the owner left alone). */
  won: MoneyTally;
  /** Invoices marked paid this month after a follow-up nudge on them was sent. */
  paidAfterNudge: MoneyTally;
};

/** Count and add up amounts in cents; a missing or non-positive amount is counted, not added. */
export function tally(amounts: (number | null | undefined)[]): MoneyTally {
  let cents = 0;
  let withoutAmount = 0;
  for (const a of amounts) {
    if (typeof a === "number" && Number.isFinite(a) && a > 0) cents += Math.round(a);
    else withoutAmount++;
  }
  return { count: amounts.length, cents, withoutAmount };
}

/** Invoice amounts are read in dollars; the tally is in cents. */
export function dollarsToCents(dollars: number | null | undefined): number | null {
  return typeof dollars === "number" && Number.isFinite(dollars) && dollars > 0
    ? Math.round(dollars * 100)
    : null;
}

/** "3 · $4,200 (1 more without an amount we could see)", or "None yet". */
export function tallyText(t: MoneyTally): string {
  if (t.count === 0) return "None yet";
  const known = t.count - t.withoutAmount;
  if (known === 0) return `${t.count} · no amounts we could see`;
  const more = t.withoutAmount ? ` (${t.withoutAmount} more without an amount we could see)` : "";
  return `${t.count} · ${formatCents(t.cents)}${more}`;
}

export function moneyIsEmpty(m: MonthMoney): boolean {
  return m.won.count === 0 && m.paidAfterNudge.count === 0;
}

export type DayGroup<T> = { key: string; label: string; entries: T[] };

/** The owner's calendar date (YYYY-MM-DD) for an instant. */
function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** The calendar date one day before a YYYY-MM-DD date. */
function dayBefore(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Split a newest-first feed into the owner's days: "Today", "Yesterday", then
 * "Monday, Oct 13" (with the year when it isn't this year). Order is kept.
 */
export function groupByDay<T extends { at: Date }>(
  entries: T[],
  now: Date,
  timeZone: string,
): DayGroup<T>[] {
  const tz = usableTimeZone(timeZone);
  const today = localDate(now, tz);
  const yesterday = dayBefore(today);
  const groups: DayGroup<T>[] = [];
  for (const e of entries) {
    const key = localDate(e.at, tz);
    let g = groups.at(-1);
    if (!g || g.key !== key) {
      const label =
        key === today
          ? "Today"
          : key === yesterday
            ? "Yesterday"
            : e.at.toLocaleDateString("en-US", {
                timeZone: tz,
                weekday: "long",
                month: "short",
                day: "numeric",
                ...(key.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
              });
      g = { key, label, entries: [] };
      groups.push(g);
    }
    g.entries.push(e);
  }
  return groups;
}
