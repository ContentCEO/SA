import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { activityLog, drafts, mailboxes, messages, threads, workspaces } from "@/db/schema";
import { InvalidPageTokenError } from "@/mailbox/connector";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import {
  incrementalSync,
  purgeExpiredBodies,
  recordSentMessage,
  resyncPage,
  runBackfill,
  runIncrementalSync,
} from "@/server/sync";
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
    // A label change on mail already stored as real mail is never refetched.
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
    // Check 25 P2: a label change on stored mail updates its labels, without reading it again.
    expect(byId.m1!.labelIds).toEqual(["INBOX", "IMPORTANT"]);
    // history + one full read of old-draft only (its conversation is in the inbox, Check 25 P1).
    expect(fake.calls - calls).toBe(2);
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

    expect(await incrementalSync(mailboxId, deps())).toMatchObject({ status: "resync_needed" });
    const out = await runIncrementalSync(mailboxId, deps());
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

describe("Reply-To (website forms, review B1)", () => {
  const form = (id: string, threadId: string, replyTo?: string, daysAgo = 1) =>
    fake.add({
      id,
      threadId,
      daysAgo,
      labelIds: ["INBOX"],
      headers: {
        from: "Wix Forms <no-reply@crm.wix.com>",
        to: "owner@shop.com",
        subject: "New form submission",
        messageId: `<${id}@wix.example>`,
        ...(replyTo ? { replyTo } : {}),
      },
    });

  it("backfill and incremental sync store the customer's Reply-To, {} without one, {} for owner mail", async () => {
    form("f1", "t1", "Dana Ruiz <dana@example.com>", 2);
    fake.add({ id: "p1", threadId: "t2", daysAgo: 2 }); // a person writing directly
    fake.add({
      id: "o1",
      threadId: "t2",
      labelIds: ["SENT"],
      headers: { from: "owner@shop.com", to: "customer-t2@example.com", replyTo: "x@y.com" },
    });
    await runBackfill(mailboxId, deps());
    form("f2", "t3", "sam@example.org", 0);
    await incrementalSync(mailboxId, deps());

    const rows = await database.select().from(messages);
    const by = Object.fromEntries(rows.map((r) => [r.gmailMessageId, r.replyToHeader]));
    expect(by.f1).toEqual({ address: "dana@example.com", name: "Dana Ruiz" });
    expect(by.f2).toEqual({ address: "sam@example.org" });
    expect(by.p1).toEqual({});
    expect(by.o1).toEqual({});
    const [t1] = await database.select().from(threads).where(eq(threads.gmailThreadId, "t1"));
    expect(t1!.participants).toContain("dana@example.com");
  });

  it("a read that couldn't return Reply-To leaves the column NULL (never read), not {}", async () => {
    form("f1", "t1", "dana@example.com");
    // A reader whose metadata reads ask for a subset without Reply-To, and no body reads.
    const base = fake.reader();
    const subset = {
      ...base,
      getMessage: (id: string) => base.getMessage(id, { withBody: false, headers: ["From", "To"] }),
    };
    await runBackfill(mailboxId, { readerFor: () => subset, now: () => NOW });
    const [row] = await database.select().from(messages);
    expect(row!.replyToHeader).toBeNull();
  });
});

describe("Gmail quota (Check 25 P1)", () => {
  it("reads inbox emails once, in full; everything else as metadata", async () => {
    fake.add({ id: "i1", threadId: "t1", labelIds: ["INBOX"] });
    fake.add({ id: "i2", threadId: "t2", labelIds: ["INBOX"] });
    fake.add({ id: "i3", threadId: "t3", labelIds: ["INBOX"] });
    fake.add({ id: "a1", threadId: "t4", labelIds: [] });
    fake.add({ id: "a2", threadId: "t5", labelIds: ["CATEGORY_UPDATES"] });
    await runBackfill(mailboxId, deps());
    expect(fake.bodyFetches.sort()).toEqual(["i1", "i2", "i3"]);
    expect(fake.metaFetches.sort()).toEqual(["a1", "a2"]);
    const rows = await database.select().from(messages);
    expect(rows).toHaveLength(5);
    expect(rows.find((r) => r.gmailMessageId === "a1")!.bodyText).toBeNull();
  });

  it("an inbox email past retention is read once and its body still isn't kept", async () => {
    process.env.RETENTION_BODY_DAYS = "10";
    fake.add({ id: "old", threadId: "t1", labelIds: ["INBOX"], daysAgo: 20 });
    await runBackfill(mailboxId, deps());
    const [row] = await database.select().from(messages);
    expect(row!.bodyText).toBeNull();
    expect(row!.snippet).toBeNull();
    expect(fake.bodyFetches).toEqual(["old"]);
    delete process.env.RETENTION_BODY_DAYS;
  });
});

