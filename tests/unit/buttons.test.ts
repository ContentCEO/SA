import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Check 7 P11: the quiet (ghost) button has no edge, so it reads as a label. It's only for the
 * Cancel / Keep / Not now next to a confirm; anything that changes data has an edge or a fill.
 */
const GHOST_OK = new Set([
  "src/app/(app)/queue/called-them.tsx",
  "src/app/(app)/queue/remind-me.tsx",
  "src/components/app/disconnect-button.tsx",
  "src/components/app/delete-account-button.tsx",
  "src/app/(app)/queue/review/batch-form.tsx",
  "src/app/(app)/queue/draft-parts.tsx",
  "src/app/(app)/queue/first-look.tsx", // "Hide this"
  "src/app/(app)/queue/draft-card.tsx", // "Keep it"
  "src/app/(app)/queue/draft-editor.tsx", // "Cancel" (the editor moved out of draft-card.tsx)
]);

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => join(dir, f));
}

describe("buttons", () => {
  it('variant="ghost" only in the confirm components', () => {
    const offenders = [...files("src/app"), ...files("src/components")].filter(
      (f) => readFileSync(f, "utf8").includes('variant="ghost"') && !GHOST_OK.has(f),
    );
    expect(offenders).toEqual([]);
  });

  it("no screen types a back arrow, a link arrow or a tick as text", () => {
    const offenders: string[] = [];
    for (const f of [...files("src/app"), ...files("src/components")]) {
      // The Growth chapter's decorative arrows are aria-hidden on purpose.
      if (f.includes("components/marketing/")) continue;
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      // A typed ← or ✓ anywhere, or a typed → ending a link's words ("Money owed →"). A → between
      // menu names in a sentence ("Settings → Your Gmail") is a path, read fine, and stays.
      if (/[←✓]/.test(src) || /→\s*<\/(Link|a)>/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
