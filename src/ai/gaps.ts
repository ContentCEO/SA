/**
 * Gaps to fill in (plan #2). When the drafter doesn't know a fact it writes a
 * typed placeholder instead of vague wording; the owner fills each one in
 * before the reply can be sent (enforced in the UI and on the server).
 *
 *   {{price}}  {{date}}  {{time}}  {{custom:job address}}
 */
export type GapKind = "price" | "date" | "time" | "custom";
export type Gap = { token: string; kind: GapKind; label: string };

const GAP = /\{\{\s*(price|date|time|custom\s*:\s*([^{}]{1,40}?))\s*\}\}/gi;

export function findGaps(body: string): Gap[] {
  return [...body.matchAll(GAP)].map((m) => {
    const kind = (
      m[1]!.toLowerCase().startsWith("custom") ? "custom" : m[1]!.toLowerCase()
    ) as GapKind;
    const label =
      kind === "custom"
        ? m[2]!.trim()
        : kind === "price"
          ? "price"
          : kind === "date"
            ? "date"
            : "time";
    return { token: m[0], kind, label };
  });
}

/** Anything that still looks like a placeholder, well-formed or not. The send gate refuses these. */
export function hasUnfilledGap(body: string): boolean {
  return /\{\{|\}\}/.test(body);
}

/** Replace the n-th gap with what the owner typed. */
export function fillGap(body: string, index: number, value: string): string {
  let i = -1;
  return body.replace(GAP, (m) => (++i === index ? value : m));
}

/** Placeholders aren't facts; checks look at the text around them. */
export function withoutGaps(body: string): string {
  return body.replace(GAP, " ");
}