describe("label changes made in Gmail (Check 25 P2)", () => {
  const pendingDraft = async (
    gmailThreadId: string,
    extra: Partial<typeof drafts.$inferInsert> = {},
  ) => {
    const [t] = await database
      .select()
      .from(threads)
      .where(eq(threads.gmailThreadId, gmailThreadId));
    const [d] = await database
      .insert(drafts)
      .values({
        threadId: t!.id,
        mailboxId,
        toAddress: `customer-${gmailThreadId}@example.com`,
        subject: "Re: x",
        body: "Hi",
        reason: "Replying",
        ...extra,
      })
      .returning();
    return d!;
  };
  const threadRow = async (gmailThreadId: string) =>
    (await database.select().from(threads).where(eq(threads.gmailThreadId, gmailThreadId)))[0]!;

  it("Spam then Not spam: read in full, back in the inbox, sorted again", async () => {
    fake.add({ id: "m0", threadId: "t0" });
    await runBackfill(mailboxId, deps());
    // A lead lands in Spam (history reports it; listing never shows Spam).
    fake.add({ id: "lead", threadId: "t1", labelIds: ["SPAM"], daysAgo: 0.5 });
    await incrementalSync(mailboxId, deps());
    let [msg] = await database.select().from(messages).where(eq(messages.gmailMessageId, "lead"));
    expect(msg!.labelIds).toEqual(["SPAM"]);
    expect(msg!.bodyText).toBeNull();
    expect((await threadRow("t1")).inInbox).toBe(false);

    await database
      .update(threads)
      .set({ classifiedAt: NOW })
      .where(eq(threads.gmailThreadId, "t1"));
    fake.notSpam("lead");
    fake.bodyFetches = [];
    await incrementalSync(mailboxId, deps());
    [msg] = await database.select().from(messages).where(eq(messages.gmailMessageId, "lead"));
    expect(msg!.labelIds).toEqual(["INBOX"]);
    expect(msg!.bodyText).toBe("body of lead");
    expect(msg!.classifiedAt).toBeNull();
    expect(fake.bodyFetches).toEqual(["lead"]);
    const t1 = await threadRow("t1");
    expect(t1.inInbox).toBe(true);
    expect(t1.classifiedAt).toBeNull();
  });

  it("Not spam on an email we never stored stores it in full", async () => {
    fake.add({ id: "m0", threadId: "t0" });
    await runBackfill(mailboxId, deps());
    fake.add({ id: "lead", threadId: "t1", labelIds: ["SPAM"], daysAgo: 0.5 });
    fake.log = fake.log.filter((h) => h.id !== "lead"); // history never told us it arrived
    fake.notSpam("lead");
    await incrementalSync(mailboxId, deps());
    const [msg] = await database.select().from(messages).where(eq(messages.gmailMessageId, "lead"));
    expect(msg!.labelIds).toEqual(["INBOX"]);
    expect(msg!.bodyText).toBe("body of lead");
    expect((await threadRow("t1")).inInbox).toBe(true);
  });

  it("Trash: out of the inbox, the waiting draft expires with a note, countdown and send dropped", async () => {
    fake.add({ id: "m1", threadId: "t1", daysAgo: 1 });
    fake.add({
      id: "m2",
      threadId: "t1",
      labelIds: ["SENT"],
      headers: { from: "owner@shop.com", to: "customer-t1@example.com" },
      daysAgo: 0.9,
    });
    await runBackfill(mailboxId, deps());
    const d = await pendingDraft("t1", {
      autoSendAt: new Date(NOW.getTime() + 600_000),
      sendAfter: new Date(NOW.getTime() + 5_000),
    });
    fake.trash("m1");
    fake.trash("m2");
    await incrementalSync(mailboxId, deps());
    expect((await threadRow("t1")).inInbox).toBe(false);
    const [after] = await database.select().from(drafts).where(eq(drafts.id, d.id));
    expect(after).toMatchObject({
      status: "expired",
      closedNote: "You deleted this in Gmail.",
      autoSendAt: null,
      sendAfter: null,
      sendClaimedAt: null,
    });
  });

  it("Spam on a whole conversation says so", async () => {
    fake.add({ id: "m1", threadId: "t1" });
    await runBackfill(mailboxId, deps());
    const d = await pendingDraft("t1");
    fake.spam("m1");
    await incrementalSync(mailboxId, deps());
    const [after] = await database.select().from(drafts).where(eq(drafts.id, d.id));
    expect(after).toMatchObject({
      status: "expired",
      closedNote: "You marked this as spam in Gmail.",
    });
  });

  it("Archive: out of the inbox, the draft stays, countdown and queued send stop", async () => {
    fake.add({ id: "m1", threadId: "t1" });
    await runBackfill(mailboxId, deps());
    const d = await pendingDraft("t1", {
      autoSendAt: new Date(NOW.getTime() + 600_000),
      sendAfter: new Date(NOW.getTime() + 5_000),
    });
    fake.archive("m1");
    await incrementalSync(mailboxId, deps());
    expect((await threadRow("t1")).inInbox).toBe(false);
    const [after] = await database.select().from(drafts).where(eq(drafts.id, d.id));
    expect(after).toMatchObject({ status: "pending", autoSendAt: null, sendAfter: null });
    const [msg] = await database.select().from(messages).where(eq(messages.gmailMessageId, "m1"));
    expect(msg!.labelIds).toEqual([]);
    const log = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "send_stopped"));
    expect(log).toHaveLength(1);
    expect(log[0]!.detail).toEqual({ draftId: d.id, why: "archived_in_gmail" });
  });

  it("deleted for good on every message behaves like Trash", async () => {
    fake.add({ id: "m1", threadId: "t1", daysAgo: 1 });
    fake.add({ id: "m2", threadId: "t1", daysAgo: 0.5 });
    await runBackfill(mailboxId, deps());
    const d = await pendingDraft("t1");
    fake.remove("m1");
    fake.remove("m2");
    await incrementalSync(mailboxId, deps());
    expect((await threadRow("t1")).inInbox).toBe(false);
    const [after] = await database.select().from(drafts).where(eq(drafts.id, d.id));
    expect(after).toMatchObject({ status: "expired", closedNote: "You deleted this in Gmail." });
  });

  it("one email trashed out of two keeps the conversation and its draft", async () => {
    fake.add({ id: "m1", threadId: "t1", daysAgo: 1 });
    fake.add({ id: "m2", threadId: "t1", daysAgo: 0.5 });
    await runBackfill(mailboxId, deps());
    const d = await pendingDraft("t1");
    fake.trash("m1");
    await incrementalSync(mailboxId, deps());
    expect((await threadRow("t1")).inInbox).toBe(true);
    const [after] = await database.select().from(drafts).where(eq(drafts.id, d.id));
    expect(after!.status).toBe("pending");
  });

  it("archived and then moved back to the inbox is in the inbox again", async () => {
    fake.add({ id: "m1", threadId: "t1" });
    await runBackfill(mailboxId, deps());
    fake.archive("m1");
    await incrementalSync(mailboxId, deps());
    fake.relabel("m1", ["INBOX"]);
    await incrementalSync(mailboxId, deps());
    expect((await threadRow("t1")).inInbox).toBe(true);
  });
});

