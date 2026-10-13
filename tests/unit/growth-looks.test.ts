import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOOK,
  PREVIEW_LOOK_IDS,
  lookFor,
  lookIdFrom,
} from "@/components/marketing/growth/looks";
import * as rules from "@/components/marketing/growth/switch-rules";

/** The TEMPORARY `?look=` preview chooser for the homepage switch (remove once Davi picks). */
describe("homepage switch look chooser", () => {
  it("no param, or anything that isn't 1–5, is the current look", () => {
    for (const search of [
      "",
      "?",
      "?look=",
      "?look=0",
      "?look=6",
      "?look=01",
      "?look=%201",
      "?look=1.0",
      "?look=current",
      "?look=one",
      "?Look=1",
      "?looks=1",
      "?ref=abc",
    ]) {
      expect(lookIdFrom(search), search).toBe(DEFAULT_LOOK);
    }
    expect(DEFAULT_LOOK).toBe("current");
  });

  it("?look=1 … ?look=5 pick that look, alongside other params", () => {
    for (const id of PREVIEW_LOOK_IDS) {
      expect(lookIdFrom(`?look=${id}`)).toBe(id);
      expect(lookIdFrom(`?ref=abc&look=${id}`)).toBe(id);
      expect(lookIdFrom(`look=${id}`)).toBe(id);
    }
    expect(PREVIEW_LOOK_IDS).toEqual(["1", "2", "3", "4", "5"]);
    // The first value wins, as URLSearchParams.get does.
    expect(lookIdFrom("?look=2&look=3")).toBe("2");
  });

  it("the current look keeps today's timings", () => {
    const look = lookFor("current");
    expect(look.id).toBe("current");
    expect(look.timing).toEqual({
      themeAtMs: rules.IN_THEME_AT_MS,
      realignAtMs: rules.IN_REALIGN_AT_MS,
      doneMs: rules.IN_DONE_MS,
      quietDoneMs: rules.OUT_DONE_MS,
    });
  });

  it("every look resolves to a show, and its timeline is in order", () => {
    for (const id of [DEFAULT_LOOK, ...PREVIEW_LOOK_IDS]) {
      const look = lookFor(id);
      // A look not built yet plays the current one (so its id is "current").
      expect([id, "current"]).toContain(look.id);
      expect(typeof look.Stage).toBe("function");
      const t = look.timing;
      expect(t.themeAtMs).toBeGreaterThan(0);
      expect(t.realignAtMs).toBeGreaterThan(t.themeAtMs);
      expect(t.doneMs).toBeGreaterThan(t.realignAtMs);
      expect(t.quietDoneMs).toBeGreaterThan(0);
    }
  });
});
