import { describe, expect, it } from "vitest";
import {
  PAUSE_EXPLAIN,
  PAUSE_EXPLAIN_BILLED,
  pauseExplanation,
  STILL_BILLED_LINE,
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
