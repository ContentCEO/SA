import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseVideoScript, VIDEO_REMINDERS } from "@/server/video-script";

/**
 * Check 28 P7: /admin/video renders the demo video script from docs/google-verification.md. The
 * parser must find every numbered step, so renumbering the script without this page noticing
 * fails here.
 */
const doc = readFileSync("docs/google-verification.md", "utf8");

describe("the demo video script parser (Check 28 P7)", () => {
  const script = parseVideoScript(doc);

  it("finds the 17 steps, numbered 1 to 17, each with a title and a part", () => {
    expect(script.steps.map((s) => s.n)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    // The same count the verification-doc test reads from the doc's "N. **" lines.
    const section = doc.slice(
      doc.indexOf("\n## Demo video script\n"),
      doc.indexOf("### Which test checks each step"),
    );
    const numbered = [...section.matchAll(/^(\d+)\. \*\*/gm)].length;
    expect(script.steps.length).toBe(numbered);
    expect(script.steps[0]).toMatchObject({
      n: 1,
      title: "Sign in.",
      part: expect.stringMatching(/^Part 1/),
    });
    expect(script.steps[3]!.title).toBe("Google's real consent screen.");
    expect(script.steps[3]!.text).toContain("`client_id=`");
    expect(script.steps[14]!.part).toMatch(/^Part 2/);
    for (const s of script.steps) {
      expect(s.title.length, `step ${s.n}`).toBeGreaterThan(3);
      expect(s.text.length, `step ${s.n}`).toBeGreaterThan(20);
      // A continuation line never swallows the next step.
      expect(s.text).not.toMatch(/^\d+\. \*\*|\s\d+\. \*\*/);
    }
  });

  it("finds the Before recording lists with their bullets", () => {
    const titles = script.before.map((b) => b.title);
    expect(titles).toContain("Before recording: fill the demo Gmail");
    expect(titles).toContain("Before recording: check the demo Gmail's Google access.");
    expect(titles).toContain("Before recording Part 1 on the house account");
    const fill = script.before.find((b) => b.title.startsWith("Before recording: fill"))!;
    expect(fill.bullets.length).toBe(3);
    expect(fill.bullets[0]).toContain("5 invented sent emails");
    const house = script.before.find((b) => b.title.includes("house account"))!;
    expect(house.bullets[0]).toMatch(/^\*\*Make your workspace the house account\*\*/);
    expect(script.intro).toContain("dedicated demo Gmail account filled with invented emails");
  });

  it("fails loudly on a doc without the section, and the reminders are fixed", () => {
    expect(() => parseVideoScript("# nothing")).toThrow(/Demo video script/);
    expect(VIDEO_REMINDERS).toHaveLength(3);
    expect(VIDEO_REMINDERS.join(" ")).toMatch(/desktop browser tab/);
    expect(VIDEO_REMINDERS.join(" ")).toMatch(/demo Gmail with invented emails/);
    expect(VIDEO_REMINDERS.join(" ")).toMatch(/Unlisted/);
  });

  it("the page reads only the doc and says noindex; next.config carries the doc for it", () => {
    const page = readFileSync("src/app/(app)/admin/video/page.tsx", "utf8");
    expect(page).toContain("robots: { index: false }");
    expect(page).toContain("requireAdmin()");
    expect(page).toContain('"google-verification.md"');
    expect(page).not.toMatch(/@\/db|threads|messages|drafts\b/);
    expect(readFileSync("next.config.ts", "utf8")).toContain(
      '"/admin/video": ["./docs/google-verification.md"]',
    );
  });
});
