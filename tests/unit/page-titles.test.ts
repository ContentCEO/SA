import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Check 32 P6: every screen has its own title. The tab, the phone's app switcher and screen
 * readers use it, and Next's route announcer reads a move only when the title changed.
 */
function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return pages(p);
    return name === "page.tsx" ? [p] : [];
  });
}

describe("page titles", () => {
  const all = pages("src/app");

  it("finds the screens", () => {
    expect(all.length).toBeGreaterThan(30);
  });

  it("every page.tsx sets metadata.title or generateMetadata", () => {
    const missing = all.filter((p) => {
      const s = readFileSync(p, "utf8");
      return (
        !/export const metadata\b[^=]*=\s*\{[\s\S]*?\btitle\s*:/.test(s) &&
        !/export (async )?function generateMetadata\b/.test(s)
      );
    });
    expect(missing).toEqual([]);
  });

  it("the root layout adds the name once, and no page writes it by hand", () => {
    const layout = readFileSync("src/app/layout.tsx", "utf8");
    expect(layout).toContain('title: { default: "Squared Away", template: "%s · Squared Away" }');
    const doubled = all.filter((p) =>
      /title:\s*"[^"]*· Squared Away"/.test(readFileSync(p, "utf8")),
    );
    expect(doubled).toEqual([]);
  });

  it("a title that names Squared Away itself is absolute (the template would add it twice)", () => {
    // The page's own title is its first `title:` (openGraph / twitter titles come after it).
    const full = all.filter((p) => {
      const first = readFileSync(p, "utf8").match(/\btitle:\s*("[^"]*"|\{[^}]*\})/);
      return first && /^"[^"]*Squared Away/.test(first[1]!);
    });
    expect(full).toEqual([]);
  });

  it("the queue title carries a number only", () => {
    const q = readFileSync("src/app/(app)/queue/page.tsx", "utf8");
    expect(q).toContain("`Queue (${waiting})`");
    expect(q).toMatch(/const waiting = workspace \? await badgeCount\(workspace\)/);
  });
});
