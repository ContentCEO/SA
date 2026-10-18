/**
 * Pure rules for the Activity screen (outside review K1: lead with money, group the feed by
 * day). No database here; activity.ts gathers the rows.
 */
import { z } from "zod";
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

/**
 * Replies package (Davi, 2026-10-16: money in the morning email): this month so far, as the
 * morning email and Activity both say it. `won` = quotes marked won this month (the owner's
 * mark or our guess) from the owner's own quoted amount; `paid` = invoices on Money owed
 * marked paid this month (the owner's mark or our guess; never "Not owed to me", supplier
 * bills or receipts); `owed` = everything still open on Money owed right now, whenever it
 * was sent. Totals only — no names, subjects or customer details.
 */
export type MoneySoFar = {
  won: MoneyTally;
  paid: MoneyTally;
  owed: { count: number; cents: number };
};

/** The note under the totals, the same words Activity has always used for its money card. */
export const MONEY_SO_FAR_NOTE =
  "From your own quotes and the invoices on Money owed. Won and paid can be our guess — check Quotes and Money owed.";

const s = (n: number) => (n === 1 ? "" : "s");

/** "$4,200 in quotes you won (+1 with no amount we could see)", or null when there were none. */
function soFarPart(t: MoneyTally, what: "won" | "paid"): string | null {
  if (t.count === 0) return null;
  if (t.count === t.withoutAmount)
    return what === "won"
      ? `${t.count} quote${s(t.count)} won (no amounts we could see)`
      : `${t.count} invoice${s(t.count)} paid (no amounts we could see)`;
  const more = t.withoutAmount ? ` (+${t.withoutAmount} with no amount we could see)` : "";
  return what === "won"
    ? `${formatCents(t.cents)} in quotes you won${more}`
    : `${formatCents(t.cents)} in invoices paid${more}`;
}

/**
 * "This month so far: $4,200 in quotes you won · $1,800 in invoices paid." and "Still owed
 * to you: $3,050 on Money owed." Zero parts are left out; nothing at all when all are zero.
 */
export function moneySoFarLines(m: MoneySoFar): string[] {
  const parts = [soFarPart(m.won, "won"), soFarPart(m.paid, "paid")].filter(
    (p): p is string => !!p,
  );
  const owed =
    m.owed.cents > 0
      ? `Still owed to you: ${formatCents(m.owed.cents)} on Money owed.`
      : m.owed.count > 0
        ? `Still owed to you: ${m.owed.count} invoice${s(m.owed.count)} on Money owed (no amounts we could see).`
        : null;
  return [parts.length ? `This month so far: ${parts.join(" · ")}.` : null, owed].filter(
    (l): l is string => !!l,
  );
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

/**
 * Check 14 P6: Activity's "Show older" cursor, `?before=<iso>_<id>`. Anything that doesn't
 * parse is the first page; the query is always scoped to the owner's own workspace.
 */
const cursorSchema = z.object({ at: z.iso.datetime(), id: z.uuid() });

export function activityCursorParam(c: { at: Date; id: string }): string {
  return `${c.at.toISOString()}_${c.id}`;
}

export function parseActivityCursor(raw: unknown): { at: Date; id: string } | undefined {
  if (typeof raw !== "string" || raw.length > 100) return undefined;
  const i = raw.indexOf("_");
  if (i < 0) return undefined;
  const parsed = cursorSchema.safeParse({ at: raw.slice(0, i), id: raw.slice(i + 1) });
  return parsed.success ? { at: new Date(parsed.data.at), id: parsed.data.id } : undefined;
}
