import { growthCopy } from "../growth-copy";
import { OUT_DONE_MS } from "../switch-rules";
import type { Look } from "./index";
import { CURTAIN_DONE_MS, CURTAIN_REALIGN_AT_MS, CURTAIN_THEME_AT_MS } from "./curtains-rules";

/**
 * Look 2, "Curtains" (TEMPORARY preview, `/?look=2`): two charcoal curtains draw shut from the
 * sides, each carrying its half of one huge heavy "One-on-one" stacked like a poster ("One-" /
 * "on-" / "one"), so the word is whole only where they meet; it then inverts (an off-white chip: "inversion means status"), and the curtains open
 * onto the opener. Decorative only (rendered inside the aria-hidden, inert stage):
 * spans, no role, nothing to tap. Styles in src/styles/theme.css ("look 2: curtains"); timings
 * in curtains-rules.ts.
 *
 * Each half is a 50%-wide window (overflow hidden) onto a full-width copy of the word, centred
 * on the seam, so the two halves line up exactly when the curtains meet. Transforms only.
 * Nothing here carries a class of the current look (.sa-switch-*), so none of its unscoped rules
 * touch it.
 */
/** "One-on-one" as a stack, a part per line, each keeping its hyphen ("One-" / "on-" / "one"). */
const STACK = growthCopy.switch.to
  .split("-")
  .map((part, i, all) => (i < all.length - 1 ? `${part}-` : part));

function Stack() {
  return (
    <>
      {STACK.map((line) => (
        <span key={line} className="sa-cu-line">
          {line}
        </span>
      ))}
    </>
  );
}

function Title({ graphic }: { graphic: boolean }) {
  return (
    <div className="sa-cu-card">
      <div className="sa-cu-title" data-sa-switch-graphic={graphic ? "" : undefined}>
        <span className="sa-cu-label sa-headline-heavy" data-label="to">
          <span className="sa-cu-stack">
            <Stack />
          </span>
          <span className="sa-cu-chip">
            <Stack />
          </span>
        </span>
      </div>
    </div>
  );
}

function CurtainsStage() {
  return (
    <div className="sa-cu-stage">
      {/* Under both halves: fills the last gap as they meet, so no page shows between them. */}
      <span className="sa-cu-seam" />
      <div className="sa-cu-half" data-side="left">
        <Title graphic />
        <span className="sa-cu-edge" />
      </div>
      <div className="sa-cu-half" data-side="right">
        <Title graphic={false} />
        <span className="sa-cu-edge" />
      </div>
    </div>
  );
}

export const curtainsLook: Look = {
  id: "2",
  Stage: CurtainsStage,
  timing: {
    themeAtMs: CURTAIN_THEME_AT_MS,
    realignAtMs: CURTAIN_REALIGN_AT_MS,
    doneMs: CURTAIN_DONE_MS,
    quietDoneMs: OUT_DONE_MS,
  },
};
