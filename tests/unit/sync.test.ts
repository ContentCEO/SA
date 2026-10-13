import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { activityLog, mailboxes, messages, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { incrementalSync, purgeExpiredBodies, recordSentMessage, runBackfill } from "@/server/sync";
import { createTestDb } from "../support/db";
import { FakeMailbox } from "../support/fake-mailbox";

const NOW = new Date("2026-09-28T12:00:00Z");
let database: Database;
let mailboxId: string;
let fake: FakeMailbox;
const deps = () => ({ readerFor: () => fake.reader(), now: () => NOW });

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  const m = await saveConnectedMailbox(workspace, {
    email: "owner@shop.com",
    refreshToken: "rt",
    grantedScopes: ["x"],
  });
  mailboxId = m.id;
  fake = new FakeMailbox();
});

describe("30-day backfill", () => {
  it("stores metadata for everything but bodies only for inbox threads", async () => {
    fake.add({ id: "m1", threadId: "t1", labelIds: ["INBOX"] });
    fake.add({
      id: "m2",
      threadId: "t1",
      labelIds: ["SENT"],
      headers: { from: "owner@shop.com", to: "a@b.com" },
    });
    fake.add({ id: "m3", threadId: "t2", labelIds: ["CATEGORY_PROMOTIONS"] }); // archived newsletter
    fake.add({ id: "m4", threadId: "t3", labelIds: ["INBOX"], daysAgo: 40 }); // outside window

    const out = await runBackfill(mailboxId, deps());
    expect(out).toMatchObject({ status: "ok", ingested: 3 });

    const rows = await database.select().from(messages);
    const byId = Object.fromEntries(rows.map((r) => [r.gmailMessageId, r]));
    expect(Object.keys(byId).sort()).toEqual(["m1", "m2", "m3"]);
    expect(byId.m1!.bodyText).toBe("body of m1");
    expect(byId.m2!.bodyText).toBe("body of m2"); // our reply, in an inbox thread
    expect(byId.m2!.direction).toBe("out");
    expect(byId.m1!.direction).toBe("in");
    expect(byId.m3!.bodyText).toBeNull(); // not in inbox → metadata only
    expect(fake.bodyFetches.sort()).toEqual(["m1", "m2"]);

    const t = await database.select().from(threads).where(eq(threads.gmailThreadId, "t1"));
    expect(t[0]!.inInbox).toBe(true);
    expect(t[0]!.participants).toContain("customer-t1@example.com");
    expect(t[0]!.participants).not.toContain("owner@shop.com");

    const [box] = await database.select().from(mailboxes);
    expect(box!.backfillCompletedAt).toEqual(NOW);
    expect(box!.historyId).toBe("104");
  });

  it("is safe to run twice", async () => {
    fake.add({ id: "m1", threadId: "t1" });
    fake.add({ id: "m2", threadId: "t2" });
    fake.add({ id: "m3", threadId: "t2" });
    await runBackfill(mailboxId, deps());
    const again = await runBackfill(mailboxId, deps());
    expect(again).toMatchObject({ status: "ok", ingested: 0 });
    expect(await database.select().from(messages)).toHaveLength(3);
    expect(await database.select().from(threads)).toHaveLength(2);
  });

  it("doesn't store body text that is already past retention", async () => {
    process.env.RETENTION_BODY_DAYS = "10";
    fake.add({ id: "old", threadId: "t1", daysAgo: 20 });
    await runBackfill(mailboxId, deps());
    const [row] = await database.select().from(messages);
    expect(row!.bodyText).toBeNull();
    expect(row!.snippet).toBeNull();
    delete process.env.RETENTION_BODY_DAYS;
  });
});

