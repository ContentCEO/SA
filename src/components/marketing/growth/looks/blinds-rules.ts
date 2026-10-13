/**
 * Look 5, "Blinds" (`/?look=5`, TEMPORARY preview): a charcoal venetian blind drops down over the
 * page with its slats open (paper shows between them), the slats tilt shut, and a word is
 * printed on every slat, eight rows of "The app", inverted, only once they're shut; the slats tilt
 * over once (as a blind's wand does) and come back with "One-on-one" on every slat, inverted;
 * the slats tilt open and the opener shows through the open blind. Pure timings (no DOM, no React), mirrored in
 * src/styles/theme.css (the "look 5: blinds" block); tests/unit/growth-look-blinds.test.ts checks
 * both use the same numbers.
 *
 * "in" (the full show, once per page view), each stage fixed to a moment, never scrubbed:
 *   blind drops          BL_DROP_MS 280 from 0 (translateY -100% → 0), slats open (scaleY
 *                        BL_OPEN_SCALE): plain charcoal bars, the title not printed on them yet
 *   slats shut           BL_SHUT_MS 160 from BL_SHUT_AT_MS 280, all together (full cover at
 *                        BL_COVERED_AT_MS 440; the charcoal backing under them and the title on
 *                        them both turn on there)
 *   BL_THEME_AT_MS       540: data-sa-theme becomes "growth", the page moves to the opener (under
 *                        full cover). 100ms after full cover: the CSS clock starts at the first
 *                        painted frame, the timer when the attribute is set, so on a slow phone
 *                        the slats can trail the timer by a frame or more
 *   slats tilt over      BL_TILT_MS 240 from BL_TILT_AT_MS 580: shut → edge-on → shut, over the
 *                        backing (so nothing behind shows)
 *   chip                 BL_CHIP_AT_MS 700, at the tilt's edge-on moment: the word swaps from
 *                        "The app" to "One-on-one", chip and all, in one frame (no fade, no third
 *                        tone)
 *   BL_REALIGN_AT_MS     1220: the opener put back at the top if a fling moved it
 *   slats open           BL_OPEN_MS 240 from BL_OPEN_AT_MS 1300 (forwards only): the backing goes
 *                        off and every slat tilts open (scaleY 1 → 0), the opener showing through
 *   sa-land              delays 820 / 880ms after the swap (= open + LAND_AFTER_LIFT_MS)
 *   BL_DONE_MS           1740: cleanup (the same length as the current look)
 * "out" / "in-quiet": a shut blind of the old colour tilts open (slats to edge-on), QUIET_MS 260;
 * OUT_DONE_MS 300.
 */
export const BL_SLATS = 8;
/** How thick an open slat is, as a share of its shut height. */
export const BL_OPEN_SCALE = 0.18;
export const BL_DROP_MS = 280;
export const BL_SHUT_AT_MS = 280;
export const BL_SHUT_MS = 160;
export const BL_THEME_AT_MS = 540;
export const BL_TILT_AT_MS = 580;
export const BL_TILT_MS = 240;
export const BL_REALIGN_AT_MS = 1220;
export const BL_OPEN_AT_MS = 1300;
export const BL_OPEN_MS = 240;
export const BL_DONE_MS = 1740;

/** Every slat is shut (and the backing is on) from here. */
export const BL_COVERED_AT_MS = BL_SHUT_AT_MS + BL_SHUT_MS;
/** The tilt passes edge-on halfway through: the chip moves then. */
export const BL_CHIP_AT_MS = BL_TILT_AT_MS + BL_TILT_MS / 2;

/** Slat `i`'s top edge, in % of the screen (and in vh: the stage is 100vh tall). */
export function slatTopPct(i: number): number {
  return (i * 100) / BL_SLATS;
}