describe("expired history after a long pause (Check 25 P3)", () => {
  const at = (daysAfterNow: number) => () => new Date(NOW.getTime() + daysAfterNow * 86_400_000);
  /** A message `daysAgo` before the later "now". */
  const addAt = (id: string, laterDays: number, daysAgo: number) =>
    fake.add({ id, threadId: `t-${id}`, now: at(laterDays)(), daysAgo });

  it("re-reads the whole gap: last sync 12 days ago, emails 11, 9, 8, 3 and 1 days old", async () => {
    fake.add({ id: "m0", threadId: "t0" });
    await runBackfill(mailboxId, deps());
    for (const [id, ago] of [
      ["a11", 11],
      ["a9", 9],
      ["a8", 8],
      ["a3", 3],
      ["a1", 1],
    ] as const)
      addAt(id, 12, ago);
    fake.oldestHistory = fake.history + 1;
    const later = { readerFor: () => fake.reader(), now: at(12) };
    const out = await runIncrementalSync(mailboxId, later);
    expect(out).toMatchObject({ status: "ok", ingested: 5 });
    const ids = (await database.select().from(messages)).map((r) => r.gmailMessageId).sort();
    expect(ids).toEqual(["a1", "a11", "a3", "a8", "a9", "m0"]);
    const [box] = await database.select().from(mailboxes);
    expect(box!.resyncSince).toBeNull();
    expect(box!.lastSyncedAt).toEqual(at(12)());
    expect(
      await database.select().from(activityLog).where(eq(activityLog.action, "mail_gap")),
    ).toEqual([]);
  });

  it("a 45-day gap reads 30 days and writes one mail_gap row with dates only", async () => {
    fake.add({ id: "m0", threadId: "t0" });
    await runBackfill(mailboxId, deps());
    addAt("old", 45, 40); // inside the gap but past 30 days: not read
    addAt("new", 45, 20);
    fake.oldestHistory = fake.history + 1;
    const later = { readerFor: () => fake.reader(), now: at(45) };
    expect(await runIncrementalSync(mailboxId, later)).toMatchObject({ status: "ok", ingested: 1 });
    const gaps = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mail_gap"));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.detail).toEqual({ mailboxId, fromDay: "2026-09-28", toDay: "2026-10-13" });
  });

  it("an interrupted re-read resumes from the saved token and stores each message once", async () => {
    fake.add({ id: "m0", threadId: "t0", daysAgo: 5 }); // before the re-read window
    await runBackfill(mailboxId, deps());
    // 120 inbox emails = 3 pages of 50, then the (empty) rest pass.
    for (let i = 0; i < 120; i++) addAt(`x${i}`, 10, 1 + (i % 8));
    fake.oldestHistory = fake.history + 1;
    const later = { readerFor: () => fake.reader(), now: at(10) };
    expect(await incrementalSync(mailboxId, later)).toMatchObject({ status: "resync_needed" });
    expect(await resyncPage(mailboxId, later)).toMatchObject({
      status: "ok",
      ingested: 50,
      done: false,
    });
    // The run stops here (a deploy, a timeout). The next sync event carries on.
    const [mid] = await database.select().from(mailboxes);
    expect(mid!.resyncPageToken).toBe("inbox:50");
    expect(await incrementalSync(mailboxId, later)).toMatchObject({ status: "resync_needed" });
    fake.bodyFetches = [];
    expect(await runIncrementalSync(mailboxId, later)).toMatchObject({
      status: "ok",
      ingested: 70,
    });
    expect(fake.bodyFetches).toHaveLength(70);
    expect(await database.select().from(messages)).toHaveLength(121);
    // Back to ordinary history-based sync from the fresh cursor.
    fake.oldestHistory = 0;
    expect(await incrementalSync(mailboxId, later)).toMatchObject({ status: "ok", ingested: 0 });
  }, 120_000);
});