describe("incremental sync", () => {
  it("picks up only what's new since the cursor", async () => {
    fake.add({ id: "m1", threadId: "t1" });
    await runBackfill(mailboxId, deps());
    fake.add({ id: "m2", threadId: "t1", daysAgo: 0 });
    fake.add({ id: "m3", threadId: "t9", daysAgo: 0 });

    const out = await incrementalSync(mailboxId, deps());
    expect(out).toMatchObject({ status: "ok", ingested: 2 });
    expect(await database.select().from(messages)).toHaveLength(3);
    const [box] = await database.select().from(mailboxes);
    expect(box!.historyId).toBe(String(fake.history));
  });

  it("waits until the backfill has finished", async () => {
    expect(await incrementalSync(mailboxId, deps())).toEqual({
      status: "skipped",
      reason: "not_ready",
    });
  });

  it("never stores a Gmail draft; the SENT message that replaces it is stored as the owner's", async () => {
    const owner = (id: string) => ({
      from: "Owner <owner@shop.com>",
      to: "customer-t1@example.com",
      subject: "Re: Subject t1",
      messageId: `<${id}@shop.com>`,
    });
    fake.add({ id: "m1", threadId: "t1", daysAgo: 2 });
    // A draft already there at backfill (ours or the owner's), and a draft-only thread.
    fake.add({ id: "d0", threadId: "t1", labelIds: ["DRAFT"], headers: owner("d0"), daysAgo: 1 });
    fake.add({ id: "d9", threadId: "t9", labelIds: ["DRAFT"], headers: owner("d9"), daysAgo: 1 });
    expect(await runBackfill(mailboxId, deps())).toMatchObject({ status: "ok", ingested: 1 });

    // History reports a new draft (messageAdded), then — if Gmail sends it as a new message —
    // the sent copy (new id, SENT). The same-id case is the next test.
    fake.add({ id: "d1", threadId: "t1", labelIds: ["DRAFT"], headers: owner("d1"), daysAgo: 0.5 });
    expect(await incrementalSync(mailboxId, deps())).toMatchObject({ status: "ok", ingested: 0 });
    const [t1] = await database.select().from(threads).where(eq(threads.gmailThreadId, "t1"));
    expect(t1!.lastMessageAt!.getTime()).toBe(NOW.getTime() - 2 * 86_400_000); // didn't move
    fake.add({ id: "s1", threadId: "t1", labelIds: ["SENT"], headers: owner("s1"), daysAgo: 0.25 });
    expect(await incrementalSync(mailboxId, deps())).toMatchObject({ status: "ok", ingested: 1 });

    const rows = await database.select().from(messages);
    expect(rows.map((r) => [r.gmailMessageId, r.direction]).sort()).toEqual([
      ["m1", "in"],
      ["s1", "out"],
    ]);
    expect(await database.select().from(threads)).toHaveLength(1); // no thread for d9
    const [after] = await database.select().from(threads).where(eq(threads.gmailThreadId, "t1"));
    expect(after!.lastMessageAt!.getTime()).toBe(NOW.getTime() - 0.25 * 86_400_000);
  });

  it("a draft Gmail sends under the same id (DRAFT → SENT) is stored as the owner's reply", async () => {
    const owner = {
      from: "Owner <owner@shop.com>",
      to: "customer-t1@example.com",
      subject: "Re: Subject t1",
      messageId: "<d1@shop.com>",
    };
    fake.add({ id: "m1", threadId: "t1", daysAgo: 2 });
    await runBackfill(mailboxId, deps());
    fake.add({ id: "d1", threadId: "t1", labelIds: ["DRAFT"], headers: owner, daysAgo: 0.5 });
    expect(await incrementalSync(mailboxId, deps())).toMatchObject({ ingested: 0 });
    // Sent: Gmail keeps the id and swaps the label; history reports the SENT label added.
    fake.relabel("d1", ["SENT"], 0.25);
    expect(await incrementalSync(mailboxId, deps())).toMatchObject({ status: "ok", ingested: 1 });
    const [d1] = await database.select().from(messages).where(eq(messages.gmailMessageId, "d1"));
    expect(d1).toMatchObject({ direction: "out", labelIds: ["SENT"] });
    const [t1] = await database.select().from(threads).where(eq(threads.gmailThreadId, "t1"));
    expect(t1!.lastMessageAt!.getTime()).toBe(NOW.getTime() - 0.25 * 86_400_000);
  });

  it("a row older code stored as a draft is updated in place once Gmail says it was sent", async () => {
    fake.add({ id: "m1", threadId: "t1", daysAgo: 2 });
    await runBackfill(mailboxId, deps());
    const [t1] = await database.select().from(threads);
    // Stored by the old sync while it was a draft (the app's own, say).
    await database.insert(messages).values({
      threadId: t1!.id,
      mailboxId,
      gmailMessageId: "old-draft",
      direction: "out",
      fromAddress: "owner@shop.com",
      labelIds: ["DRAFT"],
      bodyText: "Draft text",
      sentAt: new Date(NOW.getTime() - 86_400_000),
    });
    fake.add({
      id: "old-draft",
      threadId: "t1",
      labelIds: ["DRAFT"],
      headers: { from: "owner@shop.com", to: "customer-t1@example.com" },
      daysAgo: 1,
    });
    fake.relabel("old-draft", ["SENT"], 0.5);
    // A label change on mail already stored as real mail is never refetched or rewritten.
    fake.relabel("m1", ["INBOX", "IMPORTANT"]);
    fake.bodyFetches = [];
    const calls = fake.calls;
    expect(await incrementalSync(mailboxId, deps())).toMatchObject({ status: "ok", ingested: 1 });
    const rows = await database.select().from(messages);
    const byId = Object.fromEntries(rows.map((r) => [r.gmailMessageId, r]));
    expect(rows).toHaveLength(2);
    expect(byId["old-draft"]).toMatchObject({
      direction: "out",
      labelIds: ["SENT"],
      sentAt: new Date(NOW.getTime() - 0.5 * 86_400_000),
    });
    expect(byId.m1!.labelIds).toEqual(["INBOX"]);
    // history + metadata and body for old-draft only.
    expect(fake.calls - calls).toBe(3);
    expect(fake.bodyFetches).toEqual(["old-draft"]);
  });

  it("a thread's time comes from its stored messages, not from what was read before", async () => {
    fake.add({ id: "m1", threadId: "t1", daysAgo: 3 });
    await runBackfill(mailboxId, deps());
    // A time no stored message has (a draft row the cleanup removed after sync read the thread).
    await database
      .update(threads)
      .set({ lastMessageAt: new Date(NOW.getTime() - 0.1 * 86_400_000) })
      .where(eq(threads.gmailThreadId, "t1"));
    fake.add({ id: "m2", threadId: "t1", daysAgo: 2 });
    await incrementalSync(mailboxId, deps());
    const [t1] = await database.select().from(threads);
    expect(t1!.lastMessageAt!.getTime()).toBe(NOW.getTime() - 2 * 86_400_000);
  });

  it("falls back to re-reading the last week when the cursor has expired", async () => {
    fake.add({ id: "m1", threadId: "t1" });
    await runBackfill(mailboxId, deps());
    fake.add({ id: "m2", threadId: "t2", daysAgo: 2 });
    fake.oldestHistory = fake.history + 1; // everything we know is too old now

    const out = await incrementalSync(mailboxId, deps());
    expect(out).toMatchObject({ status: "ok", ingested: 1 });
    const [box] = await database.select().from(mailboxes);
    expect(box!.historyId).toBe(String(fake.history));
  });
});

