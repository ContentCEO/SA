import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { pricing } from "@/config/pricing";
import type { Database } from "@/db";
import { invites, waitlist } from "@/db/schema";
import { ensureUserAndWorkspace, isAllowedToSignIn } from "@/server/accounts";
import { inviteOwner, listInvites, removeInvite } from "@/server/admin";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { cardNotice, type CardNoticeRow } from "@/server/admin-rules";
import { listWaitlist } from "@/server/waitlist";
import { createTestDb } from "../support/db";

let database: Database;
beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
});

describe("taking back an invite (Check 16 P7)", () => {
  it("removes an unused invite; the address can't sign in; its waitlist entry offers Invite again", async () => {
    await database
      .insert(waitlist)
      .values({ email: "joe@shop.com", name: "Joe", invitedAt: new Date() });
    await inviteOwner({ email: "Joe@Shop.com" });
    expect(await isAllowedToSignIn("joe@shop.com")).toBe(true);
    expect(await removeInvite("JOE@shop.com")).toBe("removed");
    expect(await database.select().from(invites)).toHaveLength(0);
    expect(await isAllowedToSignIn("joe@shop.com")).toBe(false);
    const [entry] = await listWaitlist();
    expect(entry!.invitedAt).toBeNull();
    expect(entry!.inviteState).toBe("not_invited");
    expect(await removeInvite("joe@shop.com")).toBe("not_found");
  });

  it("refuses once accepted, or when an account has that email", async () => {
    await inviteOwner({ email: "dana@shop.com" });
    await database
      .update(invites)
      .set({ acceptedAt: new Date() })
      .where(eq(invites.email, "dana@shop.com"));
    expect(await removeInvite("dana@shop.com")).toBe("already_signed_in");

    await inviteOwner({ email: "mike@shop.com" });
    await ensureUserAndWorkspace({ email: "Mike@Shop.com" });
    expect(await removeInvite("mike@shop.com")).toBe("already_signed_in");
    expect(await database.select().from(invites)).toHaveLength(2);
  });
});

describe("the notice lands on the card that changed (Check 16 P6)", () => {
  const ID = "6f1c2b8e-1d2a-4c3b-9e4f-0a1b2c3d4e5f";
  const rows: CardNoticeRow[] = [
    {
      workspaceId: ID,
      businessName: "Ruiz Street Plumbing",
      ownerEmail: "ruiz@shop.com",
      plan: "crew",
      evaluationEndsAt: new Date("2026-10-22T00:24:00Z"),
    },
  ];

  it("names the shop for each move", () => {
    const n = (done: string) => cardNotice({ done, w: ID }, rows, pricing.plans)?.text;
    expect(n("pause")).toBe("Paused Ruiz Street Plumbing.");
    expect(n("plan")).toBe("Plan saved for Ruiz Street Plumbing: Crew.");
    expect(n("extend_evaluation")).toBe(
      "Added 3 days for Ruiz Street Plumbing. Trial now ends Oct 21, 8:24 PM.",
    );
    expect(cardNotice({ error: "move", w: ID }, rows, pricing.plans)).toMatchObject({
      strong: true,
    });
  });

  it("an unknown or malformed w shows no notice and doesn't throw", () => {
    for (const w of [
      undefined,
      "",
      "not-a-uuid",
      "../x",
      ["a"],
      "6f1c2b8e-1d2a-4c3b-9e4f-000000000000",
    ]) {
      expect(cardNotice({ done: "pause", w }, rows, pricing.plans)).toBeNull();
    }
    expect(cardNotice({ done: "launch_ticked", w: ID }, rows, pricing.plans)).toBeNull();
  });
});

describe("the Google test-user reminder (Check 16 P9)", () => {
  it("listInvites marks gmailConnected for an owner with a mailbox, not one without", async () => {
    await inviteOwner({ email: "connected@shop.com" });
    await inviteOwner({ email: "waiting@shop.com" });
    const { workspace } = await ensureUserAndWorkspace({ email: "Connected@Shop.com" });
    await ensureUserAndWorkspace({ email: "waiting@shop.com" });
    await saveConnectedMailbox(workspace, {
      email: "connected@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    });
    const list = await listInvites();
    expect(Object.fromEntries(list.map((i) => [i.email, i.gmailConnected]))).toEqual({
      "connected@shop.com": true,
      "waiting@shop.com": false,
    });
  });
});
