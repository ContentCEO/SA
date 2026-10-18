import { describe, expect, it } from "vitest";
import { checkDraft } from "@/ai/draft-checks";
import { blanks, fillGap, findGaps, hasUnfilledGap, showGaps } from "@/ai/gaps";

describe("[name]-style blanks are gaps (Check 23 P7)", () => {
  const body = "Hi [name], I can come at [time] for $___ if that works.";

  it("findGaps returns each blank, typed, in order", () => {
    expect(findGaps(body).map((g) => [g.token, g.kind, g.label])).toEqual([
      ["[name]", "custom", "their name"],
      ["[time]", "time", "time"],
      ["$___", "price", "price"],
    ]);
    expect(
      findGaps("It's {{price}} on [date], at [job address], $X,XXX, [day].").map((g) => g.kind),
    ).toEqual(["price", "date", "custom", "price", "date"]);
    expect(findGaps("Meet at [job address].")[0]!.label).toBe("job address");
  });

  it("fillGap fills each one in its own place", () => {
    let b = body;
    b = fillGap(b, 2, "$450");
    b = fillGap(b, 1, "8am");
    b = fillGap(b, 0, "Dana");
    expect(b).toBe("Hi Dana, I can come at 8am for $450 if that works.");
    expect(hasUnfilledGap(b)).toBe(false);
    expect(findGaps(b)).toEqual([]);
    // Typed gaps and blanks mixed keep one order.
    expect(fillGap("Hi [name], it's {{price}}.", 1, "$95")).toBe("Hi [name], it's $95.");
    // A blank written as "___" keeps the space before it.
    expect(fillGap("Call me at ___ today", 0, "555-0100")).toBe("Call me at 555-0100 today");
  });

  it("blanks() lists only the blanks; showGaps reads typed gaps as plain words", () => {
    expect(blanks("Hi [name], it's {{price}}.")).toEqual(["[name]"]);
    expect(showGaps("Hi {{custom:name}}, see you {{date}} at {{time}} — {{price}}.")).toBe(
      "Hi [name], see you [date] at [time] — [price].",
    );
  });

  it("checkDraft flags a blank so the card never reads Ready (no rewrite)", () => {
    const r = checkDraft("Hi [name], happy to. What's the address?", {
      sourceText: "Can you fix a leak?",
      doNotPromise: [],
      phrasesAvoided: [],
    });
    expect(r.flags).toContain("Has a blank (“[name]”) to fill in.");
    expect(r.hits).toEqual(["blank"]);
    expect(r.confidenceCap).toBe(0.6);
  });
});
