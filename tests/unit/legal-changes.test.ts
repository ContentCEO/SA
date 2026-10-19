import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TERMS_VERSION } from "@/config/legal";
import {
  changesMarkdown,
  changesSince,
  parseLegalChanges,
  versionLabel,
} from "@/server/legal-changes-rules";
import { isTermsVersion } from "@/server/terms-rules";

/**
 * Check 27 P3: the re-agree screen tells owners what changed. docs/legal-changes.md has an entry
 * for the current version, and the pure rules pick the entries newer than what someone agreed to.
 */

const doc = readFileSync("docs/legal-changes.md", "utf8");
const entries = parseLegalChanges(doc);

describe("docs/legal-changes.md", () => {
  it("has an entry for TERMS_VERSION, and every entry is a version with two to five bullets", () => {
    expect(entries.map((e) => e.version)).toContain(TERMS_VERSION);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(isTermsVersion(e.version), e.version).toBe(true);
      expect(e.bullets.length, e.version).toBeGreaterThanOrEqual(2);
      expect(e.bullets.length, e.version).toBeLessThanOrEqual(5);
      for (const b of e.bullets) expect(b, e.version).not.toMatch(/^\s|\s$|\n/);
    }
    // Newest first in the file, as the screen shows them.
    const versions = entries.map((e) => e.version);
    expect([...versions].sort().reverse()).toEqual(versions);
  });

  it("the entries are plain words for owners: no email content, no [To confirm], no prices", () => {
    expect(doc).not.toMatch(/\[To confirm\]|\$\s?\d/);
  });
});

describe("changesSince", () => {
  const fixture = parseLegalChanges(
    [
      "# Changes",
      "",
      "## 2026-10-17",
      "",
      "- Newest one.",
      "- And its second line",
      "  wrapped by Prettier.",
      "",
      "## 2026-10-16.2",
      "",
      "- Same-day release.",
      "",
      "## 2026-10-16",
      "",
      "- The one everyone agreed to first.",
      "- Another.",
      "",
      "## 2026-10-15",
      "- Older.",
    ].join("\n"),
  );

  it("parses headings and bullets, joining wrapped bullet lines", () => {
    expect(fixture).toEqual([
      {
        version: "2026-10-17",
        bullets: ["Newest one.", "And its second line wrapped by Prettier."],
      },
      { version: "2026-10-16.2", bullets: ["Same-day release."] },
      { version: "2026-10-16", bullets: ["The one everyone agreed to first.", "Another."] },
      { version: "2026-10-15", bullets: ["Older."] },
    ]);
  });

  it("picks only the versions newer than the one agreed to, newest first", () => {
    expect(changesSince(fixture, "2026-10-16").map((e) => e.version)).toEqual([
      "2026-10-17",
      "2026-10-16.2",
    ]);
    expect(changesSince(fixture, "2026-10-16.2").map((e) => e.version)).toEqual(["2026-10-17"]);
    expect(changesSince(fixture, "2026-10-15").map((e) => e.version)).toEqual([
      "2026-10-17",
      "2026-10-16.2",
      "2026-10-16",
    ]);
    expect(changesSince(fixture, "2026-10-17")).toEqual([]);
    expect(changesSince(fixture, "2027-01-01")).toEqual([]);
  });

  it("someone who never agreed (or has an odd version on record) sees no list: they read it all", () => {
    expect(changesSince(fixture, null)).toEqual([]);
    expect(changesSince(fixture, "zzz")).toEqual([]);
    expect(changesSince(fixture, "")).toEqual([]);
  });

  it("the real file: an owner on 2026-10-15 sees the current entry", () => {
    expect(changesSince(entries, "2026-10-15").map((e) => e.version)).toContain(TERMS_VERSION);
    expect(changesSince(entries, TERMS_VERSION)).toEqual([]);
  });

  it("renders one list for one version, dated headings for several", () => {
    expect(changesMarkdown(changesSince(fixture, "2026-10-16.2"))).toBe(
      "- Newest one.\n- And its second line wrapped by Prettier.",
    );
    expect(changesMarkdown(changesSince(fixture, "2026-10-16"))).toBe(
      [
        "### October 17, 2026",
        "- Newest one.",
        "- And its second line wrapped by Prettier.",
        "",
        "### October 16, 2026",
        "- Same-day release.",
      ].join("\n"),
    );
    expect(versionLabel("2026-10-16.2")).toBe("October 16, 2026");
  });
});

describe("/welcome/terms shows it", () => {
  it("renders What changed from legalChangesSince with the documents' Markdown renderer", () => {
    const page = readFileSync("src/app/welcome/terms/page.tsx", "utf8");
    expect(page).toContain("await legalChangesSince(terms.termsVersion)");
    expect(page).toContain("What changed");
    expect(page).toContain("<Markdown source={changesMarkdown(changed)} />");
  });
});
