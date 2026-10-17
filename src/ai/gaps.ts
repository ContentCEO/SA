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

/**
 * Placeholders written some other way (review A7): "[price]", "[Customer Name]", "[insert
 * date]", "$___", "$X,XXX", "XX:XX". A model (or a template pasted in Gmail) sometimes writes
 * these instead of {{price}}; they block sending just the same, until the owner edits them.
 */
const OTHER_PLACEHOLDER =
  /\[\s*(?:price|amount|cost|total|rate|fee|deposit|date|day|time|name|first name|customer(?: name)?|their name|your name|address|job address|phone(?: number)?|number|email|insert[^\]\n]{0,30}|enter[^\]\n]{0,30}|add [^\]\n]{0,30}|fill in[^\]\n]{0,30}|x+|tbd|\?+|\.\.\.|…)\s*\]|\$\s?_{2,}|\$\s?x[x,.]*\b|(?:^|\s)_{3,}(?=\s|$)|\bxx:xx\b/i;

/** Anything that still looks like a placeholder, well-formed or not. The send gate refuses these. */
export function hasUnfilledGap(body: string): boolean {
  return /\{\{|\}\}/.test(body) || OTHER_PLACEHOLDER.test(body);
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

/**
 * Check 9 P4: in the Edit box, gaps read as words: {{time}} → [time], {{custom:job address}}
 * → [job address]. `fromEditorText` turns them back into tokens before the text leaves the
 * phone, so the server's gap check still refuses any left unfilled.
 */
const editorWord = (g: Gap) => `[${g.label}]`;
const canonical = (g: Gap) => (g.kind === "custom" ? `{{custom:${g.label}}}` : `{{${g.kind}}}`);

export function toEditorText(body: string): string {
  return body.replace(GAP, (token) => editorWord(findGaps(token)[0]!));
}

/** The gaps of `original` still showing as [words] in `text`, turned back into tokens. */
export function fromEditorText(text: string, original: string): string {
  const words = new Map(findGaps(original).map((g) => [editorWord(g), canonical(g)]));
  let out = text;
  for (const [word, token] of words) out = out.split(word).join(token);
  return out;
}

/** The [words] of `original`'s gaps still left in the editor's text ("Fill in [time] first"). */
export function editorGapsLeft(text: string, original: string): string[] {
  return [...new Set(findGaps(original).map(editorWord))].filter((w) => text.includes(w));
}
