import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/(app)/queue/actions", () => ({ undoSendAction: async () => {} }));

const { SentStrip } = await import("@/app/(app)/queue/sent-strip");
const { UndoSend, UNDO_SPOKEN, UNDO_TIME_UP } = await import("@/app/(app)/queue/undo-send");
const { UNDO_WINDOW_SECONDS } = await import("@/config/drafting");

const srOnly = (html: string) =>
  html.match(/<p role="status" class="sr-only">([^<]*)<\/p>/)?.[1]?.replace(/&#x27;/g, "'");

describe("Check 32 P7: after Send reply", () => {
  afterEach(() => vi.useRealTimers());

  it("the sent box is the page's h1 and can take focus", () => {
    const html = renderToStaticMarkup(
      createElement(SentStrip, { serif: "reply on its way,", heavy: "squared away." }),
    );
    expect(html).toMatch(/<h1 id="sent-heading"[^>]*>.*reply on its way,.*squared away\..*<\/h1>/);
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-labelledby="sent-heading"');
    expect(html).toContain('aria-live="polite"');
  });

  it("says the undo time once, and the same words whatever second it is", () => {
    expect(UNDO_SPOKEN).toBe(`You have ${UNDO_WINDOW_SECONDS} seconds to undo.`);
    const start = new Date("2026-10-17T12:00:00Z");
    const sendAt = new Date(start.getTime() + UNDO_WINDOW_SECONDS * 1000).toISOString();
    const spoken: string[] = [];
    for (const s of [0, 3, 11, 19]) {
      vi.useFakeTimers({ now: start.getTime() + s * 1000 });
      const html = renderToStaticMarkup(createElement(UndoSend, { draftIds: ["d"], sendAt }));
      spoken.push(srOnly(html)!);
      // The ticking seconds are visible but hidden from screen readers.
      expect(html).toMatch(
        /<p class="font-semibold" aria-hidden="true">Sending in \d+ seconds?\.<\/p>/,
      );
    }
    expect(new Set(spoken)).toEqual(new Set([UNDO_SPOKEN]));
    vi.useFakeTimers({ now: start.getTime() + (UNDO_WINDOW_SECONDS + 1) * 1000 });
    const done = renderToStaticMarkup(createElement(UndoSend, { draftIds: ["d"], sendAt }));
    expect(srOnly(done)).toBe(UNDO_TIME_UP);
  });
});
