/**
 * Check 9 P7 + E2E hardening (2026-10-19): does a folded draft (four lines on a card that can't
 * send yet) hide anything? The browser knows only once it has laid the text out, at hydration;
 * a "Show full draft" toggle added then pushed everything under the card (Edit, Discard, "They
 * said no", the practice send) about 52px down, under a thumb already on its way. So the server
 * guesses from the text alone, with bounds wide enough for any phone, Sunlight's bigger type and
 * real sentences:
 *   "cut":   more than four lines even on the widest card with the narrowest text: the toggle is
 *            in the server's HTML;
 *   "fits":  four lines or fewer even on the narrowest card with the widest text: no toggle;
 *   "maybe": in between: the toggle's place is kept from the start, hidden until the browser has
 *            measured, so it shows (or stays hidden) without anything moving.
 * Pure: no DOM, no React.
 */

/** A folded draft shows this many lines (`line-clamp-4` on the card's text). */
export const FOLD_LINES = 4;

/**
 * The draft text's width on a card, in em of its own type. Widest: the app's column (max-w-xl)
 * less its gutters and the card's padding, 30.25em at any root size. Narrowest: a 320px phone in
 * Sunlight (112.5% type), about 12em.
 */
export const FOLD_WIDEST_EM = 30.5;
export const FOLD_NARROWEST_EM = 12;

/**
 * Average width of one character of real sentences in Inter Tight, in em: about 0.42 measured
 * (capitals 0.56, digits 0.5). The bounds keep a guess on the safe side.
 */
export const CHAR_EM_NARROW = 0.36;
export const CHAR_EM_WIDE = 0.55;

export type FoldGuess = "cut" | "fits" | "maybe";

/**
 * Lines the text takes at `perLine` characters a line, as `white-space: pre-line` lays it out:
 * each line break starts a line (a blank line is still a line), runs of spaces collapse, and
 * words wrap whole. A word longer than a line takes `longWords` "one" line (it overflows: the
 * fewest) or as many lines as its length needs (if the browser breaks it: the most).
 */
export function wrappedLines(
  text: string,
  perLine: number,
  longWords: "one" | "split" = "one",
): number {
  let total = 0;
  for (const line of text.trim().split("\n")) {
    const words = line.split(/\s+/).filter(Boolean);
    let lines = 1;
    let used = 0;
    for (const word of words) {
      const len = word.length;
      if (used > 0 && used + 1 + len <= perLine) {
        used += 1 + len;
        continue;
      }
      if (used > 0) lines += 1;
      if (len > perLine && longWords === "split") {
        lines += Math.ceil(len / perLine) - 1;
        used = len % perLine || perLine;
      } else used = len;
    }
    total += lines;
  }
  return total;
}

/** Does folding this draft to four lines hide anything? See the top of this file. */
export function foldGuess(body: string): FoldGuess {
  const fewest = wrappedLines(body, Math.floor(FOLD_WIDEST_EM / CHAR_EM_NARROW), "one");
  if (fewest > FOLD_LINES) return "cut";
  const most = wrappedLines(body, Math.floor(FOLD_NARROWEST_EM / CHAR_EM_WIDE), "split");
  return most <= FOLD_LINES ? "fits" : "maybe";
}