describe("a very big first read resumes and finishes (Check 25 P5)", () => {
  const fill = (n: number) => {
    for (let i = 0; i < n; i++)
      fake.add({ id: `b${i}`, threadId: `bt${i}`, daysAgo: 1 + (i % 20) });
  };

  it("700 emails, 5 pages per run: three runs finish it, each email once, history cursor set once", async () => {
    fill(700);
    let getProfiles = 0;
    const counting = () => {
      const r = fake.reader();
      return {
        ...r,
        getProfile: async () => {
          getProfiles++;
          return r.getProfile();
        },
      };
    };
    const d = { readerFor: counting, now: () => NOW };
    expect(await runBackfill(mailboxId, d, { maxPages: 5 })).toMatchObject({
      status: "continuing",
    });
    const [first] = await database.select().from(mailboxes);
    expect(first!.backfillPagesDone).toBe(5);
    expect(first!.backfillCompletedAt).toBeNull();
    // Later runs carry on: the cursor taken at the first begin stays (getProfile once).
    expect(await runBackfill(mailboxId, d, { maxPages: 5 })).toMatchObject({
      status: "continuing",
    });
    expect(await runBackfill(mailboxId, d, { maxPages: 5 })).toMatchObject({ status: "ok" });
    expect(getProfiles).toBe(1);
    const [box] = await database.select().from(mailboxes);
    expect(box!.historyId).toBe(first!.historyId);
    expect(box!.backfillCompletedAt).toEqual(NOW);
    expect(box!.backfillPageToken).toBeNull();
    const ids = (await database.select().from(messages)).map((m) => m.gmailMessageId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((i) => i.startsWith("b"))).toHaveLength(700);
  }, 120_000);

  it("a failed run resumes from the saved token, not page 0", async () => {
    fill(120);
    await runBackfill(mailboxId, deps(), { maxPages: 1 });
    // Page 2 fails (Gmail down); the run stops.
    const failing = {
      readerFor: () => ({
        ...fake.reader(),
        listMessages: async () => {
          throw new Error("Gmail API 503.");
        },
      }),
      now: () => NOW,
    };
    await expect(runBackfill(mailboxId, failing)).rejects.toThrow();
    const listed: (string | undefined)[] = [];
    const spying = () => {
      const r = fake.reader();
      return {
        ...r,
        listMessages: async (o: Parameters<typeof r.listMessages>[0]) => {
          listed.push(o.pageToken);
          return r.listMessages(o);
        },
      };
    };
    fake.bodyFetches = [];
    expect(await runBackfill(mailboxId, { readerFor: spying, now: () => NOW })).toMatchObject({
      status: "ok",
      ingested: 70,
    });
    expect(listed[0]).toBe("50");
    expect(fake.bodyFetches).toHaveLength(70);
  }, 120_000);

  it("a token Gmail no longer takes starts the listing over (stored emails are skipped)", async () => {
    fill(60);
    await runBackfill(mailboxId, deps(), { maxPages: 1 });
    const picky = () => {
      const r = fake.reader();
      return {
        ...r,
        listMessages: async (o: Parameters<typeof r.listMessages>[0]) => {
          if (o.pageToken) throw new InvalidPageTokenError();
          return r.listMessages(o);
        },
      };
    };
    // The saved token is refused once, then the listing restarts from the top.
    const out = await runBackfill(mailboxId, { readerFor: picky, now: () => NOW }, { maxPages: 1 });
    expect(out).toMatchObject({ status: "continuing", ingested: 0 });
    const [box] = await database.select().from(mailboxes);
    expect(box!.backfillPageToken).toBe("inbox:50");
  });

  it("a reconnect starts a fresh read", async () => {
    fill(120);
    await runBackfill(mailboxId, deps(), { maxPages: 1 });
    const [before] = await database.select().from(mailboxes);
    expect(before!.backfillPageToken).toBe("inbox:50");
    const [w] = await database.select().from(workspaces);
    await saveConnectedMailbox(w!, {
      email: "owner@shop.com",
      refreshToken: "rt2",
      grantedScopes: ["x"],
    });
    fake.add({ id: "new", threadId: "new", daysAgo: 0 });
    await runBackfill(mailboxId, deps(), { maxPages: 1 });
    const [after] = await database.select().from(mailboxes);
    expect(after!.historyId).not.toBe(before!.historyId);
    expect(after!.backfillPagesDone).toBe(1);
  }, 120_000);
});

