"use client";

import { useState } from "react";
import { findGaps, fillGap } from "@/ai/gaps";
import { Button } from "@/components/ui/button";
import { confidenceWords, type ConfidenceLabel } from "@/config/drafting";
import { cn } from "@/lib/utils";

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
export function BodyWithGaps({
  body,
  onChange,
  expanded,
  readOnly,
}: {
  body: string;
  onChange: (next: string) => void;
  expanded: boolean;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [value, setValue] = useState("");
  const gaps = findGaps(body);

  const parts: React.ReactNode[] = [];
  let rest = body;
  gaps.forEach((g, i) => {
    const at = rest.indexOf(g.token);
    parts.push(rest.slice(0, at));
    parts.push(
      <button
        key={i}
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
      <p className={cn("whitespace-pre-line", !expanded && !gaps.length && "line-clamp-4")}>
        {parts}
      </p>
      {open !== null && gaps[open] ? (
        <form
          className="flex flex-col gap-2 rounded-lg border-2 border-charcoal p-3"
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
          <div className="grid grid-cols-2 gap-2">
            <Button type="submit">Fill in</Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
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
          <dd>{reason}</dd>
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
