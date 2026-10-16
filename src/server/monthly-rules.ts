/**
 * Plan #35 (and M8 A11): the monthly summary's labels, as pure rules. What the customer
 * wrote and who they are never come out of here: a kind of job is one of OUR fixed labels
 * (src/config/job-kinds.ts) and a lead source is one of OUR fixed labels
 * (src/config/lead-sources.ts). Only labels and counts are returned.
 */
import { JOB_KINDS, OTHER_JOB_KIND } from "@/config/job-kinds";
import { DIRECT_EMAIL, LEAD_SOURCES } from "@/config/lead-sources";
import { isTrade, type Trade } from "@/config/trades";
import { siteConfig } from "@/config/site";
import { localMonthStart, localParts, usableTimeZone } from "./snooze-rules";

/** Lowercase words separated by single spaces ("Built-in" → "built in"); "/" is kept for "a/c". */
export function normalizeWords(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, " ")
    .trim();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Longest service text looked at (the model's field is short; this bounds the work). */
const MAX_SERVICE_CHARS = 500;

/**
 * The kind of job as a fixed label for the owner's trade: whole-word keyword match (a
 * trailing "s"/"es" is fine), first kind in the list wins, else OTHER_JOB_KIND. Never
 * returns any of the input text.
 */
export function jobKindOf(trade: Trade | null, service: string | null): string {
  if (!service) return OTHER_JOB_KIND;
  const text = ` ${normalizeWords(service.slice(0, MAX_SERVICE_CHARS))} `;
  if (!text.trim()) return OTHER_JOB_KIND;
  const kinds = JOB_KINDS[trade && isTrade(trade) ? trade : "other"];
  for (const kind of kinds) {
    for (const kw of kind.keywords) {
      const word = normalizeWords(kw);
      if (word && new RegExp(` ${escape(word)}(?:s|es)? `).test(text)) return kind.label;
    }
  }
  return OTHER_JOB_KIND;
}

/**
 * Where a lead came from, as a fixed label. Takes a sender address or just its domain
 * (the monthly query passes only the domain, so no address reaches the app's code there).
 * A domain matches itself and its subdomains, except `exact` entries; else DIRECT_EMAIL.
 */
export function leadSourceOf(fromAddressOrDomain: string | null): string {
  return leadPlatformOf(fromAddressOrDomain) ?? DIRECT_EMAIL;
}

/**
 * The lead platform (Thumbtack, Angi…) an address or domain belongs to, or null. Same domain
 * rule as `leadSourceOf`. Also used at sync: a platform's relay Reply-To
 * (reply+8x2k@messages.thumbtack.com) is never taken as the customer's own address.
 */
export function leadPlatformOf(addressOrDomain: string | null | undefined): string | null {
  if (!addressOrDomain) return null;
  const raw = addressOrDomain.trim().toLowerCase();
  const host = (raw.includes("@") ? raw.slice(raw.lastIndexOf("@") + 1) : raw)
    .replace(/[>\s]+$/, "")
    .replace(/\.$/, "");
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  for (const source of LEAD_SOURCES) {
    for (const d of source.domains) {
      if (host === d || (!source.exact && host.endsWith(`.${d}`))) return source.label;
    }
  }
  return null;
}

/** The n most common labels with their counts: most first, then alphabetical. */
export function topCounts(labels: string[], n = 3): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .slice(0, Math.max(0, n));
}

/* ------------------------------------------------------------------------------------------
 * Plan #35: the first-of-month summary email.
 * ---------------------------------------------------------------------------------------- */

/**
 * The owner's month that just ended: [start, end) from midnight on the 1st to midnight on
 * the next 1st, in their time zone (DST-safe), and its 'YYYY-MM' key.
 */
export function previousMonth(
  now: Date,
  timeZone: string,
): { start: Date; end: Date; key: string } {
  const tz = usableTimeZone(timeZone);
  const end = localMonthStart(now, tz);
  const start = localMonthStart(new Date(end.getTime() - 1), tz);
  return { start, end, key: localParts(start, tz).date.slice(0, 7) };
}

/**
 * Due once a month, for the month just ended: on the owner's local 1st at or after their
 * morning-summary hour, or on the 2nd or 3rd at or after that hour if the 1st was missed
 * (never in the middle of the night, A15). Follows the morning summary's on/off switch.
 */
