import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import {
  activityLog,
  businessProfiles,
  mailboxes,
  rateLimits,
  threads,
  users,
  workspaces,
} from "@/db/schema";
import type { MailboxConnector } from "@/mailbox/connector";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { deleteAccount, SubscriptionCancelError } from "@/server/account-deletion";
import { setStripeForTests } from "@/server/billing";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { hitLimit, ipKey, LIMITS, purgeRateLimits } from "@/server/rate-limit";
import { createTestDb } from "../support/db";

let database: Database;
beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
});
afterEach(() => setStripeForTests(undefined));

describe("rate limits", () => {
  const T = new Date("2026-10-10T14:00:05Z");

  it("allows up to the limit, then refuses until the window turns over", async () => {
    const { max, windowSec } = LIMITS.send;
    for (let i = 0; i < max; i++) expect((await hitLimit("send", "w1", T)).allowed).toBe(true);
    const over = await hitLimit("send", "w1", T);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSec).toBeGreaterThan(0);
    expect(over.retryAfterSec).toBeLessThanOrEqual(windowSec);

    // Someone else isn't affected; neither is another kind of action.
    expect((await hitLimit("send", "w2", T)).allowed).toBe(true);
    expect((await hitLimit("draft", "w1", T)).allowed).toBe(true);

    const next = new Date(T.getTime() + windowSec * 1000);
    expect((await hitLimit("send", "w1", next)).allowed).toBe(true);
  });

  it("re-learning voice is limited to three a day", async () => {
    for (let i = 0; i < 3; i++) expect((await hitLimit("relearn", "w1", T)).allowed).toBe(true);
    expect((await hitLimit("relearn", "w1", T)).allowed).toBe(false);
  });

  it("never stores a raw IP address", async () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
    const key = ipKey(h);
    expect(key).not.toContain("203.0.113.9");
    expect(key).toBe(ipKey(new Headers({ "x-forwarded-for": "203.0.113.9" })));
    expect(key).not.toBe(ipKey(new Headers({ "x-forwarded-for": "203.0.113.10" })));
    await hitLimit("waitlist", key, T);
    const rows = await database.select().from(rateLimits);
    expect(JSON.stringify(rows)).not.toContain("203.0.113");
  });

  it("old windows are cleaned up", async () => {
    await hitLimit("send", "w1", new Date("2026-10-01T00:00:00Z"));
    await hitLimit("send", "w2", T);
    await purgeRateLimits(T);
    const rows = await database.select().from(rateLimits);
    expect(rows.map((r) => r.key)).toEqual(["send:w2"]);
  });
});

describe("delete my account", () => {
  const revoked: string[] = [];
  const connector = {
    revoke: async (token: string) => {
      revoked.push(token);
    },
  } as unknown as MailboxConnector;

  async function seed() {
    revoked.length = 0;
    const { user, workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "refresh-1",
      grantedScopes: [],
    });
    const [mb] = await database.select().from(mailboxes);
    await database
      .insert(threads)
      .values({ mailboxId: mb!.id, gmailThreadId: "t1", subject: "Panel upgrade" } as never);
    await database.insert(businessProfiles).values({ workspaceId: workspace.id } as never);
    return { user, workspace };
  }

  it("revokes Google, cancels billing, and deletes every row", async () => {
    const { user, workspace } = await seed();
    await database
      .update(workspaces)
      .set({ stripeSubscriptionId: "sub_1" })
      .where(eq(workspaces.id, workspace.id));
    const canceled: string[] = [];
    setStripeForTests({
      subscriptions: { cancel: async (id: string) => void canceled.push(id) },
    } as unknown as Stripe);

    const r = await deleteAccount(user.id, connector);
    expect(r).toEqual({ mailboxes: 1, revoked: 1, subscriptionCanceled: true });
    expect(revoked).toEqual(["refresh-1"]);
    expect(canceled).toEqual(["sub_1"]);
    for (const table of [users, workspaces, mailboxes, threads, businessProfiles, activityLog]) {
      expect(await database.select().from(table)).toHaveLength(0);
    }
  });

  it("still deletes when Google's revoke fails", async () => {
    const { user } = await seed();
    const failing = {
      revoke: async () => {
        throw new Error("network");
      },
    } as unknown as MailboxConnector;
    const r = await deleteAccount(user.id, failing);
    expect(r.revoked).toBe(0);
    expect(await database.select().from(users)).toHaveLength(0);
  });

  it("deletes nothing if the plan can't be canceled", async () => {
    const { user, workspace } = await seed();
    await database
      .update(workspaces)
      .set({ stripeSubscriptionId: "sub_1" })
      .where(eq(workspaces.id, workspace.id));
    setStripeForTests({
      subscriptions: {
        cancel: async () => {
          throw new Error("stripe down");
        },
      },
    } as unknown as Stripe);
    await expect(deleteAccount(user.id, connector)).rejects.toBeInstanceOf(SubscriptionCancelError);
    expect(revoked).toEqual([]);
    expect(await database.select().from(users)).toHaveLength(1);
    expect(await database.select().from(mailboxes)).toHaveLength(1);
  });

  it("a subscription Stripe already ended doesn't block deletion", async () => {
    const { user, workspace } = await seed();
    await database
      .update(workspaces)
      .set({ stripeSubscriptionId: "sub_gone" })
      .where(eq(workspaces.id, workspace.id));
    setStripeForTests({
      subscriptions: {
        cancel: async () => {
          throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
        },
      },
    } as unknown as Stripe);
    await deleteAccount(user.id, connector);
    expect(await database.select().from(users)).toHaveLength(0);
  });
});
