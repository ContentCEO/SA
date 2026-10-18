import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import {
  activityLog,
  appSettings,
  drafts,
  mailboxes,
  messages,
  priceHistory,
  threads,
  workspaces,
} from "@/db/schema";
import { MailboxAuthError, type MailMessage } from "@/mailbox/connector";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  DRAFT_MESSAGES_BATCH,
  DRAFT_MESSAGES_CLEANUP_KEY,
  draftMessagesDoneKey,
  runDraftMessagesCleanup,
} from "@/server/draft-message-cleanup";
import { knownCustomer } from "@/server/known-customer";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { captureQuoteAmounts, ownerGavePrice } from "@/server/quotes";
import { isUnsentDraft } from "@/server/sync";
import { createTestDb } from "../support/db";

/**
 * A Gmail draft is a message carrying the DRAFT label. The old sync stored drafts as the
 * owner's mail ('out'), so an unsent draft read as the owner having answered. Sync now skips
 * them; this covers the one-shot cleanup of the rows already stored (re-checked with Gmail,
 * since a draft Gmail sent under the same id is real mail), the price data they left, and the
 * "the owner wrote" rules that read the owner's mail.
 */
const NOW = new Date("2026-10-13T15:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

let database: Database;
let workspaceId: string;
let mailboxId: string;
let otherMailboxId: string;
let n = 0;

/** What Gmail says each message is now (labels, time); missing = 404. */
let gmail: Map<string, { labelIds: string[]; at: Date }>;
let looked: string[];
const reader = () => ({
  getMessage: async (id: string): Promise<MailMessage | null> => {
    looked.push(id);
    const g = gmail.get(id);
    return g
      ? {
          providerMessageId: id,
          providerThreadId: "gt",
          labelIds: g.labelIds,
          snippet: "",
          internalDate: g.at.getTime(),
          headers: {},
        }
      : null;
  },
});
const cleanup = (deps = { readerFor: reader }) => runDraftMessagesCleanup(NOW, deps);

async function box(email: string) {
  const { workspace } = await ensureUserAndWorkspace({ email });
  await database
    .update(workspaces)
    .set({ status: "active", setupPaidVia: "stripe" })
    .where(eq(workspaces.id, workspace.id));
  const id = (
    await saveConnectedMailbox(workspace, { email, refreshToken: "rt", grantedScopes: [] })
  ).id;
  return { id, workspaceId: workspace.id };
}

async function thread(
  lastMessageAt: Date | null,
  mb = mailboxId,
  over: Partial<typeof threads.$inferInsert> = {},
) {
  const [t] = await database
    .insert(threads)
    .values({ mailboxId: mb, gmailThreadId: `g${++n}`, inInbox: true, lastMessageAt, ...over })
    .returning();
  return t!.id;
}

/** A stored message; returns its row id. Its Gmail id is `gmailId(rowId)`. */
const gmailIds = new Map<string, string>();
const gmailId = (rowId: string) => gmailIds.get(rowId)!;
async function message(
  threadId: string,
  direction: "in" | "out",
  labelIds: string[],
  sentAt: Date,
  over: Partial<typeof messages.$inferInsert> = {},
) {
  const g = `m${++n}`;
  const [m] = await database
    .insert(messages)
    .values({
      threadId,
      mailboxId,
      gmailMessageId: g,
      direction,
      fromAddress: direction === "in" ? "dana@customer.com" : "owner@shop.com",
      toAddresses: direction === "in" ? ["owner@shop.com"] : ["dana@customer.com"],
      labelIds,
      bodyText: "SECRET-BODY",
      sentAt,
      ...over,
    })
    .returning();
  gmailIds.set(m!.id, g);
  return m!.id;
}

async function draftReplyingTo(
  threadId: string,
  messageId: string,
  status: "pending" | "sent",
  over: Partial<typeof drafts.$inferInsert> = {},
) {
  const [d] = await database
    .insert(drafts)
    .values({
      threadId,
      mailboxId,
      replyToMessageId: messageId,
      gmailDraftId: `d${++n}`,
      toAddress: "dana@customer.com",
      subject: "Re",
      body: "SECRET-DRAFT",
      originalBody: "SECRET-DRAFT",
      reason: "r",
      promptVersion: "draft.v5",
      status,
      ...over,
    })
    .returning();
  return d!.id;
}

const ids = async () =>
  (await database.select({ id: messages.id }).from(messages)).map((r) => r.id).sort();
const row = async (id: string) =>
  (await database.select().from(messages).where(eq(messages.id, id)))[0];
const lastAt = async (id: string) =>
  (await database.select().from(threads).where(eq(threads.id, id)))[0]!.lastMessageAt;
const doneKey = () =>
  database.select().from(appSettings).where(eq(appSettings.key, DRAFT_MESSAGES_CLEANUP_KEY));
const boxDone = async (id: string) =>
  (
    await database
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, draftMessagesDoneKey(id)))
  ).length === 1;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
  const mine = await box("owner@shop.com");
  mailboxId = mine.id;
  workspaceId = mine.workspaceId;
  otherMailboxId = (await box("other@shop.com")).id;
  gmail = new Map();
  looked = [];
}, 30_000);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("which messages are drafts", () => {
  it("DRAFT without SENT is an unsent draft; anything else isn't", () => {
    expect(isUnsentDraft(["DRAFT"])).toBe(true);
    expect(isUnsentDraft(["DRAFT", "CATEGORY_PERSONAL"])).toBe(true);
    expect(isUnsentDraft(["SENT"])).toBe(false);
    expect(isUnsentDraft(["DRAFT", "SENT"])).toBe(false);
    expect(isUnsentDraft(["INBOX", "UNREAD"])).toBe(false);
    expect(isUnsentDraft([])).toBe(false);
  });

  it("the SQL rule agrees with sync's: a row labelled DRAFT and SENT is sent mail", async () => {
    const t = await thread(ago(1));
    await message(t, "out", ["DRAFT"], ago(5));
    expect(await knownCustomer(mailboxId, "dana@customer.com", NOW)).toBe(false);
    await message(t, "out", ["DRAFT", "SENT"], ago(4));
    expect(await knownCustomer(mailboxId, "dana@customer.com", NOW)).toBe(true);
  });
});

