/**
 * Squared Away Growth clients (2026-10-16): the pure rules behind /admin's "Growth clients"
 * card, the sign-in choice (/start) and the client's dashboard (/my-growth). No database, no
 * "server-only" (tests/unit/rules-purity.test.ts).
 *
 * Growth never uses inbox data (Davi's review, 2026-10-16; Google's Limited Use covers counts
 * from Gmail too): every number on the dashboard is one Davi entered after a monthly check-in.
 */
import { siteConfig } from "@/config/site";
import { atLocalHour, FALLBACK_TIME_ZONE, localParts, usableTimeZone } from "./snooze-rules";

const davi = siteConfig.operator.split(" ")[0]!;

/** "$4,500" / "$1,450.50": dollars from cents (kept here so Growth needs nothing from Quotes). */
export function formatCents(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export const GROWTH_STATUSES = ["active", "paused", "ended"] as const;
export type GrowthStatus = (typeof GROWTH_STATUSES)[number];

export const GROWTH_STATUS_LABEL: Record<GrowthStatus, string> = {
  active: "Active",
  paused: "Paused",
  ended: "Ended",
};

/** Who sees the dashboard and the sign-in choice: active and paused clients only. */
export const portalOpen = (status: string | null | undefined): boolean =>
  status === "active" || status === "paused";

export const GROWTH_MOVES = ["pause", "resume", "end"] as const;
export type GrowthMove = (typeof GROWTH_MOVES)[number];
export const isGrowthMove = (v: unknown): v is GrowthMove =>
  typeof v === "string" && (GROWTH_MOVES as readonly string[]).includes(v);

/** Where a move takes a client, or null when it isn't allowed from there. */
export function growthMoveTarget(from: GrowthStatus, move: GrowthMove): GrowthStatus | null {
  if (move === "pause") return from === "active" ? "paused" : null;
  if (move === "resume") return from === "paused" ? "active" : null;
  return from === "ended" ? null : "ended";
}

/** "Start Growth for this account" works for an account that isn't a client, or whose Growth ended. */
export const canStartGrowth = (existing: GrowthStatus | null | undefined): boolean =>
  !existing || existing === "ended";

// ---------------------------------------------------------------------------------------------
// Dates. Davi types start dates in Davi's own calendar (Eastern); the dashboard reads months in the
// client's time zone (growth_clients.time_zone, set by Davi; Eastern by default).

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** A real calendar date written YYYY-MM-DD. */
export function isCalendarDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d;
}

export const isMonthKey = (s: unknown): s is string => typeof s === "string" && MONTH.test(s);

/** Today's date in Davi's calendar (Eastern), for the admin forms. */
export const adminToday = (now: Date): string => localParts(now, FALLBACK_TIME_ZONE).date;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Start dates Davi may type: real dates from 2020 to a year ahead. */
export const EARLIEST_START = "2020-01-01";
export const START_DAYS_AHEAD = 366;
export function startDateOk(s: unknown, today: string): s is string {
  return isCalendarDate(s) && s >= EARLIEST_START && s <= addDays(today, START_DAYS_AHEAD);
}

/** Months Davi may enter numbers for: from 2020 up to the current month (Eastern). */
export function checkInMonthOk(s: unknown, today: string): s is string {
  return isMonthKey(s) && s >= EARLIEST_START.slice(0, 7) && s <= today.slice(0, 7);
}

/** The instant a calendar date begins (local midnight) in a time zone. DST-safe. */
export function localDayStart(date: string, timeZone: string): Date {
  const tz = usableTimeZone(timeZone);
  const noon = new Date(`${date}T12:00:00Z`);
  const seen = localParts(noon, tz).date;
  const offset = seen === date ? 0 : seen < date ? 1 : -1;
  return atLocalHour(noon, tz, offset, 0);
}

/** The owner's current month, 'YYYY-MM'. */
export const monthKeyOf = (now: Date, timeZone: string): string =>
  localParts(now, timeZone).date.slice(0, 7);

/** The last `n` months up to the given month, newest first: '2026-10', '2026-09', … */
export function recentMonths(month: string, n: number): string[] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    return d.toISOString().slice(0, 7);
  });
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** '2026-10' → "October 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1] ?? month} ${y}`;
}

