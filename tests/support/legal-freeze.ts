/**
 * Check 50 P5: the legal text ships as one release. Only a `claude/legal-*` branch (the release
 * itself) or the integrator's `integrate-*` branch may change docs/terms.md, docs/privacy-policy.md
 * or TERMS_VERSION; every other branch writes the wording it needs in docs/notes/legal-<branch>.md
 * (docs/LEGAL-RELEASE.md). Pure: the test feeds it what git says.
 */

/** The branch the release work merges into; a diff is read against the merge-base with it. */
export const LEGAL_BASE_BRANCH = "claude/squared-away-mvp-ddxl7s";

/** The two documents whose every sentence is Davi's. */
export const FROZEN_DOCS = ["docs/terms.md", "docs/privacy-policy.md"] as const;

/** Branches allowed to move the legal text: the release branch and the integrator's. */
export function legalEditsAllowed(branch: string): boolean {
  return (
    branch.startsWith("claude/legal-") ||
    branch.startsWith("integrate-") ||
    branch === LEGAL_BASE_BRANCH ||
    branch === "main"
  );
}

/** `export const TERMS_VERSION = "2026-10-16";` → "2026-10-16" (null when the line is missing). */
export function termsVersionIn(source: string | null): string | null {
  return source?.match(/export const TERMS_VERSION = "([^"]+)"/)?.[1] ?? null;
}

export type FreezeVerdict =
  { kind: "exempt"; branch: string } | { kind: "ok" } | { kind: "frozen"; problems: string[] };

export function legalFreezeVerdict(input: {
  branch: string;
  /** Frozen documents that differ from the merge-base (committed or in the working tree). */
  changedDocs: string[];
  versionBefore: string | null;
  versionAfter: string | null;
}): FreezeVerdict {
  if (legalEditsAllowed(input.branch)) return { kind: "exempt", branch: input.branch };
  const problems: string[] = [];
  for (const doc of input.changedDocs) problems.push(`${doc} changed`);
  if (input.versionBefore !== input.versionAfter)
    problems.push(
      `TERMS_VERSION changed (${input.versionBefore ?? "missing"} → ${input.versionAfter ?? "missing"})`,
    );
  return problems.length ? { kind: "frozen", problems } : { kind: "ok" };
}

/** The message a stray edit fails with: where the wording goes instead. */
export function frozenMessage(branch: string, problems: string[]): string {
  return [
    `Legal text is frozen on "${branch}": ${problems.join("; ")}.`,
    "Builders never edit docs/terms.md, docs/privacy-policy.md or TERMS_VERSION. Write the exact",
    `wording, the reason and the review prompt id in docs/notes/legal-${branch.replace(/\//g, "-")}.md;`,
    "the integrator applies every note in one claude/legal-<date> release (docs/LEGAL-RELEASE.md).",
  ].join("\n");
}
