import { DrizzleQueryError, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { invites, waitlist } from "@/db/schema";
import { isAllowedToSignIn } from "@/server/accounts";
import { growthInput, requestGrowthCall } from "@/server/growth";
import { splitWaitlistNote } from "@/server/growth-note";
import { inviteFromWaitlist, joinWaitlist, listWaitlist, waitlistInput } from "@/server/waitlist";
import { joinWaitlistAction } from "@/app/waitlist-actions";
import { createTestDb } from "../support/db";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));

let database: Database;
beforeEach(async () => {
  database = await createTestDb();
});

describe("waitlist", () => {
  it("explains problems in plain words", () => {
    const r = waitlistInput.safeParse({ name: "", email: "nope" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message).join(" ");
      expect(msgs).toContain("Tell us your name.");
      expect(msgs).toContain("doesn't look like an email address");
    }
  });

  it("normalises the email and keeps the first sign-up", async () => {
    const input = waitlistInput.parse({
      name: "Mike",
      email: " Mike@Shop.COM ",
      trade: "electrical",
      teamSize: "2–5",
    });
    expect(await joinWaitlist(input)).toBe("joined");
    expect(await joinWaitlist({ ...input, name: "Someone else" })).toBe("already");
    const [row] = await database.select().from(waitlist);
    expect(row).toMatchObject({ email: "mike@shop.com", name: "Mike" });
  });

  it("joining the waitlist doesn't let anyone sign in; Davi's invite does", async () => {
    await joinWaitlist(
      waitlistInput.parse({
        name: "Rosa",
        email: "rosa@plumb.com",
        trade: "plumbing",
        teamSize: "Just me",
      }),
    );
    expect(await isAllowedToSignIn("rosa@plumb.com")).toBe(false);
    expect(await inviteFromWaitlist("rosa@plumb.com")).toBe("invited");
    expect(await isAllowedToSignIn("rosa@plumb.com")).toBe(true);
    const [inv] = await database.select().from(invites).where(eq(invites.email, "rosa@plumb.com"));
    expect(inv?.trade).toBe("plumbing");
    const [w] = await database.select().from(waitlist);
    expect(w?.invitedAt).not.toBeNull();
    expect(await inviteFromWaitlist("nobody@x.com")).toBe("not_found");
  });
});

