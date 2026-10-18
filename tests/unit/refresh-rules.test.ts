import { describe, expect, it } from "vitest";
import {
  REFRESH_AFTER_HIDDEN_MS,
  returnDecision,
  takesTyping,
  updatedTime,
} from "@/lib/refresh-rules";

/** Check 8 P3: coming back to the app refreshes the list, never under an open edit. */
describe("returnDecision", () => {
  const base = { now: 1_000_000, typing: false, editing: false };

  it("refreshes after a minute or more away", () => {
    expect(returnDecision({ ...base, hiddenAt: base.now - REFRESH_AFTER_HIDDEN_MS })).toBe(
      "refresh",
    );
    expect(returnDecision({ ...base, hiddenAt: base.now - 10 * 60_000 })).toBe("refresh");
  });

  it("leaves a quick look away alone", () => {
    expect(returnDecision({ ...base, hiddenAt: base.now - 59_999 })).toBe("no");
    expect(returnDecision({ ...base, hiddenAt: null })).toBe("no");
  });

  it("waits while the owner is typing or editing a draft", () => {
    const away = base.now - 2 * 60_000;
    expect(returnDecision({ ...base, hiddenAt: away, typing: true })).toBe("later");
    expect(returnDecision({ ...base, hiddenAt: away, editing: true })).toBe("later");
    // A short look away while editing is still nothing to do.
    expect(returnDecision({ ...base, hiddenAt: base.now - 1000, editing: true })).toBe("no");
  });
});

describe("takesTyping", () => {
  it("counts text boxes and textareas, not switches or buttons", () => {
    expect(takesTyping({ tagName: "TEXTAREA" })).toBe(true);
    expect(takesTyping({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(takesTyping({ tagName: "INPUT", type: "" })).toBe(true);
    expect(takesTyping({ tagName: "INPUT", type: "email" })).toBe(true);
    expect(takesTyping({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(takesTyping({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(takesTyping({ tagName: "INPUT", type: "radio" })).toBe(false);
    expect(takesTyping({ tagName: "BUTTON" })).toBe(false);
    expect(takesTyping({ tagName: "A" })).toBe(false);
  });
});

describe("updatedTime", () => {
  it("is the owner's clock time", () => {
    const at = new Date("2026-10-18T13:41:00Z");
    expect(updatedTime(at, "America/New_York")).toBe("9:41 AM");
    expect(updatedTime(at, "America/Los_Angeles")).toBe("6:41 AM");
  });
});
