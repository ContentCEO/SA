/**
 * Check 27 P3: what changed in the terms and privacy policy, for the re-agree screen. Pure: no
 * `server-only`, no database. docs/legal-changes.md holds one `## <version>` section per
 * TERMS_VERSION; the screen shows the sections newer than the version the person agreed to.
 */
import { compareTermsVersions, isTermsVersion } from "./terms-rules";

export type LegalChange = { version: string; bullets: string[] };

/** The `## <version>` sections of docs/legal-changes.md, in file order, with their bullets. */
export function parseLegalChanges(markdown: string): LegalChange[] {
  const out: LegalChange[] = [];
  let current: LegalChange | null = null;
  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const heading = raw.match(/^## (\S+)\s*$/);
    if (heading) {
      current = { version: heading[1]!, bullets: [] };
      out.push(current);
      continue;
    }
    if (!current) continue;
    if (/^- /.test(raw)) current.bullets.push(raw.slice(2).trim());
    else if (/^\s{2,}\S/.test(raw) && current.bullets.length)
      current.bullets[current.bullets.length - 1] += ` ${raw.trim()}`;
  }
  return out;
}

/**
 * The entries someone who agreed to `agreedVersion` hasn't seen: every version newer than it,
 * newest first. Someone who never agreed (null) reads the whole documents, so nothing.
 */
export function changesSince(entries: LegalChange[], agreedVersion: string | null): LegalChange[] {
  if (agreedVersion === null || !isTermsVersion(agreedVersion)) return [];
  return entries
    .filter((e) => isTermsVersion(e.version) && compareTermsVersions(e.version, agreedVersion) > 0)
    .sort((a, b) => compareTermsVersions(b.version, a.version));
}

/** "2026-10-16.2" → "October 16, 2026" (the suffix is a same-day release; the date is what matters). */
export function versionLabel(version: string): string {
  const [y, m, d] = version.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * The "What changed" section as Markdown for the documents' renderer: one list for a single
 * version, a dated `###` heading over each list when several versions have gone by.
 */
export function changesMarkdown(changes: LegalChange[]): string {
  if (changes.length === 1) return changes[0]!.bullets.map((b) => `- ${b}`).join("\n");
  return changes
    .map((c) => [`### ${versionLabel(c.version)}`, ...c.bullets.map((b) => `- ${b}`)].join("\n"))
    .join("\n\n");
}
