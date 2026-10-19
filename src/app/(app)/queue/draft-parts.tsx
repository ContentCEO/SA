"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { findGaps, fillGap } from "@/ai/gaps";
import { Button } from "@/components/ui/button";
import { confidenceWords, type ConfidenceLabel } from "@/config/drafting";
import { foldGuess } from "@/lib/draft-fold";
import { cn } from "@/lib/utils";
import { withoutCategoryPrefix } from "@/lib/card-words";
import { closeOnEscape } from "./focus";

/** Plan #8: three labels by weight and inversion — never colour. */
export function ConfidenceTag({ label }: { label: ConfidenceLabel }) {
  return (
    <span
      className={cn(
        "self-start rounded-md px-2 py-0.5 text-sm",
        label === "ready" && "border border-charcoal font-semibold",
        label === "check_details" && "border-2 border-charcoal font-black",
        label === "check_everything" && "sa-inverted font-black",
      )}
    >
      {confidenceWords[label]}
    </span>
  );
}

/**
 * Plan #2: the draft with each {{gap}} shown as a chip. Tapping a chip opens
 * a big input; the filled text replaces it. The parent owns the body.
 */
/** Which gap's fill box is open, and on which text (the card owns it: Check 9 P11). */
export type GapOpen = { index: number; body: string } | null;

