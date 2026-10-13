import { growthCopy } from "../growth-copy";
import { OUT_DONE_MS } from "../switch-rules";
import type { Look } from "./index";
import { BL_DONE_MS, BL_REALIGN_AT_MS, BL_SLATS, BL_THEME_AT_MS } from "./blinds-rules";

/**
 * Look 5, "Blinds" (TEMPORARY preview, `/?look=5`): a charcoal venetian blind drops over the page
 * with its slats open (plain charcoal bars), the slats tilt shut and a word is printed on every
 * slat, eight rows of "The app", inverted ("inversion means status"); the slats tilt over once and
 * come back with "One-on-one" on every slat instead, inverted; then they tilt open and the opener
 * shows through the blind.
 * Decorative only (rendered inside the aria-hidden, inert stage): spans, no role, nothing to tap.
 * Styles in src/styles/theme.css ("look 5: blinds"); timings in blinds-rules.ts.
 *
 * Each slat (overflow hidden) carries its own copy of the word, centred in it, so every word
 * squashes with its slat as it tilts and no chip ever crosses a slat boundary. Transforms only. Nothing here carries a class of another look (.sa-switch-*, .sa-ls-*,
 * .sa-cu-*, .sa-td-*, .sa-bw-*), so none of their rules touch it.
 */
const SLATS = Array.from({ length: BL_SLATS }, (_, i) => i);

function Title({ graphic }: { graphic: boolean }) {
  const c = growthCopy.switch;
  return (
    <div className="sa-bl-title" data-sa-switch-graphic={graphic ? "" : undefined}>
      <span className="sa-bl-label sa-headline-serif" data-label="from">
        <span>{c.from}</span>
        <span className="sa-bl-chip">{c.from}</span>
      </span>
      <span className="sa-bl-label sa-headline-heavy" data-label="to">
        <span>{c.to}</span>
        <span className="sa-bl-chip">{c.to}</span>
      </span>
    </div>
  );
}

function BlindsStage() {
  return (
    <div className="sa-bl-blind">
      {/* Under the slats: on once they're shut, so the tilt never shows the page. */}
      <span className="sa-bl-back" />
      {SLATS.map((i) => (
        <div key={i} className="sa-bl-slat" data-slat={i}>
          <div className="sa-bl-card">
            <Title graphic={i === 0} />
          </div>
        </div>
      ))}
    </div>
  );
}

export const blindsLook: Look = {
  id: "5",
  Stage: BlindsStage,
  timing: {
    themeAtMs: BL_THEME_AT_MS,
    realignAtMs: BL_REALIGN_AT_MS,
    doneMs: BL_DONE_MS,
    quietDoneMs: OUT_DONE_MS,
  },
};
