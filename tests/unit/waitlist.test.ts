import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { invites, waitlist } from "@/db/schema";
import { isAllowedToSignIn } from "@/server/accounts";
import { inviteFromWaitlist, joinWaitlist, waitlistInput } from "@/server/waitlist";
import { createTestDb } from "../support/db";

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
});
