/**
 * The homepage switch from the app (paper) to Squared Away Growth (charcoal): pure rules.
 * No DOM here, so the hysteresis and the line maths are unit-tested on their own
 * (tests/unit/growth-switch.test.ts). GrowthSwitch (growth-switch.tsx) feeds them the top edge
 * of the Growth wrapper, in px from the top of the viewport.
 */

export type HalfMode = "app" | "growth";

/**
 * App → Growth as soon as the Growth part comes up: its top edge (the chapter bar) is in the
 * bottom 15% of the screen. Only the bar can show on paper before the switch, never the opener.
 */
export const SWITCH_IN_AT = 0.85;
/** Growth → app only once it has dropped back off the bottom edge: a 15% band, so no strobing. */
export const SWITCH_OUT_AT = 1.0;
/** The two lines, in observer order (observer 0 watches the in line, observer 1 the out line). */
export const LINES = [SWITCH_IN_AT, SWITCH_OUT_AT] as const;
/** Navigation (a # link, back/forward, a bfcache restore) picks a side without the band. */
export const JUMP_AT = (SWITCH_IN_AT + SWITCH_OUT_AT) / 2;
/** Readings this long after a navigation count as that navigation: instant, no band. */
export const NAV_MS = 1000;

/*
 * Timings, in ms. Mirrored in src/styles/theme.css (the "Homepage switch" block); a unit test
 * checks the comment and the animation declarations there use the same numbers. Change both.
 *
 * "in" (the full show, once per page view):
 *   sa-switch-flood-in   300ms, delay 0, fill both (full cover from 300 to FLOOD_OUT_AT_MS)
 *   top edge             leads the flood up, fades 120ms from 300ms
 *   IN_THEME_AT_MS       360: data-sa-theme becomes "growth" and the page moves to the opener
 *                        (#growth), under full cover; scrolling is held until cleanup
 *   knob + dark labels   KNOB_MS 220 from KNOB_AT_MS 420, no overshoot: lands at 640
 *   hold                 "One-on-one" alone on screen from 640 to 1250 (at least 600ms)
 *   IN_REALIGN_AT_MS     1150: the opener put back at the top if a fling's momentum moved it
 *   sa-switch-flood-out  240ms, delay FLOOD_OUT_AT_MS 1250, forwards (never both); the bottom
 *                        edge shows from 1250 and trails the lift
 *   sa-land              300ms, delays 930ms (serif) and 990ms (heavy) after the swap at 360
 *   IN_DONE_MS           1740: cleanup re-applies the theme, then drops data-sa-switching
 *
 * "out" and "in-quiet" (the quiet paths: transform-only wipes, no pill, no edges):
 *   sa-switch-wipe-*     QUIET_MS 260, delay 0
 *   OUT_DONE_MS          300: cleanup
 */
export const IN_THEME_AT_MS = 360;
export const KNOB_AT_MS = 420;
export const KNOB_MS = 220;
export const FLOOD_OUT_AT_MS = 1250;
/** Just before the lift, still under full cover. */
export const IN_REALIGN_AT_MS = 1150;
/** sa-land starts this long after the flood starts lifting. */
export const LAND_AFTER_LIFT_MS = 40;
export const IN_DONE_MS = 1740;
export const QUIET_MS = 260;
export const OUT_DONE_MS = 300;

/** Decisions are instant (no show) until the page has settled for this long after mount. */
export const SETTLE_MS = 500;

/** The next mode for a Growth wrapper whose top edge sits `top` px down a `vh` px viewport. */
export function nextMode(current: HalfMode, top: number, vh: number): HalfMode {
  if (top <= SWITCH_IN_AT * vh) return "growth";
  if (top >= SWITCH_OUT_AT * vh) return "app";
  return current;
}

/** After navigation there is no "current" to keep: one line in the middle of the band decides. */
export function jumpMode(top: number, vh: number): HalfMode {
  return top <= JUMP_AT * vh ? "growth" : "app";
}

/**
 * The viewport height an observer reading was measured against. An observer's root bounds end at
 * its line (`line` × the root's height), so the decision uses the height the observer fired on,
 * not the window's innerHeight, which can differ on phones (toolbar, pinch zoom). Without usable root
 * bounds it falls back to `fallback`.
 */
export function rootHeight(
  lineBottom: number | null | undefined,
  line: number,
  fallback: number,
): number {
  return typeof lineBottom === "number" && lineBottom > 0 && line > 0
    ? lineBottom / line
    : fallback;
}

/** The IntersectionObserver rootMargin that puts the root's bottom edge on `line`. */
export function rootMarginFor(line: number): string {
  const pct = Math.round((1 - line) * 100);
  return `0px 0px ${pct === 0 ? 0 : -pct}% 0px`;
}
