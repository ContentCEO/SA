import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DISCARD_SPOKEN, DiscardCountdown, SwipeLabel } from "@/app/(app)/queue/swipe-parts";

const status = (html: string) =>
  html.match(/<p role="status" class="sr-only">([^<]*)<\/p>/)?.[1]?.replace(/&#x27;/g, "'");

describe("Check 9 P14: swipe to discard", () => {
  it("the countdown is announced once: the status words never change per tick", () => {
    const said = [5, 4, 3, 2, 1].map((left) =>
      status(renderToStaticMarkup(createElement(DiscardCountdown, { left }))),
    );
    expect(new Set(said)).toEqual(new Set([DISCARD_SPOKEN]));
    expect(DISCARD_SPOKEN).toBe("Discarding in 5 seconds. Undo to keep it.");
    // The ticking number is visible but hidden from screen readers.
    expect(renderToStaticMarkup(createElement(DiscardCountdown, { left: 3 }))).toContain(
      '<p class="font-semibold" aria-hidden="true">Discarding in 3…',
    );
  });

  it("the uncovered strip says Open or Discard, mirrored for a left thumb", () => {
    const label = (dx: number, toSend: 1 | -1) =>
      renderToStaticMarkup(createElement(SwipeLabel, { dx, toSend }));
    expect(label(0, 1)).toBe("");
    expect(label(60, 1)).toContain(">Open<");
    expect(label(-60, 1)).toContain(">Discard<");
    expect(label(60, -1)).toContain(">Discard<");
    expect(label(-60, -1)).toContain(">Open<");
    expect(label(60, 1)).toContain('aria-hidden="true"');
  });
});
