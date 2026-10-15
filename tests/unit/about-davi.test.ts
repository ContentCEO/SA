import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(__dirname, "../../src/components/marketing/about-davi.tsx"),
  "utf8",
);
// The words a visitor reads: JSX text and string props, without the code comments.
const words = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("homepage About section", () => {
  it("uses no pronouns for Davi and never says builder", () => {
    expect(words).not.toMatch(/\b(he|him|his|himself|builder)\b/i);
  });

  it("never says GC and shows no license number", () => {
    expect(words).not.toMatch(/\bGC\b|general contractor|license (no\.|number|#)/i);
  });

  it("keeps the signature serif-over-heavy headline", () => {
    expect(source).toContain('serif="who\'s behind this," heavy="someone in the trades."');
  });
});
