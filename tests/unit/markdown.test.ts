import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLegalDoc } from "@/components/marketing/legal-page";
import { Markdown } from "@/lib/markdown";

/**
 * Check 7 P1: bold (and links) wrapped across source lines by Prettier render as bold, not as
 * ** stars. Check 7 P8: the legal pages show their own headline, so the document's "# Title" can
 * be skipped.
 */
const render = (source: string, skipFirstH1 = false) =>
  renderToStaticMarkup(createElement(Markdown, { source, skipFirstH1 }));
const text = (html: string) => html.replace(/<[^>]+>/g, "");

afterEach(() => vi.unstubAllEnvs());

describe("Markdown paragraphs (Check 7 P1)", () => {
  it("a bold phrase across two lines is one <strong>", () => {
    const html = render("a **bold\nphrase** here");
    expect(html).toContain("<strong>bold phrase</strong>");
    expect(text(html)).toBe("a bold phrase here");
    expect(text(html)).not.toContain("**");
  });

  it("the same in a list item and in a block quote", () => {
    const list = render("- tap **Send\n  reply** to send");
    expect(list).toContain("<li>tap <strong>Send reply</strong> to send</li>");
    const quote = render("> **Draft — not\n> yet reviewed.** Items");
    expect(quote).toContain("<strong>Draft — not yet reviewed.</strong> Items");
  });

  it("a link wrapped across lines still links", () => {
    const html = render("see the [User Data\nPolicy](https://example.com/p) now");
    expect(html).toMatch(/<a [^>]*href="https:\/\/example.com\/p"[^>]*>User Data Policy<\/a>/);
    expect(text(html)).not.toMatch(/[[\]()]/);
  });

  it("a line ending in a backslash is a hard break; bold never crosses it", () => {
    const html = render("Name, Place\\\nPhone: **555**\\\nText: [t](sms:+15085551234)");
    expect(html.match(/<br\/>/g)).toHaveLength(2);
    expect(html).toContain("Phone: <strong>555</strong>");
    expect(html).toContain('href="sms:+15085551234"');
    expect(text(html)).toBe("Name, PlacePhone: 555Text: t");
  });

  it("plain joining is unchanged: lines of a paragraph become one line of text", () => {
    expect(text(render("one\ntwo\nthree"))).toBe("one two three");
  });
});

describe("skipFirstH1 (Check 7 P8)", () => {
  it("drops the document's first # heading only; later headings stay", () => {
    const source = "> note\n\n# Title\n\n_Last updated_\n\n## Part\n\ntext\n\n# Not again";
    expect(render(source)).toContain("<h1");
    const html = render(source, true);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).not.toContain(">Title<");
    expect(html).toContain("Not again");
    expect(html).toContain("<h2");
    expect(html).toContain("<em>Last updated</em>");
  });

  it("renders no h1 when the document has one", () => {
    expect(render("# Only\n\ntext", true)).not.toContain("<h1");
  });
});

describe("the legal documents render clean", () => {
  for (const file of ["privacy-policy.md", "terms.md"] as const) {
    it(`${file}: no raw ** and no lone _ in the text`, async () => {
      vi.stubEnv("SUPPORT_EMAIL", undefined);
      const html = render(await loadLegalDoc(file), true);
      const t = text(html);
      expect(t).not.toContain("**");
      // Any _ left in the text is a code span's (like `utm_source`), never a stray italic marker.
      const code = [...html.matchAll(/<code[^>]*>([^<]*)<\/code>/g)].map((m) => m[1]!).join("");
      expect(t.split("_").length - 1).toBe(code.split("_").length - 1);
      expect(html).not.toContain("<h1");
      expect(html).toContain("<strong>Draft — not yet reviewed.</strong>");
      // The phrases Check 7 P1 found broken on the live pages are bold now.
      expect(html).toContain("<strong>Send reply</strong>");
      if (file === "privacy-policy.md") expect(html).toContain("<strong>I called them</strong>");
    });
  }
});