export function BodyWithGaps({
  body,
  onChange,
  openGap,
  onOpenGap,
  expanded,
  onToggle,
  clamp = false,
  readOnly,
  priceSuggestions,
}: {
  body: string;
  onChange: (next: string) => void;
  /** Check 9 P11: the open fill box, held by the card so "Fill in 1 gap to send" can open it. */
  openGap: GapOpen;
  onOpenGap: (next: GapOpen) => void;
  expanded: boolean;
  /** "Show full draft" / "Show less" (shown only when the text really is cut short). */
  onToggle?: () => void;
  /**
   * Check 9 P7: may the text fold to four lines? Never above a Send reply button — the owner
   * reads the whole reply before okaying it — and never with a gap in it.
   */
  clamp?: boolean;
  readOnly?: boolean;
  /** Plan #15: the owner's past prices for similar jobs, offered in an open price gap. */
  priceSuggestions?: PastPrice[];
}) {
  // The form belongs to the text it was opened on. If that text changes from outside (a past
  // price tapped below the draft fills an earlier gap), the gaps shift under it, so the form
  // closes instead of putting the owner's answer into a different gap.
  const open = openGap && openGap.body === body ? openGap.index : null;
  const setOpen = (index: number | null) => onOpenGap(index === null ? null : { index, body });
  const [value, setValue] = useState("");
  const gaps = findGaps(body);
  const folds = clamp && !gaps.length;
  // Check 9 P7: the toggle only when folding hides something (measured while folded).
  const text = useRef<HTMLParagraphElement>(null);
  const [measured, setMeasured] = useState(false);
  // Only measured, the toggle appeared at hydration and pushed everything under the card (Edit,
  // Discard, They said no) down under a thumb (or a click) already on its way. So the server
  // guesses from the text (src/lib/draft-fold.ts): surely cut → the toggle is in its HTML;
  // maybe → the toggle's place is kept, hidden until measured; surely fits → none.
  const guess = folds ? foldGuess(body) : "fits";
  const surelyCut = guess === "cut";
  const cutShort = surelyCut || (folds && measured);
  const keepPlace = guess === "maybe";
  useLayoutEffect(() => {
    const el = text.current;
    if (!folds || expanded || !el) return;
    if (surelyCut) return;
    // A layout measurement of the folded text.
    setMeasured(el.scrollHeight > el.clientHeight + 1);
  }, [folds, expanded, body, surelyCut]);
  // Check 32 P1: Cancel (or Escape) puts focus back on the gap chip that opened the box.
  const chips = useRef<(HTMLButtonElement | null)[]>([]);
  const [returnTo, setReturnTo] = useState<number | null>(null);
  useEffect(() => {
    if (returnTo === null) return;
    chips.current[returnTo]?.focus();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot: focus has moved
    setReturnTo(null);
  }, [returnTo]);
  const cancel = () => {
    if (open !== null) setReturnTo(open);
    setOpen(null);
  };

  const parts: React.ReactNode[] = [];
  let rest = body;
  gaps.forEach((g, i) => {
    const at = rest.indexOf(g.token);
    parts.push(rest.slice(0, at));
    parts.push(
      <button
        key={i}
        ref={(el) => {
          chips.current[i] = el;
        }}
        type="button"
        disabled={readOnly}
        aria-label={`Fill in ${g.label}`}
        onClick={() => {
          setOpen(i);
          setValue("");
        }}
        className="sa-inverted mx-0.5 inline-flex min-h-tap items-center rounded-md px-2 align-middle font-black"
      >
        {g.label} ▸
      </button>,
    );
    rest = rest.slice(at + g.token.length);
  });
  parts.push(rest);

  return (
    <div className="flex flex-col gap-2">
      <p ref={text} className={cn("whitespace-pre-line", folds && !expanded && "line-clamp-4")}>
        {parts}
      </p>
      {(cutShort || keepPlace) && onToggle ? (
        // Kept in place while nothing is cut: `invisible` takes it off the screen, out of the
        // tab order and away from screen readers, and leaves its 44px where it is.
        <button
          type="button"
          className={cn(
            "inline-flex min-h-tap items-center self-start font-semibold underline underline-offset-4",
            !cutShort && "invisible",
          )}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? "Show less" : "Show full draft"}
        </button>
      ) : null}
      {open !== null && gaps[open] ? (
        <form
          className="flex flex-col gap-2 rounded-lg border-2 border-charcoal p-3"
          onKeyDown={closeOnEscape(cancel)}
          onSubmit={(e) => {
            e.preventDefault();
            if (!value.trim()) return;
            onChange(fillGap(body, open, value.trim()));
            setOpen(null);
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="font-semibold">What should “{gaps[open].label}” say?</span>
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode={gaps[open].kind === "price" ? "decimal" : "text"}
              placeholder={
                gaps[open].kind === "price"
                  ? "$450"
                  : gaps[open].kind === "date"
                    ? "Thursday the 14th"
                    : gaps[open].kind === "time"
                      ? "8am"
                      : ""
              }
              className="min-h-14 rounded-lg border border-input bg-paper px-3 text-2xl"
            />
          </label>
          {gaps[open].kind === "price" && priceSuggestions?.length ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold">Or use one of your past prices:</span>
              <div className="flex flex-wrap gap-2">
                {priceSuggestions.map((s, i) => (
                  <Button
                    key={i}
                    type="button"
                    variant="outline"
                    onClick={() => {
                      onChange(fillGap(body, open, s.value));
                      setOpen(null);
                    }}
                  >
                    <PastPriceText price={s} />
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <Button type="submit">Fill in</Button>
            <Button type="button" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

/** One past price the owner quoted for a similar job: "$1,800" and "Mar". */
export type PastPrice = { cents: number; value: string; month: string };

/**
 * The button text: "Use" for screen readers, then the figure. Never an aria-label —
 * error reports copy those from taps, and an amount must never leave (A9).
 */
function PastPriceText({ price }: { price: PastPrice }) {
  return (
    <>
      <span className="sr-only">Use </span>
      {price.value} ({price.month})
    </>
  );
}

/**
 * Plan #15 price memory: what the owner quoted for similar jobs. Only they see it,
 * and a figure goes into the draft only when they tap it — into a {{price}} gap.
 */
export function PastPrices({
  prices,
  canFill,
  readOnly,
  onUse,
}: {
  prices: PastPrice[];
  canFill: boolean;
  readOnly?: boolean;
  onUse: (value: string) => void;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 rounded-lg border p-3">
      <p id={id} className="font-semibold">
        {prices.length === 1 ? "Your last similar quote:" : `Last ${prices.length} similar quotes:`}
      </p>
      <div className="flex flex-wrap gap-2">
        {prices.map((p, i) => (
          <Button
            key={i}
            type="button"
            variant="outline"
            disabled={!canFill}
            onClick={() => onUse(p.value)}
          >
            <PastPriceText price={p} />
          </Button>
        ))}
      </div>
      {!canFill && !readOnly ? (
        <p className="text-sm font-semibold">No price gap left to fill.</p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Only you see these. They never go into a draft unless you tap.
      </p>
    </section>
  );
}

const FACT_LABELS: Record<string, string> = {
  price_list: "Your price list",
  services: "The work you do",
  service_area: "Your service area",
  hours: "Your hours",
  lead_time: "How far out you're booking",
  payment_terms: "How you get paid",
  policies: "Your policies",
  signature: "Your signature",
  never_promise: "Your never-promise list",
  never_say: "Your never-say list",
  seasonal_notes: "Your seasonal notes",
  trade_questions: "What to ask before quoting",
  voice_greeting: "Your usual greeting",
  voice_signoff: "Your usual sign-off",
  voice_phrases: "Phrases you use",
  voice_length: "How long you usually write",
  voice_examples: "Replies you've written",
};

/** Plan #1: just the facts — reason, what it used, what fired. No hidden reasoning. */
export function WhyThis({
  reason,
  usedFacts,
  flags,
}: {
  reason: string;
  usedFacts: string[];
  flags: string[];
}) {
  const facts = usedFacts.filter((f) => !f.startsWith("voice_") && FACT_LABELS[f]);
  const voice = usedFacts.filter((f) => f.startsWith("voice_") && FACT_LABELS[f]);
  return (
    <details className="group rounded-lg border">
      <summary className="flex min-h-tap cursor-pointer list-none items-center px-3 font-semibold underline underline-offset-4">
        Why this?
      </summary>
      <dl className="flex flex-col gap-2 px-3 pb-3 text-sm">
        <div>
          <dt className="font-black">What it is</dt>
          <dd>{withoutCategoryPrefix(reason)}</dd>
        </div>
        <div>
          <dt className="font-black">From your business profile</dt>
          <dd>
            {facts.length ? facts.map((f) => FACT_LABELS[f]).join(" · ") : "Nothing specific."}
          </dd>
        </div>
        <div>
          <dt className="font-black">From how you write</dt>
          <dd>
            {voice.length ? voice.map((f) => FACT_LABELS[f]).join(" · ") : "Nothing specific."}
          </dd>
        </div>
        <div>
          <dt className="font-black">Checks that fired</dt>
          <dd>{flags.length ? flags.join(" ") : "None."}</dd>
        </div>
      </dl>
    </details>
  );
}