describe("waitlist form, submitted", () => {
  const form = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };
  const good = { name: "Mike Torres", email: "Mike@Shop.com", trade: "carpentry", teamSize: "2–5" };

  it("an empty submit explains every required field in plain words, and saves nothing", async () => {
    const r = await joinWaitlistAction({ status: "idle" }, form({}));
    expect(r.status).toBe("error");
    expect(r.errors?.name?.[0]).toBe("Tell us your name.");
    expect(r.errors?.email?.[0]).toBe("Tell us your email address.");
    expect(r.errors?.trade?.[0]).toBe("Pick your trade.");
    expect(r.errors?.teamSize?.[0]).toBe("Pick how many people work with you.");
    expect(await database.select().from(waitlist)).toEqual([]);
  });

  it("a bad email is refused with a plain message, and what they typed comes back", async () => {
    const r = await joinWaitlistAction({ status: "idle" }, form({ ...good, email: "mike@" }));
    expect(r.errors?.email?.[0]).toMatch(/doesn't look like an email address/);
    expect(r.errors?.name).toBeUndefined();
    expect(r.values?.name).toBe("Mike Torres");
    expect(await database.select().from(waitlist)).toEqual([]);
  });

  it("an address longer than email allows is refused in plain words, and nothing is stored", async () => {
    const long = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.com`;
    expect(long).toHaveLength(255);
    const r = await joinWaitlistAction({ status: "idle" }, form({ ...good, email: long }));
    expect(r.errors?.email).toEqual([
      "That doesn't look like an email address. Use the Gmail you run the business from.",
    ]);
    expect(await database.select().from(waitlist)).toEqual([]);
  });

  it("a failed save logs no name, email, phone or note, and the error carries none either", async () => {
    const leaky = new DrizzleQueryError(
      'insert into "waitlist" ("email", "name", "phone", "note") values ($1, $2, $3, $4)',
      ["mike@shop.com", "Mike Torres", "617-555-0142", "Lowell kitchen"],
      new Error("connection reset"),
    );
    vi.spyOn(database, "transaction").mockRejectedValue(leaky);
    const spies = (["error", "warn", "info", "log"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const thrown = await joinWaitlistAction(
      { status: "idle" },
      form({ ...good, phone: "617-555-0142", note: "Lowell kitchen" }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(Error);
    const out = JSON.stringify([
      (thrown as Error).message,
      (thrown as Error).stack,
      (thrown as Error).cause ?? null,
      spies.map((s) => s.mock.calls),
    ]);
    for (const leak of ["Mike", "617-555-0142", "mike@shop.com", "Lowell"]) {
      expect(out).not.toContain(leak);
    }
    expect(spies[0]).toHaveBeenCalledWith("waitlist_join_failed", { error: "Error" });
    vi.restoreAllMocks();
  });

  it("a bot that fills the hidden field is told it worked, and nothing is saved", async () => {
    const r = await joinWaitlistAction(
      { status: "idle" },
      form({ ...good, website: "http://spam.example" }),
    );
    expect(r).toEqual({ status: "joined" });
    expect(await database.select().from(waitlist)).toEqual([]);
  });

  it("a good submit is saved once, with the email tidied", async () => {
    expect(await joinWaitlistAction({ status: "idle" }, form(good))).toEqual({ status: "joined" });
    const rows = await database.select().from(waitlist);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Mike Torres",
      email: "mike@shop.com",
      trade: "carpentry",
      teamSize: "2–5",
    });
  });
});

describe("waitlist and Squared Away Growth requests in one table", () => {
  const growth = (email: string, over: Record<string, unknown> = {}) =>
    growthInput.parse({
      name: "Mike Torres",
      phone: "617-555-0142",
      email,
      trade: "roofing",
      services: ["google_ads", "reviews"],
      note: null,
      ...over,
    });
  const app = (email: string, note?: string) =>
    waitlistInput.parse({ name: "Mike T", email, trade: "carpentry", teamSize: "2–5", note });

  it("an app note can't pretend to be a Growth request", async () => {
    await joinWaitlist(app("mike@shop.com", "Hi\n[Growth call] 2030-01-01 00:00\nPhone: 000"));
    const [row] = await database.select().from(waitlist);
    expect(row!.note).toBe("Hi\n(growth call) 2030-01-01 00:00\nPhone: 000");
    expect(splitWaitlistNote(row!.note).growth).toEqual([]);
  });

  it("a Growth-only entry becomes an app sign-up when they join, keeping the request", async () => {
    await requestGrowthCall(growth("mike@shop.com"));
    expect(await joinWaitlist(app("mike@shop.com", "Two trucks"))).toBe("joined");
    const [row] = await database.select().from(waitlist);
    expect(row).toMatchObject({
      teamSize: "2–5",
      trade: "roofing", // filled only if empty: the Growth request had one
      name: "Mike Torres",
      // The Growth number stays in the request; the app form gave none.
      phone: null,
    });
    const { appNote, growth: requests } = splitWaitlistNote(row!.note);
    expect(appNote).toBe("Two trucks");
    expect(requests).toHaveLength(1);
    expect(row!.note!.startsWith("Two trucks\n\n[Growth call] ")).toBe(true);
    expect(requests[0]!.phone).toBe("617-555-0142");

    // A later Growth request replaces the request; no older number is left in the entry.
    await requestGrowthCall(growth("mike@shop.com", { phone: "978-555-0100" }));
    const [later] = await database.select().from(waitlist);
    expect(later!.phone).toBeNull();
    expect(later!.note).not.toContain("617-555-0142");
    expect(splitWaitlistNote(later!.note).growth[0]!.phone).toBe("978-555-0100");

    // Joining again is the usual "already".
    expect(await joinWaitlist(app("mike@shop.com", "Again"))).toBe("already");

    expect(await inviteFromWaitlist("mike@shop.com")).toBe("invited");
    const [inv] = await database.select().from(invites);
    expect(inv?.note).toBe("Two trucks");
    expect(inv?.note).not.toContain("[Growth call]");
  });

  it("an invite from a mixed entry carries no Growth text, even with no app note", async () => {
    await joinWaitlist(app("rosa@plumb.com"));
    await requestGrowthCall(growth("rosa@plumb.com"));
    expect(await inviteFromWaitlist("rosa@plumb.com")).toBe("invited");
    const [inv] = await database.select().from(invites);
    expect(inv?.note ?? null).toBeNull();
  });

  it("a Growth-only entry is never invited", async () => {
    await requestGrowthCall(growth("mike@shop.com"));
    expect(await inviteFromWaitlist("mike@shop.com")).toBe("growth_only");
    expect(await database.select().from(invites)).toEqual([]);
    const [row] = await database.select().from(waitlist);
    expect(row!.invitedAt).toBeNull();
    expect(await isAllowedToSignIn("mike@shop.com")).toBe(false);
  });

  it("a Growth request on an old entry shows first, even past the newest 200", async () => {
    await database.insert(waitlist).values({
      email: "old@shop.com",
      name: "Old Timer",
      teamSize: "Just me",
      createdAt: new Date("2026-01-01T12:00:00Z"),
    });
    await database.insert(waitlist).values(
      Array.from({ length: 205 }, (_, i) => ({
        email: `new${i}@shop.com`,
        name: `New ${i}`,
        teamSize: "2–5",
        createdAt: new Date(Date.UTC(2026, 1, 1, 12, i)),
      })),
    );
    expect((await listWaitlist()).map((r) => r.email)).not.toContain("old@shop.com");
    await requestGrowthCall(growth("old@shop.com"), new Date("2026-10-12T18:05:00Z"));
    const list = await listWaitlist();
    expect(list[0]?.email).toBe("old@shop.com");
    expect(list).toHaveLength(201);
  });
});