describe("one-shot cleanup of drafts stored as owner mail", () => {
  it("asks Gmail about each stored draft: unsent or gone → deleted, sent under its id → kept", async () => {
    const answered = await thread(ago(1));
    const asked = await message(answered, "in", ["INBOX"], ago(5));
    const stillDraft = await message(answered, "out", ["DRAFT"], ago(1));
    gmail.set(gmailId(stillDraft), { labelIds: ["DRAFT"], at: ago(1) });
    const goneDraft = await message(answered, "out", ["DRAFT"], ago(2)); // 404 in Gmail
    // Gmail sent this one under the same id: it's the owner's real answer.
    const sentSameId = await message(answered, "out", ["DRAFT"], ago(3));
    gmail.set(gmailId(sentSameId), { labelIds: ["SENT"], at: ago(2.5) });
    // An app send recorded this id: sent, no need to ask Gmail.
    const recorded = await message(answered, "out", ["DRAFT"], ago(3.6));
    await draftReplyingTo(answered, asked, "sent", {
      sentGmailMessageId: gmailId(recorded),
      decidedAt: ago(3.4),
    });
    // Labelled SENT too: sent mail, never looked up or touched.
    const both = await message(answered, "out", ["DRAFT", "SENT"], ago(4));
    // A thread that only ever held the owner's draft: nothing left, its time stays.
    const draftOnly = await thread(ago(6));
    const onlyRow = await message(draftOnly, "out", ["DRAFT"], ago(6));
    // A thread without drafts isn't touched (its time is deliberately off, to prove it).
    const clean = await thread(ago(10));
    const cleanIn = await message(clean, "in", ["INBOX"], ago(5));

    expect(await cleanup()).toEqual({
      ran: true,
      deleted: 3,
      markedSent: 2,
      threadsUpdated: 1,
      pricesCleared: 0,
      skipped: 0,
      failed: 0,
    });
    expect(looked.sort()).toEqual([stillDraft, goneDraft, sentSameId, onlyRow].map(gmailId).sort());
    expect(await ids()).toEqual([asked, sentSameId, recorded, both, cleanIn].sort());
    expect(await row(sentSameId)).toMatchObject({
      direction: "out",
      labelIds: ["SENT"],
      sentAt: ago(2.5),
    });
    expect(await row(recorded)).toMatchObject({ labelIds: ["SENT"], sentAt: ago(3.4) });
    expect((await row(both))!.labelIds).toEqual(["DRAFT", "SENT"]);
    expect(await lastAt(answered)).toEqual(ago(2.5));
    expect(await lastAt(draftOnly)).toEqual(ago(6));
    expect(await lastAt(clean)).toEqual(ago(10));
  });

  it("re-points a pending reply threaded to a deleted draft to the newest real message", async () => {
    const t = await thread(ago(1));
    await message(t, "in", ["INBOX"], ago(5));
    const reply = await message(t, "out", ["SENT"], ago(4));
    const heldByPending = await message(t, "out", ["DRAFT"], ago(2));
    const heldBySent = await message(t, "out", ["DRAFT"], ago(1));
    const pending = await draftReplyingTo(t, heldByPending, "pending");
    const sent = await draftReplyingTo(t, heldBySent, "sent");

    expect(await cleanup()).toMatchObject({ deleted: 2, threadsUpdated: 1 });
    expect(await ids()).not.toContain(heldByPending);
    const byId = Object.fromEntries(
      (await database.select().from(drafts)).map((d) => [d.id, d.replyToMessageId]),
    );
    expect(byId[pending]).toBe(reply);
    expect(byId[sent]).toBeNull();
    expect(await lastAt(t)).toEqual(ago(4));
  });

  it("clears a quote amount and price memory taken from a draft's text, and nothing else", async () => {
    const extracted = { service_requested: "panel upgrade" };
    const quote = (amount: number) =>
      thread(ago(1), mailboxId, { category: "quote_request", extracted, quoteAmountCents: amount });
    const remember = (threadId: string, amountCents: number, quotedAt: Date) =>
      database
        .insert(priceHistory)
        .values({ workspaceId, threadId, service: "panel upgrade", amountCents, quotedAt });
    // The auto-draft quoted the price list; old code captured it as the owner's quote.
    const fromDraft = await quote(180_000);
    await message(fromDraft, "in", ["INBOX"], ago(10));
    await message(fromDraft, "out", ["DRAFT"], ago(9), { bodyText: "That'll be $1,800." });
    await remember(fromDraft, 180_000, ago(9));
    // The owner really sent $2,400; a draft repeating it, or with another figure, changes nothing.
    const real = await quote(240_000);
    await message(real, "in", ["INBOX"], ago(10));
    await message(real, "out", ["SENT"], ago(8), { bodyText: "It's $2,400 all in." });
    await message(real, "out", ["DRAFT"], ago(7), { bodyText: "Still $2,400. Or $999 for parts." });
    await remember(real, 240_000, ago(8));
    // The owner typed this amount when marking it Won: theirs, kept.
    const typed = await quote(180_000);
    await message(typed, "in", ["INBOX"], ago(10));
    await message(typed, "out", ["DRAFT"], ago(9), { bodyText: "That'll be $1,800." });
    await database.insert(activityLog).values({
      workspaceId,
      actor: "owner",
      action: "quote_marked",
      threadId: typed,
      detail: { outcome: "won", amountTyped: true },
    });
    // The draft's text is already purged: price memory dated to the draft gives it away.
    const purged = await quote(50_000);
    await message(purged, "in", ["INBOX"], ago(10));
    await message(purged, "out", ["DRAFT"], ago(9), { bodyText: null });
    await remember(purged, 50_000, ago(9));

    expect(await cleanup()).toMatchObject({ deleted: 4, pricesCleared: 2, failed: 0 });
    const amounts = Object.fromEntries(
      (await database.select().from(threads)).map((t) => [t.id, t.quoteAmountCents]),
    );
    expect(amounts).toMatchObject({
      [fromDraft]: null,
      [real]: 240_000,
      [typed]: 180_000,
      [purged]: null,
    });
    const memory = await database.select().from(priceHistory);
    expect(memory.map((p) => [p.threadId, p.amountCents])).toEqual([[real, 240_000]]);

    // Worked out again from sent mail only: there's none with a figure, so nothing comes back.
    await captureQuoteAmounts(workspaceId);
    const [after] = await database.select().from(threads).where(eq(threads.id, fromDraft));
    expect(after!.quoteAmountCents).toBeNull();
    expect(await database.select().from(priceHistory)).toHaveLength(1);
  });

  it("keeps a price when a real owner email's text is purged: it may have been the source", async () => {
    const extracted = { service_requested: "panel upgrade" };
    const quote = (amount: number) =>
      thread(ago(1), mailboxId, { category: "quote_request", extracted, quoteAmountCents: amount });
    const remember = (threadId: string, amountCents: number, quotedAt: Date) =>
      database
        .insert(priceHistory)
        .values({ workspaceId, threadId, service: "panel upgrade", amountCents, quotedAt });
    // The owner really quoted $500; a later unsent nudge said "$500" again and old code dated
    // price memory to it. Both texts are past the purge now.
    const bothPurged = await quote(50_000);
    await message(bothPurged, "in", ["INBOX"], ago(12));
    await message(bothPurged, "out", ["SENT"], ago(11), { bodyText: null });
    await message(bothPurged, "out", ["DRAFT"], ago(9), { bodyText: null });
    await remember(bothPurged, 50_000, ago(9));
    // Only the real email's text is purged; the draft's still says the figure.
    const realPurged = await quote(70_000);
    await message(realPurged, "in", ["INBOX"], ago(12));
    await message(realPurged, "out", ["SENT"], ago(11), { bodyText: null });
    await message(realPurged, "out", ["DRAFT"], ago(9), { bodyText: "Still $700." });
    await remember(realPurged, 70_000, ago(9));

    expect(await cleanup()).toMatchObject({ deleted: 2, pricesCleared: 0, failed: 0 });
    const amounts = Object.fromEntries(
      (await database.select().from(threads)).map((t) => [t.id, t.quoteAmountCents]),
    );
    expect(amounts).toMatchObject({ [bothPurged]: 50_000, [realPurged]: 70_000 });
    const memory = await database.select().from(priceHistory);
    expect(memory.map((p) => [p.threadId, p.amountCents]).sort()).toEqual(
      [
        [bothPurged, 50_000],
        [realPurged, 70_000],
      ].sort(),
    );
  });

  it("a mailbox we can't read keeps its rows (recorded sends are still fixed), and the run isn't done", async () => {
    await database
      .update(mailboxes)
      .set({ status: "reconnect_needed" })
      .where(eq(mailboxes.id, otherMailboxId));
    const theirs = await thread(ago(1), otherMailboxId);
    const unknown = await message(theirs, "out", ["DRAFT"], ago(1), { mailboxId: otherMailboxId });
    const recorded = await message(theirs, "out", ["DRAFT"], ago(2), {
      mailboxId: otherMailboxId,
    });
    await draftReplyingTo(theirs, unknown, "sent", {
      mailboxId: otherMailboxId,
      sentGmailMessageId: gmailId(recorded),
      decidedAt: ago(1.5),
    });

    expect(await cleanup()).toMatchObject({ deleted: 0, markedSent: 1, skipped: 1, failed: 0 });
    expect(looked).toEqual([]);
    expect((await row(unknown))!.labelIds).toEqual(["DRAFT"]);
    expect((await row(recorded))!.labelIds).toEqual(["SENT"]);
    // Its rows were never checked: the run isn't done, and neither is that mailbox.
    expect(await doneKey()).toHaveLength(0);
    expect(await boxDone(otherMailboxId)).toBe(false);
    expect(await boxDone(mailboxId)).toBe(true);
    // Still unreadable next run: skipped again, nothing else looked at.
    expect(await cleanup()).toMatchObject({ ran: true, skipped: 1, deleted: 0 });
    expect(looked).toEqual([]);
    expect(await doneKey()).toHaveLength(0);

    // The owner reconnects: the next run checks its rows with Gmail, and then it's done.
    await database
      .update(mailboxes)
      .set({ status: "active" })
      .where(eq(mailboxes.id, otherMailboxId));
    expect(await cleanup()).toMatchObject({ ran: true, deleted: 1, skipped: 0, failed: 0 });
    expect(looked).toEqual([gmailId(unknown)]);
    expect(await ids()).not.toContain(unknown);
    expect(await doneKey()).toHaveLength(1);
    expect(await cleanup()).toEqual({ ran: false });
  });

  it("a read-only account's mailbox waits too, and is checked once the account can run again", async () => {
    // Stored 'evaluating' but the clock ran out: read-only, so no Gmail calls.
    const [other] = await database
      .select({ workspaceId: mailboxes.workspaceId })
      .from(mailboxes)
      .where(eq(mailboxes.id, otherMailboxId));
    await database
      .update(workspaces)
      .set({ status: "evaluating", evaluationEndsAt: ago(1) })
      .where(eq(workspaces.id, other!.workspaceId));
    const theirs = await thread(ago(1), otherMailboxId);
    const kept = await message(theirs, "out", ["DRAFT"], ago(1), { mailboxId: otherMailboxId });

    expect(await cleanup()).toMatchObject({ skipped: 1, deleted: 0 });
    expect(looked).toEqual([]);
    expect(await doneKey()).toHaveLength(0);

    await database
      .update(workspaces)
      .set({ status: "active", evaluationEndsAt: null })
      .where(eq(workspaces.id, other!.workspaceId));
    expect(await cleanup()).toMatchObject({ skipped: 0, deleted: 1 });
    expect(looked).toEqual([gmailId(kept)]);
    expect(await doneKey()).toHaveLength(1);
  });

  it("lost access mid-run: the mailbox is marked, its rows wait, the others are done", async () => {
    const mine = await thread(ago(1));
    const kept = await message(mine, "out", ["DRAFT"], ago(1));
    const theirs = await thread(ago(1), otherMailboxId);
    await message(theirs, "out", ["DRAFT"], ago(1), { mailboxId: otherMailboxId });
    const r = await runDraftMessagesCleanup(NOW, {
      readerFor: (m) =>
        m.id === mailboxId
          ? {
              getMessage: async () => {
                throw new MailboxAuthError();
              },
            }
          : reader(),
    });
    expect(r).toMatchObject({ deleted: 1, skipped: 1, failed: 0 });
    expect(await ids()).toEqual([kept]);
    const [b] = await database.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(b!.status).toBe("reconnect_needed");
    // The other mailbox is done; this one waits for the reconnect.
    expect(await boxDone(otherMailboxId)).toBe(true);
    expect(await boxDone(mailboxId)).toBe(false);
    expect(await doneKey()).toHaveLength(0);
  });

  it("isn't marked done while a mailbox has more drafts than one run checks", async () => {
    const t = await thread(ago(1));
    await database.insert(messages).values(
      Array.from({ length: DRAFT_MESSAGES_BATCH + 1 }, (_, i) => ({
        threadId: t,
        mailboxId,
        gmailMessageId: `bulk-${i}`,
        direction: "out" as const,
        labelIds: ["DRAFT"],
        sentAt: ago(2 + i / 100),
      })),
    );
    expect(await cleanup()).toMatchObject({ ran: true, deleted: DRAFT_MESSAGES_BATCH });
    expect(await doneKey()).toHaveLength(0);
    expect(await cleanup()).toMatchObject({ ran: true, deleted: 1 });
    expect(await doneKey()).toHaveLength(1);
    expect(await cleanup()).toEqual({ ran: false });
  });

  it("covers every mailbox, runs once (app_settings key), and a second pass changes nothing", async () => {
    const mine = await thread(ago(1));
    await message(mine, "out", ["DRAFT"], ago(1));
    const theirs = await thread(ago(1), otherMailboxId);
    await message(theirs, "out", ["DRAFT"], ago(1), { mailboxId: otherMailboxId });
    await message(theirs, "in", ["INBOX"], ago(2), { mailboxId: otherMailboxId });

    expect(await cleanup()).toMatchObject({ ran: true, deleted: 2, threadsUpdated: 1, failed: 0 });
    const [key] = await doneKey();
    expect(key!.value).toBe(NOW.toISOString());

    // Once done, it doesn't run again — even if a draft row appeared somehow.
    await message(mine, "out", ["DRAFT"], ago(0.5));
    expect(await cleanup()).toEqual({ ran: false });

    // Each mailbox is done on its own: without the run-wide key, done mailboxes aren't
    // looked at again.
    await database.delete(appSettings).where(eq(appSettings.key, DRAFT_MESSAGES_CLEANUP_KEY));
    looked = [];
    expect(await cleanup()).toMatchObject({ ran: true, deleted: 0, failed: 0 });
    expect(looked).toEqual([]);
    expect(await cleanup()).toEqual({ ran: false });

    // Idempotent: run again without any marker, and only what's still a draft goes.
    await database.delete(appSettings);
    expect(await cleanup()).toMatchObject({ ran: true, deleted: 1, threadsUpdated: 0, failed: 0 });
    expect(await cleanup()).toEqual({ ran: false });
  });

  it("one mailbox failing doesn't stop the others, logs no content, and leaves it to run again", async () => {
    const mine = await thread(ago(1));
    await message(mine, "out", ["DRAFT"], ago(1));
    const theirs = await thread(ago(1), otherMailboxId);
    await message(theirs, "out", ["DRAFT"], ago(1), { mailboxId: otherMailboxId });
    // The other mailbox's delete fails inside the database.
    await database.execute(
      sql.raw(`create function fail_delete() returns trigger language plpgsql as $$
        begin raise exception 'SECRET-dana@customer.com'; end $$`),
    );
    await database.execute(
      sql.raw(`create trigger fail_delete before delete on messages for each row
        when (old.mailbox_id = '${otherMailboxId}') execute function fail_delete()`),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const infos = vi.spyOn(console, "info").mockImplementation(() => {});

    expect(await cleanup()).toMatchObject({ ran: true, deleted: 1, failed: 1 });
    const logged = JSON.stringify([errors.mock.calls, infos.mock.calls]);
    expect(logged).toContain("draft_messages_cleanup_failed");
    expect(logged).not.toMatch(/SECRET|@/);
    expect(await doneKey()).toHaveLength(0);

    // Fixed: the next run finishes the job and marks it done.
    await database.execute(sql.raw("drop trigger fail_delete on messages"));
    expect(await cleanup()).toMatchObject({ ran: true, deleted: 1, failed: 0 });
    expect(await cleanup()).toEqual({ ran: false });
  });

  it("runs in the 15-minute job, after the M7 backfill and before the lead-at-risk pushes", () => {
    const src = readFileSync("src/jobs/functions.ts", "utf8");
    const head = "export const workspaceLifecycle = inngest.createFunction(";
    const start = src.indexOf(head);
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf("inngest.createFunction(", start + head.length);
    const body = src.slice(start, next === -1 ? undefined : next);
    // Check 25 P4: the checks run inside four grouped steps (runChecks), in this order.
    const cleanup = body.indexOf('"draft-messages-cleanup": () => runDraftMessagesCleanup()');
    const m7 = body.indexOf('"m7-backfill": () => runM7Backfill()');
    expect(m7).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(m7);
    expect(cleanup).toBeLessThan(
      body.indexOf('"lead-at-risk-pushes": () => sendLeadAtRiskPushes()'),
    );
  });
});

describe("quotes: a draft is no price given", () => {
  it("a quote whose only owner email is an unsent draft with a figure has no amount", async () => {
    const t = await thread(ago(1), mailboxId, {
      category: "quote_request",
      extracted: { service_requested: "panel upgrade" },
    });
    await message(t, "in", ["INBOX"], ago(10));
    await message(t, "out", ["DRAFT"], ago(9), { bodyText: "That'll be $1,800 for the panel." });
    await captureQuoteAmounts(workspaceId);
    const [after] = await database.select().from(threads).where(eq(threads.id, t));
    expect(after!.quoteAmountCents).toBeNull();
    expect(await database.select().from(priceHistory)).toHaveLength(0);
    expect(await ownerGavePrice({ id: t, quoteAmountCents: null }, NOW)).toBe(false);
    // Sent, it is the price.
    await message(t, "out", ["SENT"], ago(8), { bodyText: "That'll be $1,800 for the panel." });
    expect(await ownerGavePrice({ id: t, quoteAmountCents: null }, NOW)).toBe(true);
  });
});

describe("knownCustomer: the owner has written to them before", () => {
  it("an unsent draft to the address doesn't count; a sent email does", async () => {
    const t = await thread(ago(1));
    await message(t, "out", ["DRAFT"], ago(5));
    expect(await knownCustomer(mailboxId, "dana@customer.com", NOW)).toBe(false);
    await message(t, "out", ["SENT"], ago(4));
    expect(await knownCustomer(mailboxId, "Dana@Customer.com", NOW)).toBe(true);
    // Only mail before the moment asked about.
    expect(await knownCustomer(mailboxId, "dana@customer.com", ago(4))).toBe(false);
  });
});
