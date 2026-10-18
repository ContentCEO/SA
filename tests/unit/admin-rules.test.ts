import { describe, expect, it } from "vitest";
import {
  needsYou,
  NOTHING_NEEDS_YOU,
  PAUSE_EXPLAIN,
  PAUSE_EXPLAIN_BILLED,
  pauseExplanation,
  STILL_BILLED_LINE,
  supportSentence,
} from "@/server/admin-rules";
import { PAUSED_STILL_BILLED_LINE } from "@/server/billing-rules";

describe("pausing says Stripe keeps charging (Check 17 P2)", () => {
  it("without a subscription, today's words", () => {
    expect(pauseExplanation(false)).toBe(PAUSE_EXPLAIN);
    expect(PAUSE_EXPLAIN).toBe("Stops reading, drafting and sending. Nothing is deleted.");
  });

  it("with a subscription, the Stripe warning", () => {
    expect(pauseExplanation(true)).toBe(PAUSE_EXPLAIN_BILLED);
    expect(PAUSE_EXPLAIN_BILLED).toContain("Their Stripe plan keeps charging.");
    expect(PAUSE_EXPLAIN_BILLED).toContain(
      "Pause or cancel it in Stripe if they shouldn't pay while paused.",
    );
    expect(STILL_BILLED_LINE).toBe("Still billed in Stripe");
    expect(PAUSED_STILL_BILLED_LINE).toBe("Your plan's billing hasn't changed.");
  });
});

describe("the Needs you box (Check 16 P3)", () => {
  const zero = {
    growthCalls: 0,
    newSignups: 0,
    stuckInboxes: 0,
    paymentsFailed: 0,
    trialsEndingSoon: 0,
  };

  it("empty input: no lines (the page shows the empty line)", () => {
    expect(needsYou(zero)).toEqual([]);
    expect(NOTHING_NEEDS_YOU).toBe("Nothing needs you right now.");
  });

  it("each line only above zero, in a fixed order, with its anchor; counts only", () => {
    const all = needsYou({
      trialsEndingSoon: 1,
      paymentsFailed: 2,
      stuckInboxes: 3,
      newSignups: 4,
      growthCalls: 5,
    });
    expect(all.map((l) => [l.text, l.href])).toEqual([
      ["Growth calls to return: 5", "#waitlist"],
      ["New sign-ups to invite: 4", "#waitlist"],
      ["Inboxes stuck: 3", "#accounts"],
      ["Payments failed: 2", "#accounts"],
      ["Trials ending in the next 24 hours: 1", "#accounts"],
    ]);
    for (const key of Object.keys(zero) as Array<keyof typeof zero>) {
      const one = needsYou({ ...zero, [key]: 1 });
      expect(one.map((l) => l.key)).toEqual([key]);
    }
  });
});

describe("the support page's timeline (Check 16 P8)", () => {
  const at = new Date("2026-10-14T13:42:00Z");
  it("plain sentences with who and when; unknown actions in plain words", () => {
    expect(
      supportSentence({ action: "reply_sent", actor: "owner", createdAt: at, detail: {} }),
    ).toBe("Reply sent by owner · Oct 14, 9:42 AM");
    expect(
      supportSentence({
        action: "workspace_status_changed",
        actor: "squared_away",
        createdAt: at,
        detail: { by: "admin", move: "mark_setup_call_done", from: "setup_paid", to: "active" },
      }),
    ).toBe("Status changed by you: setup paid -> active · Oct 14, 9:42 AM");
    expect(
      supportSentence({ action: "voice_idea_ignored", actor: "owner", createdAt: at, detail: {} }),
    ).toBe("Voice idea ignored by owner · Oct 14, 9:42 AM");
  });
});
