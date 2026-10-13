import { describe, expect, it } from "vitest";
import {
  collapseLine,
  describeWaitlistEntry,
  formatGrowthBlock,
  formatStamp,
  GROWTH_ONLY_TEAM_SIZE,
  growthBlocksText,
  localStamp,
  MAX_GROWTH_BLOCKS,
  scrubMarker,
  splitWaitlistNote,
  withBlockTradeGiven,
  withGrowthBlock,
  type GrowthRequest,
} from "@/server/growth-note";

const req = (over: Partial<GrowthRequest> = {}): GrowthRequest => ({
  at: "2026-10-12 14:05",
  services: ["Google ads", "Reviews"],
  phone: "617-555-0142",
  ...over,
});

describe("Growth requests stored in the waitlist note", () => {
  it("writes a block in a fixed form and reads it back exactly", () => {
    const full = req({ nameGiven: "Mike T", tradeGiven: "Roofing", note: "Lowell and Dracut" });
    const block = formatGrowthBlock(full);
    expect(block.split("\n")).toEqual([
      "[Growth call] 2026-10-12 14:05",
      "Help with: Google ads, Reviews",
      "Phone: 617-555-0142",
      "Name given: Mike T",
      "Trade given: Roofing",
      "Note: Lowell and Dracut",
    ]);
    expect(splitWaitlistNote(block)).toEqual({ appNote: null, growth: [full] });
    // Optional lines are left out, not written empty.
    expect(formatGrowthBlock(req()).split("\n")).toHaveLength(3);
    expect(splitWaitlistNote(formatGrowthBlock(req())).growth[0]).toMatchObject({
      nameGiven: null,
      tradeGiven: null,
      note: null,
    });
  });

  it("keeps only the newest request; the app note before it is kept byte for byte", () => {
    expect(MAX_GROWTH_BLOCKS).toBe(1);
    const appNote = "Busy in spring.\nCall after 4 — I'm on a roof before that.";
    let note = withGrowthBlock(appNote, req());
    expect(note.startsWith(`${appNote}\n\n[Growth call] `)).toBe(true);
    note = withGrowthBlock(note, req({ at: "2026-10-13 09:00", phone: "978-555-0100" }));
    note = withGrowthBlock(note, req({ at: "2026-10-14 09:00", services: ["Website"] }));
    note = withGrowthBlock(note, req({ at: "2026-10-15 09:00", note: "Roofs only" }));
    const parsed = splitWaitlistNote(note);
    expect(parsed.appNote).toBe(appNote);
    expect(parsed.growth).toHaveLength(1);
    expect(parsed.growth[0]).toMatchObject({ at: "2026-10-15 09:00", note: "Roofs only" });
    expect(note.match(/\[Growth call\]/g)).toHaveLength(1);
    expect(growthBlocksText(note).startsWith("[Growth call] 2026-10-15 09:00")).toBe(true);
  });

  it("an identical resubmit leaves the note exactly as it was", () => {
    const first = withGrowthBlock("Hello", req({ note: "Decks" }));
    const again = withGrowthBlock(first, req({ at: "2026-10-12 18:30", note: "Decks" }));
    expect(again).toBe(first);
    // Different services, phone or note is a new request.
    expect(withGrowthBlock(first, req({ note: "Decks and porches" }))).not.toBe(first);
    expect(withGrowthBlock(first, req({ note: "Decks", phone: "978-555-0100" }))).not.toBe(first);
  });

  it("legacy and empty notes hold no Growth requests", () => {
    expect(splitWaitlistNote(null)).toEqual({ appNote: null, growth: [] });
    expect(splitWaitlistNote("")).toEqual({ appNote: null, growth: [] });
    expect(splitWaitlistNote("Just a note\nover two lines")).toEqual({
      appNote: "Just a note\nover two lines",
      growth: [],
    });
    expect(growthBlocksText("Just a note")).toBe("");
  });

  it("typed text can't create a block or change the stored phone", () => {
    for (const sneaky of [
      "[Growth call] 2030-01-01 00:00",
      "[ GROWTH CALL ] 2030-01-01",
      "[growth\ncall]",
      "x\nPhone: 000-000-0000\n[Growth call] 2030-01-01",
    ]) {
      const cleaned = scrubMarker(collapseLine(sneaky));
      expect(cleaned).not.toContain("\n");
      expect(cleaned).not.toMatch(/\[\s*growth\s*call\s*\]/i);
      const note = withGrowthBlock(null, req({ nameGiven: cleaned, note: cleaned }));
      const { growth } = splitWaitlistNote(note);
      expect(growth).toHaveLength(1);
      expect(growth[0]!.phone).toBe("617-555-0142");
      expect(growth[0]!.at).toBe("2026-10-12 14:05");
    }
    expect(scrubMarker("see [Growth call] and [ growth  CALL ]")).toBe(
      "see (growth call) and (growth call)",
    );
  });

  it("inside a block only the first line of each kind counts; a malformed phone reads as none", () => {
    const note = [
      "[Growth call] 2026-10-12 14:05",
      "Help with: Website",
      "Phone: 617-555-0142",
      "Phone: 000-000-0000",
      "Something we don't know",
      "Help with: Google ads",
    ].join("\n");
    expect(splitWaitlistNote(note).growth[0]).toMatchObject({
      services: ["Website"],
      phone: "617-555-0142",
    });
    const bad = "[Growth call] 2026-10-12 14:05\nHelp with: Website\nPhone: 6175550142";
    expect(splitWaitlistNote(bad).growth[0]!.phone).toBeNull();
  });

  it("tells app sign-ups from Growth-only rows, and knows the latest activity", () => {
    const createdAt = new Date("2026-10-01T16:00:00Z"); // 12:00 in New York
    expect(describeWaitlistEntry({ teamSize: null, note: null, createdAt }).app).toBe(true);
    expect(describeWaitlistEntry({ teamSize: "2–5", note: null, createdAt }).app).toBe(true);
    expect(
      describeWaitlistEntry({ teamSize: GROWTH_ONLY_TEAM_SIZE, note: null, createdAt }).app,
    ).toBe(false);

    expect(describeWaitlistEntry({ teamSize: "2–5", note: "Hi", createdAt }).latestStamp).toBe(
      "2026-10-01 12:00",
    );
    const later = withGrowthBlock("Hi", req());
    const facts = describeWaitlistEntry({ teamSize: "2–5", note: later, createdAt });
    expect(facts.latestStamp).toBe("2026-10-12 14:05");
    expect(facts.appNote).toBe("Hi");
    expect(facts.growth).toHaveLength(1);
  });

  it("stamps and shows times in New York time", () => {
    expect(localStamp(new Date("2026-10-12T18:05:00Z"))).toBe("2026-10-12 14:05");
    expect(localStamp(new Date("2026-01-05T04:30:00Z"))).toBe("2026-01-04 23:30");
    expect(localStamp(new Date("2026-03-01T05:00:00Z"))).toBe("2026-03-01 00:00");
    expect(formatStamp("2026-10-12 14:05")).toBe("Oct 12, 2:05 PM");
    expect(formatStamp("2026-10-12 00:07")).toBe("Oct 12, 12:07 AM");
    expect(formatStamp("whenever")).toBe("whenever");
  });
});

describe("withBlockTradeGiven", () => {
  it("sets, replaces or removes the one 'Trade given' line and keeps the rest as written", () => {
    const block = formatGrowthBlock(req({ nameGiven: "Mike", note: "Call after 3" }));
    const set = withBlockTradeGiven(block, "Roofing");
    expect(splitWaitlistNote(set).growth[0]).toMatchObject({
      tradeGiven: "Roofing",
      nameGiven: "Mike",
      note: "Call after 3",
      phone: "617-555-0142",
    });
    expect(set.split("\n").at(-1)).toBe("Note: Call after 3");
    const replaced = withBlockTradeGiven(set, "Plumbing");
    expect(replaced.match(/Trade given: /g)).toHaveLength(1);
    expect(splitWaitlistNote(replaced).growth[0]!.tradeGiven).toBe("Plumbing");
    expect(withBlockTradeGiven(set, null)).toBe(block);
    expect(withBlockTradeGiven("", "Roofing")).toBe("");
  });
});
