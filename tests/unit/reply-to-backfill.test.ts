import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import {
  activityLog,
  appSettings,
  drafts,
  mailboxes,
  messages,
  threads,
  workspaces,
} from "@/db/schema";
import {
  MailboxAuthError,
  MailboxRateLimitError,
  type MailboxReader,
  type MailMessage,
} from "@/mailbox/connector";
import { describeActivity } from "@/server/activity";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { REPOINTED_FLAG } from "@/server/reply-address-rules";
import {
  REPLY_TO_BACKFILL_BATCH,
  REPLY_TO_BACKFILL_BUDGET_MS,
  REPLY_TO_BACKFILL_KEY,
  replyToDoneKey,
  runReplyToBackfill,
} from "@/server/reply-to-backfill";
import { createTestDb } from "../support/db";
import { FakeWriter } from "../support/fake-writer";

/**
 * Review B1: the one-shot read of Reply-To for form leads stored before sync read it, and
 * the move of waiting drafts off the form's robot address.
 */
const NOW = new Date("2026-10-15T15:00:00Z");
const DAY = 86_400_000;
const ROBOT = "form-submission@squarespace.info";

let database: Database;
let workspaceId: string;
let mailboxId: string;
let writer: FakeWriter;
let threadId: string;
let n = 0;

/** A Gmail stand-in: Reply-To per message id, every read recorded, concurrency measured. */
function gmail(replyTo: Record<string, string> = {}) {
  const reads: { id: string; headers?: readonly string[] }[] = [];
  let live = 0;
  let maxLive = 0;
  const fail = new Map<string, Error>();
  const reader: Pick<MailboxReader, "getMessage"> = {
    async getMessage(id, opts) {
      reads.push({ id, headers: opts.headers });
      live++;
      maxLive = Math.max(maxLive, live);
      await new Promise((r) => setTimeout(r, 1));
      live--;
      const err = fail.get(id);
      if (err) throw err;
      const m: MailMessage = {
        providerMessageId: id,
        providerThreadId: "t",
        labelIds: [],
        snippet: "",
        internalDate: 0,
        headers: { replyTo: replyTo[id], replyToRead: true },
      };
      return m;
    },
  };
  return { reader, reads, fail, maxLive: () => maxLive };
}

async function inbound(over: Partial<typeof messages.$inferInsert> = {}) {
  const [m] = await database
    .insert(messages)
    .values({
      threadId,
      mailboxId,
      gmailMessageId: `m${++n}`,
      direction: "in",
      fromAddress: ROBOT,
      fromName: "Squarespace",
      sentAt: new Date(NOW.getTime() - DAY),
      ...over,
    })
    .returning();
  return m!;
}

