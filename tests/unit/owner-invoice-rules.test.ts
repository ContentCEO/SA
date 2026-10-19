import { describe, expect, it } from "vitest";
import { looksLikeOwnerInvoice } from "@/server/owner-invoice-rules";

describe("looksLikeOwnerInvoice (Check 21 P4)", () => {
  it.each([
    [{ subject: "Invoice 1043", bodyText: null }],
    [{ subject: "Re: Deck", bodyText: "Invoice #1043 for the deck is attached." }],
    [{ subject: "Re: Deck", bodyText: "Here's INV-2207, thanks!" }],
    [{ subject: "Re: Deck", bodyText: "Attached is the invoice for $2,100." }],
    [{ subject: "Your invoice", bodyText: "Total due: $640.00" }],
  ])("yes: %o", (m) => {
    expect(looksLikeOwnerInvoice(m)).toBe(true);
  });
  it.each([
    [{ subject: "Fwd: Invoice 1043", bodyText: null }],
    [{ subject: "Re: Fwd: Invoice 1043", bodyText: null }],
    [{ subject: "Re: Deck", bodyText: "I'll send the invoice once we're done." }],
    [{ subject: "Re: Deck", bodyText: "It's $2,100 for the deck." }],
    [
      {
        subject: "Re: Deck",
        bodyText: "Sure thing.\n\nOn Mon, Dana wrote:\n> Can you send the invoice for $400?",
      },
    ],
    [{ subject: "Re: Deck", bodyText: "Sure.\n> invoice 1043 please" }],
  ])("no: %o", (m) => {
    expect(looksLikeOwnerInvoice(m)).toBe(false);
  });
});
