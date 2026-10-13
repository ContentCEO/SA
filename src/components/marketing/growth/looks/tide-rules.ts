/**
 * Look 3, "Tide" (`/?look=3`, TEMPORARY preview): a charcoal tide comes in from the bottom in two
 * surges (a deep pull back between them), its tall scalloped crest rolling sideways, one big line
 * riding just behind the crest; the line jumps from "The app" to "One-on-one" (each inverted, the
 * active label); then the tide goes out, down off the screen, the line riding it out, uncovering
 * the opener from the top. Pure timings (no DOM, no React), mirrored in
 * src/styles/theme.css (the "look 3: tide" block); tests/unit/growth-look-tide.test.ts checks
 * both use the same numbers.
 *
 * "in" (the full show, once per page view), each stage fixed to a moment, never scrubbed:
 *   tide comes in        TIDE_IN_MS 520 from 0 (translateY 100% → 30%, back to 48%, → 0): the
 *                        crest leads it, rolling sideways the whole show
 *   TIDE_THEME_AT_MS     580: data-sa-theme becomes "growth", the page moves to the opener (under
 *                        full cover)
 *   chip                 TIDE_CHIP_AT_MS 640: the line jumps from "The app" to "One-on-one",
 *                        chip and all, in one frame (no fade, no third tone)
 *   TIDE_REALIGN_AT_MS   1180: the opener put back at the top if a fling moved it
 *   tide goes out        TIDE_OUT_MS 300 from TIDE_OUT_AT_MS 1260 (forwards only), down off the
 *                        bottom; its off-white crest line trails across the charcoal page
 *   sa-land              delays 720 / 780ms after the swap (= out + LAND_AFTER_LIFT_MS)
 *   TIDE_DONE_MS         1740: cleanup (the same length as the current look)
 * "out": a charcoal tide goes out, down off the screen; "in-quiet": a paper tide recedes up off
 * the screen, its crest flipped onto the leading (bottom) edge, so both move with the scroll;
 * QUIET_MS 260; OUT_DONE_MS 300.
 */
export const TIDE_IN_MS = 520;
export const TIDE_THEME_AT_MS = 580;
export const TIDE_CHIP_AT_MS = 640;
export const TIDE_REALIGN_AT_MS = 1180;
export const TIDE_OUT_AT_MS = 1260;
export const TIDE_OUT_MS = 300;
export const TIDE_DONE_MS = 1740;
/** How many crest bumps: ten across the screen plus one, so the roll loops without a seam. */
export const TIDE_BUMPS = 11;