async function stored(id: string) {
  return (await database.select().from(messages).where(eq(messages.id, id)))[0]!.replyToHeader;
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "mike@ruizplumbing.com" });
  workspaceId = workspace.id;
  mailboxId = (
    await saveConnectedMailbox(workspace, {
      email: "mike@ruizplumbing.com",
      refreshToken: "rt",
      grantedScopes: [],
    })
  ).id;
  await database
    .update(mailboxes)
    .set({
      historyId: "100",
      backfillCompletedAt: new Date(NOW.getTime() - DAY),
      lastSyncedAt: new Date(NOW.getTime() - 10 * 60_000),
    })
    .where(eq(mailboxes.id, mailboxId));
  const [t] = await database
    .insert(threads)
    .values({ mailboxId, gmailThreadId: "gt", inInbox: true, subject: "Form Submission" })
    .returning();
  threadId = t!.id;
  writer = new FakeWriter();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("reading Reply-To for stored form leads", () => {
  it("scope: inbound, inbox, last 30 days, never read — newest first, Reply-To only, 2 at a time", async () => {
    const lead = await inbound();
    const newer = await inbound({ sentAt: new Date(NOW.getTime() - 3600_000) });
    const old = await inbound({ sentAt: new Date(NOW.getTime() - 40 * DAY) });
    const out = await inbound({ direction: "out", fromAddress: "mike@ruizplumbing.com" });
    const already = await inbound({ replyToHeader: { address: "sync@wrote.it" } });
    const [archived] = await database
      .insert(threads)
      .values({ mailboxId, gmailThreadId: "archived", inInbox: false })
      .returning();
    const notInbox = await inbound({ threadId: archived!.id });
    const g = gmail({
      [lead.gmailMessageId]: "Dana Ruiz <dana@example.com>",
      [newer.gmailMessageId]: "sam@example.org",
    });
    const r = await runReplyToBackfill(NOW, { readerFor: () => g.reader, writerFor: () => writer });
    expect(g.reads.map((x) => x.id)).toEqual([newer.gmailMessageId, lead.gmailMessageId]);
    expect(g.reads.every((x) => JSON.stringify(x.headers) === '["Reply-To"]')).toBe(true);
    expect(g.maxLive()).toBeLessThanOrEqual(2);
    expect(await stored(lead.id)).toEqual({ address: "dana@example.com", name: "Dana Ruiz" });
    expect(await stored(newer.id)).toEqual({ address: "sam@example.org" });
    for (const m of [old, out, notInbox]) expect(await stored(m.id)).toBeNull();
    // Never overwrites what sync wrote.
    expect(await stored(already.id)).toEqual({ address: "sync@wrote.it" });
    expect(r).toMatchObject({ ran: true, done: true });
    // Markers: the mailbox's and the run-wide one; the next run is a no-op.
    const keys = (await database.select().from(appSettings)).map((s) => s.key);
    expect(keys).toEqual(
      expect.arrayContaining([REPLY_TO_BACKFILL_KEY, replyToDoneKey(mailboxId)]),
    );
    expect(await runReplyToBackfill(NOW, { readerFor: () => g.reader })).toEqual({ ran: false });
  });

  it("gone (404) or a bad id (400) → {} so one id can't stall a mailbox", async () => {
    const a = await inbound();
    const b = await inbound();
    const g = gmail();
    g.fail.set(a.gmailMessageId, new Error("Gmail API 404."));
    g.fail.set(b.gmailMessageId, new Error("Gmail API 400 (invalidArgument)."));
    await runReplyToBackfill(NOW, { readerFor: () => g.reader, writerFor: () => writer });
    expect(await stored(a.id)).toEqual({});
    expect(await stored(b.id)).toEqual({});
  });

  it("100 per run, and stops at the time budget leaving the rest (no marker)", async () => {
    for (let i = 0; i < REPLY_TO_BACKFILL_BATCH + 3; i++)
      await inbound({ sentAt: new Date(NOW.getTime() - (i + 1) * 60_000) });
    const g = gmail();
    const first = await runReplyToBackfill(NOW, {
      readerFor: () => g.reader,
      writerFor: () => writer,
    });
    expect(g.reads).toHaveLength(REPLY_TO_BACKFILL_BATCH);
    expect(first).toMatchObject({ done: false });

    let t = 0;
    const clock = () => (t += REPLY_TO_BACKFILL_BUDGET_MS / 2);
    const g2 = gmail();
    const second = await runReplyToBackfill(NOW, {
      readerFor: () => g2.reader,
      writerFor: () => writer,
      clock,
    });
    expect(g2.reads.length).toBeLessThan(3);
    expect(second).toMatchObject({ done: false });
    const keys = (await database.select().from(appSettings)).map((s) => s.key);
    expect(keys).not.toContain(replyToDoneKey(mailboxId));
  });

  it("skips (no Gmail call, no marker): read-only account, lost access, a sync still busy", async () => {
    await inbound();
    const g = gmail();
    const run = () =>
      runReplyToBackfill(NOW, { readerFor: () => g.reader, writerFor: () => writer });

    await database
      .update(workspaces)
      .set({ status: "canceled" })
      .where(eq(workspaces.id, workspaceId));
    expect(await run()).toMatchObject({ done: false });
    await database
      .update(workspaces)
      .set({ status: "active" })
      .where(eq(workspaces.id, workspaceId));

    await database
      .update(mailboxes)
      .set({ status: "reconnect_needed" })
      .where(eq(mailboxes.id, mailboxId));
    expect(await run()).toMatchObject({ done: false });
    await database.update(mailboxes).set({ status: "active" }).where(eq(mailboxes.id, mailboxId));

    for (const busy of [
      { backfillCompletedAt: null },
      { historyId: null },
      { lastSyncedAt: new Date(NOW.getTime() - 30_000) },
    ]) {
      await database.update(mailboxes).set(busy).where(eq(mailboxes.id, mailboxId));
      expect(await run()).toMatchObject({ done: false });
      await database
        .update(mailboxes)
        .set({
          historyId: "100",
          backfillCompletedAt: new Date(NOW.getTime() - DAY),
          lastSyncedAt: new Date(NOW.getTime() - 10 * 60_000),
        })
        .where(eq(mailboxes.id, mailboxId));
    }
    expect(g.reads).toEqual([]);
    expect((await database.select().from(appSettings)).map((s) => s.key)).toEqual([]);
  });

  it("lost access → reconnect needed; a rate limit → failed, no marker, logged by name only", async () => {
    const m = await inbound();
    const g = gmail();
    g.fail.set(m.gmailMessageId, new MailboxRateLimitError("Gmail said slow down for dana@x.com"));
    expect(
      await runReplyToBackfill(NOW, { readerFor: () => g.reader, writerFor: () => writer }),
    ).toMatchObject({ done: false, results: [expect.objectContaining({ status: "failed" })] });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("dana@x.com");
    expect(await stored(m.id)).toBeNull();

    g.fail.set(m.gmailMessageId, new MailboxAuthError());
    await runReplyToBackfill(NOW, { readerFor: () => g.reader, writerFor: () => writer });
    const [box] = await database.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(box!.status).toBe("reconnect_needed");
    // Counts only in the run log.
    for (const call of vi.mocked(console.info).mock.calls)
      expect(JSON.stringify(call)).not.toMatch(/@/);
  });
});

