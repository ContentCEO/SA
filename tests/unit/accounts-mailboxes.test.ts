import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { activityLog, drafts, invites, mailboxes, threads, workspaces } from "@/db/schema";
import type { MailboxConnector } from "@/mailbox/connector";
import { ensureUserAndWorkspace, isAllowedToSignIn } from "@/server/accounts";
import {
  InboxSwapError,
  MailboxLimitError,
  disconnectMailbox,
  listMailboxes,
  mailboxLimit,
  saveConnectedMailbox,
  swapPausedInbox,
} from "@/server/mailboxes";
import { inboxLimitEffects, resumeOverPlanInboxes } from "@/server/workspace-lifecycle";
import { decryptSecret } from "@/lib/crypto";
import { createTestDb } from "../support/db";

let database: Database;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.ADMIN_EMAIL = "davi@example.com";
  database = await createTestDb();
});

function fakeConnector(revoke = vi.fn().mockResolvedValue(undefined)): MailboxConnector {
  return {
    provider: "gmail",
    requiredScopes: [],
    authorizationUrl: () => "",
    exchangeCode: vi.fn(),
    revoke,
  };
}

const connect = (email: string, refreshToken = "rt-" + email) => ({
  email,
  refreshToken,
  grantedScopes: ["a", "b"],
});

describe("invite-only sign-in", () => {
  it("lets in invited emails (case-insensitive) and the admin, and nobody else", async () => {
    await database.insert(invites).values({ email: "owner@shop.com", trade: "plumbing" });
    expect(await isAllowedToSignIn("Owner@Shop.com")).toBe(true);
    expect(await isAllowedToSignIn("DAVI@example.com")).toBe(true);
    expect(await isAllowedToSignIn("stranger@shop.com")).toBe(false);
  });

  it("creates one user and one workspace no matter how often they sign in", async () => {
    await database.insert(invites).values({ email: "owner@shop.com", trade: "electrical" });
    const first = await ensureUserAndWorkspace({ email: "Owner@Shop.com", name: "Dana" });
    const second = await ensureUserAndWorkspace({ email: "owner@shop.com", name: null });
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.name).toBe("Dana");
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(first.workspace.status).toBe("invited");
    expect(first.workspace.trade).toBe("electrical");
    const [invite] = await database.select().from(invites);
    expect(invite!.acceptedAt).not.toBeNull();
  });
});

describe("mailboxes", () => {
  it("stores the refresh token encrypted and never lists it", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "o@shop.com" });
    await saveConnectedMailbox(workspace, connect("o@shop.com", "super-secret-token"));

    const [row] = await database.select().from(mailboxes);
    expect(row!.encryptedRefreshToken).not.toContain("super-secret-token");
    expect(decryptSecret(row!.encryptedRefreshToken)).toBe("super-secret-token");

    const listed = await listMailboxes(workspace.id);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("super-secret-token");
    expect(Object.keys(listed[0]!)).not.toContain("encryptedRefreshToken");
  });

  it("allows one mailbox during evaluation, but reconnecting the same one is fine", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "o@shop.com" });
    await saveConnectedMailbox(workspace, connect("o@shop.com", "first"));
    await database.update(mailboxes).set({ status: "reconnect_needed" });

    const again = await saveConnectedMailbox(workspace, connect("O@shop.com", "second"));
    expect(again.status).toBe("active");
    const rows = await database.select().from(mailboxes);
    expect(rows).toHaveLength(1);
    expect(decryptSecret(rows[0]!.encryptedRefreshToken)).toBe("second");

    await expect(saveConnectedMailbox(workspace, connect("other@shop.com"))).rejects.toBeInstanceOf(
      MailboxLimitError,
    );
  });

  it("enforces the Crew limit of three", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "o@shop.com" });
    await database.update(workspaces).set({ plan: "crew" }).where(eq(workspaces.id, workspace.id));
    const crew = { ...workspace, plan: "crew" as const };
    for (const e of ["a@x.com", "b@x.com", "c@x.com"]) await saveConnectedMailbox(crew, connect(e));
    await expect(saveConnectedMailbox(crew, connect("d@x.com"))).rejects.toBeInstanceOf(
      MailboxLimitError,
    );
  });

  it("disconnect revokes at Google, deletes the mailbox, and logs it", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "o@shop.com" });
    const m = await saveConnectedMailbox(workspace, connect("o@shop.com", "tok"));
    const revoke = vi.fn().mockResolvedValue(undefined);

    expect(await disconnectMailbox(workspace.id, m.id, fakeConnector(revoke))).toBe(true);
    expect(revoke).toHaveBeenCalledWith("tok");
    expect(await database.select().from(mailboxes)).toHaveLength(0);

    const log = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mailbox_disconnected"));
    expect(log).toHaveLength(1);
    expect(log[0]!.detail).toMatchObject({ revokedAtProvider: true });
    expect(JSON.stringify(log[0]!.detail)).not.toContain("tok");
  });

  it("still deletes our copy if Google's revoke fails", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "o@shop.com" });
    const m = await saveConnectedMailbox(workspace, connect("o@shop.com"));
    const revoke = vi.fn().mockRejectedValue(new Error("down"));
    expect(await disconnectMailbox(workspace.id, m.id, fakeConnector(revoke))).toBe(true);
    expect(await database.select().from(mailboxes)).toHaveLength(0);
  });

  it("won't disconnect a mailbox from someone else's workspace", async () => {
    const a = await ensureUserAndWorkspace({ email: "a@shop.com" });
    const b = await ensureUserAndWorkspace({ email: "b@shop.com" });
    const m = await saveConnectedMailbox(a.workspace, connect("a@shop.com"));
    const revoke = vi.fn();

    expect(await disconnectMailbox(b.workspace.id, m.id, fakeConnector(revoke))).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
    expect(await database.select().from(mailboxes)).toHaveLength(1);
  });
});

