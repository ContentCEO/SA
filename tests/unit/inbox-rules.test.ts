import { describe, expect, it } from "vitest";
import {
  compareInbox,
  inboxRank,
  isFoldableJunk,
  isOlderUnsorted,
  kindWord,
  replyState,
  urgencyWord,
  type InboxRankInput,
} from "@/server/inbox-rules";

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

describe("inbox order (Check 10 P3)", () => {
  const NOW = t(20);
  const HOUR = 3_600_000;
  const row = (o: Partial<InboxRankInput> & { id: string }): InboxRankInput => ({
    urgency: "normal",
    priority: "normal",
    needsOwner: false,
    lastMessageAt: t(18),
    lastIn: t(18),
    lastOut: null,
    ...o,
  });

  it("an emergency from today beats a newer complaint that needs you", () => {
    const pipe = row({ id: "a", urgency: "emergency", priority: "high", needsOwner: true });
    const complaint = row({ id: "b", needsOwner: true, lastMessageAt: t(19), lastIn: t(19) });
    expect([complaint, pipe].sort((x, y) => compareInbox(x, y, NOW)).map((r) => r.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("an emergency the owner answered drops back", () => {
    const pipe = row({ id: "a", urgency: "emergency", lastOut: t(19) });
    expect(inboxRank(pipe, NOW)[0]).toBe(0);
    const newer = row({ id: "b", lastMessageAt: t(19) });
    expect([pipe, newer].sort((x, y) => compareInbox(x, y, NOW))[0]!.id).toBe("b");
  });

  it("an emergency (or urgent email) older than 24 hours drops back", () => {
    const old = new Date(NOW.getTime() - 25 * HOUR);
    expect(
      inboxRank(row({ id: "a", urgency: "emergency", lastMessageAt: old, lastIn: old }), NOW)[0],
    ).toBe(0);
    expect(inboxRank(row({ id: "a", priority: "high", lastMessageAt: old }), NOW)[0]).toBe(0);
    expect(inboxRank(row({ id: "a", priority: "high" }), NOW)[0]).toBe(1);
  });

  it("then needs you, then urgent today, then newest, then id", () => {
    const rows = [
      row({ id: "1", lastMessageAt: t(19) }),
      row({ id: "2", priority: "high" }),
      row({ id: "3", needsOwner: true, lastMessageAt: t(10) }),
      row({ id: "4", lastMessageAt: null }),
      row({ id: "5", lastMessageAt: t(19) }),
    ];
    expect(rows.sort((x, y) => compareInbox(x, y, NOW)).map((r) => r.id)).toEqual([
      "3",
      "2",
      "5",
      "1",
      "4",
    ]);
  });

  it("the tag word: Emergency first, else Urgent, by weight only", () => {
    expect(urgencyWord({ urgency: "emergency", priority: "high" })).toBe("Emergency");
    expect(urgencyWord({ urgency: "high", priority: "high" })).toBe("Urgent");
    expect(urgencyWord({ urgency: "normal", priority: "normal" })).toBeNull();
  });
});

describe("unsorted and failed sorts (Check 10 P7)", () => {
  const NOW = t(12);
  const DAY = 86_400_000;
  const days = (n: number) => new Date(NOW.getTime() - n * DAY);

  it("folds never-sorted mail whose latest customer email is past the look-back", () => {
    const r = (o: Partial<Parameters<typeof isOlderUnsorted>[0]>) => ({
      category: null,
      lastIn: days(20),
      lastMessageAt: days(20),
      ...o,
    });
    expect(isOlderUnsorted(r({}), NOW, 14)).toBe(true);
    expect(isOlderUnsorted(r({ lastIn: days(3) }), NOW, 14)).toBe(false);
    expect(isOlderUnsorted(r({ category: "scheduling" }), NOW, 14)).toBe(false);
    // No customer email at all: the thread's own time decides.
    expect(isOlderUnsorted(r({ lastIn: null }), NOW, 14)).toBe(true);
    expect(isOlderUnsorted(r({ lastIn: null, lastMessageAt: null }), NOW, 14)).toBe(false);
  });

  it("the kind word: Couldn't sort for a failed sort, Not sorted (yet) for never sorted", () => {
    const tags = { customer_question: "Question" };
    expect(
      kindWord({ category: "customer_question", extracted: { unreadable: true } }, tags, false),
    ).toBe("Couldn't sort");
    expect(kindWord({ category: "customer_question", extracted: {} }, tags, false)).toBe(
      "Question",
    );
    expect(kindWord({ category: null, extracted: null }, tags, false)).toBe("Not sorted yet");
    expect(kindWord({ category: null, extracted: null }, tags, true)).toBe("Not sorted");
  });
});