describe("waiting drafts addressed to the robot", () => {
  async function pendingDraft(over: Partial<typeof drafts.$inferInsert> = {}) {
    const created = await writer.createDraft({ threadId: "gt", raw: "" });
    const body = "Hi there,\n\nHappy to quote it. What's the address?\n\nMike";
    await writer.updateDraft(created.draftId, {
      threadId: "gt",
      raw: Buffer.from(
        `To: ${ROBOT}\r\nSubject: Re: x\r\n\r\n${Buffer.from(body).toString("base64")}`,
      ).toString("base64url"),
    });
    const [d] = await database
      .insert(drafts)
      .values({
        threadId,
        mailboxId,
        gmailDraftId: created.draftId,
        gmailMessageId: created.messageId,
        toAddress: ROBOT,
        subject: "Re: Form Submission",
        body,
        originalBody: body,
        reason: "Reply drafted.",
        flags: ["Check the date."],
        confidence: 90,
        promptVersion: "draft.v5",
        autoSendAt: new Date(NOW.getTime() + 5 * 60_000),
        createdAt: new Date(NOW.getTime() - 3600_000),
        ...over,
      })
      .returning();
    return d!;
  }

  it("re-pointed: Gmail first (same text, new To), then the row — flag first, countdown cleared", async () => {
    const lead = await inbound();
    const d = await pendingDraft();
    const g = gmail({ [lead.gmailMessageId]: "Dana Ruiz <dana@example.com>" });
    await runReplyToBackfill(NOW, { readerFor: () => g.reader, writerFor: () => writer });
    const [after] = await database.select().from(drafts).where(eq(drafts.id, d.id));
    expect(after).toMatchObject({
      toAddress: "dana@example.com",
      autoSendAt: null,
      status: "pending",
    });
    expect(after!.flags).toEqual([REPOINTED_FLAG, "Check the date."]);
    const raw = writer.drafts.get(d.gmailDraftId!)!.raw;
    expect(FakeWriter.headersOf(raw)).toContain("To: dana@example.com");
    expect(FakeWriter.bodyOf(raw)).toBe(d.body);
    const logs = await database.select().from(activityLog);
    expect(logs.map((l) => [l.action, l.detail])).toContainEqual([
      "draft_repointed",
      { draftId: d.id },
    ]);
    expect(describeActivity("draft_repointed", { draftId: d.id }, null)).toBe(
      "A draft now goes to the customer's own address, not their website form's.",
    );
  });

  it("a crew reply after the form email: still matched to the form email", async () => {
    const lead = await inbound({ sentAt: new Date(NOW.getTime() - 2 * 3600_000) });
    await inbound({
      fromAddress: "crew@ruizplumbing.com",
      fromName: "Crew",
      replyToHeader: {},
      sentAt: new Date(NOW.getTime() - 3600_000),
    });
    const d = await pendingDraft();
    const g = gmail({ [lead.gmailMessageId]: "dana@example.com" });
    await runReplyToBackfill(NOW, { readerFor: () => g.reader, writerFor: () => writer });
    const [after] = await database.select().from(drafts).where(eq(drafts.id, d.id));
    expect(after!.toAddress).toBe("dana@example.com");
  });

  it("left alone: in its undo window, claimed, changed in Gmail (text or message id), gone", async () => {
    const replyTos: Record<string, string> = {};
    /** Each draft on its own form thread (one pending draft per thread). */
    const onOwnThread = async (over: Partial<typeof drafts.$inferInsert> = {}) => {
      const [t] = await database
        .insert(threads)
        .values({ mailboxId, gmailThreadId: `gt${++n}`, inInbox: true })
        .returning();
      threadId = t!.id;
      const lead = await inbound();
      replyTos[lead.gmailMessageId] = "dana@example.com";
      return pendingDraft(over);
    };
    const queued = await onOwnThread({ sendAfter: new Date(NOW.getTime() + 5000) });
    const claimed = await onOwnThread({ sendClaimedAt: NOW });
    const edited = await onOwnThread();
    writer.editInGmail(edited.gmailDraftId!, "Owner's own words.");
    const touched = await onOwnThread();
    // The owner fixed the To in Gmail: same text, a new message id.
    writer.drafts.get(touched.gmailDraftId!)!.messageId = "dm-new";
    const gone = await onOwnThread();
    writer.drafts.delete(gone.gmailDraftId!);
    const g = gmail(replyTos);
    await runReplyToBackfill(NOW, { readerFor: () => g.reader, writerFor: () => writer });
    for (const d of [queued, claimed, edited, touched, gone]) {
      const [after] = await database.select().from(drafts).where(eq(drafts.id, d.id));
      expect(after!.toAddress).toBe(ROBOT);
    }
  });
});

