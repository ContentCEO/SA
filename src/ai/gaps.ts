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

/** A typed {{…}} gap's kind and label. */
function typedGap(token: string): Gap {
  const m = new RegExp(GAP.source, "i").exec(token)!;
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
  return { token, kind, label };
}

/**
 * Check 23 P7: a "[name]"-style blank as a gap the card can show as a chip: "[name]" → their
 * name, "[time]" → time, "[date]" / "[day]" → date, "[price]" / "[amount]" / "$___" / "$X,XXX"
 * → price, anything else → its own words.
 */
function blankGap(token: string): Gap {
  const inner = token
    .replace(/^\[\s*|\s*\]$/g, "")
    .trim()
    .toLowerCase();
  if (/^\$/.test(token) || /^(?:price|amount|cost|total|rate|fee)$/.test(inner))
    return { token, kind: "price", label: "price" };
  if (inner === "time" || inner === "xx:xx") return { token, kind: "time", label: "time" };
  if (inner === "date" || inner === "day") return { token, kind: "date", label: "date" };
  if (/^(?:name|first name|customer(?: name)?|their name)$/.test(inner))
    return { token, kind: "custom", label: "their name" };
  if (/^_+$/.test(inner) || /^(?:x+|tbd|\?+|\.\.\.|…)$/.test(inner) || !inner)
    return { token, kind: "custom", label: "blank" };
  const words = token.startsWith("[") ? token.replace(/^\[\s*|\s*\]$/g, "").trim() : inner;
  return { token, kind: "custom", label: words.slice(0, 40) };
}

/** Every gap, typed or written as a blank, in the order they appear (Check 23 P7). */
const ANY_GAP = () => new RegExp(`${GAP.source}|${OTHER_PLACEHOLDER.source}`, "gi");
/** A blank written as "  ___" carries the space before it; that space stays. */
const lead = (m: string) => /^\s*/.exec(m)![0];

export function findGaps(body: string): Gap[] {
  return [...body.matchAll(ANY_GAP())].map((m) => {
    const token = m[0].slice(lead(m[0]).length);
    return /^\{\{/.test(token) ? typedGap(token) : blankGap(token);
  });
}

/** Check 23 P7: the "[name]"-style blanks in a text (not the typed {{…}} gaps). */
export function blanks(body: string): string[] {
  return findGaps(body)
    .filter((g) => !g.token.startsWith("{{"))
    .map((g) => g.token);
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

/** Replace the n-th gap (typed or a blank, Check 23 P7) with what the owner typed. */
export function fillGap(body: string, index: number, value: string): string {
  let i = -1;
  return body.replace(ANY_GAP(), (m) => (++i === index ? `${lead(m)}${value}` : m));
}

/** Typed gaps as plain words for reading ("{{custom:name}}" → "[name]"), never braces. */
export function showGaps(text: string): string {
  return text.replace(GAP, (m) => `[${typedGap(m).label}]`);
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
// Integration (wave 1): a "[name]"-style blank (Check 23 P7) already reads as words, so the
// editor shows it as written and it goes back unchanged; only typed {{…}} gaps are swapped.
const typed = (g: Gap) => g.token.startsWith("{{");
const editorWord = (g: Gap) => (typed(g) ? `[${g.label}]` : g.token);
const canonical = (g: Gap) =>
  !typed(g) ? g.token : g.kind === "custom" ? `{{custom:${g.label}}}` : `{{${g.kind}}}`;

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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Check 23 P8: the values the owner typed into gaps on the card, when `current` is exactly
 * `saved` with some of its gaps filled in (each filled gap a non-empty run of text holding no
 * new gap, nothing else changed). Anything else — a changed word, a forged body — gives null,
 * so only the owner's filled-in values can ride along with a quick change.
 */
export function filledGaps(saved: string, current: string): string[] | null {
  if (saved === current) return [];
  const gaps = findGaps(saved);
  if (!gaps.length || current.length > saved.length + 2000) return null;
  let pattern = "^";
  let rest = saved;
  for (const g of gaps) {
    const at = rest.indexOf(g.token);
    if (at < 0) return null;
    pattern += `${escapeRe(rest.slice(0, at))}(${escapeRe(g.token)}|[^\\n{}]{1,200}?)`;
    rest = rest.slice(at + g.token.length);
  }
  pattern += `${escapeRe(rest)}$`;
  const m = new RegExp(pattern).exec(current);
  if (!m) return null;
  const values = m
    .slice(1)
    .filter((v, i) => v !== gaps[i]!.token)
    .map((v) => v.trim());
  if (!values.length || values.some((v) => !v || findGaps(v).length)) return null;
  return values;
}
