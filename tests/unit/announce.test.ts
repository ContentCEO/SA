import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANNOUNCE_DELAY_MS, ANNOUNCER_ID, announce } from "@/lib/announce";
import {
  entryApplies,
  FOCUS_ENTRY_MAX_AGE_MS,
  parseEntry,
  targetSelectors,
} from "@/lib/focus-after-save";

/** Check 32 P5: notices are read out through always-present live regions. */
describe("announce (what Notice does after mount)", () => {
  function setup() {
    const region = { textContent: "old words" as string | null };
    const timers: { fn: () => void; ms: number }[] = [];
    const schedule = (fn: () => void, ms: number) => timers.push({ fn, ms });
    const find = (id: string) => (id === ANNOUNCER_ID ? region : null);
    return { region, timers, schedule, find };
  }

  it("clears the region, then writes the notice's words 100ms later", () => {
    const { region, timers, schedule, find } = setup();
    announce(find, "  Saved.\n ", schedule, () => {});
    expect(region.textContent).toBe("");
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(ANNOUNCE_DELAY_MS);
    timers[0]!.fn();
    expect(region.textContent).toBe("Saved.");
  });

  it("the same words again are cleared and written again (read twice)", () => {
    const { region, timers, schedule, find } = setup();
    region.textContent = "Saved.";
    announce(find, "Saved.", schedule, () => {});
    expect(region.textContent).toBe("");
    timers[0]!.fn();
    expect(region.textContent).toBe("Saved.");
  });

  it("two writers of the same words in one render write once", () => {
    const { region, timers, schedule, find } = setup();
    announce(find, "Saved.", schedule, () => {});
    announce(find, "Saved.", schedule, () => {});
    timers[0]!.fn();
    const node = region.textContent;
    timers[1]!.fn();
    expect(region.textContent).toBe(node);
  });

  it("cleanup cancels a pending write and empties the region it filled", () => {
    const { region, timers, schedule, find } = setup();
    const cancelled: unknown[] = [];
    const stop = announce(find, "Saved.", schedule, (h) => cancelled.push(h));
    timers[0]!.fn();
    stop();
    expect(cancelled).toHaveLength(1);
    expect(region.textContent).toBe("");
  });

  it("does nothing without words; a missing region just stays missing", () => {
    const { timers, schedule } = setup();
    announce(
      () => ({ textContent: "" }),
      "   ",
      schedule,
      () => {},
    )();
    expect(timers).toHaveLength(0);
    announce(
      () => null,
      "Saved.",
      schedule,
      () => {},
    );
    expect(() => timers[0]!.fn()).not.toThrow();
  });

  it("a region that mounts after the notice (first load) still gets the words", () => {
    const { timers, schedule } = setup();
    let region: { textContent: string | null } | null = null;
    announce(
      () => region,
      "Saved.",
      schedule,
      () => {},
    );
    region = { textContent: "" };
    timers[0]!.fn();
    expect(region.textContent).toBe("Saved.");
  });

  it("Notice announces after mount and isn't a second live region; the region is in the root layout", () => {
    const notice = readFileSync("src/components/app/notice.tsx", "utf8");
    expect(notice).toMatch(/^"use client";/);
    expect(notice).toMatch(/useEffect\(\(\) => \{[\s\S]*announce\(findRegion/);
    expect(notice).toContain('aria-live={strong ? undefined : "off"}');
    const layout = readFileSync("src/app/layout.tsx", "utf8");
    expect(layout).toContain("<Announcer />");
    const region = readFileSync("src/components/app/announcer.tsx", "utf8");
    expect(region).toContain('setAttribute("role", "status")');
    expect(region).toContain('setAttribute("aria-live", "polite")');
    // Kept out of the page's own text (the words are on screen already).
    expect(region).toContain('attachShadow({ mode: "closed" })');
  });
});

describe("focus after a settings save", () => {
  const now = 1_000_000;
  const entry = { path: "/settings/follow-ups", at: now - 1000, name: "enabled" };

  it("applies on the same screen, soon after, with a notice in the URL", () => {
    const where = { path: "/settings/follow-ups", search: "?done=saved", now };
    expect(entryApplies(entry, where)).toBe(true);
    expect(entryApplies(entry, { ...where, search: "error=nope" })).toBe(true);
    expect(entryApplies(entry, { ...where, search: "" })).toBe(false);
    expect(entryApplies(entry, { ...where, path: "/settings/phone" })).toBe(false);
    expect(entryApplies(entry, { ...where, now: entry.at + FOCUS_ENTRY_MAX_AGE_MS + 1 })).toBe(
      false,
    );
    expect(entryApplies(null, where)).toBe(false);
  });

  it("parses only what it wrote", () => {
    expect(parseEntry(JSON.stringify(entry))).toEqual(entry);
    expect(parseEntry("{")).toBeNull();
    expect(parseEntry('{"path":1}')).toBeNull();
    expect(parseEntry(null)).toBeNull();
  });

  it("finds the control by key, or by name and value", () => {
    const esc = (s: string) => s.replace(/"/g, '\\"');
    expect(targetSelectors({ ...entry, refocus: "followups-save" }, esc)).toEqual([
      '[data-refocus="followups-save"]',
    ]);
    expect(targetSelectors(entry, esc)).toEqual(['[name="enabled"]']);
    expect(targetSelectors({ ...entry, name: "hand", value: "left" }, esc)).toEqual([
      '[name="hand"][value="left"]',
      '[name="hand"]',
    ]);
    expect(targetSelectors({ path: "/settings", at: now }, esc)).toEqual([]);
  });
});