describe("replies already sent to the robot", () => {
  it("one Activity line each (content-free), never twice", async () => {
    const lead = await inbound();
    const [d] = await database
      .insert(drafts)
      .values({
        threadId,
        mailboxId,
        toAddress: ROBOT,
        subject: "Re",
        body: "b",
        status: "sent",
        reason: "r",
        promptVersion: "draft.v5",
        createdAt: new Date(NOW.getTime() - 3 * DAY),
        decidedAt: new Date("2026-10-12T16:00:00Z"),
      })
      .returning();
    const g = gmail({ [lead.gmailMessageId]: "dana@example.com" });
    await runReplyToBackfill(NOW, { readerFor: () => g.reader, writerFor: () => writer });
    await database.delete(appSettings);
    await runReplyToBackfill(NOW, { readerFor: () => g.reader, writerFor: () => writer });
    const rows = (await database.select().from(activityLog)).filter(
      (l) => l.action === "reply_went_to_form",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toEqual({ draftId: d!.id, sentOn: "2026-10-12" });
    expect(JSON.stringify(rows[0]!.detail)).not.toMatch(/@/);
    expect(
      describeActivity("reply_went_to_form", rows[0]!.detail, { name: "Dana", category: null }),
    ).toBe(
      "A reply you sent on Oct 12 to Dana went to the website form's address, so the customer may not have it. Send it again from Gmail.",
    );
  });
});
