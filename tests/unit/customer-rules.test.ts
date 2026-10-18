import { describe, expect, it } from "vitest";
import { headlineName } from "@/lib/headline-name";
import {
  customerFactsLine,
  customerThreadStage,
  listStartsOn,
  wroteWords,
} from "@/server/customer-rules";

const NOW = new Date("2026-10-10T14:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describe("customer page wording (Check 13 P5)", () => {
  const q = (o: Partial<Parameters<typeof customerThreadStage>[0]>) => ({
    isQuote: true,
    outcome: null,
    amountCents: null,
    lastInboundAt: daysAgo(5),
    lastOutboundAt: null,
    ...o,
  });
  it("names each conversation's stage", () => {
    expect(customerThreadStage(q({}), NOW, 3)).toBe("Waiting on you");
    expect(customerThreadStage(q({ lastOutboundAt: daysAgo(1) }), NOW, 3)).toBe(
      "Priced, waiting on them",
    );
    expect(customerThreadStage(q({ lastOutboundAt: daysAgo(4) }), NOW, 3)).toBe("Gone quiet");
    expect(customerThreadStage(q({ outcome: "won", amountCents: 210_000 }), NOW, 3)).toBe(
      "Won $2,100",
    );
    expect(customerThreadStage(q({ outcome: "won" }), NOW, 3)).toBe("Won");
    expect(customerThreadStage(q({ outcome: "lost" }), NOW, 3)).toBe("Lost");
    expect(customerThreadStage(q({ outcome: "no_answer" }), NOW, 3)).toBe("No answer");
    // Not a quote: only "Waiting on you", when the customer wrote last.
    expect(customerThreadStage(q({ isQuote: false }), NOW, 3)).toBe("Waiting on you");
    expect(
      customerThreadStage(q({ isQuote: false, lastOutboundAt: daysAgo(1) }), NOW, 3),
    ).toBeNull();
  });
  it("one facts line, empty parts left out", () => {
    expect(
      customerFactsLine({
        openQuotes: 1,
        wonCents: 210_000,
        owedCents: 35_000,
        lastWroteAt: new Date("2026-10-08T15:00:00Z"),
      }),
    ).toBe("1 open quote · Won $2,100 · Owes $350 · Wrote you Oct 8");
    expect(customerFactsLine({ openQuotes: 2, wonCents: 0 })).toBe("2 open quotes");
    expect(customerFactsLine({ openQuotes: 0, wonCents: 0, owedCents: 0, lastWroteAt: null })).toBe(
      "",
    );
  });
});

describe("when they last wrote, how far back, and the headline (Check 13 P6–P8)", () => {
  it("says when the customer last wrote in plain words", () => {
    expect(wroteWords(new Date(NOW.getTime() - 3 * 3_600_000), NOW)).toBe("Wrote 3 hours ago");
    expect(wroteWords(daysAgo(29), NOW)).toBe("Wrote 29 days ago");
    expect(wroteWords(new Date("2026-07-15T15:00:00Z"), NOW)).toBe("Wrote in July");
    expect(wroteWords(new Date("2025-03-10T15:00:00Z"), NOW)).toBe("Wrote Mar 2025");
    // The owner's time zone decides the year at the edge.
    expect(wroteWords(new Date("2026-01-01T03:00:00Z"), NOW, "America/Los_Angeles")).toBe(
      "Wrote Dec 2025",
    );
  });

  it("says how far back the list goes", () => {
    expect(listStartsOn(new Date("2026-10-01T16:00:00Z"), 30)).toBe("Sep 1, 2026");
    expect(listStartsOn(null, 30)).toBeNull();
  });

  it.each([
    ["Dana Ruiz", "dana"],
    ["Mr. John Smith", "john"],
    ["Dr Kim", "kim"],
    ["The Hill Property Group", "the hill property group"],
    ["Supply House Branch 42", "supply house branch 42"],
    ["Chelmsford Building Dept", "chelmsford building dept"],
    ["O'Connor, Kevin", "kevin"],
    ["Mary Ann Lopez", "mary ann lopez"],
    ["", "this customer"],
    [null, "this customer"],
    ["dana.ruiz@gmail.com", "this customer"],
  ])("headlineName(%s) → %s", (name, want) => {
    expect(headlineName(name, "dana.ruiz@gmail.com")).toBe(want);
  });
});
