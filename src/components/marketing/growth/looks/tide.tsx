import { growthCopy } from "../growth-copy";
import { OUT_DONE_MS } from "../switch-rules";
import type { Look } from "./index";
import { TIDE_BUMPS, TIDE_DONE_MS, TIDE_REALIGN_AT_MS, TIDE_THEME_AT_MS } from "./tide-rules";

/**
 * Look 3, "Tide" (TEMPORARY preview, `/?look=3`): a charcoal tide comes in from the bottom in two
 * surges, its scalloped crest rolling sideways, one big line riding just behind it: "The app",
 * inverted ("inversion means status"), which becomes "One-on-one", inverted, in one frame; then
 * the tide goes out, down off the screen, the line riding it out, onto the opener. Decorative only (rendered inside the aria-hidden,
 * inert stage): spans, no role, nothing to tap. Styles in src/styles/theme.css ("look 3: tide");
 * timings in tide-rules.ts.
 *
 * The crest is a row of half-ellipses sitting on the water's top edge (no SVG, no gradients);
 * everything moves with transforms. Nothing here carries a class of another look (.sa-switch-*,
 * .sa-ls-*, .sa-cu-*), so none of their rules touch it.
 */
const BUMPS = Array.from({ length: TIDE_BUMPS }, (_, i) => i);

function TideStage() {
  const c = growthCopy.switch;
  return (
    <div className="sa-td-water">
      <div className="sa-td-crest">
        <div className="sa-td-roll">
          {BUMPS.map((i) => (
            <span key={i} className="sa-td-bump" />
          ))}
        </div>
      </div>
      <div className="sa-td-card">
        <div className="sa-td-title" data-sa-switch-graphic>
          <span className="sa-td-label sa-headline-serif" data-label="from">
            <span>{c.from}</span>
            <span className="sa-td-chip">{c.from}</span>
          </span>
          <span className="sa-td-label sa-headline-heavy" data-label="to">
            <span>{c.to}</span>
            <span className="sa-td-chip">{c.to}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

export const tideLook: Look = {
  id: "3",
  Stage: TideStage,
  timing: {
    themeAtMs: TIDE_THEME_AT_MS,
    realignAtMs: TIDE_REALIGN_AT_MS,
    doneMs: TIDE_DONE_MS,
    quietDoneMs: OUT_DONE_MS,
  },
};