/** '2026-10-01' → "Oct 1, 2026". */
export function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${(MONTHS[m - 1] ?? "").slice(0, 3)} ${d}, ${y}`;
}

// ---------------------------------------------------------------------------------------------
// Admin input.

export const GROWTH_TITLE_MAX = 80;
export const GROWTH_BODY_MAX = 2000;
export const GROWTH_NOTE_MAX = 280;
export const GROWTH_MAX_COUNT = 1_000_000;
/** $20,000,000: what fits the integer cents columns with room to spare. */
export const GROWTH_MAX_CENTS = 2_000_000_000;

const oneLine = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** An update: a one-line title (≤80) and text (≤2000, line breaks kept, at most one blank line). */
export function parseUpdate(
  title: unknown,
  body: unknown,
): { ok: true; title: string; body: string } | { ok: false } {
  const t = oneLine(title);
  const b =
    typeof body === "string"
      ? body
          .replace(/\r\n?/g, "\n")
          .split("\n")
          .map((l) => l.replace(/[^\S\n]+/g, " ").trim())
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim()
      : "";
  if (!t || t.length > GROWTH_TITLE_MAX || !b || b.length > GROWTH_BODY_MAX) return { ok: false };
  return { ok: true, title: t, body: b };
}

/** A whole number someone typed ("1,200"), blank = not entered. */
export function parseCount(v: unknown): number | null | "bad" {
  const s = typeof v === "string" ? v.replace(/[,\s]/g, "") : "";
  if (!s) return null;
  if (!/^\d+$/.test(s)) return "bad";
  const n = Number(s);
  return n <= GROWTH_MAX_COUNT ? n : "bad";
}

/** Dollars someone typed ("$1,450.50", "0"), as cents; blank = not entered. */
export function parseMoneyCents(v: unknown): number | null | "bad" {
  const s = typeof v === "string" ? v.replace(/[$,\s]/g, "") : "";
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return "bad";
  const cents = Math.round(Number(s) * 100);
  return cents <= GROWTH_MAX_CENTS ? cents : "bad";
}

/** The numbers Davi enters after a monthly check-in, in the order the forms and the dashboard use. */
export const CHECK_IN_FIELDS = [
  { key: "newLeads", form: "newLeads", label: "New leads", money: false },
  { key: "calls", form: "calls", label: "Calls", money: false },
  { key: "jobsWon", form: "jobsWon", label: "Jobs won", money: false },
  { key: "moneyWonCents", form: "moneyWon", label: "Money from jobs won ($)", money: true },
  { key: "reviewsGained", form: "reviewsGained", label: "Reviews gained", money: false },
  { key: "adSpendCents", form: "adSpend", label: "Ad spend ($)", money: true },
] as const;
export type CheckInKey = (typeof CHECK_IN_FIELDS)[number]["key"];
export type CheckInNumbers = Record<CheckInKey, number | null>;

/** One month's form: every number optional; a note of at most 280 characters. */
export function parseCheckIn(
  read: (field: string) => unknown,
): { ok: true; numbers: CheckInNumbers; note: string | null } | { ok: false; field: string } {
  const numbers = {} as CheckInNumbers;
  for (const f of CHECK_IN_FIELDS) {
    const v = f.money ? parseMoneyCents(read(f.form)) : parseCount(read(f.form));
    if (v === "bad") return { ok: false, field: f.form };
    numbers[f.key] = v;
  }
  const note = oneLine(read("note"));
  if (note.length > GROWTH_NOTE_MAX) return { ok: false, field: "note" };
  return { ok: true, numbers, note: note || null };
}

/** True when a month's form holds nothing at all (the month's row is then removed). */
export const checkInEmpty = (n: CheckInNumbers, note: string | null) =>
  !note && CHECK_IN_FIELDS.every((f) => n[f.key] === null);

// ---------------------------------------------------------------------------------------------
// The dashboard's numbers.

export type CheckInRow = CheckInNumbers & { month: string };
/** A sum over the months where that number was entered, and how many months that was. */
export type Summed = { value: number; months: number };
export type CheckInTotals = Record<CheckInKey, Summed | null>;

/** Add up check-in rows field by field; null when there are no rows at all. */
export function sumCheckIns(rows: readonly CheckInRow[]): CheckInTotals | null {
  if (rows.length === 0) return null;
  const out = {} as CheckInTotals;
  for (const f of CHECK_IN_FIELDS) {
    const entered = rows.map((r) => r[f.key]).filter((v): v is number => typeof v === "number");
    out[f.key] = entered.length
      ? { value: entered.reduce((a, b) => a + b, 0), months: entered.length }
      : null;
  }
  return out;
}

export type MetricKey = "money" | "newLeads" | "calls" | "jobsWon" | "reviewsGained" | "adSpend";
export type Metric = { key: MetricKey; label: string; value: string; source: string };

export const CHECK_IN_SOURCE = `From your monthly check-in with ${davi}`;
export const EMPTY_CHECK_IN = `${davi} adds these after your first monthly check-in.`;
export const EMPTY_CHECK_IN_MONTH = `${davi} adds this month's numbers after your monthly check-in.`;

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

