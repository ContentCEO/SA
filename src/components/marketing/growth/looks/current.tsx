import { growthCopy } from "../growth-copy";
import { IN_DONE_MS, IN_REALIGN_AT_MS, IN_THEME_AT_MS, OUT_DONE_MS } from "../switch-rules";
import type { Look } from "./index";

/**
 * The look the homepage has today: a charcoal cover sweeps up, the little switch flicks from
 * "The app" to "One-on-one", holds, and the cover lifts off the top onto the opener. Styles in
 * src/styles/theme.css (the "Homepage switch" block); timings in switch-rules.ts.
 */
function CurrentStage() {
  const c = growthCopy.switch;
  const label = "text-xl font-black sm:text-3xl";
  return (
    <div className="sa-switch-flood">
      <span className="sa-switch-edge" data-edge="top" />
      <span className="sa-switch-edge" data-edge="bottom" />
      <div className="sa-switch-center">
        <div className="sa-switch-graphic" data-sa-switch-graphic>
          <span className="sa-switch-knob" />
          {/* Off-white words on charcoal, and a charcoal copy clipped to the knob's shape on
              top: the words invert exactly where the knob passes, never blank. */}
          <span className="sa-switch-labels" data-ink="light">
            <span className={label}>{c.from}</span>
            <span className={label}>{c.to}</span>
          </span>
          <span className="sa-switch-labels" data-ink="dark">
            <span className={label}>{c.from}</span>
            <span className={label}>{c.to}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

export const currentLook: Look = {
  id: "current",
  Stage: CurrentStage,
  timing: {
    themeAtMs: IN_THEME_AT_MS,
    realignAtMs: IN_REALIGN_AT_MS,
    doneMs: IN_DONE_MS,
    quietDoneMs: OUT_DONE_MS,
  },
};
