import { describe, expect, it } from "vitest";
import { readExtracted } from "@/server/extracted";
import { invoiceOf, isInvoiceThread, paymentSaid } from "@/server/money-rules";

/** Check 30 P6: one reader for `threads.extracted`, per prompt version. */

const v2Row = {
  service_requested: "Panel upgrade",
  address: "12 Elm St",
  dates: ["Tuesday"],
  dollar_amounts: [2400],
  urgency: "normal",
  permit: null,
  invoice: { invoice_number: "1042", amount: 850, due_date: null, status: "unpaid" },
};

const v4Row = {
  ...v2Row,
  invoice_direction: "owed_to_business",
  accepts_quote: true,
  quote_accepted: true,
  quote_accepted_at: "2026-10-01T12:00:00.000Z",
  payment_said: "partly_paid",
  invoice_thread: true,
  owner_rule_hits: ["amount"],
};

describe("readExtracted", () => {
  it("reads a classify.v2-shaped row", () => {
    const r = readExtracted(v2Row, "classify.v2");
    expect(r).not.toBeNull();
    expect(r!.service_requested).toBe("Panel upgrade");
    expect(r!.invoice).toMatchObject({ invoice_number: "1042" });
    // v2 had no acceptance signal.
    expect(r!.quote_accepted).toBeUndefined();
  });

  it("reads a classify.v4-shaped row, keeping keys it doesn't name", () => {
    const r = readExtracted(v4Row, "classify.v4");
    expect(r).toMatchObject({
      invoice_direction: "owed_to_business",
      quote_accepted: true,
      quote_accepted_at: "2026-10-01T12:00:00.000Z",
      payment_said: "partly_paid",
      invoice_thread: true,
    });
    expect((r as Record<string, unknown>).owner_rule_hits).toEqual(["amount"]);
  });

  it("reads an old row (no version) as the newest shape", () => {
    expect(readExtracted(v4Row, null)?.payment_said).toBe("partly_paid");
    expect(readExtracted(v4Row)?.payment_said).toBe("partly_paid");
  });

  it("an odd value reads as missing, never an error", () => {
    const r = readExtracted({ ...v4Row, payment_said: "maybe", dates: "Tuesday", urgency: 3 });
    expect(r).not.toBeNull();
    expect(r!.payment_said).toBeUndefined();
    expect(r!.dates).toBeUndefined();
    expect(r!.service_requested).toBe("Panel upgrade");
  });

  it("refuses a non-object", () => {
    for (const v of [null, undefined, "classify", 42, true, ["a"]])
      expect(readExtracted(v)).toBeNull();
  });

  it("the money readers read through it", () => {
    expect(invoiceOf(v4Row)).toMatchObject({
      invoice_number: "1042",
      amount: 850,
      status: "unpaid",
    });
    expect(invoiceOf("nope")).toBeNull();
    expect(paymentSaid(v4Row)).toBe("partly_paid");
    expect(paymentSaid(v2Row)).toBeNull();
    expect(isInvoiceThread({ category: "scheduling", extracted: v4Row })).toBe(true);
    expect(isInvoiceThread({ category: "scheduling", extracted: v2Row })).toBe(false);
  });
});
