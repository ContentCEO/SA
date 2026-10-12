/**
 * Plan #35 (and M8 A11): the monthly summary's labels, as pure rules. What the customer
 * wrote and who they are never come out of here: a kind of job is one of OUR fixed labels
 * (src/config/job-kinds.ts) and a lead source is one of OUR fixed labels
 * (src/config/lead-sources.ts). Only labels and counts are returned.
 */
import { JOB_KINDS, OTHER_JOB_KIND } from "@/config/job-kinds";
import { DIRECT_EMAIL, LEAD_SOURCES } from "@/config/lead-sources";
import { isTrade, type Trade } from "@/config/trades";

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
  if (!fromAddressOrDomain) return DIRECT_EMAIL;
  const raw = fromAddressOrDomain.trim().toLowerCase();
  const host = (raw.includes("@") ? raw.slice(raw.lastIndexOf("@") + 1) : raw)
    .replace(/[>\s]+$/, "")
    .replace(/\.$/, "");
  if (!/^[a-z0-9.-]+$/.test(host)) return DIRECT_EMAIL;
  for (const source of LEAD_SOURCES) {
    for (const d of source.domains) {
      if (host === d || (!source.exact && host.endsWith(`.${d}`))) return source.label;
    }
  }
  return DIRECT_EMAIL;
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
