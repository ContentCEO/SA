import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fonts are self-hosted (src/app/_fonts, next/font/local) since 2026-10-15: next/font/google
 * downloads them at build time, and CI builds failed whenever Google Fonts was unreachable.
 * These checks keep every build free of that network call.
 */
const ROOT = resolve(__dirname, "../..");
const LAYOUT = join(ROOT, "src/app/layout.tsx");
const layout = readFileSync(LAYOUT, "utf8");

/** Every font file layout.tsx hands to next/font/local (`src: "…"` or `path: "…"`). */
const fontFiles = [
  ...new Set([...layout.matchAll(/\b(?:src|path):\s*"([^"]+\.woff2)"/g)].map((m) => m[1]!)),
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|css)$/.test(f))
    .map((f) => join(dir, f));
}

describe("self-hosted fonts", () => {
  it("nothing loads fonts from Google, so a build never fetches them", () => {
    expect(layout).not.toContain("next/font/google");
    expect(layout).toContain('from "next/font/local"');
    const files = [...sourceFiles(join(ROOT, "src")), join(ROOT, "next.config.ts")];
    const offenders = files.filter((f) =>
      /next\/font\/google|fonts\.(googleapis|gstatic)\.com/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("every font file layout.tsx references exists and is a real WOFF2 file", () => {
    expect(fontFiles).toEqual([
      "./_fonts/InterTight-latin.woff2",
      "./_fonts/InstrumentSerif-Italic-latin.woff2",
    ]);
    for (const rel of fontFiles) {
      const file = resolve(dirname(LAYOUT), rel);
      expect(existsSync(file), rel).toBe(true);
      const bytes = readFileSync(file);
      expect(bytes.subarray(0, 4).toString("latin1"), rel).toBe("wOF2");
      expect(bytes.length, rel).toBeGreaterThan(1_000);
    }
  });

  it("each family ships with its SIL Open Font License", () => {
    for (const name of ["InterTight-OFL.txt", "InstrumentSerif-OFL.txt"]) {
      const text = readFileSync(join(ROOT, "src/app/_fonts", name), "utf8");
      expect(text, name).toContain("SIL OPEN FONT LICENSE Version 1.1");
    }
  });

  it("keeps the CSS variables the theme reads", () => {
    expect(layout).toContain('variable: "--font-inter-tight"');
    expect(layout).toContain('variable: "--font-instrument-serif"');
    const theme = readFileSync(join(ROOT, "src/styles/theme.css"), "utf8");
    expect(theme).toContain("--font-sans: var(--font-inter-tight)");
    expect(theme).toContain("--font-heading: var(--font-inter-tight)");
    expect(theme).toContain("--font-serif: var(--font-instrument-serif)");
  });
});
