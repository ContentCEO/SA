import { describe, expect, it } from "vitest";
import { isFoldableJunk, replyState } from "@/server/inbox-rules";

const t = (h: number) => new Date(Date.UTC(2026, 9, 15, h));

describe("inbox junk fold (outside review follow-up)", () => {
  it("folds noise that doesn't need the owner", () => {
    expect(isFoldableJunk({ category: "noise", needsOwner: false })).toBe(true);
  });

  it("never folds noise that needs the owner (VIP, injection, low confidence, their own tap)", () => {
    expect(isFoldableJunk({ category: "noise", needsOwner: true })).toBe(false);
  });

  it("never folds other categories", () => {
    expect(isFoldableJunk({ category: "quote_request", needsOwner: false })).toBe(false);
    expect(isFoldableJunk({ category: null, needsOwner: false })).toBe(false);
  });
});

describe("replyState", () => {
  it("labels noise that needs the owner", () => {
    expect(replyState({ lastIn: t(9), lastOut: null, category: "noise", needsOwner: true })).toBe(
      "Waiting on you",
    );
  });

  it("gives plain junk no word", () => {
    expect(
      replyState({ lastIn: t(9), lastOut: null, category: "noise", needsOwner: false }),
    ).toBeNull();
  });

  it("says Replied when the owner wrote after the customer", () => {
    expect(
      replyState({ lastIn: t(9), lastOut: t(10), category: "scheduling", needsOwner: false }),
    ).toBe("Replied");
  });
});
