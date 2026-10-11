import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { invites, waitlist } from "@/db/schema";
import { isAllowedToSignIn } from "@/server/accounts";
import { inviteFromWaitlist, joinWaitlist, waitlistInput } from "@/server/waitlist";
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
