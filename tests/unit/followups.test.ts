import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { ModelDraft } from "@/ai/prompts/draft.v1";
import type { Database } from "@/db";
import { activityLog, drafts, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  createDraftForThread,
  reconcileDrafts,
  sendDraft,
  sentDraftSummary,
} from "@/server/drafts";
import { threadsToFollowUp } from "@/server/followups";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { followupSettingsInput, saveFollowupSettings } from "@/server/profile";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const DAY = 86_400_000;
const NOW = new Date("2026-10-05T14:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);
const nudge = (over: Partial<ModelDraft> = {}): ModelDraft => ({
  body: "Hi Dana,\n\nJust checking you got the quote for the panel upgrade. Any questions, shout.\n\nThanks, Davi",
  reason: "No reply in 4 days to your panel upgrade quote. Gentle nudge.",
  flags: [],
  confidence: 0.9,
  ...over,
});

let database: Database;
let workspaceId: string;
let mailboxId: string;
let writer: FakeWriter;
let g = 0;
const deps = () => ({ writerFor: () => writer, now: () => NOW });

/** A customer asked; the owner answered `ownerRepliedDaysAgo` days ago; nothing since. */
async function quietThread(
  opts: {
    category?: string;
    needsOwner?: boolean;
    ownerRepliedDaysAgo?: number;
    customerWroteAfter?: boolean;
  } = {},
) {
  const id = `g${++g}`;
  const replied = opts.ownerRepliedDaysAgo ?? 4;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: id,
      inInbox: true,
      subject: "Panel upgrade",
      category: opts.category ?? "quote_request",
      needsOwner: opts.needsOwner ?? false,
      summary: "Dana wants a panel upgrade quote.",
      classifiedAt: daysAgo(replied + 1),
      lastMessageAt: daysAgo(replied),
    })
    .returning();
  await database.insert(messages).values([
    {
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-in`,
      rfc822MessageId: `<${id}-in@customer.com>`,
      direction: "in",
      fromAddress: "dana@customer.com",
      fromName: "Dana Ruiz",
      subject: "Panel upgrade",
      bodyText: "Can you quote a 200 amp panel upgrade?",
      sentAt: daysAgo(replied + 1),
    },
    {
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-out`,
      rfc822MessageId: `<${id}-out@shop.com>`,
      references: `<${id}-in@customer.com>`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["dana@customer.com"],
      subject: "Re: Panel upgrade",
      bodyText: "Hi Dana, it's $2,400 including the permit. Thanks, Davi",
      sentAt: daysAgo(replied),
    },
  ]);
  if (opts.customerWroteAfter) {
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-in2`,
      direction: "in",
      fromAddress: "dana@customer.com",
      bodyText: "Thanks, thinking about it.",
      sentAt: daysAgo(replied - 1),
    });
  }
  return t!.id;
}

async function sentNudge(threadId: string, createdDaysAgo: number) {
  await database.insert(drafts).values({
    threadId,
    mailboxId,
    kind: "followup",
    gmailDraftId: `old-${threadId}-${createdDaysAgo}`,
    toAddress: "dana@customer.com",
    subject: "Re: Panel upgrade",
    body: "nudge",
    originalBody: "nudge",
    status: "sent",
    reason: "nudge",
    promptVersion: "followup.v1",
    // Drafted a little before it went out.
    createdAt: daysAgo(createdDaysAgo + 0.1),
    decidedAt: daysAgo(createdDaysAgo),
  });
  // The sent nudge shows up in Gmail as the owner's latest message.
  await database.insert(messages).values({
    threadId,
    mailboxId,
    gmailMessageId: `${threadId}-nudge-${createdDaysAgo}`,
    rfc822MessageId: `<${threadId}-nudge@shop.com>`,
    direction: "out",
    fromAddress: "owner@shop.com",
    subject: "Re: Panel upgrade",
    bodyText: "nudge",
    sentAt: daysAgo(createdDaysAgo),
  });
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "100";
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  workspaceId = workspace.id;
  mailboxId = (
    await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    })
  ).id;
  writer = new FakeWriter();
});

describe("which threads get a nudge", () => {
  it("a quote the owner answered 3+ days ago with no reply is due", async () => {
    const due = await quietThread({ ownerRepliedDaysAgo: 4 });
    await quietThread({ ownerRepliedDaysAgo: 1 }); // too soon
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([due]);
  });

  it("invoices count; complaints, other categories and flagged threads never do", async () => {
    const invoice = await quietThread({ category: "invoice_payment" });
    await quietThread({ category: "complaint" });
    await quietThread({ category: "customer_question" });
    await quietThread({ needsOwner: true });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([invoice]);
  });

  it("not if the customer has written since", async () => {
    await quietThread({ ownerRepliedDaysAgo: 5, customerWroteAfter: true });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
  });

  it("not if it went quiet weeks ago", async () => {
    await quietThread({ ownerRepliedDaysAgo: 30 });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
  });

  it("never more than two nudges, ever", async () => {
    const once = await quietThread({ ownerRepliedDaysAgo: 10 });
    await sentNudge(once, 6);
    const twice = await quietThread({ ownerRepliedDaysAgo: 12 });
    await sentNudge(twice, 8);
    await sentNudge(twice, 4);
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([once]);
  });

  it("a nudge the owner discarded isn't written again until they write again", async () => {
    const t = await quietThread({ ownerRepliedDaysAgo: 5 });
    await database.insert(drafts).values({
      threadId: t,
      mailboxId,
      kind: "followup",
      gmailDraftId: "discarded",
      toAddress: "dana@customer.com",
      subject: "Re",
      body: "x",
      originalBody: "x",
      status: "discarded",
      reason: "x",
      promptVersion: "followup.v1",
      createdAt: daysAgo(1),
    });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
  });

  it("follows the owner's settings: off, or a different wait", async () => {
    const t = await quietThread({ ownerRepliedDaysAgo: 4 });
    await saveFollowupSettings(workspaceId, followupSettingsInput.parse({ days: "5" }));
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
    await saveFollowupSettings(
      workspaceId,
      followupSettingsInput.parse({ enabled: "on", days: "3" }),
    );
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([t]);
    await saveFollowupSettings(workspaceId, followupSettingsInput.parse({ days: "3" }));
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
  });

  it("rejects a wait that isn't one of the choices", () => {
    expect(followupSettingsInput.safeParse({ enabled: "on", days: "1" }).success).toBe(false);
    expect(followupSettingsInput.safeParse({ days: "30" }).success).toBe(false);
  });
});

describe("writing and sending a nudge", () => {
  it("is a real Gmail draft to the customer, threaded after the owner's message, using the follow-up prompt", async () => {
    const t = await quietThread({ ownerRepliedDaysAgo: 4 });
    const { transport, calls } = fakeTransport([nudge()]);
    setModelTransportForTests(transport);

    const r = await createDraftForThread(t, { trigger: "followup", ...deps() });
    expect(r.status).toBe("created");
    expect(calls[0]!.system[0]!.text).toMatch(/follow-up/i);
    expect(calls[0]!.user).toMatch(/hasn't replied for 4 days/);

    const [d] = await database.select().from(drafts).where(eq(drafts.threadId, t));
    expect(d).toMatchObject({
      kind: "followup",
      toAddress: "dana@customer.com",
      status: "pending",
    });
    expect(d!.promptVersion).toBe("followup.v1");
    const raw = [...writer.drafts.values()][0]!.raw;
    expect(FakeWriter.headersOf(raw)).toMatch(/In-Reply-To: <g\d+-out@shop.com>/);
    expect(FakeWriter.headersOf(raw)).toMatch(/To: dana@customer.com/);
    // Repeating a price already in the conversation isn't flagged as invented.
    expect(d!.flags).toEqual([]);

    const [log] = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "followup_drafted"));
    expect(log!.detail).toMatchObject({ nudgeNumber: 1 });
    expect(JSON.stringify(log!.detail)).not.toMatch(/Dana|panel|2,400/i);
  });

  it("the second nudge is the last, and offers an easy out", async () => {
    const t = await quietThread({ ownerRepliedDaysAgo: 10 });
    await sentNudge(t, 4);
    const { transport, calls } = fakeTransport([nudge()]);
    setModelTransportForTests(transport);
    expect((await createDraftForThread(t, { trigger: "followup", ...deps() })).status).toBe(
      "created",
    );
    expect(calls[0]!.user).toMatch(/second and final follow-up/);
  });

  it("the cap holds even if something asks directly", async () => {
    const t = await quietThread({ ownerRepliedDaysAgo: 12 });
    await sentNudge(t, 8);
    await sentNudge(t, 4);
    const { transport, calls } = fakeTransport([nudge()]);
    setModelTransportForTests(transport);
    expect(await createDraftForThread(t, { trigger: "followup", ...deps() })).toEqual({
      status: "skipped",
      reason: "followup_cap",
    });
    const complaint = await quietThread({ category: "complaint" });
    expect(await createDraftForThread(complaint, { trigger: "followup", ...deps() })).toEqual({
      status: "skipped",
      reason: "followup_not_allowed",
    });
    const answered = await quietThread({ customerWroteAfter: true });
    expect(await createDraftForThread(answered, { trigger: "followup", ...deps() })).toEqual({
      status: "skipped",
      reason: "customer_replied",
    });
    expect(calls).toHaveLength(0);
    expect(writer.calls).toEqual([]);
  });

  it("a nudge is never sent during evaluation, like any other draft", async () => {
    const t = await quietThread();
    setModelTransportForTests(fakeTransport([nudge()]).transport);
    const r = await createDraftForThread(t, { trigger: "followup", ...deps() });
    if (r.status !== "created") throw new Error("expected a draft");
    await expect(sendDraft(workspaceId, r.draftId, deps())).rejects.toThrow(/blocked/);
    expect(writer.sent).toEqual([]);
  });

  it("sending counts toward the cap, and the sent screen says what's next", async () => {
    await database
      .update(workspaces)
      .set({ status: "active" })
      .where(eq(workspaces.id, workspaceId));
    const t = await quietThread({ ownerRepliedDaysAgo: 4 });
    setModelTransportForTests(fakeTransport([nudge()]).transport);
    const r = await createDraftForThread(t, { trigger: "followup", ...deps() });
    if (r.status !== "created") throw new Error("expected a draft");

    const sent = await sendDraft(workspaceId, r.draftId, deps());
    expect(sent).toMatchObject({ status: "sent", toName: "Dana Ruiz" });
    const [thread] = await database.select().from(threads).where(eq(threads.id, t));
    expect(thread!.followupCount).toBe(1);

    const summary = await sentDraftSummary(workspaceId, r.draftId);
    expect(summary!.kind).toBe("followup");
    expect(summary!.nudgeOn).toEqual(new Date(NOW.getTime() + 3 * DAY));
    expect(summary!.lastNudgeUsed).toBe(false);
  });

  it("after the second nudge, the sent screen says that was the last one", async () => {
    await database
      .update(workspaces)
      .set({ status: "active" })
      .where(eq(workspaces.id, workspaceId));
    const t = await quietThread({ ownerRepliedDaysAgo: 10 });
    await sentNudge(t, 4);
    setModelTransportForTests(fakeTransport([nudge()]).transport);
    const r = await createDraftForThread(t, { trigger: "followup", ...deps() });
    if (r.status !== "created") throw new Error("expected a draft");
    await sendDraft(workspaceId, r.draftId, deps());
    const summary = await sentDraftSummary(workspaceId, r.draftId);
    expect(summary).toMatchObject({ nudgeOn: null, lastNudgeUsed: true });
  });

  it("a pending nudge is withdrawn if the owner writes to them some other way", async () => {
    const t = await quietThread({ ownerRepliedDaysAgo: 4 });
    setModelTransportForTests(fakeTransport([nudge()]).transport);
    const r = await createDraftForThread(t, { trigger: "followup", ...deps() });
    if (r.status !== "created") throw new Error("expected a draft");
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: "owner-wrote-again",
      direction: "out",
      fromAddress: "owner@shop.com",
      bodyText: "Called you, left a voicemail.",
      sentAt: new Date(NOW.getTime() + 3600_000),
    });
    const later = { writerFor: () => writer, now: () => new Date(NOW.getTime() + 7200_000) };
    expect((await reconcileDrafts(mailboxId, later)).closed).toBe(1);
    const [d] = await database.select().from(drafts).where(eq(drafts.id, r.draftId));
    expect(d!.status).toBe("expired");
    expect(writer.drafts.size).toBe(0);
  });

  it("read-only accounts get no nudges", async () => {
    const t = await quietThread();
    await database
      .update(workspaces)
      .set({ status: "evaluation_expired" })
      .where(eq(workspaces.id, workspaceId));
    const { transport, calls } = fakeTransport([nudge()]);
    setModelTransportForTests(transport);
    expect(await createDraftForThread(t, { trigger: "followup", ...deps() })).toEqual({
      status: "skipped",
      reason: "read_only",
    });
    expect(calls).toHaveLength(0);
  });
});
