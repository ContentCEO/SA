import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { servicesExample, servicesExampleFor, TRADES } from "@/config/trades";
import type { Database } from "@/db";
import { seasonalNotes } from "@/db/schema";
import { plainDate, untilLine } from "@/lib/plain-date";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { AUTOPILOT_NEVER_LINES, AUTOPILOT_WHEN_LINES } from "@/server/autopilot-reasons";
import { createTestDb } from "../support/db";

/** Check 15 P9 + P11 + P12: Settings polish. */
const session = vi.hoisted(() => ({ ws: "" }));
class Redirected extends Error {
  constructor(readonly url: string) {
    super("redirect");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirected(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/session", () => ({
  requireOwner: async () => ({ workspace: { id: session.ws } }),
}));
const { addSeasonalNoteFormAction } = await import("@/app/(app)/settings/wording-actions");

describe("seasonal note dates (Check 15 P9)", () => {
  it("read like dates, with the year only when it isn't this year", () => {
    expect(plainDate("2026-11-30", "2026-10-18")).toBe("Mon, Nov 30");
    expect(untilLine("2026-11-29", "2026-10-18")).toBe("Until Sun, Nov 29");
    expect(plainDate("2027-01-31", "2026-10-18")).toBe("Sun, Jan 31, 2027");
    // Month ends and a leap day, with no time zone shift.
    expect(plainDate("2026-02-28", "2026-01-01")).toBe("Sat, Feb 28");
    expect(plainDate("2028-02-29", "2028-01-01")).toBe("Tue, Feb 29");
    expect(plainDate("2026-12-31", "2026-12-01")).toBe("Thu, Dec 31");
    expect(plainDate("not a date", "2026-01-01")).toBe("not a date");
    expect(plainDate("2026-02-30", "2026-01-01")).toBe("2026-02-30");
  });
});

describe("a failed seasonal note keeps what was typed (Check 15 P9)", () => {
  let database: Database;
  beforeEach(async () => {
    database = await createTestDb();
    session.ws = (await ensureUserAndWorkspace({ email: "owner@shop.com" })).workspace.id;
  });
  const form = (text: string, endsOn: string) => {
    const d = new FormData();
    d.set("text", text);
    d.set("endsOn", endsOn);
    return d;
  };

  it("too short: the schema's own message, and the typed text back", async () => {
    const r = await addSeasonalNoteFormAction({}, form("Hi", "2026-12-01"));
    expect(r.values).toEqual({ text: "Hi", endsOn: "2026-12-01" });
    expect(r.errors?.text).toEqual(["Write a short note, like “Booked through November”."]);
  });

  it("a past or far date: the date's message; nothing saved", async () => {
    const past = await addSeasonalNoteFormAction({}, form("Booked through November", "2020-01-01"));
    expect(past.errors?.endsOn).toEqual(["That date has already passed."]);
    expect(past.values?.text).toBe("Booked through November");
    const far = await addSeasonalNoteFormAction({}, form("Booked through November", "2099-01-01"));
    expect(far.errors?.endsOn).toEqual(["Pick a date within the next year."]);
    expect(await database.select().from(seasonalNotes)).toHaveLength(0);
  });

  it("a good note is saved and goes back to the screen", async () => {
    const next = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    await expect(
      addSeasonalNoteFormAction({}, form("Booked through November", next)),
    ).rejects.toMatchObject({ url: "/settings/business?done=note_added" });
    expect(await database.select().from(seasonalNotes)).toHaveLength(1);
  });
});

describe("one name per setting (Check 15 P11)", () => {
  it("every trade has its own services example", () => {
    for (const t of TRADES) expect(servicesExample[t], t).toMatch(/\S.{10,}/);
    expect(servicesExampleFor("plumbing")).not.toContain("EV chargers");
    expect(servicesExampleFor("electrical")).toContain("EV chargers");
    expect(servicesExampleFor(null)).toBe(servicesExample.other);
  });

  it("the summary rows use the form's words", () => {
    const facts = readFileSync(join("src", "server", "profile-facts.ts"), "utf8");
    expect(facts).toContain('"People who always need you"');
    expect(facts).toContain('"Send me anything over"');
    const page = readFileSync(
      join("src", "app", "(app)", "settings", "business", "page.tsx"),
      "utf8",
    );
    expect(page).not.toContain("Always send me");
    expect(page).not.toContain("Flag amounts over");
  });
});

describe("two explanations tidied (Check 15 P12)", () => {
  const screen = (name: string) =>
    readFileSync(join("src", "app", "(app)", "settings", name, "page.tsx"), "utf8");
  it("the monthly note is mentioned once on Morning email", () => {
    const src = screen("morning-email");
    expect(src).toContain("(and a short one on the 1st of each month)");
    expect(src).not.toContain("On the 1st of each month you");
  });
  it("Autopilot's money wording matches what the code allows", () => {
    const src = screen("autopilot").replace(/\s+/g, " ");
    expect(src).not.toContain("anything about money");
    // Wave 2 merge B: the screen's rules now come from the guardrail codes (Check 20 P6), one
    // line each, with the same meaning: no amount in the reply, and an invoice email only
    // when it names none.
    const lines = [...AUTOPILOT_WHEN_LINES, ...AUTOPILOT_NEVER_LINES].map((l) => l.text);
    expect(lines).toContain("No price or amount anywhere in the reply.");
    expect(lines.some((l) => /only when the email has no amount/.test(l))).toBe(true);
    expect(src).toContain("AUTOPILOT_WHEN_LINES");
  });
});