describe("sync error codes", () => {
  it("records a code (never text) on failure and clears it on the next success", async () => {
    fake.add({ id: "m1", threadId: "t1" });
    await runBackfill(mailboxId, deps());
    const broken = {
      ...deps(),
      readerFor: () => ({
        ...fake.reader(),
        listHistory: async () => {
          throw new Error("Gmail said something with customer@x.com in it");
        },
      }),
    };
    await expect(incrementalSync(mailboxId, broken)).rejects.toThrow();
    let [box] = await database.select().from(mailboxes);
    expect(box!.lastSyncErrorCode).toBe("sync_failed");
    expect(JSON.stringify(box)).not.toContain("customer@x.com");
    await incrementalSync(mailboxId, deps());
    [box] = await database.select().from(mailboxes);
    expect(box!.lastSyncErrorCode).toBeNull();
  });
});

describe("revoked access", () => {
  it("flags the mailbox, logs it once, and stops every later job", async () => {
    fake.add({ id: "m1", threadId: "t1" });
    await runBackfill(mailboxId, deps());
    fake.revoked = true;

    expect(await incrementalSync(mailboxId, deps())).toEqual({ status: "reconnect_needed" });
    const [box] = await database.select().from(mailboxes);
    expect(box!.status).toBe("reconnect_needed");
    expect(box!.lastSyncErrorCode).toBe("access_lost");

    const callsBefore = fake.calls;
    expect(await incrementalSync(mailboxId, deps())).toEqual({
      status: "skipped",
      reason: "not_active",
    });
    expect(await runBackfill(mailboxId, deps())).toEqual({
      status: "skipped",
      reason: "not_active",
    });
    expect(fake.calls).toBe(callsBefore); // not one more call to Google

    const logs = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mailbox_access_lost"));
    expect(logs).toHaveLength(1);
  });

  it("revocation during backfill leaves the mailbox flagged, not half-marked done", async () => {
    fake.add({ id: "m1", threadId: "t1" });
    fake.revoked = true;
    expect(await runBackfill(mailboxId, deps())).toEqual({ status: "reconnect_needed" });
    const [box] = await database.select().from(mailboxes);
    expect(box!.status).toBe("reconnect_needed");
    expect(box!.backfillCompletedAt).toBeNull();
  });

  it("reconnecting clears the flag so sync can resume", async () => {
    fake.revoked = true;
    await runBackfill(mailboxId, deps());
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "new",
      grantedScopes: ["x"],
    });
    fake.revoked = false;
    fake.add({ id: "m1", threadId: "t1" });
    expect(await runBackfill(mailboxId, deps())).toMatchObject({ status: "ok", ingested: 1 });
  });
});

