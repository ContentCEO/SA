/**
 * Wave 1 "Safety guards", end to end on the real database code (PGlite, fake model): gas, carbon
 * monoxide and smelly water, from sorting to the fixed safety note. Every email is invented.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import { reserveAiCall } from "@/ai/usage";
import {
  CO_REASON,
  GAS_SMELL_REASON,
  PAYMENT_CHANGE_REASON,
  WATER_SMELL_REASON,
} from "@/ai/guards";
import type { Database } from "@/db";
import { drafts, messages, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { classifyPending } from "@/server/classification";
import {
  CO_SAFETY_NOTE_FLAG,
  createDraftForThread,
  SAFETY_NOTE_FLAG,
  threadsToAutoDraft,
} from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";
import { classification, fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const NOW = new Date("2026-10-16T15:00:00Z");
const minsAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
let database: Database;
let mailboxId: string;
let workspaceId: string;
let writer: FakeWriter;
const deps = () => ({ writerFor: () => writer, now: () => NOW });

async function thread(g: string, over: Partial<typeof threads.$inferInsert> = {}) {
  const [t] = await database
    .insert(threads)
    .values({ mailboxId, gmailThreadId: g, inInbox: true, lastMessageAt: NOW, ...over })
    .returning();
  return t!;
}
async function message(threadId: string, id: string, over: Partial<typeof messages.$inferInsert>) {
  await database.insert(messages).values({
    threadId,
    mailboxId,
    gmailMessageId: id,
    rfc822MessageId: `<${id}@x.test>`,
    direction: "in",
    fromAddress: "dana@x.test",
    fromName: "Dana",
    subject: "Help",
    bodyText: `body ${id}`,
    labelIds: ["INBOX"],
    replyToHeader: {},
    sentAt: minsAgo(30),
    createdAt: minsAgo(30),
    ...over,
  });
}
const threadRow = async (id: string) =>
  (await database.select().from(threads).where(eq(threads.id, id)))[0]!;
const draftsOn = (id: string) => database.select().from(drafts).where(eq(drafts.threadId, id));

/** Sort one email with a fake model answer, then let the draft job run with no model at all. */
async function sortThenDraft(threadId: string, model = classification()) {
  setModelTransportForTests(fakeTransport([model]).transport);
  await classifyPending(mailboxId, { now: NOW });
  const none = fakeTransport([]);
  setModelTransportForTests(none.transport);
  const candidates = await threadsToAutoDraft(mailboxId);
  const r = candidates.includes(threadId)
    ? await createDraftForThread(threadId, { trigger: "auto", ...deps() })
    : null;
  return { row: await threadRow(threadId), candidates, r, modelCalls: none.calls.length };
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "100";
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.test" });
  workspaceId = workspace.id;
  mailboxId = (
    await saveConnectedMailbox(workspace, {
      email: "owner@shop.test",
      refreshToken: "rt",
      grantedScopes: [],
    })
  ).id;
  writer = new FakeWriter();
});

describe("gas, CO and smelly water, sorted and drafted (Check 22 P4 + Check 36 P1)", () => {
  it("a gas bill's footer, sorted as junk: not needs-you, no safety note", async () => {
    const t = await thread("bill");
    await message(t.id, "bill", {
      fromAddress: "billing@gasco.test",
      subject: "Your bill is ready",
      bodyText:
        "Your October bill is ready. Amount due: $84.12.\n\nSmell gas? Leave the building right away and call 911.",
    });
    const { row, candidates } = await sortThenDraft(
      t.id,
      classification({ category: "noise", priority: "low", confidence: 0.95 }),
    );
    expect(row).toMatchObject({ needsOwner: false, category: "noise" });
    expect((row.extracted as { gas_smell?: boolean }).gas_smell).toBeUndefined();
    expect(candidates).toEqual([]);
    expect(await draftsOn(t.id)).toHaveLength(0);
  });

  it("junk the model still says smells gas: needs you, but no safety note to a stranger", async () => {
    const t = await thread("news");
    await message(t.id, "news", {
      fromAddress: "news@trade.test",
      subject: "This week",
      bodyText: "Tips for the season.",
    });
    const m = classification({
      category: "noise",
      signals: { ...classification().signals, smells_gas: true },
    });
    const { row, r } = await sortThenDraft(t.id, m);
    expect(row.needsOwner).toBe(true);
    expect(r).toBeNull();
    expect(await createDraftForThread(t.id, { trigger: "auto", ...deps() })).toEqual({
      status: "skipped",
      reason: "noise",
    });
    expect(await draftsOn(t.id)).toHaveLength(0);
  });

  it("a carbon monoxide alarm: needs you, high, CO_REASON, one CO note waiting for Send reply", async () => {
    const t = await thread("co");
    await message(t.id, "co", {
      bodyText:
        "Our carbon monoxide alarm went off twice last night. Can someone check the furnace?",
    });
    const { row, r, modelCalls } = await sortThenDraft(
      t.id,
      classification({ category: "complaint" }),
    );
    expect(row).toMatchObject({ needsOwner: true, priority: "high", needsOwnerReason: CO_REASON });
    expect(row.extracted).toMatchObject({ co_alarm: true, urgency: "emergency" });
    expect(r?.status).toBe("created");
    expect(modelCalls).toBe(0);
    const ds = await draftsOn(t.id);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ purpose: "safety", status: "pending" });
    expect(ds[0]!.flags[0]).toBe(CO_SAFETY_NOTE_FLAG);
    expect(ds[0]!.body).toMatch(/carbon monoxide/);
    expect(ds[0]!.body).toMatch(/911/);
    expect(writer.sent).toHaveLength(0);
    // Once per thread.
    await database.update(drafts).set({ status: "discarded" }).where(eq(drafts.id, ds[0]!.id));
    expect(await threadsToAutoDraft(mailboxId)).toEqual([]);
  });

  it("well water that smells like rotten eggs: the water reason, no safety note", async () => {
    const t = await thread("well");
    await message(t.id, "well", {
      bodyText:
        "The hot water smells like rotten eggs since the new heater went in. We're on a well.",
    });
    const { row, candidates } = await sortThenDraft(
      t.id,
      classification({ category: "customer_question" }),
    );
    expect(row).toMatchObject({
      needsOwner: true,
      priority: "normal",
      needsOwnerReason: WATER_SMELL_REASON,
    });
    expect(row.extracted).toMatchObject({ water_smell: true });
    expect((row.extracted as { gas_smell?: boolean }).gas_smell).toBeUndefined();
    expect(candidates).toEqual([]);
    expect(await draftsOn(t.id)).toHaveLength(0);
  });

  it("propane, even when the model says no gas: the gas reason and the gas safety note", async () => {
    const t = await thread("propane");
    await message(t.id, "propane", { bodyText: "We smell propane by the tankless heater." });
    const { row, r } = await sortThenDraft(t.id, classification({ category: "customer_question" }));
    expect(row).toMatchObject({
      needsOwner: true,
      priority: "high",
      needsOwnerReason: GAS_SMELL_REASON,
    });
    expect(r?.status).toBe("created");
    const [d] = await draftsOn(t.id);
    expect(d!.flags[0]).toBe(SAFETY_NOTE_FLAG);
  });
});

