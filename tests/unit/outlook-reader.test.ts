import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { mailboxes, messages, threads } from "@/db/schema";
import {
  HistoryExpiredError,
  InvalidPageTokenError,
  type MailboxReader,
} from "@/mailbox/connector";
import { createGraphCaller } from "@/mailbox/outlook/http";
import { labelsFor, toMailMessage, countGraphAttachments } from "@/mailbox/outlook/parse";
import {
  createOutlookReader,
  decodeCursor,
  deltaChanges,
  encodeCursor,
  freshDeltaLinks,
} from "@/mailbox/outlook/reader";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { runBackfill, runIncrementalSync } from "@/server/sync";
import { createTestDb } from "../support/db";
import { createFakeGraph, type FakeGraph } from "../support/fake-graph";

/**
 * Plan #49: Outlook's read side (the `<provider>-api` half of SETUP §8b's shared tests), against
 * the Graph stand-in, and through the real sync engine on PGlite.
 */

const NOW = new Date("2026-10-20T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

let graph: FakeGraph;

beforeEach(() => {
  vi.stubEnv("FEATURE_OUTLOOK", "1");
  vi.stubEnv("MS_CLIENT_ID", "ms-id");
  vi.stubEnv("MS_CLIENT_SECRET", "ms-secret");
  graph = createFakeGraph({ owner: "owner@shop.com", now: () => NOW });
});
afterEach(() => vi.unstubAllEnvs());

function reader(): MailboxReader {
  const g = createGraphCaller({
    refreshToken: graph.grantRefreshToken(),
    fetchImpl: graph.fetch,
    sleep: async () => {},
  });
  return {
    ...createOutlookReader(g, { now: () => NOW }),
    watch: async () => {
      throw new Error("no watch");
    },
  };
}

const dana = { name: "Dana Ruiz", address: "dana@example.com" };

describe("mapping Graph messages", () => {
  const folders = {
    inbox: "I",
    sentitems: "S",
    drafts: "D",
    deleteditems: "T",
    junkemail: "J",
  };
  it("folders become the labels shared code reads; other folders none (archived)", () => {
    expect(labelsFor({ parentFolderId: "I" }, folders)).toEqual(["INBOX"]);
    expect(labelsFor({ parentFolderId: "S" }, folders)).toEqual(["SENT"]);
    expect(labelsFor({ parentFolderId: "T" }, folders)).toEqual(["TRASH"]);
    expect(labelsFor({ parentFolderId: "J" }, folders)).toEqual(["SPAM"]);
    expect(labelsFor({ parentFolderId: "D", isDraft: true }, folders)).toEqual(["DRAFT"]);
    expect(labelsFor({ parentFolderId: "Archive" }, folders)).toEqual([]);
    // Never Promotions / Social: Focused / Other is not the same thing.
    expect(labelsFor({ parentFolderId: "I", isDraft: false }, folders)).not.toContain(
      "CATEGORY_PROMOTIONS",
    );
  });

  it("addresses, ids, threading headers and Reply-To", () => {
    const m = toMailMessage(
      {
        id: "AAMk-1",
        conversationId: "conv-1",
        parentFolderId: "I",
        receivedDateTime: "2026-10-19T10:00:00Z",
        subject: "Deck",
        from: { emailAddress: { name: "Dana Ruiz", address: "dana@example.com" } },
        toRecipients: [{ emailAddress: { name: "o@shop.com", address: "o@shop.com" } }],
        replyTo: [{ emailAddress: { address: "form@example.com" } }],
        internetMessageId: "<m1@x>",
        internetMessageHeaders: [
          { name: "In-Reply-To", value: "<m0@x>" },
          { name: "Auto-Submitted", value: "auto-replied" },
        ],
        bodyPreview: "Hi",
        body: { content: " Hi there \n" },
      },
      folders,
      true,
    );
    expect(m).toMatchObject({
      providerMessageId: "AAMk-1",
      providerThreadId: "conv-1",
      labelIds: ["INBOX"],
      internalDate: Date.parse("2026-10-19T10:00:00Z"),
      bodyText: "Hi there",
      attachments: { images: 0, pdfs: 0, other: 0 },
      headers: {
        from: '"Dana Ruiz" <dana@example.com>',
        to: "o@shop.com",
        replyTo: "form@example.com",
        replyToRead: true,
        messageId: "<m1@x>",
        inReplyTo: "<m0@x>",
        autoSubmitted: "auto-replied",
      },
    });
  });

  it("counts attachments by kind; small inline images (logos) don't count", () => {
    expect(
      countGraphAttachments([
        { contentType: "image/jpeg", size: 200_000, isInline: false },
        { contentType: "image/png", size: 2_000, isInline: true },
        { contentType: "application/pdf", size: 9 },
        { contentType: "application/zip", size: 9 },
      ]),
    ).toEqual({ images: 1, pdfs: 1, other: 1 });
  });
});

describe("the delta cursor", () => {
  it("round-trips, and anything else is an expired cursor", () => {
    const links = freshDeltaLinks(NOW);
    expect(decodeCursor(encodeCursor(links))).toEqual({ links, done: [] });
    expect(() => decodeCursor("12345")).toThrow(HistoryExpiredError);
    expect(() => decodeCursor("o1.garbage")).toThrow(HistoryExpiredError);
  });

  it("tracks every folder from 30 days back, ids and conversations only", () => {
    const links = freshDeltaLinks(NOW);
    expect(Object.keys(links)).toEqual(["inbox", "sentitems", "deleteditems", "junkemail"]);
    const u = new URL(`https://x${links.inbox}`);
    expect(u.searchParams.get("$filter")).toBe(`receivedDateTime ge ${ago(30).toISOString()}`);
    expect(u.searchParams.get("$select")).toBe("id,conversationId,isDraft");
  });

  it("folder moves become label changes", () => {
    expect(deltaChanges("inbox", [{ id: "a", conversationId: "c" }])).toEqual({
      added: [{ id: "a", threadId: "c", labelIds: ["INBOX"] }],
      labelChanges: [{ id: "a", threadId: "c", added: ["INBOX"], removed: ["TRASH", "SPAM"] }],
    });
    expect(deltaChanges("inbox", [{ id: "a", "@removed": { reason: "deleted" } }])).toEqual({
      added: [],
      labelChanges: [{ id: "a", threadId: "", added: [], removed: ["INBOX"] }],
    });
    expect(deltaChanges("deleteditems", [{ id: "a", conversationId: "c" }]).labelChanges).toEqual([
      { id: "a", threadId: "c", added: ["TRASH"], removed: ["INBOX"] },
    ]);
    expect(deltaChanges("junkemail", [{ id: "a", conversationId: "c" }]).labelChanges).toEqual([
      { id: "a", threadId: "c", added: ["SPAM"], removed: ["INBOX"] },
    ]);
    expect(deltaChanges("sentitems", [{ id: "a", conversationId: "c" }]).added).toEqual([
      { id: "a", threadId: "c", labelIds: ["SENT"] },
    ]);
    // A draft sitting in Sent (never happens in Outlook, but never "sent").
    expect(
      deltaChanges("sentitems", [{ id: "a", conversationId: "c", isDraft: true }]).added,
    ).toEqual([]);
  });
});

describe("Outlook reader against the Graph stand-in", () => {
  it("every request carries the immutable-id preference", async () => {
    graph.deliver({ from: dana, subject: "Deck", text: "Need a deck", at: ago(2) });
    const r = reader();
    const p = await r.getProfile();
    const page = await r.listMessages({ newerThanDays: 30, inbox: true });
    await r.getMessage(page.messages[0]!.id, { withBody: true });
    await r.listHistory({ startHistoryId: p.historyId });
    expect(graph.state.calls.filter((c) => c.path !== "/token" && c.noImmutableId)).toEqual([]);
    expect(p.emailAddress).toBe("owner@shop.com");
  });

  it("lists by window, inbox / not inbox / sent, never drafts, trash or junk; pages by nextLink", async () => {
    for (let i = 0; i < 5; i++)
      graph.deliver({ from: dana, subject: `q${i}`, text: "x", at: ago(i + 1) });
    graph.deliver({ from: dana, subject: "old", text: "x", at: ago(40) });
    const archived = graph.deliver({
      from: dana,
      subject: "arch",
      text: "x",
      at: ago(3),
      folder: "archive",
    });
    graph.deliver({ from: dana, subject: "junk", text: "x", at: ago(3), folder: "junkemail" });
    graph.deliver({ from: dana, subject: "bin", text: "x", at: ago(3), folder: "deleteditems" });
    const r = reader();
    const p1 = await r.listMessages({ after: ago(30), inbox: true, maxResults: 3 });
    expect(p1.messages).toHaveLength(3);
    expect(p1.nextPageToken).toMatch(/^https:\/\/graph\.microsoft\.com\/v1\.0\//);
    const p2 = await r.listMessages({
      after: ago(30),
      inbox: true,
      maxResults: 3,
      pageToken: p1.nextPageToken,
    });
    expect(p2.messages).toHaveLength(2);
    expect(p2.nextPageToken).toBeUndefined();
    const rest = await r.listMessages({ after: ago(30), inbox: false });
    expect(rest.messages.map((m) => m.id)).toEqual([archived.id]);
  });

  it("a page token Graph refuses (400) restarts the listing", async () => {
    const r = reader();
    await r.listMessages({ inbox: true });
    graph.state.failNext.push({ status: 400, json: { error: { code: "BadRequest" } } });
    await expect(
      r.listMessages({
        inbox: true,
        pageToken: "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=9",
      }),
    ).rejects.toBeInstanceOf(InvalidPageTokenError);
  });

  it("delta pages: one Graph page per folder per call, cursor stored only at the end", async () => {
    const r = reader();
    const p = await r.getProfile();
    for (let i = 0; i < 250; i++) graph.deliver({ from: dana, subject: `n${i}`, text: "x" });
    const pages = [];
    let token: string | undefined;
    do {
      const page = await r.listHistory({ startHistoryId: p.historyId, pageToken: token });
      pages.push(page);
      token = page.nextPageToken;
    } while (token);
    expect(pages).toHaveLength(3); // 100 + 100 + 50
    expect(pages.flatMap((x) => x.added).length).toBe(250);
    expect(pages[0]!.historyId).toBe(p.historyId);
    expect(pages[2]!.historyId).not.toBe(p.historyId);
    // The next round sees only what changed since.
    const later = graph.deliver({ from: dana, subject: "later", text: "x" });
    const next = await r.listHistory({ startHistoryId: pages[2]!.historyId });
    expect(next.added.map((a) => a.id)).toEqual([later.id]);
    expect(next.nextPageToken).toBeUndefined();
  });

  it("an expired delta link (410) is HistoryExpiredError", async () => {
    const r = reader();
    const p = await r.getProfile();
    const first = await r.listHistory({ startHistoryId: p.historyId });
    graph.expireDeltaTokens();
    await expect(r.listHistory({ startHistoryId: first.historyId })).rejects.toBeInstanceOf(
      HistoryExpiredError,
    );
  });
});

describe("through the sync engine (PGlite)", () => {
  let database: Database;
  let mailboxId: string;

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    const m = await saveConnectedMailbox(
      workspace,
      { email: "owner@shop.com", refreshToken: "rt", grantedScopes: ["Mail.ReadWrite"] },
      "outlook",
    );
    mailboxId = m.id;
  });

  it("backfill, then a delta sync of a new thread, an owner reply, an archive and a delete", async () => {
    const first = graph.deliver({
      from: dana,
      subject: "Deck quote",
      text: "How much for a deck?",
      at: ago(2),
    });
    const deps = { readerFor: () => reader(), now: () => NOW };
    expect(await runBackfill(mailboxId, deps)).toMatchObject({ status: "ok", ingested: 1 });
    const [box] = await database.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(box!.provider).toBe("outlook");
    expect(box!.historyId).toMatch(/^o1\./);

    // The first delta round re-lists the window: nothing new is stored twice.
    expect(await runIncrementalSync(mailboxId, deps)).toMatchObject({ status: "ok", ingested: 0 });

    const second = graph.deliver({
      from: { name: "Sam", address: "sam@example.com" },
      subject: "Leak",
      text: "Pipe burst",
    });
    // The owner answers Dana from Outlook itself.
    const reply = graph.deliver({
      from: { address: "owner@shop.com" },
      subject: "Re: Deck quote",
      text: "About $4,000",
      conversationId: first.conversationId,
      folder: "sentitems",
    });
    expect(await runIncrementalSync(mailboxId, deps)).toMatchObject({ status: "ok", ingested: 2 });
    const rows = await database.select().from(messages);
    const byId = new Map(rows.map((r) => [r.gmailMessageId, r]));
    expect(byId.get(second.id)!.direction).toBe("in");
    expect(byId.get(second.id)!.bodyText).toBe("Pipe burst");
    expect(byId.get(reply.id)!.direction).toBe("out");
    expect(byId.get(reply.id)!.labelIds).toEqual(["SENT"]);
    const ts = await database.select().from(threads);
    expect(ts.find((t) => t.gmailThreadId === first.conversationId)!.inInbox).toBe(true);
    expect(
      rows.filter(
        (r) => r.threadId === ts.find((t) => t.gmailThreadId === first.conversationId)!.id,
      ),
    ).toHaveLength(2);

    // Archive Sam's thread, bin Dana's first email.
    graph.move(second.id, "archive");
    graph.move(first.id, "deleteditems");
    await runIncrementalSync(mailboxId, deps);
    const after = new Map(
      (await database.select().from(messages)).map((r) => [r.gmailMessageId, r]),
    );
    expect(after.get(second.id)!.labelIds).toEqual([]);
    expect(after.get(first.id)!.labelIds).toEqual(["TRASH"]);
    const t2 = await database.select().from(threads);
    expect(t2.find((t) => t.gmailThreadId === second.conversationId)!.inInbox).toBe(false);
  });

  it("an unsent draft in Outlook is never stored (it isn't mail)", async () => {
    const lead = graph.deliver({ from: dana, subject: "Deck", text: "Deck?", at: ago(1) });
    graph.deliver({
      from: { address: "owner@shop.com" },
      subject: "Re: Deck",
      text: "half-written",
      conversationId: lead.conversationId,
      folder: "drafts",
    });
    [...graph.messages.values()].find((m) => m.folder === "drafts")!.isDraft = true;
    const deps = { readerFor: () => reader(), now: () => NOW };
    await runBackfill(mailboxId, deps);
    await runIncrementalSync(mailboxId, deps);
    const rows = await database.select().from(messages);
    expect(rows.map((r) => r.gmailMessageId)).toEqual([lead.id]);
  });

  it("an expired cursor re-reads the gap and takes a fresh cursor", async () => {
    graph.deliver({ from: dana, subject: "a", text: "x", at: ago(1) });
    const deps = { readerFor: () => reader(), now: () => NOW };
    await runBackfill(mailboxId, deps);
    await runIncrementalSync(mailboxId, deps);
    graph.expireDeltaTokens();
    graph.deliver({ from: dana, subject: "b", text: "y" });
    expect(await runIncrementalSync(mailboxId, deps)).toMatchObject({ status: "ok", ingested: 1 });
    expect(await database.select().from(messages)).toHaveLength(2);
  });
});
