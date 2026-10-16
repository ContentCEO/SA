import type { ToneShift } from "@/ai/prompts/edit-tone.v1";

/**
 * Plan #21, as pure rules. What an owner's edit did — counts and yes/no only,
 * never words — and the plain-language suggestions a pattern of them earns.
 */

export type EditShape = {
  wordsBefore: number;
  wordsAfter: number;
  openingChanged: boolean;
  signoffChanged: boolean;
  firstSentenceCut: boolean;
  sentencesRemoved: number;
  sentencesAdded: number;
};

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
/** Body sentences: everything between the greeting line and the sign-off lines. */
function sentences(body: string): string[] {
  const ls = lines(body);
  const inner = ls.length > 2 ? ls.slice(1, -1) : ls;
  return inner
    .join(" ")
    .split(/(?<=[.!?])\s+/)
    .map(norm)
    .filter(Boolean);
}
const signoff = (body: string) => lines(body).slice(-2).map(norm).join(" ");

export function editShape(drafted: string, sent: string): EditShape {
  const a = sentences(drafted);
  const b = sentences(sent);
  const inB = new Set(b);
  const inA = new Set(a);
  return {
    wordsBefore: words(drafted),
    wordsAfter: words(sent),
    openingChanged: norm(lines(drafted)[0] ?? "") !== norm(lines(sent)[0] ?? ""),
    signoffChanged: signoff(drafted) !== signoff(sent),
    firstSentenceCut: a.length > 1 && !inB.has(a[0]!),
    sentencesRemoved: a.filter((s) => !inB.has(s)).length,
    sentencesAdded: b.filter((s) => !inA.has(s)).length,
  };
}

export type EditSignal = EditShape & { toneShift: ToneShift | null };

export const SUGGESTION_KINDS = [
  "shorter",
  "longer",
  "skip_opener",
  "signoff",
  "greeting",
  "warmer",
  "more_formal",
  "more_casual",
] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];
export const isSuggestionKind = (v: unknown): v is SuggestionKind =>
  typeof v === "string" && (SUGGESTION_KINDS as readonly string[]).includes(v);

/** Enough edits to call it a habit, and how often it has to happen. */
export const MIN_EDITS = 5;
export const HABIT_SHARE = 0.6;

export type Suggestion = { kind: SuggestionKind; text: string; targetWords?: number };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/** What a month of edits suggests, in the owner's words. Never more than three at once. */
export function proposeSuggestions(signals: EditSignal[]): Suggestion[] {
  if (signals.length < MIN_EDITS) return [];
  const share = (f: (s: EditSignal) => boolean) => signals.filter(f).length / signals.length;
  const out: Suggestion[] = [];
  const cut = share((s) => s.wordsAfter <= s.wordsBefore * 0.8);
  const grew = share((s) => s.wordsAfter >= s.wordsBefore * 1.25);
  if (cut >= HABIT_SHARE) {
    const target = Math.max(20, Math.round(median(signals.map((s) => s.wordsAfter)) / 5) * 5);
    out.push({
      kind: "shorter",
      text: `You usually cut the replies down. Write them shorter — about ${target} words?`,
      targetWords: target,
    });
  } else if (grew >= HABIT_SHARE) {
    const target = Math.round(median(signals.map((s) => s.wordsAfter)) / 5) * 5;
    out.push({
      kind: "longer",
      text: `You usually add to the replies. Write them fuller — about ${target} words?`,
      targetWords: target,
    });
  }
  if (share((s) => s.firstSentenceCut) >= HABIT_SHARE)
    out.push({
      kind: "skip_opener",
      text: "You always cut the first sentence. Start shorter, straight to the point?",
    });
  if (share((s) => s.signoffChanged) >= HABIT_SHARE)
    out.push({
      kind: "signoff",
      text: "You usually change how replies end. Tell us the sign-off you use?",
    });
  if (share((s) => s.openingChanged && !s.firstSentenceCut) >= HABIT_SHARE)
    out.push({
      kind: "greeting",
      text: "You usually change the greeting. Tell us how you say hello?",
    });
  for (const [tone, kind, text] of [
    ["warmer", "warmer", "You often make replies friendlier. Write them a bit warmer?"],
    ["more_formal", "more_formal", "You often make replies more formal. Write them that way?"],
    ["more_casual", "more_casual", "You often make replies more relaxed. Write them that way?"],
  ] as const) {
    if (share((s) => s.toneShift === tone) >= HABIT_SHARE) out.push({ kind, text });
  }
  return out.slice(0, 3);
}
