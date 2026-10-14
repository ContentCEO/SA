/**
 * The homepage switch from the app (paper) to Squared Away Growth (charcoal): pure rules.
 * No DOM here, so the hysteresis, the line maths and which path a decision plays are unit-tested
 * on their own (tests/unit/growth-switch.test.ts). GrowthSwitch (growth-switch.tsx) feeds them
 * the top edge of the Growth wrapper, in px from the top of the viewport. The show's clock is in
 * big-words-rules.ts.
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

/**
 * How a change of side plays: the full show ("in"), a quiet path ("in-quiet" / "out": the bare
 * bands) or an instant swap with nothing on screen. The values of data-sa-switching, plus
 * "instant".
 */
export type SwitchPath = "in" | "in-quiet" | "out" | "instant";

/**
 * The path for a move to `next`. Every move from the app into Growth plays the full show, however
 * many times it has played before; the way back up is always the quiet "out". `instant`
 * (navigation, a hidden tab, reduced motion, a page that hasn't settled) swaps with no show.
 * `queued` = the decision was made while a show or wipe was playing and waited for it to finish:
 * it plays quietly, so one show never runs straight into another.
 */
export function switchPath(next: HalfMode, instant: boolean, queued: boolean): SwitchPath {
  if (instant) return "instant";
  if (next === "app") return "out";
  return queued ? "in-quiet" : "in";
}

/**
 * Whether a click on a link plays the full show on its way to the opener: a pointer tap
 * (`pointer`: not keyboard activation, main button, no modifier keys) on a `#growth` link while
 * the page is on the app side, nothing is playing and the switch isn't instant. Every such tap
 * plays it. In Growth a tap is a plain jump to the opener: the show is the move from the app.
 */
export function tapPlaysShow(tap: {
  href: string;
  pointer: boolean;
  mode: HalfMode;
  playing: boolean;
  instant: boolean;
}): boolean {
  return (
    tap.href === "#growth" && tap.pointer && tap.mode === "app" && !tap.playing && !tap.instant
  );
}
