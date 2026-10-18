import { describe, expect, it } from "vitest";
import { describeProfileFacts, priceListSummary } from "@/server/profile-facts";

/** Check 15 P4: every saved business profile fact on Settings → Your business. */
const ORDER = [
  "Price list",
  "Booking out",
  "Hours",
  "Work",
  "Area",
  "Other trades",
  "How you get paid",
  "Customers should know",
  "Signature",
  "Never promise",
  "People who always need you",
  "Send me anything over",
];

describe("describeProfileFacts", () => {
  it("all empty: every row says Not set and what that means", () => {
    const rows = describeProfileFacts(null, { businessName: null, extraTrades: [] });
    expect(rows.slice(0, ORDER.length).map((r) => r.label)).toEqual(ORDER);
    for (const r of rows) {
      expect(r.value).toBeNull();
      expect(r.emptyNote).toMatch(/^Not set\. \S/);
    }
    expect(rows[0]!.emptyNote).toBe("Not set. Drafts never give a price.");
  });

  it("all full: values as saved, each row naming its form field", () => {
    const rows = describeProfileFacts(
      {
        pricingNotes: "Service call $129\nDrain clearing from $189",
        leadTime: "About two weeks out",
        hours: "Mon–Fri 7–4",
        services: "Drains, water heaters",
        serviceArea: "Lowell and 20 miles",
        paymentTerms: "Card or check",
        policies: "Permits included",
        signature: "Ruiz Street Plumbing",
        doNotPromise: ["Same-day service", "Weekend work"],
        vipSenders: ["boss@gc.com"],
        amountThresholdDollars: 2500,
        reviewUrl: "https://g.page/r/abc/review",
        licenses: { hic_number: "123456" },
        state: "MA",
      },
      { businessName: "Ruiz Street Plumbing", extraTrades: ["hvac"] },
    );
    const by = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(rows.slice(0, ORDER.length).map((r) => r.label)).toEqual(ORDER);
    expect(by["Price list"]).toMatchObject({
      field: "pricingNotes",
      value: "Service call $129\nDrain clearing from $189",
    });
    expect(by["Other trades"]!.value).toBe("HVAC (heating & cooling)");
    expect(by["Never promise"]!.value).toBe("Same-day service · Weekend work");
    expect(by["Send me anything over"]).toMatchObject({
      value: "$2,500",
      field: "amountThresholdDollars",
    });
    expect(by["State"]!.value).toBe("Massachusetts");
    expect(by["Licenses"]!.value).toContain("123456");
    for (const r of rows) expect(r.value, r.label).not.toBeNull();
    expect(new Set(rows.map((r) => r.field)).size).toBe(rows.length);
  });

  it("a 10-line price list shows 3 lines and “and 7 more”", () => {
    const list = Array.from({ length: 10 }, (_, i) => `Item ${i + 1}: $${(i + 1) * 100}`);
    const [price] = describeProfileFacts({ pricingNotes: list.join("\n\n") }, {});
    expect(price!.value).toBe("Item 1: $100\nItem 2: $200\nItem 3: $300\nand 7 more");
    expect(priceListSummary(list.join("\n"))).toBe("Price list: 10 lines");
    expect(priceListSummary("One thing $5")).toBe("Price list: 1 line");
    expect(priceListSummary("  \n ")).toBe("No price list yet");
  });
});