export function monthlyDue(
  s: {
    digestEnabled: boolean;
    digestHour: number;
    timeZone: string;
    monthlySummaryLastSentFor: string | null;
  },
  now: Date,
): { due: boolean; monthKey: string } {
  const tz = usableTimeZone(s.timeZone);
  const { date, hour } = localParts(now, tz);
  const day = Number(date.slice(8, 10));
  const monthKey = previousMonth(now, tz).key;
  return {
    due:
      s.digestEnabled &&
      day >= 1 &&
      day <= 3 &&
      hour >= s.digestHour &&
      s.monthlySummaryLastSentFor !== monthKey,
    monthKey,
  };
}

/** A month in counts and OUR fixed labels — nothing a customer wrote, nobody's address. */
export type MonthlyStats = {
  quoteRequests: number;
  jobKinds: { label: string; count: number }[];
  leadSources: { label: string; count: number }[];
  repeatCustomers: number;
  won: number;
  lost: number;
  noAnswer: number;
  ratePct: number | null;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const counted = (xs: { label: string; count: number }[]) =>
  xs.map((x) => `${x.label} (${x.count})`).join(", ");

/** The summary's lines, in order. Fixed words, our labels and numbers only. */
export function monthlyLines(s: MonthlyStats): string[] {
  const decided = s.won + s.lost + s.noAnswer;
  return [
    s.quoteRequests
      ? `${plural(s.quoteRequests, "quote request")}.`
      : "No quote requests came in by email.",
    s.quoteRequests && s.jobKinds.length ? `Busiest: ${counted(s.jobKinds)}.` : null,
    s.quoteRequests && s.leadSources.length
      ? `Where they came from: ${counted(s.leadSources)}.`
      : null,
    s.repeatCustomers ? `${plural(s.repeatCustomers, "repeat customer")} wrote in again.` : null,
    decided
      ? `You won ${s.won} of ${plural(decided, "quote")} decided${s.ratePct === null ? "" : ` (${s.ratePct}%)`}.`
      : null,
  ].filter((l): l is string => !!l);
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The monthly email. Counts and our fixed labels only — never a customer's name, address,
 * words, the job they described, or an amount — because it goes through an email provider.
 * A month with nothing in it isn't worth an email.
 */
export function buildMonthlySummary(
  s: MonthlyStats,
  monthName: string,
  urls: { activityUrl: string; settingsUrl: string },
): { subject: string; text: string; html: string; worthSending: boolean } {
  const decided = s.won + s.lost + s.noAnswer;
  const lines = monthlyLines(s);
  const subject = `Your ${monthName} in numbers`;
  const text = [
    `Your ${monthName}, in numbers.`,
    "",
    ...lines,
    "",
    `See your Activity: ${urls.activityUrl}`,
    "",
    `Nothing is sent without your okay. This comes with your morning summary; change or turn it off: ${urls.settingsUrl}`,
    siteConfig.copyright,
  ].join("\n");
  const para = (l: string) =>
    `<p style="margin:0 0 12px;font-size:17px;line-height:1.45">${esc(l)}</p>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f7f6f3;color:#1b1b1b;font-family:Inter,Helvetica,Arial,sans-serif">
<div style="max-width:480px;margin:0 auto;padding:24px 16px">
<p style="margin:0;font-family:Georgia,serif;font-style:italic;font-size:24px">${esc(`your ${monthName},`)}</p>
<p style="margin:0 0 20px;font-weight:900;font-size:30px;letter-spacing:-0.02em">in numbers.</p>
${lines.map(para).join("\n")}
<p style="margin:24px 0"><a href="${esc(urls.activityUrl)}" style="display:inline-block;background:#1b1b1b;color:#efeeea;text-decoration:none;font-weight:700;font-size:17px;padding:14px 22px;border-radius:10px">See your Activity</a></p>
<p style="margin:24px 0 4px;font-size:14px;color:#5e5d59">Nothing is sent without your okay. This comes with your morning summary. <a href="${esc(urls.settingsUrl)}" style="color:#5e5d59">Change or turn it off</a>.</p>
<p style="margin:0;font-size:14px;color:#5e5d59">${esc(siteConfig.copyright)}</p>
</div></body></html>`;
  return {
    subject,
    text,
    html,
    worthSending: s.quoteRequests > 0 || s.repeatCustomers > 0 || decided > 0,
  };
}
