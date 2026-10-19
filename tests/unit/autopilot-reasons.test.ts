import { describe, expect, it } from "vitest";
import {
  AUTOPILOT_NEVER_LINES,
  AUTOPILOT_WHEN_LINES,
  autopilotWaitLine,
  GUARDRAIL_CODES,
  GUARDRAIL_LINES,
  knownReasonCodes,
  REASON_PHRASES,
  RUN_CODES,
} from "@/server/autopilot-reasons";
import { describeActivity } from "@/server/activity";

const ALL = [...GUARDRAIL_CODES, ...RUN_CODES];

describe("autopilot reason codes (Check 20 P7)", () => {
  it("every code has a plain sentence or phrase", () => {
    for (const c of GUARDRAIL_CODES) expect(GUARDRAIL_LINES[c]).toMatch(/\.$/);
    for (const c of ALL) expect(REASON_PHRASES[c]).toMatch(/^[a-z]/);
  });

  it("codes are short fixed words: no email text can ride along", () => {
    for (const c of ALL) expect(c).toMatch(/^[a-z_]{2,24}$/);
    // Anything not in the list (an address, a sentence) is dropped before it's shown.
    expect(knownReasonCodes(["money", "dana@customer.com", "Hi Dana", 3, "money"])).toEqual([
      "money",
    ]);
    expect(knownReasonCodes("money")).toEqual([]);
  });

  it("describeActivity names the first reason for every code", () => {
    for (const c of ALL) {
      expect(
        describeActivity(
          "autopilot_stood_down",
          { codes: [c] },
          { name: "Dana Ruiz", category: null },
        ),
      ).toBe(`Autopilot didn't send the reply to Dana: ${REASON_PHRASES[c]}`);
      expect(
        describeActivity(
          "autopilot_skipped",
          { codes: [c] },
          { name: "Dana Ruiz", category: null },
        ),
      ).toBe(`Autopilot left the reply to Dana for you: ${REASON_PHRASES[c]}`);
    }
    expect(describeActivity("autopilot_stood_down", { codes: ["newer_mail"] }, null)).toBe(
      "Autopilot didn't send the reply: new mail came in on the conversation",
    );
    expect(describeActivity("autopilot_stood_down", { codes: ["writing_in_gmail"] }, null)).toBe(
      "Autopilot didn't send the reply: you're writing a reply in Gmail",
    );
    // Older rows carry only a count.
    expect(describeActivity("autopilot_stood_down", { reasonCount: 2 }, null)).toMatch(
      /something changed/,
    );
    expect(describeActivity("autopilot_skipped", {}, null)).toBeNull();
  });

  it("the card line", () => {
    expect(autopilotWaitLine("Scheduling", ["not_known", "money"])).toBe(
      "Autopilot is on for scheduling, but this one waits: you haven't written to this address before.",
    );
    expect(autopilotWaitLine("Scheduling", null)).toBeNull();
    expect(autopilotWaitLine("Scheduling", ["junk"])).toBeNull();
  });
});

describe("Settings → Autopilot lines (Check 20 P6)", () => {
  const lines = [...AUTOPILOT_WHEN_LINES, ...AUTOPILOT_NEVER_LINES];
  it("every guardrail has exactly one Settings line (add a line with every new rule)", () => {
    for (const c of GUARDRAIL_CODES) {
      expect(
        lines.filter((l) => l.codes.includes(c)).map((l) => l.text),
        c,
      ).toHaveLength(1);
    }
  });
  it("every run reason a stand-down can give is explained too", () => {
    for (const c of RUN_CODES)
      expect(
        lines.some((l) => l.codes.includes(c)),
        c,
      ).toBe(true);
  });
  it("says the money rule truthfully, with the cap and the window", () => {
    const text = lines.map((l) => l.text).join("\n");
    expect(text).not.toMatch(/anything about money/i);
    expect(text).toContain("No price or amount anywhere in the reply.");
    expect(text).toContain(
      'For Invoices & payments: only when the email has no amount, like "Did you get my check?"',
    );
    expect(text).toContain("At most 20 in any 24 hours.");
    expect(text).toContain("Each one waits 10 minutes in your queue with Hold it.");
  });
});