describe("retention purge", () => {
  it("removes body text and snippets older than the window, keeps metadata and recent mail", async () => {
    fake.add({ id: "recent", threadId: "t1", daysAgo: 2 });
    fake.add({ id: "older", threadId: "t2", daysAgo: 25 });
    await runBackfill(mailboxId, deps());

    // 10 days later, "older" is 35 days old and "recent" is 12.
    const later = new Date(NOW.getTime() + 10 * 86_400_000);
    expect(await purgeExpiredBodies(later, 30)).toBe(1);

    const rows = Object.fromEntries(
      (await database.select().from(messages)).map((r) => [r.gmailMessageId, r]),
    );
    expect(rows.older!.bodyText).toBeNull();
    expect(rows.older!.snippet).toBeNull();
    expect(rows.older!.bodyPurgedAt).toEqual(later);
    expect(rows.older!.subject).toBe("Subject t2"); // metadata survives
    expect(rows.older!.fromAddress).toBe("customer-t2@example.com");
    expect(rows.recent!.bodyText).toBe("body of recent");

    // Running it again does nothing.
    expect(await purgeExpiredBodies(later, 30)).toBe(0);
  });
});

describe("storing an app send alongside a sync", () => {
  it("merges the thread's addresses: a sync writing meanwhile loses none", async () => {
    const [mailbox] = await database.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    await database.insert(threads).values({
      mailboxId,
      gmailThreadId: "t1",
      inInbox: true,
      participants: ["dana@customer.com"],
      lastMessageAt: new Date(NOW.getTime() - 3_600_000),
    });
    const sentMessage = {
      providerMessageId: "sent-1",
      providerThreadId: "t1",
      labelIds: ["SENT"],
      snippet: "",
      internalDate: NOW.getTime(),
      headers: { from: "owner@shop.com", to: "dana@customer.com", cc: "sam@customer.com" },
    };
    const reader = {
      getMessage: async (_id: string, { withBody }: { withBody: boolean }) => {
        // After the send read the thread, a sync of the same thread adds an address.
        if (withBody)
          await database
            .update(threads)
            .set({ participants: ["dana@customer.com", "lee@customer.com"] })
            .where(eq(threads.gmailThreadId, "t1"));
        return { ...sentMessage, bodyText: withBody ? "Thursday works." : undefined };
      },
    };
    expect(await recordSentMessage(mailbox!, reader, { id: "sent-1", threadId: "t1" }, NOW)).toBe(
      1,
    );
    const [t] = await database.select().from(threads).where(eq(threads.gmailThreadId, "t1"));
    expect([...t!.participants].sort()).toEqual([
      "dana@customer.com",
      "lee@customer.com",
      "sam@customer.com",
    ]);
  });
});
