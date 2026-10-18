import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Check 7 P9: grey text comes from the muted token (text-muted-foreground), never from opacity:
 * opacity isn't a token, and sunlight mode (which promises no grey) can't remove it.
 */
const ALLOWED: Record<string, string[]> = {
  // Disabled buttons fade (not text styling).
  "src/components/ui/button.tsx": ["disabled:opacity-50"],
  // The Growth form's invisible checkbox overlay and its tick, shown when checked.
  "src/components/marketing/growth/growth-call-form.tsx": [
    "opacity-0",
    "peer-checked:[&>svg]:opacity-100",
  ],
};

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(tsx|ts)$/.test(f))
    .map((f) => join(dir, f));
}

describe("two tones: no see-through grey text", () => {
  it("no opacity-* class outside the allow-list", () => {
    const found: string[] = [];
    for (const f of [...files("src/app"), ...files("src/components")]) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/[\w:[\]&>-]*opacity-\d+/g)) {
        if (!(ALLOWED[f] ?? []).includes(m[0])) found.push(`${f}: ${m[0]}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("no hand-picked muted colour where the token already resolves inside a panel", () => {
    for (const f of ["src/app/(app)/billing/page.tsx", "src/app/(app)/inbox/page.tsx"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/\? "text-ash" : "text-muted-foreground"/);
    }
  });
});
