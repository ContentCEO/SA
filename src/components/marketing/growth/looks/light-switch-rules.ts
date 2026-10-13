/**
 * Look 1, "Light switch" (`/?look=1`, TEMPORARY preview): a wall rocker switch pops out of the
 * page, flips from "The app" to "One-on-one", and the dark spreads out of it like the lights going
 * off; at the end the plate sinks back into the wall and the dark drains into it. Pure timings (no
 * DOM, no React), mirrored in src/styles/theme.css (the "look 1: light switch" block);
 * tests/unit/growth-look-light.test.ts checks both use the same numbers.
 *
 * The dark is a charcoal disc LIGHT_DISC_VMAX across (radius 71vmax: past every corner of any
 * viewport, a square's being 70.7vmax from its centre, and no bigger, so its layer stays as small
 * as it can be), centred where the plate is, grown and shrunk with transform: scale() only, so the
 * compositor plays it in every browser (no clip-path). Its off-white rim is its own border, so the
 * line and the dark's edge are one layer with one transform and can never come apart.
 *
 * "in" (the full show, once per page view), each stage fixed to a moment, never scrubbed:
 *   plate pops           LIGHT_POP_MS 220 from 0 (scale 0.2 → 1.05 → 1, no fade)
 *   paddle rocks         LIGHT_FLIP_MS 140 from LIGHT_FLIP_AT_MS 260 (impact at 64% ≈ 350)
 *   dark                 LIGHT_DARK_MS 300 from LIGHT_DARK_AT_MS 260 (as the paddle starts to
 *                        rock): the disc grows from behind the plate, scale LIGHT_DARK_FROM_SCALE
 *                        (radius 8.5vmax) → 1 (71vmax) on an ease-in-out, so it is past a
 *                        phone's corners by ≈455, a 1280×800 screen's by ≈470 and a square's by
 *                        ≈545 (a margin for the first frame of the show landing late); the
 *                        screen is fully charcoal by 560
 *   click                LIGHT_CLICK_AT_MS 350: the chips swap in one frame, the plate thunks 160ms
 *   LIGHT_THEME_AT_MS    600: data-sa-theme becomes "growth", the page moves to the opener (under
 *                        full cover)
 *   LIGHT_REALIGN_AT_MS  1220: the opener put back at the top if a fling moved it
 *   lights back          LIGHT_EXIT_MS 240 from LIGHT_EXIT_AT_MS 1300 (forwards only): the plate
 *                        sinks back into the wall (scale 1 → 1.05 → 0) and the dark drains into it
 *                        (disc 1 → 0), its border turning off-white in one frame so the
 *                        drain's edge shows on the charcoal page
 *   sa-land              delays 740 / 800ms after the swap (= exit + LAND_AFTER_LIFT_MS)
 *   LIGHT_DONE_MS        1780: cleanup
 * "out" / "in-quiet": the cover's disc drains into the middle, scale LIGHT_DRAIN_FROM_SCALE → 0 in
 * LIGHT_QUIET_MS 240 on an ease-out (it moves from the first frame and leaves no dot); OUT_DONE_MS
 * 300.
 */
export const LIGHT_POP_MS = 220;
export const LIGHT_FLIP_AT_MS = 260;
export const LIGHT_FLIP_MS = 140;
export const LIGHT_CLICK_AT_MS = 350;
export const LIGHT_DARK_AT_MS = 260;
export const LIGHT_DARK_MS = 300;
export const LIGHT_THEME_AT_MS = 600;
export const LIGHT_REALIGN_AT_MS = 1220;
export const LIGHT_EXIT_AT_MS = 1300;
export const LIGHT_EXIT_MS = 240;
export const LIGHT_DONE_MS = 1780;
export const LIGHT_QUIET_MS = 240;

/** The disc's width and height, in vmax (its radius is half of this). */
export const LIGHT_DISC_VMAX = 142;
/** The disc's scale as the dark starts: radius 8.5vmax, hidden behind the plate. */
export const LIGHT_DARK_FROM_SCALE = 0.12;
/** The quiet paths' cover starts at full size (71vmax): still past every corner. */
export const LIGHT_DRAIN_FROM_SCALE = 1;