describe("after the day's AI limit (Check 39 P1)", () => {
  async function useUpTheLimit() {
    process.env.AI_DAILY_CALL_CAP = "1";
    await reserveAiCall(workspaceId, NOW);
  }

  it("a gas smell and a new bank account are still sorted in code; a plain email waits", async () => {
    await useUpTheLimit();
    const gas = await thread("gas", { lastMessageAt: minsAgo(40) });
    await message(gas.id, "gas", {
      bodyText: "There's a gas smell near the furnace in the basement. Please call.",
      sentAt: minsAgo(40),
    });
    const bank = await thread("bank", { lastMessageAt: minsAgo(35) });
    await message(bank.id, "bank", {
      fromAddress: "ap@supply.test",
      bodyText: "Please note our bank details have changed. Pay the new account below.",
      sentAt: minsAgo(35),
    });
    const plain = await thread("plain");
    await message(plain.id, "plain", { bodyText: "Can you quote a new vanity?" });
    const { transport, calls } = fakeTransport([classification(), classification()]);
    setModelTransportForTests(transport);

    const r = await classifyPending(mailboxId, { now: NOW });
    expect(r).toMatchObject({ capped: true, codeOnly: 2, classified: 2 });
    expect(calls).toHaveLength(0);
    expect(await threadRow(gas.id)).toMatchObject({
      needsOwner: true,
      priority: "high",
      needsOwnerReason: GAS_SMELL_REASON,
    });
    expect((await threadRow(gas.id)).extracted).toMatchObject({
      gas_smell: true,
      urgency: "emergency",
    });
    expect(await threadRow(bank.id)).toMatchObject({
      needsOwner: true,
      priority: "high",
      needsOwnerReason: PAYMENT_CHANGE_REASON,
    });
    const plainRow = await threadRow(plain.id);
    expect(plainRow.classifiedAt).toBeNull();
    const [plainMsg] = await database
      .select()
      .from(messages)
      .where(eq(messages.threadId, plain.id));
    expect(plainMsg!.classifiedAt).toBeNull();
  });

  it("the draft job writes the safety note first, with no model call", async () => {
    // An ordinary lead sorted earlier, newer than the gas email, also waiting for a reply.
    const lead = await thread("lead", { lastMessageAt: NOW });
    await message(lead.id, "lead", { bodyText: "Quote for a vanity?", sentAt: minsAgo(5) });
    setModelTransportForTests(fakeTransport([classification()]).transport);
    await classifyPending(mailboxId, { now: NOW });

    // That was the day's one call.
    process.env.AI_DAILY_CALL_CAP = "1";
    const gas = await thread("gas", { lastMessageAt: minsAgo(40) });
    await message(gas.id, "gas", {
      bodyText: "I smell gas by the stove.",
      sentAt: minsAgo(40),
    });
    const { transport, calls } = fakeTransport([]);
    setModelTransportForTests(transport);
    await classifyPending(mailboxId, { now: NOW });

    const due = await threadsToAutoDraft(mailboxId);
    expect(due[0]).toBe(gas.id);
    expect(due).toContain(lead.id);
    expect(await createDraftForThread(gas.id, { trigger: "auto", ...deps() })).toMatchObject({
      status: "created",
    });
    expect(calls).toHaveLength(0);
    const [d] = await draftsOn(gas.id);
    expect(d).toMatchObject({ purpose: "safety", status: "pending" });
    // The ordinary reply waits for the reset.
    expect(await createDraftForThread(lead.id, { trigger: "auto", ...deps() })).toEqual({
      status: "skipped",
      reason: "capped",
    });
  });
});
