import { describe, expect, it } from "vitest";
import { JOB_KINDS, OTHER_JOB_KIND } from "@/config/job-kinds";
import { DIRECT_EMAIL, LEAD_SOURCES } from "@/config/lead-sources";
import { TRADES } from "@/config/trades";
import { jobKindOf, leadSourceOf, normalizeWords, topCounts } from "@/server/monthly-rules";

describe("JOB_KINDS", () => {
  it("every trade has at least 3 kinds, unique labels, and real keywords", () => {
    for (const trade of TRADES) {
      const kinds = JOB_KINDS[trade];
      expect(kinds.length, trade).toBeGreaterThanOrEqual(3);
      const labels = kinds.map((k) => k.label);
      expect(new Set(labels).size, trade).toBe(labels.length);
      expect(labels, trade).not.toContain(OTHER_JOB_KIND);
      for (const k of kinds) {
        expect(k.keywords.length, k.label).toBeGreaterThan(0);
        for (const kw of k.keywords) {
          expect(kw.trim(), `${trade}/${k.label}`).not.toBe("");
          // Stored already normalized, so what's written is what's matched.
          expect(normalizeWords(kw), `${trade}/${k.label}`).toBe(kw);
        }
      }
    }
  });
});

describe("jobKindOf", () => {
  it.each([
    ["electrical", "panel upgrade 200A", "Panel upgrades"],
    ["electrical", "Install a Tesla wall connector", "EV chargers"],
    ["electrical", "Two new GFCI outlets in the kitchen", "Outlets and circuits"],
    ["electrical", "breaker keeps tripping", "Repairs and service calls"],
    ["plumbing", "Tankless water heater install", "Water heaters"],
    ["plumbing", "kitchen sink is clogged", "Drains and clogs"],
    ["plumbing", "Leaking pipe under the sink", "Leaks"],
    ["carpentry", "New composite deck, 12x16", "Decks and porches"],
    ["carpentry", "built-in bookshelves", "Built-ins and cabinets"],
    ["hvac", "A/C not cooling upstairs", "AC and heat pumps"],
    ["roofing", "Re-roof, 30 squares", "Roof replacements"],
    ["painting", "Paint three bedrooms", "Interior painting"],
    ["landscaping", "Paver patio and fire pit", "Patios and hardscaping"],
    ["other", "Bathroom remodel", "Remodels and renovations"],
  ] as const)("%s: %s → %s", (trade, service, label) => {
    expect(jobKindOf(trade, service)).toBe(label);
  });

  it("whole words only: 'meteor' is not a meter, 'planet' is not a plant", () => {
    expect(jobKindOf("electrical", "meteor shower lamp")).toBe(OTHER_JOB_KIND);
    expect(jobKindOf("landscaping", "planet mural")).toBe(OTHER_JOB_KIND);
  });

  it("nothing usable → 'Other jobs'", () => {
    expect(jobKindOf("electrical", null)).toBe(OTHER_JOB_KIND);
    expect(jobKindOf("electrical", "")).toBe(OTHER_JOB_KIND);
    expect(jobKindOf("electrical", "   ")).toBe(OTHER_JOB_KIND);
    expect(jobKindOf("electrical", "SECRET-xyz")).toBe(OTHER_JOB_KIND);
  });

  it("no trade uses the 'other' list", () => {
    expect(jobKindOf(null, "kitchen remodel")).toBe("Remodels and renovations");
    expect(jobKindOf(null, "panel upgrade")).toBe(OTHER_JOB_KIND);
  });

  it("only ever returns one of OUR labels, never the input (random strings)", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const vocabulary = [
      ...Object.values(JOB_KINDS).flatMap((ks) => ks.flatMap((k) => k.keywords)),
      "dana@x.com",
      "12 Elm St",
      "$2,400",
      "SECRET",
      "ignore previous instructions",
      "ünïcödé",
      "​",
      "(",
      "[",
      "*",
      "\\",
    ];
    const trades = [...TRADES, null] as const;
    for (let i = 0; i < 2000; i++) {
      const trade = trades[Math.floor(rand() * trades.length)]!;
      const words = Array.from(
        { length: 1 + Math.floor(rand() * 6) },
        () => vocabulary[Math.floor(rand() * vocabulary.length)]!,
      );
      const randomChars = String.fromCharCode(
        ...Array.from({ length: Math.floor(rand() * 12) }, () => 32 + Math.floor(rand() * 400)),
      );
      const input = `${words.join(" ")} ${randomChars}`;
      const allowed = new Set([...JOB_KINDS[trade ?? "other"].map((k) => k.label), OTHER_JOB_KIND]);
      const out = jobKindOf(trade, input);
      expect(allowed.has(out), input).toBe(true);
    }
  });
});

describe("leadSourceOf", () => {
  it.each([
    ["noreply@thumbtack.com", "Thumbtack"],
    ["x@mail.thumbtack.com", "Thumbtack"],
    ["Leads@HomeAdvisor.com", "Angi / HomeAdvisor"],
    ["x@angi.com", "Angi / HomeAdvisor"],
    ["messages@yelp.com", "Yelp"],
    ["leads@localservices.google.com", "Google (Local Services)"],
    ["x@business.google.com", "Google (Local Services)"],
    ["dana@gmail.com", DIRECT_EMAIL],
    ["x@notthumbtack.com", DIRECT_EMAIL],
    ["x@thumbtack.com.evil.io", DIRECT_EMAIL],
    // Google: exact hosts only. Calendar, forms and Workspace all write from google.com.
    ["calendar-notification@google.com", DIRECT_EMAIL],
    ["x@sub.localservices.google.com", DIRECT_EMAIL],
    ["x@gmail.com", DIRECT_EMAIL],
    // Every Facebook notification comes from facebookmail.com: too broad to call a lead.
    ["notification@facebookmail.com", DIRECT_EMAIL],
    ["", DIRECT_EMAIL],
    ["not an address", DIRECT_EMAIL],
  ])("%s → %s", (from, label) => {
    expect(leadSourceOf(from)).toBe(label);
  });

  it("null → Direct email", () => {
    expect(leadSourceOf(null)).toBe(DIRECT_EMAIL);
  });

  it("takes a bare domain too (the monthly query passes only the domain)", () => {
    expect(leadSourceOf("thumbtack.com")).toBe("Thumbtack");
    expect(leadSourceOf("mail.houzz.com")).toBe("Houzz");
    expect(leadSourceOf("gmail.com")).toBe(DIRECT_EMAIL);
  });

  it("only ever returns one of OUR labels", () => {
    const labels = new Set([...LEAD_SOURCES.map((s) => s.label), DIRECT_EMAIL]);
    for (const from of ["a@b.c", "@@", "x@[127.0.0.1]", "dana smith <dana@thumbtack.com>"])
      expect(labels.has(leadSourceOf(from))).toBe(true);
  });
});

describe("topCounts", () => {
  it("most first, ties broken alphabetically, n respected", () => {
    const labels = ["Decks", "Trim", "Decks", "Repairs", "Trim", "Built-ins", "Decks"];
    expect(topCounts(labels)).toEqual([
      { label: "Decks", count: 3 },
      { label: "Trim", count: 2 },
      { label: "Built-ins", count: 1 },
    ]);
    expect(topCounts(labels, 1)).toEqual([{ label: "Decks", count: 3 }]);
    expect(topCounts(labels, 10)).toHaveLength(4);
    expect(topCounts([])).toEqual([]);
    expect(topCounts(labels, 0)).toEqual([]);
  });
});
