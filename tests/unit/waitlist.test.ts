import { DrizzleQueryError, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { invites, waitlist, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace, isAllowedToSignIn } from "@/server/accounts";
import { growthInput, requestGrowthCall } from "@/server/growth";
import { splitWaitlistNote } from "@/server/growth-note";
import { setReferralConfigForTests } from "@/server/referral-rules";
import {
  inviteFromWaitlist,
  joinWaitlist,
  listWaitlist,
  waitlistInput,
  waitlistInviteState,
} from "@/server/waitlist";
import { joinWaitlistAction } from "@/app/waitlist-actions";
import { createTestDb } from "../support/db";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));
// The sign-up emails run after the response; here they are collected and never sent.
const afterTasks: (() => unknown)[] = [];
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (task: () => unknown) => afterTasks.push(task),
}));

let database: Database;
beforeEach(async () => {
  database = await createTestDb();
});
afterEach(() => {
  delete process.env.FEATURE_REFERRALS;
  setReferralConfigForTests(undefined);
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

  it("the admin card's invite state comes from the invite list, not only the old invite date", async () => {
    const at = new Date("2026-09-01T12:00:00Z");
    expect(waitlistInviteState({ invitedAt: null, inviteExists: false, hasAccount: false })).toBe(
      "not_invited",
    );
    expect(waitlistInviteState({ invitedAt: at, inviteExists: true, hasAccount: true })).toBe(
      "invited",
    );
    // Invited with the "Invite an owner" form, never from this entry: still invited.
    expect(waitlistInviteState({ invitedAt: null, inviteExists: true, hasAccount: false })).toBe(
      "invited",
    );
    // Delete my account removed the invite: the old date alone doesn't count.
    expect(waitlistInviteState({ invitedAt: at, inviteExists: false, hasAccount: false })).toBe(
      "invite_gone",
    );
    expect(waitlistInviteState({ invitedAt: null, inviteExists: false, hasAccount: true })).toBe(
      "has_account",
    );

    const entry = (email: string, name: string) =>
      joinWaitlist(waitlistInput.parse({ name, email, trade: "plumbing", teamSize: "Just me" }));
    await entry("new@shop.com", "New");
    await entry("gone@shop.com", "Gone");
    await entry("form@shop.com", "Form");
    await entry("admin@shop.com", "Admin");
    await entry("caps@shop.com", "Caps");
    await database
      .update(waitlist)
      .set({ invitedAt: at })
      .where(eq(waitlist.email, "gone@shop.com"));
    await database.insert(invites).values({ email: "form@shop.com", invitedAt: at });
    // A hand-typed invite row with capitals: the sign-in gate matches exactly and turns this
    // person away, so the card must not call them invited either.
    await database.insert(invites).values({ email: "Caps@Shop.com", invitedAt: at });
    expect(await isAllowedToSignIn("caps@shop.com")).toBe(false);
    expect(await isAllowedToSignIn("form@shop.com")).toBe(true);
    await ensureUserAndWorkspace({ email: "admin@shop.com" });

    const states = Object.fromEntries(
      (await listWaitlist()).map((w) => [w.email, [w.inviteState, w.inviteAt]]),
    );
    expect(states).toEqual({
      "new@shop.com": ["not_invited", null],
      "gone@shop.com": ["invite_gone", null],
      "form@shop.com": ["invited", at],
      "admin@shop.com": ["has_account", null],
      "caps@shop.com": ["not_invited", null],
    });
  });

  it("keeps a referral code (#47) only while referrals are on, and only a well-formed one", async () => {
    const code = "AbCdEf123_-x";
    const ann = { name: "Ann", email: "ann@yahoo.com", trade: "carpentry", teamSize: "Just me" };
    const parsed = waitlistInput.parse({ ...ann, referralCode: code });
    expect(parsed.referralCode).toBe(code);
    expect(waitlistInput.parse({ ...ann, referralCode: "bad code" }).referralCode).toBeNull();
    expect(waitlistInput.parse(ann).referralCode).toBeNull();

    // Off (the default): accepted by the form, but not stored.
    await joinWaitlist(parsed);
    // On, with an amount: stored.
    process.env.FEATURE_REFERRALS = "1";
    setReferralConfigForTests({ reward: "free_month_one_plan_up" });
    await joinWaitlist({ ...parsed, email: "bo@yahoo.com" });
    const rows = await database.select().from(waitlist);
    const byEmail = Object.fromEntries(rows.map((r) => [r.email, r.referralCode]));
    expect(byEmail).toEqual({ "ann@yahoo.com": null, "bo@yahoo.com": code });
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
    expect(r.errors?.teamSize?.[0]).toBe("Pick how many people are in the business.");
    expect(await database.select().from(waitlist)).toEqual([]);
  });

  it("too many tries: the message is for the whole form, not under the email (Check 6 P10)", async () => {
    let r = await joinWaitlistAction({ status: "idle" }, form({}));
    for (let i = 0; i < 20 && !r.errors?.form; i++) {
      r = await joinWaitlistAction({ status: "idle" }, form({}));
    }
    expect(r.status).toBe("error");
    expect(r.errors?.form?.[0]).toBe(
      "Too many tries from here. Try again in an hour, or give us a call.",
    );
    expect(r.errors?.email).toBeUndefined();
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
    expect(r.errors?.email).toEqual(["That doesn't look like an email address."]);
    expect(await database.select().from(waitlist)).toEqual([]);
  });

  it("a failed save logs no name, email, phone or note, and keeps what they typed with a plain message", async () => {
    const leaky = new DrizzleQueryError(
      'insert into "waitlist" ("email", "name", "phone", "note") values ($1, $2, $3, $4)',
      ["mike@shop.com", "Mike Torres", "617-555-0142", "Lowell kitchen"],
      new Error("connection reset"),
    );
    vi.spyOn(database, "transaction").mockRejectedValue(leaky);
    const spies = (["error", "warn", "info", "log"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const r = await joinWaitlistAction(
      { status: "idle" },
      form({ ...good, phone: "617-555-0142", note: "Lowell kitchen" }),
    );
    expect(r.status).toBe("error");
    expect(r.errors?.form).toEqual([
      "We couldn't save that just now. Try again in a minute, or call or text 978-201-9763.",
    ]);
    expect(r.values).toMatchObject({
      name: "Mike Torres",
      phone: "617-555-0142",
      note: "Lowell kitchen",
    });
    expect(afterTasks).toEqual([]);
    const out = JSON.stringify(spies.map((s) => s.mock.calls));
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
      trade: "carpentry", // the app form's answer; Growth's "roofing" stays in its block
      name: "Mike Torres",
      // The Growth number stays in the request; the app form gave none.
      phone: null,
    });
    const { appNote, growth: requests } = splitWaitlistNote(row!.note);
    expect(appNote).toBe("Two trucks");
    expect(requests).toHaveLength(1);
    expect(row!.note!.startsWith("Two trucks\n\n[Growth call] ")).toBe(true);
    expect(requests[0]!.phone).toBe("617-555-0142");
    expect(requests[0]!.tradeGiven).toBe("Roofing");

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
    expect(inv?.trade).toBe("carpentry");
  });

  it("upgrading a Growth-only entry uses the app form's trade, and drops a stale 'Trade given'", async () => {
    // Same trade on both forms: nothing extra in the block.
    await requestGrowthCall(growth("rosa@plumb.com", { trade: "carpentry" }));
    await joinWaitlist(app("rosa@plumb.com"));
    const [same] = await database.select().from(waitlist);
    expect(same!.trade).toBe("carpentry");
    expect(splitWaitlistNote(same!.note).growth[0]!.tradeGiven).toBeNull();

    // A second Growth request gave another trade ("Trade given: Roofing"), then the app form
    // picks roofing: the row says roofing and the block no longer repeats it.
    await requestGrowthCall(growth("bo@shop.com", { trade: "carpentry" }));
    await requestGrowthCall(growth("bo@shop.com", { trade: "roofing", phone: "978-555-0100" }));
    const [before] = await database
      .select()
      .from(waitlist)
      .where(eq(waitlist.email, "bo@shop.com"));
    expect(splitWaitlistNote(before!.note).growth[0]!.tradeGiven).toBe("Roofing");
    await joinWaitlist(
      waitlistInput.parse({
        name: "Bo",
        email: "bo@shop.com",
        trade: "roofing",
        teamSize: "Just me",
      }),
    );
    const [after] = await database.select().from(waitlist).where(eq(waitlist.email, "bo@shop.com"));
    expect(after!.trade).toBe("roofing");
    const [request] = splitWaitlistNote(after!.note).growth;
    expect(request).toMatchObject({ tradeGiven: null, phone: "978-555-0100" });
    expect(await inviteFromWaitlist("bo@shop.com")).toBe("invited");
    const [inv] = await database.select().from(invites);
    expect(inv?.trade).toBe("roofing");
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

  describe("with referral links (#47) switched on", () => {
    const code = "AbCdEf123_-x";
    const referrer = async () => {
      const { workspace } = await ensureUserAndWorkspace({ email: "rosa@gmail.com" });
      await database
        .update(workspaces)
        .set({ referralCode: code })
        .where(eq(workspaces.id, workspace.id));
      return workspace.id;
    };
    const on = () => {
      process.env.FEATURE_REFERRALS = "1";
      setReferralConfigForTests({ reward: "free_month_one_plan_up" });
    };

    it("a Growth request keeps its link's code (Davi, 2026-10-16); off, it keeps none", async () => {
      await requestGrowthCall(growth("off@shop.com", { referralCode: code }));
      on();
      await requestGrowthCall(growth("mike@shop.com", { referralCode: code }));
      // A later request with another code never replaces the first.
      await requestGrowthCall(growth("mike@shop.com", { referralCode: "ZZZZZZZZZZZZ" }));
      // ...and one without a code keeps it.
      await requestGrowthCall(growth("mike@shop.com"));
      const byEmail = Object.fromEntries(
        (await database.select().from(waitlist)).map((r) => [r.email, r.referralCode]),
      );
      expect(byEmail).toEqual({ "off@shop.com": null, "mike@shop.com": code });
      expect(growth("x@shop.com", { referralCode: "bad code" }).referralCode).toBeNull();
    });

    it("a Growth request with no code; the app sign-up that upgrades it stores one, and the invite carries it", async () => {
      on();
      const referrerId = await referrer();
      await requestGrowthCall(growth("mike@shop.com"));
      const [growthOnly] = await database.select().from(waitlist);
      expect(growthOnly!.referralCode).toBeNull();

      expect(await joinWaitlist({ ...app("mike@shop.com"), referralCode: code })).toBe("joined");
      const [upgraded] = await database.select().from(waitlist);
      expect(upgraded).toMatchObject({ teamSize: "2–5", referralCode: code });

      expect(await inviteFromWaitlist("mike@shop.com")).toBe("invited");
      const [inv] = await database.select().from(invites);
      expect(inv?.referredByWorkspaceId).toBe(referrerId);
      expect(inv?.note ?? null).toBeNull();
    });

    it("upgrading a Growth-only entry while referrals are off stores no code", async () => {
      await requestGrowthCall(growth("mike@shop.com"));
      await joinWaitlist({ ...app("mike@shop.com"), referralCode: code });
      const [row] = await database.select().from(waitlist);
      expect(row).toMatchObject({ teamSize: "2–5", referralCode: null });
    });

    it("a Growth-only entry is never invited, even carrying a code", async () => {
      on();
      await referrer();
      await requestGrowthCall(growth("mike@shop.com"));
      // However it got there (seeded, or saved by older code), a code doesn't make it an invite.
      await database.update(waitlist).set({ referralCode: code });
      expect(await inviteFromWaitlist("mike@shop.com")).toBe("growth_only");
      expect(await database.select().from(invites)).toEqual([]);
      expect(await isAllowedToSignIn("mike@shop.com")).toBe(false);
    });
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
