import { growthCopy } from "./growth-copy";
import { BW_BANDS, bandSide } from "./big-words-rules";

/**
 * "Big words", the homepage switch's picture (GrowthSwitch renders it inside its aria-hidden,
 * inert stage): five charcoal bands slam in from alternate sides, the middle one first carrying
 * "Your inbox" in huge serif; the words tick over to "Your marketing" in huge heavy sans, which inverts
 * ("inversion means status"); the bands fly back out the way they came, outer ones first, onto the
 * opener. The quiet paths are the bare bands. Decorative only: spans, no role, nothing to tap.
 * Styles in src/styles/theme.css (the "Homepage switch" block); timings in big-words-rules.ts.
 *
 * The words live inside the middle band, which clips them (overflow hidden), so the tick-over is
 * two transforms.
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

export function BigWordsStage() {
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
