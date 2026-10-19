import { describe, expect, it } from "vitest";
import {
  CHAR_EM_NARROW,
  CHAR_EM_WIDE,
  FOLD_NARROWEST_EM,
  FOLD_WIDEST_EM,
  foldGuess,
  wrappedLines,
} from "@/lib/draft-fold";

describe("wrappedLines (white-space: pre-line)", () => {
  it("counts each line break, blank lines included", () => {
    expect(wrappedLines("Hi Avery,\n\nThanks, Sam", 40)).toBe(3);
    expect(wrappedLines("\n\nHi\n\n", 40)).toBe(1); // trimmed, as the card's text is
  });
  it("wraps whole words and collapses runs of spaces", () => {
    expect(wrappedLines("aaaa bbbb cccc", 9)).toBe(2); // "aaaa bbbb" / "cccc"
    expect(wrappedLines("aaaa     bbbb", 9)).toBe(1);
    expect(wrappedLines("aaaa bbbbb", 9)).toBe(2);
  });
  it("a word longer than a line: one line (overflowing) or split", () => {
    const url = "https://example.com/" + "x".repeat(40);
    expect(wrappedLines(`See ${url}`, 20, "one")).toBe(2);
    expect(wrappedLines(`See ${url}`, 20, "split")).toBe(4); // "See" + 60 chars over 3 lines
  });
});

describe("foldGuess", () => {
  it("the bounds sit outside what the card really measures", () => {
    // Measured (2026-10-19, Chromium): 30.25em wide on desktop, 17.7em at 375px; real sentences
    // average 0.42em a character.
    expect(FOLD_WIDEST_EM).toBeGreaterThanOrEqual(30.25);
    expect(FOLD_NARROWEST_EM).toBeLessThanOrEqual(12.1);
    expect(CHAR_EM_NARROW).toBeLessThan(0.42);
    expect(CHAR_EM_WIDE).toBeGreaterThan(0.42);
  });
  it("five or more lines by line break: cut", () => {
    expect(
      foldGuess(
        "Hey Priya,\n\nWhat's the address, and how old is the current panel?\n\nThanks, Davi",
      ),
    ).toBe("cut");
  });
  it("four lines that wrap past four even on the widest card: cut", () => {
    expect(
      foldGuess(
        "Hi Priya,\nThanks for the photos. I can do the panel upgrade and the new circuit for the range in one visit, and we pull the permit.\nWhat's the address?\nThanks, Davi",
      ),
    ).toBe("cut");
  });
  it("short lines that fit even on the narrowest card: fits", () => {
    expect(foldGuess("Hi Avery,\nYes, we can do that.\nThanks, Sam")).toBe("fits");
    expect(foldGuess("Sounds good, see you then.")).toBe("fits");
  });
  it("in between (fits a desktop card, maybe not a phone): maybe", () => {
    expect(
      foldGuess(
        "Hi Avery,\nYes, we pull the gas permit and book the inspection for you.\nThanks, Sam",
      ),
    ).toBe("maybe");
  });
});
