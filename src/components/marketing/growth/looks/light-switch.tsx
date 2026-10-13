import { growthCopy } from "../growth-copy";
import { OUT_DONE_MS } from "../switch-rules";
import type { Look } from "./index";
import { LIGHT_DONE_MS, LIGHT_REALIGN_AT_MS, LIGHT_THEME_AT_MS } from "./light-switch-rules";

/**
 * Look 1, "Light switch" (TEMPORARY preview, `/?look=1`): a wall rocker switch pops out of the
 * page, flips from "The app" to "One-on-one", and the dark spreads out of it; at the end the plate
 * sinks back into the wall and the dark drains into it. Decorative only
 * (rendered inside the aria-hidden, inert stage): spans, no role, nothing to tap. Styles in
 * src/styles/theme.css ("look 1: light switch"); timings in light-switch-rules.ts.
 *
 * Nothing here carries a pill class (.sa-switch-flood / -edge / -center / -graphic), so none of
 * the current look's unscoped rules touch it.
 */
function LightSwitchStage() {
  const c = growthCopy.switch;
  return (
    <>
      {/* The quiet paths' cover: a disc of the old colour that drains into the middle. */}
      <div className="sa-ls-cover" />
      <div className="sa-ls-show">
        {/* The dark: a charcoal disc, scaled (never clipped) out from behind the plate. Its rim
            (its own border) turns off-white as it drains, so the edge is always marked. */}
        <div className="sa-ls-dark" />
        <div className="sa-ls-center">
          <div className="sa-ls-pop">
            <div className="sa-ls-plate" data-sa-switch-graphic>
              <span className="sa-ls-screw" />
              {/* The active label is inverted (a charcoal chip): "inversion means status". */}
              <span
                className="sa-ls-label sa-headline-serif text-xl sm:text-2xl lg:text-3xl"
                data-label="from"
              >
                <span>{c.from}</span>
                <span className="sa-ls-chip">{c.from}</span>
              </span>
              <span className="sa-ls-paddle">
                <span className="sa-ls-press" />
              </span>
              <span
                className="sa-ls-label sa-headline-heavy text-lg sm:text-2xl lg:text-3xl"
                data-label="to"
              >
                <span>{c.to}</span>
                <span className="sa-ls-chip">{c.to}</span>
              </span>
              <span className="sa-ls-screw" />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export const lightSwitchLook: Look = {
  id: "1",
  Stage: LightSwitchStage,
  timing: {
    themeAtMs: LIGHT_THEME_AT_MS,
    realignAtMs: LIGHT_REALIGN_AT_MS,
    doneMs: LIGHT_DONE_MS,
    quietDoneMs: OUT_DONE_MS,
  },
};
