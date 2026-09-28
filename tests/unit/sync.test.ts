import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { activityLog, mailboxes, messages, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { incrementalSync, purgeExpiredBodies, runBackfill } from "@/server/sync";
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

describe("revoked access", () => {
  it("flags the mailbox, logs it once, and stops every later job", async () => {
    fake.add({ id: "m1", threadId: "t1" });
    await runBackfill(mailboxId, deps());
    fake.revoked = true;

    expect(await incrementalSync(mailboxId, deps())).toEqual({ status: "reconnect_needed" });
    const [box] = await database.select().from(mailboxes);
    expect(box!.status).toBe("reconnect_needed");

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