function sourceLine(period: "since" | "month", s: Summed): string {
  return period === "month"
    ? `${CHECK_IN_SOURCE}.`
    : `From your monthly check-ins with ${davi} (${plural(s.months, "month", "months")}).`;
}

/**
 * One period's numbers ("since" Growth started, or this "month"): only what Davi entered after
 * the monthly check-ins, each with its source line. The money line comes first and says it's
 * what the client told Davi. A number nobody entered is left out — nothing is invented.
 */
export function periodMetrics(period: "since" | "month", checkIn: CheckInTotals | null): Metric[] {
  if (!checkIn) return [];
  const labels: Record<CheckInKey, [MetricKey, string]> = {
    moneyWonCents: [
      "money",
      period === "since"
        ? `Money from jobs you won since Growth started (as you told ${davi})`
        : `Money from jobs you won this month (as you told ${davi})`,
    ],
    newLeads: ["newLeads", "New leads"],
    calls: ["calls", "Calls"],
    jobsWon: ["jobsWon", "Jobs won"],
    reviewsGained: ["reviewsGained", "Reviews gained"],
    adSpendCents: ["adSpend", "Ad spend"],
  };
  const order: CheckInKey[] = [
    "moneyWonCents",
    "newLeads",
    "calls",
    "jobsWon",
    "reviewsGained",
    "adSpendCents",
  ];
  return order.flatMap((k) => {
    const s = checkIn[k];
    if (!s) return [];
    const money = k === "moneyWonCents" || k === "adSpendCents";
    const [key, label] = labels[k];
    return [
      {
        key,
        label,
        value: money ? formatCents(s.value) : count(s.value),
        source: sourceLine(period, s),
      },
    ];
  });
}

/** Time zones Davi can set for a client (their months on the dashboard). */
export const GROWTH_TIME_ZONES = [
  { value: "America/New_York", label: "Eastern" },
  { value: "America/Chicago", label: "Central" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Phoenix", label: "Arizona" },
  { value: "America/Los_Angeles", label: "Pacific" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
] as const;
export const isGrowthTimeZone = (v: unknown): v is string =>
  typeof v === "string" && GROWTH_TIME_ZONES.some((z) => z.value === v);

// ---------------------------------------------------------------------------------------------
// Emails. Content-free apart from Davi's own update title: nothing from the client's email.

export function growthUpdateEmailCopy(o: { title: string; dashboardUrl: string; phone: string }) {
  return {
    subject: "New update from Squared Away Growth",
    serif: "new update,",
    heavy: "from Squared Away Growth.",
    lines: [`${davi} posted an update for you: “${o.title}”`, "Read it on your Growth dashboard."],
    button: { label: "Open my Growth dashboard", url: o.dashboardUrl },
    footer: `Questions? Call or text ${davi} at ${o.phone}.`,
  };
}

export function growthInviteEmailCopy(o: { signInUrl: string; phone: string }) {
  return {
    subject: "Your Squared Away Growth dashboard",
    serif: "you're in,",
    heavy: "your Growth dashboard is ready.",
    lines: [
      `${davi} has set up your Squared Away Growth dashboard. Sign in with Google using this email address.`,
      `It shows the numbers from your monthly check-ins with ${davi}, and ${davi}'s updates on the work.`,
      "Signing in only shares your name and email address. It doesn't read your email or start anything else.",
    ],
    button: { label: "Sign in", url: o.signInUrl },
    footer: `Questions? Call or text ${davi} at ${o.phone}.`,
  };
}
