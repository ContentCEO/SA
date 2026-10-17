import { describe, expect, it } from "vitest";
import { moneyMentions } from "@/ai/money-words";

const amounts = (t: string) => [...new Set(moneyMentions(t).map((m) => m.amount))];

describe("number words read whole (Check 36 P10)", () => {
  it.each([
    ["Mass Save gives seven hundred fifty dollars back on those.", 750],
    ["two thousand five hundred for the whole job", 2500],
    ["twelve hundred", 1200],
    ["a hundred and fifty", 150],
  ])("%s → %d", (text, amount) => {
    expect(amounts(text)).toEqual([amount]);
  });
  it("“a hundred times” is not money", () => {
    expect(moneyMentions("I've done that a hundred times")).toEqual([]);
  });
});