describe("the stand-in Gmail behaves like Gmail (Check 25 P8)", () => {
  it("a message deleted between the listing and the read: the rest are stored, it's skipped quietly", async () => {
    fake.add({ id: "m1", threadId: "t1" });
    fake.add({ id: "m2", threadId: "t2" });
    fake.add({ id: "m3", threadId: "t3" });
    const vanishing = () => {
      const r = fake.reader();
      return {
        ...r,
        listMessages: async (o: Parameters<typeof r.listMessages>[0]) => {
          const page = await r.listMessages(o);
          // Deleted for good right after Gmail listed it.
          fake.messages = fake.messages.filter((m) => m.providerMessageId !== "m2");
          return page;
        },
      };
    };
    expect(await runBackfill(mailboxId, { readerFor: vanishing, now: () => NOW })).toMatchObject({
      status: "ok",
      ingested: 2,
    });
    const ids = (await database.select().from(messages)).map((m) => m.gmailMessageId).sort();
    expect(ids).toEqual(["m1", "m3"]);
  });

  it("the same change synced twice is stored once", async () => {
    fake.add({ id: "m1", threadId: "t1" });
    await runBackfill(mailboxId, deps());
    const [box] = await database.select().from(mailboxes);
    fake.add({ id: "m2", threadId: "t1", daysAgo: 0 });
    fake.archive("m2");
    expect(await incrementalSync(mailboxId, deps())).toMatchObject({ ingested: 1 });
    // A retry from the old cursor (a step that ran but whose result was lost).
    await database.update(mailboxes).set({ historyId: box!.historyId });
    expect(await incrementalSync(mailboxId, deps())).toMatchObject({ ingested: 0 });
    expect(await database.select().from(messages)).toHaveLength(2);
    const [m2] = await database.select().from(messages).where(eq(messages.gmailMessageId, "m2"));
    expect(m2!.labelIds).toEqual([]);
  });

  it("history reports a relabel as a label change, never as a new message", async () => {
    fake.add({ id: "m1", threadId: "t1" });
    const start = fake.history;
    fake.relabel("m1", ["INBOX", "STARRED"]);
    const page = await fake.reader().listHistory({ startHistoryId: String(start) });
    expect(page.added).toEqual([]);
    expect(page.labelChanges).toEqual([
      { id: "m1", threadId: "t1", added: ["STARRED"], removed: [] },
    ]);
  });

  it("counts Google's units per minute, so a test can check the peak", async () => {
    let t = new Date("2026-10-17T10:00:00Z").getTime();
    fake.clock = () => new Date(t);
    for (let i = 0; i < 5; i++) fake.add({ id: `u${i}`, threadId: `ut${i}` });
    const r = fake.reader(50);
    await r.listMessages({ newerThanDays: 30 }); // 5
    await r.getMessage("u0", { withBody: true }); // 20
    t += 60_000;
    await r.getMessage("u1", { withBody: false }); // 20, next minute
    expect([...fake.unitsByMinute.values()]).toEqual([25, 20]);
    expect(fake.peakUnitsPerMinute()).toBe(25);
  });

  it("revoked access on page 2 of a first read: not marked done, flagged for reconnecting", async () => {
    for (let i = 0; i < 60; i++) fake.add({ id: `r${i}`, threadId: `rt${i}` });
    let pages = 0;
    const revokesLater = () => {
      const r = fake.reader();
      return {
        ...r,
        listMessages: async (o: Parameters<typeof r.listMessages>[0]) => {
          if (++pages === 2) fake.revoked = true;
          return r.listMessages(o);
        },
      };
    };
    expect(await runBackfill(mailboxId, { readerFor: revokesLater, now: () => NOW })).toEqual({
      status: "reconnect_needed",
    });
    const [box] = await database.select().from(mailboxes);
    expect(box!.backfillCompletedAt).toBeNull();
    expect(box!.status).toBe("reconnect_needed");
  });
});
