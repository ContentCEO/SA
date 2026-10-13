import { readFileSync } from "node:fs";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { STRIPE_REASONS, stripeErrorReason, stripeReasonText } from "@/server/stripe-error-rules";

const SECRET_MESSAGE = "Invalid API Key provided: sk_test_SECRET123 for cus_SECRETCUSTOMER";

describe("M11 C10: why Connect Stripe failed, without Stripe's own words", () => {
  it("maps each Stripe error class to a fixed code", () => {
    const cases: [Stripe.errors.StripeError, string][] = [
      [new Stripe.errors.StripeAuthenticationError({ message: SECRET_MESSAGE }), "auth"],
      [new Stripe.errors.StripePermissionError({ message: SECRET_MESSAGE }), "permission"],
      [new Stripe.errors.StripeConnectionError({ message: SECRET_MESSAGE }), "connection"],
      [new Stripe.errors.StripeRateLimitError({ message: SECRET_MESSAGE }), "rate_limit"],
      [new Stripe.errors.StripeInvalidRequestError({ message: SECRET_MESSAGE }), "invalid_request"],
      [new Stripe.errors.StripeAPIError({ message: SECRET_MESSAGE }), "api"],
    ];
    for (const [err, code] of cases) expect(stripeErrorReason(err), err.type).toBe(code);
  });

  it("anything else is 'unknown' — never the raw message", () => {
    for (const err of [
      new Error(SECRET_MESSAGE),
      new Error("STRIPE_SECRET_KEY is not set."),
      { type: SECRET_MESSAGE },
      { type: "toString" },
      SECRET_MESSAGE,
      null,
      undefined,
      42,
    ]) {
      expect(stripeErrorReason(err)).toBe("unknown");
    }
  });

  it("every code is URL-safe and has a plain sentence; the sentences echo nothing", () => {
    for (const [code, text] of Object.entries(STRIPE_REASONS)) {
      expect(code).toMatch(/^[a-z_]+$/);
      expect(stripeReasonText(code)).toBe(text);
      expect(text).not.toMatch(/sk_test|SECRET123|cus_/);
    }
  });

  it("the page shows nothing for a reason that isn't one of ours (a crafted link)", () => {
    for (const r of [
      SECRET_MESSAGE,
      "Stripe said: call 555-0100",
      "",
      "constructor",
      null,
      ["auth"],
    ]) {
      expect(stripeReasonText(r)).toBeNull();
    }
  });

  it("the admin action and page use only the code (source check)", () => {
    const action = readFileSync("src/app/(app)/admin/actions.ts", "utf8");
    expect(action).toContain("stripeErrorReason(err)");
    expect(action).not.toMatch(/err(or)?\.message/);
    const page = readFileSync("src/app/(app)/admin/page.tsx", "utf8");
    expect(page).toContain("stripeReasonText(params.reason)");
    expect(page).not.toMatch(/params\.reason\.slice/);
  });
});
