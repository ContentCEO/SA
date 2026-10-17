import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The homepage's words, held to what the code does (wave 1, Homepage words). */
const flat = (s: string) => s.replace(/\s+/g, " ").replace(/&apos;/g, "'");
const page = () => flat(readFileSync("src/app/page.tsx", "utf8"));

describe("Writes like you (Check 6 P1)", () => {
  it("says the drafts are written by AI and that a new price, day or promise is flagged", () => {
    expect(page()).toContain("The drafts are written by AI");
    expect(page()).toContain("it's flagged so you can check it before you send");
    expect(page()).not.toContain("never invents");
  });
});
