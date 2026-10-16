import { describe, expect, it } from "vitest";
import { categoryLabels, isCategory } from "@/config/categories";
import {
  CATEGORY_NOUN,
  categoryNoun,
  needsYouHeader,
  queueThreadUrl,
  waitedPhrase,
  type NeedsYouItem,
} from "@/server/digest-rules";

const NOW = new Date("2026-10-06T11:30:00Z"); // 7:30am New York, 4:30am Los Angeles
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const url = (t: string) => queueThreadUrl("https://app.example/queue", t);

describe("category nouns (A14)", () => {
  it("every category has a plain noun with the right article — never 'A invoice / payment'", () => {
    const all = Object.keys(categoryLabels);
    expect(all.length).toBeGreaterThan(0);
    for (const c of all) {
      expect(isCategory(c)).toBe(true);
      const noun = categoryNoun(c);
      expect(noun).toBe(CATEGORY_NOUN[c as keyof typeof CATEGORY_NOUN]);
      expect(noun).not.toMatch(/[/×]/);
      // "An" before a vowel sound, "A" before anything else.
      const [article, next] = noun.split(" ");
      expect(article).toBe(/^[aeiou]/i.test(next!) ? "An" : "A");
    }
    expect(categoryNoun("invoice_payment")).toBe("An invoice or payment email");
    expect(categoryNoun("scheduling")).toBe("A scheduling email");
    expect(categoryNoun("complaint")).toBe("A complaint");
    expect(categoryNoun(null)).toBe("An email");
    expect(categoryNoun("something_new")).toBe("An email");
  });
});

describe("waitedPhrase", () => {
  it("minutes, then hours on the same local day", () => {
    expect(waitedPhrase(ago(40), NOW, "America/New_York")).toBe("waiting 40 minutes");
    expect(waitedPhrase(ago(1), NOW, "America/New_York")).toBe("waiting 1 minute");
    expect(waitedPhrase(ago(0), NOW, "America/New_York")).toBe("waiting under a minute");
    // A clock a little ahead never says "-3 minutes".
    expect(waitedPhrase(new Date(NOW.getTime() + 60_000), NOW, "America/New_York")).toBe(
      "waiting under a minute",
    );
    expect(waitedPhrase(ago(5 * 60), NOW, "America/New_York")).toBe("waiting 5 hours");
    expect(waitedPhrase(ago(60), NOW, "America/New_York")).toBe("waiting 1 hour");
  });

  it("'since yesterday' follows the owner's own midnight (New York vs Los Angeles)", () => {
    // 23:30 on Oct 5 in New York (20:30 in LA) → 01:00 Oct 6 in New York (22:00 Oct 5 in LA).
    const since = new Date("2026-10-06T03:30:00Z");
    const now = new Date("2026-10-06T05:00:00Z");
    expect(waitedPhrase(since, now, "America/New_York")).toBe("waiting since yesterday");
    expect(waitedPhrase(since, now, "America/Los_Angeles")).toBe("waiting 1 hour");
    // An unknown zone falls back to Eastern, like the rest of the summary.
    expect(waitedPhrase(since, now, "Mars/Base")).toBe("waiting since yesterday");
  });

  it("days by the owner's calendar", () => {
    expect(waitedPhrase(new Date("2026-10-03T15:00:00Z"), NOW, "America/New_York")).toBe(
      "waiting 3 days",
    );
    expect(waitedPhrase(new Date("2026-10-05T23:00:00Z"), NOW, "America/New_York")).toBe(
      "waiting since yesterday",
    );
  });
});

describe("needsYouHeader", () => {
  const item = (n: number, over: Partial<NeedsYouItem> = {}): NeedsYouItem => ({
    threadId: id(n),
    category: "customer_question",
    priority: "normal",
    waitingSince: ago(n * 10),
    ...over,
  });

  it("five waiting: high priority first, then the longest wait; three lines and '+ 2 more'", () => {
    const h = needsYouHeader(
      [
        item(1),
        item(2, { category: "complaint", priority: "high" }),
        item(3, { waitingSince: null }),
        item(4, { category: "quote_request" }),
        item(5, { category: "invoice_payment" }),
      ],
      NOW,
      "America/New_York",
      url,
    );
    expect(h.empty).toBe(false);
    expect(h.more).toBe(2);
    expect(h.lines).toEqual([
      { text: "A complaint — waiting 20 minutes", href: `https://app.example/queue#t-${id(2)}` },
      {
        text: "An invoice or payment email — waiting 50 minutes",
        href: `https://app.example/queue#t-${id(5)}`,
      },
      {
        text: "A quote request — waiting 40 minutes",
        href: `https://app.example/queue#t-${id(4)}`,
      },
    ]);
  });

  it("the owner wrote last: the noun alone, and it sorts last", () => {
    const h = needsYouHeader(
      [item(1, { waitingSince: null, category: "complaint" }), item(2)],
      NOW,
      "America/New_York",
      url,
    );
    expect(h.lines.map((l) => l.text)).toEqual([
      "A customer question — waiting 20 minutes",
      "A complaint",
    ]);
    expect(h.more).toBe(0);
  });

  it("nothing waiting says so", () => {
    expect(needsYouHeader([], NOW, "America/New_York", url)).toEqual({
      lines: [],
      more: 0,
      empty: true,
    });
  });

  it("never reads anything but the category and the times", () => {
    const sneaky = {
      ...item(1),
      needsOwnerReason: "SECRET reason",
      summary: "SECRET summary",
      customerName: "SECRET",
    } as NeedsYouItem;
    expect(JSON.stringify(needsYouHeader([sneaky], NOW, "America/New_York", url))).not.toContain(
      "SECRET",
    );
  });
});

describe("queueThreadUrl", () => {
  it("links a uuid to its card and anything else to the queue", () => {
    expect(url(id(7))).toBe(`https://app.example/queue#t-${id(7)}`);
    expect(url(id(7).toUpperCase())).toBe(`https://app.example/queue#t-${id(7)}`);
    expect(url("dana@customer.com")).toBe("https://app.example/queue");
    expect(url(`${id(7)}?x=1`)).toBe("https://app.example/queue");
  });
});
