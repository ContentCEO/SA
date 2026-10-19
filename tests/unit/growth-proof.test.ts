import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GrowthProof } from "@/components/marketing/growth/growth-proof";
import { GROWTH_PROOF, liveProof, proofDate, type GrowthProofItem } from "@/config/growth-proof";

/** Check 2 P6: room for real proof on /growth, never invented. */
const NOW = new Date("2026-10-19T12:00:00Z");
const item = (over: Partial<GrowthProofItem> = {}): GrowthProofItem => ({
  kind: "quote",
  shop: "Lima Plumbing",
  town: "Lowell",
  text: "Calls from the listing every week now.",
  permissionOn: "2026-09-01",
  checkedOn: "2026-10-01",
  ...over,
});
const render = (items: GrowthProofItem[]) =>
  renderToStaticMarkup(createElement(GrowthProof, { items, now: NOW }));

describe("Growth proof", () => {
  it("every shipped item has real permission and checked dates", () => {
    for (const p of GROWTH_PROOF) {
      expect(proofDate(p.permissionOn), p.shop).not.toBeNull();
      expect(proofDate(p.checkedOn), p.shop).not.toBeNull();
    }
  });

  it("dates must be real calendar days", () => {
    expect(proofDate("2026-02-30")).toBeNull();
    expect(proofDate("10/01/2026")).toBeNull();
    expect(proofDate("2026-10-01")?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("renders nothing, not even a heading, for an empty list", () => {
    expect(render([])).toBe("");
  });

  it("shows a dated, permitted item", () => {
    const html = render([item()]);
    expect(html).toContain("what it looks like,");
    expect(html).toContain("Calls from the listing every week now.");
    expect(html).toContain("Lima Plumbing, Lowell");
  });

  it("hides an item checked more than 12 months ago, or with a bad date", () => {
    expect(liveProof([item({ checkedOn: "2025-10-18" })], NOW)).toEqual([]);
    expect(liveProof([item({ checkedOn: "2025-10-20" })], NOW)).toHaveLength(1);
    expect(liveProof([item({ permissionOn: "soon" })], NOW)).toEqual([]);
    expect(render([item({ checkedOn: "2024-01-01" })])).toBe("");
  });

  it("links only to https pages", () => {
    const html = render([
      item({ kind: "link", href: "javascript:alert(1)", text: undefined }),
      item({ kind: "link", shop: "Rosa Roofing", href: "https://rosa.example", text: undefined }),
    ]);
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://rosa.example"');
  });
});
