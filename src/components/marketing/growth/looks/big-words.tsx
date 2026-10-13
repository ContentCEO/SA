import { growthCopy } from "../growth-copy";
import { OUT_DONE_MS } from "../switch-rules";
import type { Look } from "./index";
import {
  BW_BANDS,
  BW_DONE_MS,
  BW_REALIGN_AT_MS,
  BW_THEME_AT_MS,
  bandSide,
} from "./big-words-rules";

/**
 * Look 4, "Big words" (TEMPORARY preview, `/?look=4`): five charcoal bands slam in from alternate
 * sides, the middle one first carrying "The app" in huge serif; the words tick over to
 * "One-on-one" in huge heavy sans, which inverts ("inversion means status"); the bands fly back
 * out the way they came, outer ones first, onto the opener. Decorative only (rendered inside the aria-hidden, inert stage): spans,
 * no role, nothing to tap. Styles in src/styles/theme.css ("look 4: big words"); timings in
 * big-words-rules.ts.
 *
 * The words live inside the middle band, which clips them (overflow hidden), so the tick-over is
 * two transforms. Nothing here carries a class of another look (.sa-switch-*, .sa-ls-*, .sa-cu-*,
 * .sa-td-*), so none of their rules touch it.
 */
const MIDDLE = (BW_BANDS - 1) / 2;
const BANDS = Array.from({ length: BW_BANDS }, (_, i) => i);

function Words() {
  const c = growthCopy.switch;
  return (
    <div className="sa-bw-words" data-sa-switch-graphic>
      <span className="sa-bw-word sa-headline-serif" data-word="from">
        <span className="sa-bw-label">
          <span>{c.from}</span>
          <span className="sa-bw-chip">{c.from}</span>
        </span>
      </span>
      <span className="sa-bw-word sa-headline-heavy" data-word="to">
        <span className="sa-bw-label">
          <span>{c.to}</span>
          <span className="sa-bw-chip">{c.to}</span>
        </span>
      </span>
    </div>
  );
}

function BigWordsStage() {
  return (
    <div className="sa-bw-stage">
      {BANDS.map((i) => (
        <div key={i} className="sa-bw-band" data-band={i} data-side={bandSide(i)}>
          {i === MIDDLE ? <Words /> : null}
        </div>
      ))}
    </div>
  );
}

export const bigWordsLook: Look = {
  id: "4",
  Stage: BigWordsStage,
  timing: {
    themeAtMs: BW_THEME_AT_MS,
    realignAtMs: BW_REALIGN_AT_MS,
    doneMs: BW_DONE_MS,
    quietDoneMs: OUT_DONE_MS,
  },
};
