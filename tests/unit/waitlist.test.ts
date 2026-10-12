import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { invites, waitlist } from "@/db/schema";
import { isAllowedToSignIn } from "@/server/accounts";
import { setReferralConfigForTests } from "@/server/referral-rules";
import { inviteFromWaitlist, joinWaitlist, waitlistInput } from "@/server/waitlist";
import { createTestDb } from "../support/db";

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
    });
    expect(await joinWaitlist(input)).toBe("joined");
    expect(await joinWaitlist({ ...input, name: "Someone else" })).toBe("already");
    const [row] = await database.select().from(waitlist);
    expect(row).toMatchObject({ email: "mike@shop.com", name: "Mike" });
  });

  it("joining the waitlist doesn't let anyone sign in; Davi's invite does", async () => {
    await joinWaitlist(
      waitlistInput.parse({ name: "Rosa", email: "rosa@plumb.com", trade: "plumbing" }),
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

  it("keeps a referral code (#47) only while referrals are on, and only a well-formed one", async () => {
    const code = "AbCdEf123_-x";
    const parsed = waitlistInput.parse({ name: "Ann", email: "ann@yahoo.com", referralCode: code });
    expect(parsed.referralCode).toBe(code);
    expect(
      waitlistInput.parse({ name: "Ann", email: "ann@yahoo.com", referralCode: "bad code" })
        .referralCode,
    ).toBeNull();
    expect(waitlistInput.parse({ name: "Ann", email: "ann@yahoo.com" }).referralCode).toBeNull();

    // Off (the default): accepted by the form, but not stored.
    await joinWaitlist(parsed);
    // On, with an amount: stored.
    process.env.FEATURE_REFERRALS = "1";
    setReferralConfigForTests({ cents: 1_000, to: "both" });
    await joinWaitlist({ ...parsed, email: "bo@yahoo.com" });
    const rows = await database.select().from(waitlist);
    const byEmail = Object.fromEntries(rows.map((r) => [r.email, r.referralCode]));
    expect(byEmail).toEqual({ "ann@yahoo.com": null, "bo@yahoo.com": code });
  });
});