// --- Plan #47 offer A: the plan that counts, and inboxes over it (§3.6) --------------------

describe("inbox limits follow the plan that counts", () => {
  const NOW = new Date("2026-10-16T15:00:00Z");
  const DAY = 86_400_000;
  let workspaceId: string;

  async function ws() {
    const [w] = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    return w!;
  }
  async function setPlan(values: Partial<typeof workspaces.$inferInsert>) {
    await database.update(workspaces).set(values).where(eq(workspaces.id, workspaceId));
  }
  /** Inboxes made a day apart: a, b, c (oldest first). */
  async function threeInboxes() {
    await setPlan({ plan: "crew", status: "active", setupPaidVia: "stripe" });
    const ids: string[] = [];
    for (const [i, e] of ["a@x.com", "b@x.com", "c@x.com"].entries()) {
      const m = await saveConnectedMailbox(await ws(), connect(e));
      await database
        .update(mailboxes)
        .set({ createdAt: new Date(NOW.getTime() - (10 - i) * DAY) })
        .where(eq(mailboxes.id, m.id));
      ids.push(m.id);
    }
    return ids;
  }
  const byEmail = async () =>
    Object.fromEntries(
      (await database.select().from(mailboxes)).map((m) => [m.email, [m.status, m.pausedReason]]),
    );
  const logs = (action: string) =>
    database.select().from(activityLog).where(eq(activityLog.action, action));

  beforeEach(async () => {
    workspaceId = (await ensureUserAndWorkspace({ email: "o@shop.com" })).workspace.id;
  });

  it("a running free month raises the limit, and it drops at the end with no job", async () => {
    await setPlan({ plan: "solo", freePlan: "crew", freePlanUntil: new Date(NOW.getTime() + DAY) });
    const w = await ws();
    expect(mailboxLimit(w, NOW)).toBe(3);
    expect(mailboxLimit(w, new Date(NOW.getTime() + DAY))).toBe(1);
    expect(mailboxLimit({ ...w, freePlan: null }, NOW)).toBe(1);
    expect(mailboxLimit({ plan: null, freePlan: null, freePlanUntil: null }, NOW)).toBe(1);
  });

  it("over the limit, the newest-created inboxes pause; a reconnect never moves the first one back", async () => {
    const [a] = await threeInboxes();
    // The first inbox is reconnected mid-month: connected_at moves, created_at doesn't.
    await saveConnectedMailbox(await ws(), connect("a@x.com", "new-token"));
    expect((await database.select().from(mailboxes).where(eq(mailboxes.id, a!)))[0]!.status).toBe(
      "active",
    );
    await setPlan({ plan: "solo" });
    expect(await inboxLimitEffects(workspaceId, NOW)).toBe(2);
    expect(await byEmail()).toEqual({
      "a@x.com": ["active", null],
      "b@x.com": ["paused", "over_plan"],
      "c@x.com": ["paused", "over_plan"],
    });
    const paused = await logs("inboxes_paused_plan");
    expect(paused.map((l) => l.detail)).toEqual([{ count: 2, plan: "solo", limit: 1 }]);
    // Idempotent: nothing more to pause, nothing more logged. Nothing was deleted.
    expect(await inboxLimitEffects(workspaceId, NOW)).toBe(0);
    expect(await logs("inboxes_paused_plan")).toHaveLength(1);
    expect(await database.select().from(mailboxes)).toHaveLength(3);
  });

  it("an inbox that needs a reconnect still counts against the limit", async () => {
    await threeInboxes();
    await database
      .update(mailboxes)
      .set({ status: "reconnect_needed" })
      .where(eq(mailboxes.email, "a@x.com"));
    await setPlan({ plan: "solo" });
    await inboxLimitEffects(workspaceId, NOW);
    expect(await byEmail()).toEqual({
      "a@x.com": ["reconnect_needed", null],
      "b@x.com": ["paused", "over_plan"],
      "c@x.com": ["paused", "over_plan"],
    });
  });

  it("a free month that is still running keeps every inbox on", async () => {
    await threeInboxes();
    await setPlan({ plan: "solo", freePlan: "crew", freePlanUntil: new Date(NOW.getTime() + DAY) });
    expect(await inboxLimitEffects(workspaceId, NOW)).toBe(0);
    expect(await inboxLimitEffects(workspaceId, new Date(NOW.getTime() + DAY))).toBe(2);
  });

  it("pausing an inbox stops its autopilot countdowns (and no other inbox's)", async () => {
    const ids = await threeInboxes();
    const countdowns: string[] = [];
    for (const mailboxId of ids) {
      const [t] = await database
        .insert(threads)
        .values({ mailboxId, gmailThreadId: `t-${mailboxId}` })
        .returning();
      const [d] = await database
        .insert(drafts)
        .values({
          threadId: t!.id,
          mailboxId,
          gmailDraftId: `g-${mailboxId}`,
          toAddress: "dana@customer.com",
          subject: "Re",
          body: "b",
          originalBody: "b",
          reason: "r",
          promptVersion: "draft.v1",
          autoSendAt: new Date(NOW.getTime() + 600_000),
        })
        .returning();
      countdowns.push(d!.id);
    }
    await setPlan({ plan: "solo" });
    await inboxLimitEffects(workspaceId, NOW);
    const left = await database.select().from(drafts);
    expect(left.filter((d) => d.autoSendAt !== null).map((d) => d.mailboxId)).toEqual([ids[0]]);
  });

  it("reconnecting a paused inbox at the limit is refused; below it, it switches back on", async () => {
    await threeInboxes();
    await setPlan({ plan: "solo" });
    await inboxLimitEffects(workspaceId, NOW);
    const refused = await saveConnectedMailbox(await ws(), connect("b@x.com")).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(MailboxLimitError);
    expect((refused as MailboxLimitError).reason).toBe("paused_over_plan");
    expect((await byEmail())["b@x.com"]).toEqual(["paused", "over_plan"]);
    // A new address is refused as before (paused inboxes don't make room).
    expect(
      await saveConnectedMailbox(await ws(), connect("d@x.com")).catch((e: unknown) => e),
    ).toMatchObject({ reason: "limit" });

    await setPlan({ plan: "crew" });
    await saveConnectedMailbox(await ws(), connect("b@x.com"));
    expect((await byEmail())["b@x.com"]).toEqual(["active", null]);
  });

  it("disconnecting an inbox that is on switches the oldest paused one back on", async () => {
    const [a] = await threeInboxes();
    await setPlan({ plan: "solo" });
    await inboxLimitEffects(workspaceId, NOW);
    expect(await disconnectMailbox(workspaceId, a!, fakeConnector())).toBe(true);
    expect(await byEmail()).toEqual({
      "b@x.com": ["active", null],
      "c@x.com": ["paused", "over_plan"],
    });
    expect((await logs("inboxes_resumed_plan")).map((l) => l.detail)).toEqual([{ count: 1 }]);
  });

  it("moving up a plan switches paused inboxes back on, up to the new limit", async () => {
    await threeInboxes();
    await setPlan({ plan: "solo" });
    await inboxLimitEffects(workspaceId, NOW);
    expect(await resumeOverPlanInboxes(workspaceId, NOW)).toBe(0); // no room on Solo
    await setPlan({ plan: "crew" });
    expect(await resumeOverPlanInboxes(workspaceId, NOW)).toBe(2);
    expect(Object.values(await byEmail()).every(([s]) => s === "active")).toBe(true);
    expect(await resumeOverPlanInboxes(workspaceId, NOW)).toBe(0);
  });

  it("the owner can swap which inbox is on; the limit holds and only their own inboxes move", async () => {
    const [a, b] = await threeInboxes();
    await setPlan({ plan: "solo" });
    await inboxLimitEffects(workspaceId, NOW);
    await swapPausedInbox(workspaceId, b!, a!, NOW);
    expect(await byEmail()).toEqual({
      "a@x.com": ["paused", "over_plan"],
      "b@x.com": ["active", null],
      "c@x.com": ["paused", "over_plan"],
    });
    const swapped = await logs("inbox_swapped");
    expect(swapped.map((l) => [l.actor, l.detail])).toEqual([["owner", {}]]);

    // Refused, and nothing moves: the same inbox twice, pausing one that's already paused,
    // or another workspace's inboxes.
    const before = await byEmail();
    const c = (await database.select().from(mailboxes).where(eq(mailboxes.email, "c@x.com")))[0]!;
    await expect(swapPausedInbox(workspaceId, a!, a!, NOW)).rejects.toBeInstanceOf(InboxSwapError);
    await expect(swapPausedInbox(workspaceId, c.id, a!, NOW)).rejects.toMatchObject({
      code: "not_on",
    });
    const other = (await ensureUserAndWorkspace({ email: "x@other.com" })).workspace.id;
    await expect(swapPausedInbox(other, a!, b!, NOW)).rejects.toMatchObject({ code: "not_on" });
    expect(await byEmail()).toEqual(before);

    // Switching on one that isn't paused rolls the whole swap back.
    await setPlan({ plan: "crew" });
    await resumeOverPlanInboxes(workspaceId, NOW);
    await expect(swapPausedInbox(workspaceId, b!, a!, NOW)).rejects.toMatchObject({
      code: "not_paused",
    });
    expect(Object.values(await byEmail()).every(([s]) => s === "active")).toBe(true);
  });
});
