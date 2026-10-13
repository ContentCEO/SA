import type { ComponentType } from "react";
import { bigWordsLook } from "./big-words";
import { blindsLook } from "./blinds";
import { currentLook } from "./current";
import { curtainsLook } from "./curtains";
import { lightSwitchLook } from "./light-switch";
import { tideLook } from "./tide";
import { DEFAULT_LOOK, type LookId } from "./look-rules";

/*
 * TEMPORARY preview registry for the homepage switch's look (see look-rules.ts): maps a `?look=`
 * id to the show it plays. Once a look is picked, keep only that one (and drop the chooser).
 *
 * A look is only the picture and its clock. GrowthSwitch (growth-switch.tsx) keeps everything
 * else the same for every look: scrolling alone decides (switch-rules.ts hysteresis, no
 * strobing), reduced motion / navigation / load are instant swaps, taps and scrolling are held
 * while the full show covers the screen, the theme flips at `themeAtMs` under full cover and the
 * page lands on the opener (#growth), and scrolling back up reverses it to paper.
 *
 * Contract for a look's CSS (src/styles/theme.css): style only the look's own Stage markup,
 * driven by <html data-sa-switching="in" | "in-quiet" | "out"> and, for anything shared, scoped to
 * <html data-sa-look="<id>"> (set only for a look other than "current"). Two-tone theme tokens
 * only, transform/opacity animations, no CSS scroll or view timelines (older iOS Safari).
 */

export type LookTiming = {
  /** Full show: the screen is fully covered; the theme flips and the page moves to the opener. */
  themeAtMs: number;
  /** Full show: still covered; the opener is put back at the top if a fling moved the page. */
  realignAtMs: number;
  /** Full show: cleanup re-applies the theme and drops data-sa-switching. */
  doneMs: number;
  /** The quiet paths ("in-quiet" and "out"): cleanup. */
  quietDoneMs: number;
};

export type Look = {
  id: LookId;
  /** The decorative stage's content (rendered inside the aria-hidden, inert stage). */
  Stage: ComponentType;
  timing: LookTiming;
};

/** Looks 1–5 are added here as they are built; an id with no entry yet plays the current look. */
const LOOKS: Partial<Record<LookId, Look>> = {
  current: currentLook,
  "1": lightSwitchLook,
  "2": curtainsLook,
  "3": tideLook,
  "4": bigWordsLook,
  "5": blindsLook,
};

/** The look to play for `id`; the current look for the default or an id not built yet. */
export function lookFor(id: LookId): Look {
  return LOOKS[id] ?? LOOKS[DEFAULT_LOOK] ?? currentLook;
}

export { DEFAULT_LOOK, LOOK_PARAM, PREVIEW_LOOK_IDS, lookIdFrom } from "./look-rules";
export type { LookId, PreviewLookId } from "./look-rules";
