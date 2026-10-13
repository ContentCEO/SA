/**
 * Look 4, "Big words" (`/?look=4`, TEMPORARY preview): five charcoal bands slam in from
 * alternate sides, the middle one first, carrying "The app" in huge serif; the words tick over,
 * "The app" up and out of the band and "One-on-one" up into it in huge heavy sans, which then
 * inverts (the active label); the bands fly back out the way they came, outer ones first, onto the
 * opener. Pure timings (no DOM,
 * no React), mirrored in src/styles/theme.css (the "look 4: big words" block);
 * tests/unit/growth-look-big-words.test.ts checks both use the same numbers.
 *
 * "in" (the full show, once per page view), each stage fixed to a moment, never scrubbed:
 *   bands in             BW_BAND_MS 240 each: the middle band from 0, its two neighbours after
 *                        BW_BAND_STAGGER_MS 40, the outer two after 80 (full cover at 320); bands
 *                        0, 2, 4 come from the left, 1 and 3 from the right
 *   BW_THEME_AT_MS       380: data-sa-theme becomes "growth", the page moves to the opener (under
 *                        full cover)
 *   words tick over      BW_TICK_MS 240 from BW_TICK_AT_MS 440: "The app" up and out of the
 *                        middle band, "One-on-one" up into it (a small overshoot), clipped by it
 *   chip                 BW_CHIP_AT_MS 680: "One-on-one" inverts in one frame (no fade)
 *   BW_REALIGN_AT_MS     1220: the opener put back at the top if a fling moved it
 *   bands out            BW_OUT_MS 160 each from BW_OUT_AT_MS 1300 (forwards only): the outer two
 *                        first, their neighbours after BW_BAND_STAGGER_MS 40, the middle band (with
 *                        the words) last, each back to the side it came from; all gone by
 *                        BW_OUT_DONE_AT_MS 1540
 *   sa-land              delays 960 / 1020ms after the swap (= out + LAND_AFTER_LIFT_MS)
 *   BW_DONE_MS           1740: cleanup (the same length as the current look)
 * "out" / "in-quiet": bands of the old colour fly apart sideways, QUIET_MS 260; OUT_DONE_MS 300.
 */
export const BW_BANDS = 5;
export const BW_BAND_MS = 240;
export const BW_BAND_STAGGER_MS = 40;
export const BW_THEME_AT_MS = 380;
export const BW_TICK_AT_MS = 440;
export const BW_TICK_MS = 240;
export const BW_CHIP_AT_MS = 680;
export const BW_REALIGN_AT_MS = 1220;
export const BW_OUT_AT_MS = 1300;
export const BW_OUT_MS = 160;
export const BW_DONE_MS = 1740;

/** How far band `i` sits from the middle band (0 for the middle, 2 for the top and bottom). */
export function bandRing(i: number): number {
  return Math.abs(i - (BW_BANDS - 1) / 2);
}

/** When band `i` starts coming in: the middle first, then outwards. */
export function bandDelayMs(i: number): number {
  return bandRing(i) * BW_BAND_STAGGER_MS;
}

/** When band `i` starts flying back out in the full show: the outer bands first. */
export function bandOutDelayMs(i: number): number {
  return BW_OUT_AT_MS + (bandRing(0) - bandRing(i)) * BW_BAND_STAGGER_MS;
}

/** Which side band `i` comes in from (and flies back out to, in the full show and the quiet paths). */
export function bandSide(i: number): "left" | "right" {
  return i % 2 === 0 ? "left" : "right";
}

/** The whole screen is covered once the last (outer) bands are in. */
export const BW_COVERED_AT_MS = bandDelayMs(0) + BW_BAND_MS;
/** Every band is off the screen again (the middle one goes last). */
export const BW_OUT_DONE_AT_MS = bandOutDelayMs((BW_BANDS - 1) / 2) + BW_OUT_MS;
