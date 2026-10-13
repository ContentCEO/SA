/**
 * Look 2, "Curtains" (`/?look=2`, TEMPORARY preview): two charcoal curtains draw shut from the
 * sides, each carrying half of one huge heavy "One-on-one", so the word is whole only where they
 * meet; the word then inverts, and the curtains open sideways onto the opener.
 * Pure timings (no DOM, no React), mirrored in src/styles/theme.css (the "look 2: curtains"
 * block); tests/unit/growth-look-curtains.test.ts checks both use the same numbers.
 *
 * "in" (the full show, once per page view), each stage fixed to a moment, never scrubbed:
 *   curtains close         CURTAIN_CLOSE_MS 360 from 0 (each half translateX ±100% → 0); an
 *                          off-white edge leads each one and switches off at
 *                          CURTAIN_EDGE_OFF_AT_MS 300, while the two are still about 6px apart on
 *                          a 375px screen (so they never sit together on the seam as one bright
 *                          bar); the charcoal seam under the halves turns on then, so the last
 *                          few px of the close (its ease-out tail) never show the page
 *   CURTAIN_THEME_AT_MS    420: data-sa-theme becomes "growth", the page moves to the opener
 *                          (under full cover)
 *   chip                   CURTAIN_CHIP_AT_MS 520: "One-on-one" inverts (an off-white chip) in
 *                          one frame (no fade, no third tone)
 *   CURTAIN_REALIGN_AT_MS  1180: the opener put back at the top if a fling moved it
 *   curtains open          CURTAIN_OPEN_MS 300 from CURTAIN_OPEN_AT_MS 1260 (forwards only); the
 *                          edges come back at CURTAIN_EDGE_ON_AT_MS 1380, once the halves have
 *                          parted (the opening eases in: about 3% of the way by then, 11px apart
 *                          on a 375px screen) and trail them
 *   sa-land                delays 880 / 940ms after the swap (= open + LAND_AFTER_LIFT_MS)
 *   CURTAIN_DONE_MS        1740: cleanup (the same length as the current look)
 * "out" / "in-quiet": closed curtains of the old colour open sideways, QUIET_MS 260; OUT_DONE_MS
 * 300.
 */
export const CURTAIN_CLOSE_MS = 360;
export const CURTAIN_EDGE_OFF_AT_MS = 300;
export const CURTAIN_THEME_AT_MS = 420;
export const CURTAIN_CHIP_AT_MS = 520;
export const CURTAIN_REALIGN_AT_MS = 1180;
export const CURTAIN_OPEN_AT_MS = 1260;
export const CURTAIN_OPEN_MS = 300;
export const CURTAIN_EDGE_ON_AT_MS = 1380;
export const CURTAIN_DONE_MS = 1740;
