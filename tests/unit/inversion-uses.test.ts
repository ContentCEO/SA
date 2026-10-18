import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Check 7 P5: inversion means status. Activity's money summary, the suggested plan on Billing
 * and the learning screen's voice card are summaries, so they get a border-2 edge instead.
 */
describe("charcoal panels mean something needs the owner", () => {
  it.each(["src/app/(app)/activity/page.tsx", "src/app/(app)/welcome/learning/page.tsx"])(
    "%s has no inverted panel",
    (f) => {
      expect(readFileSync(f, "utf8")).not.toContain("sa-inverted");
    },
  );

  it("billing inverts only its status boxes, never a plan card", () => {
    const src = readFileSync("src/app/(app)/billing/page.tsx", "utf8");
    const plans = src.slice(
      src.indexOf("PLAN_IDS.map"),
      src.indexOf("</ul>", src.indexOf("PLAN_IDS.map")),
    );
    expect(plans).not.toContain("sa-inverted");
    expect(plans).toContain("border-2 border-charcoal bg-card");
    expect(plans).toContain("Your plan");
  });

  it("the theme says what inversion is for", () => {
    const theme = readFileSync("src/styles/theme.css", "utf8");
    expect(theme).toContain(
      "needs you now, status banners, confirm steps, the selected item in a control",
    );
  });
});
