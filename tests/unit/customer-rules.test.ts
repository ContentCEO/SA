import { describe, expect, it } from "vitest";
import { customerFactsLine, customerThreadStage } from "@/server/customer-rules";

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
