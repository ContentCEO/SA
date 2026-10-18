import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/queue/actions", () => ({ reviseDraftAction: async () => {} }));
const { HoldToTalk, SayAChange, VOICE_NOTE_GENERAL, voiceNote } =
  await import("@/app/(app)/queue/revise-controls");

/** Check 48 P5: the voice note is true for every browser that shows Hold to talk. */
const UA = {
  chrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  safari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  chromeIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1",
};

describe("Check 48 P5: the voice note", () => {
  it("names every maker in general, one company only when the browser clearly says", () => {
    expect(VOICE_NOTE_GENERAL).toContain("(Google, Apple or Microsoft)");
    expect(VOICE_NOTE_GENERAL).toContain("Prefer not to? Type it in the box.");
    expect(voiceNote(UA.chrome)).toBe(VOICE_NOTE_GENERAL);
    expect(voiceNote(UA.chromeIos)).toBe(VOICE_NOTE_GENERAL);
    expect(voiceNote("")).toBe(VOICE_NOTE_GENERAL);
    expect(voiceNote(UA.edge)).toContain("to Microsoft to turn it into text.");
    expect(voiceNote(UA.safari)).toContain("to Apple to turn it into text.");
  });

  it("renders whenever Hold to talk renders, and never without it", () => {
    const withButton = renderToStaticMarkup(
      createElement(HoldToTalk, {
        listening: false,
        onStart: () => {},
        onStop: () => {},
        note: VOICE_NOTE_GENERAL,
      }),
    ).replace(/&#x27;/g, "'");
    expect(withButton).toContain("Hold to talk");
    expect(withButton).toContain(VOICE_NOTE_GENERAL);
    expect(withButton).toMatch(/<p class="text-base[^"]*">/);
    // No speech recognition (as on the server): neither the button nor the note.
    const without = renderToStaticMarkup(
      createElement(SayAChange, { draftId: "d", threadId: "t", seenHash: "h" }),
    );
    expect(without).not.toContain("Hold to talk");
    expect(without).not.toContain("to turn it into text");
  });
});
