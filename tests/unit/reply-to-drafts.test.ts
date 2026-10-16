import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { ModelDraft } from "@/ai/prompts/draft.v5";
import type { Database } from "@/db";
import { drafts, messages, threads, workspaces } from "@/db/schema";
import { MailboxRateLimitError } from "@/mailbox/connector";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { batchCandidates, createDraftForThread, listQueue, sendDraft } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import type { ReplyToHeader } from "@/server/reply-address-rules";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

/**
 * Review "Must fix" (B1) and H7: a website-form lead is answered at the customer's own
 * address (the email's Reply-To), never at the form's robot address, and every card says
 * where the reply goes.
 */
const NOW = new Date("2026-10-15T15:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const modelDraft = (over: Partial<ModelDraft> = {}): ModelDraft => ({
  body: "Hi Dana,\n\nHappy to take a look. What's the address?\n\nThanks, Mike",
  reason: "Quote request. Asked for the address.",
  flags: [],
  confidence: 0.9,
  used_facts: [],
  ...over,
});

let database: Database;
let workspaceId: string;
let mailboxId: string;
let writer: FakeWriter;
let n = 0;
const deps = () => ({ writerFor: () => writer, now: () => NOW });

async function lead(opts: {
  from: string;
  fromName?: string | null;
  replyToHeader: ReplyToHeader | null;
  category?: string;
}) {
  const g = `g${++n}`;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: g,
      inInbox: true,
      subject: "Form Submission - Request a quote",
      category: opts.category ?? "quote_request",
      summary: "Dana wants a water heater quote.",
      classifiedAt: NOW,
      lastMessageAt: ago(1),
    })
    .returning();
  const [m] = await database
    .insert(messages)
    .values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${g}-m1`,
      rfc822MessageId: `<${g}-m1@forms.example>`,
      direction: "in",
      fromAddress: opts.from,
      fromName: opts.fromName === undefined ? "Squarespace" : opts.fromName,
      replyToHeader: opts.replyToHeader,
      subject: "Form Submission - Request a quote",
      bodyText: "Name: Dana Ruiz\nMessage: Could you quote a water heater swap?",
      sentAt: ago(2),
    })
    .returning();
  return { thread: t!, message: m! };
}

const mimeTo = (draftId: string | null) =>
  FakeWriter.headersOf(writer.drafts.get(draftId ?? "")!.raw)
    .split("\r\n")
    .find((l) => l.startsWith("To: "));

async function draftOf(r: unknown) {
  const id = (r as { draftId: string }).draftId;
  return (await database.select().from(drafts).where(eq(drafts.id, id)))[0]!;
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "100";
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
  writer = new FakeWriter();
});

afterEach(() => setModelTransportForTests(undefined));

describe("drafting to the customer's reply address", () => {
  it("a stored Reply-To: the draft, the MIME and the card go to the customer; no Gmail read", async () => {
    const { thread } = await lead({
      from: "form-submission@squarespace.info",
      replyToHeader: { address: "dana@example.com", name: "Dana Ruiz" },
    });
    const { transport, calls } = fakeTransport([modelDraft()]);
    setModelTransportForTests(transport);
    const r = await createDraftForThread(thread.id, { trigger: "auto", ...deps() });
    const d = await draftOf(r);
    expect(d.toAddress).toBe("dana@example.com");
    expect(mimeTo(d.gmailDraftId)).toBe("To: dana@example.com");
    expect(writer.replyToReads).toEqual([]);
    // The model reads the customer's name, never the robot's.
    expect(calls[0]!.user).toContain("Dana Ruiz");
    expect(calls[0]!.user).not.toContain("Squarespace");

    const q = await listQueue(workspaceId, NOW);
    expect(q.drafts[0]).toMatchObject({
      customerName: "Dana Ruiz",
      customerAddress: "dana@example.com",
      toAddress: "dana@example.com",
      replyRedirected: true,
    });
  });

  it("never read (stored before this): one metadata read, stored, used — before any model call", async () => {
    const { thread, message } = await lead({
      from: "no-reply@crm.wix.com",
      fromName: "Wix Forms",
      replyToHeader: null,
    });
    writer.replyTo.set(message.gmailMessageId, "Dana Ruiz <dana@example.com>");
    const { transport, calls } = fakeTransport([modelDraft()]);
    setModelTransportForTests(transport);
    const r = await createDraftForThread(thread.id, { trigger: "auto", ...deps() });
    expect(writer.replyToReads).toEqual([message.gmailMessageId]);
    const d = await draftOf(r);
    expect(d.toAddress).toBe("dana@example.com");
    expect(calls[0]!.user).not.toContain("Wix Forms");
    const [stored] = await database.select().from(messages).where(eq(messages.id, message.id));
    expect(stored!.replyToHeader).toEqual({ address: "dana@example.com", name: "Dana Ruiz" });
  });

  it("a plain email never read: the read finds none, {} is stored, the sender gets it", async () => {
    const { thread, message } = await lead({
      from: "dana@example.com",
      fromName: "Dana",
      replyToHeader: null,
    });
    setModelTransportForTests(fakeTransport([modelDraft()]).transport);
    const d = await draftOf(await createDraftForThread(thread.id, { trigger: "auto", ...deps() }));
    expect(d.toAddress).toBe("dana@example.com");
    const [stored] = await database.select().from(messages).where(eq(messages.id, message.id));
    expect(stored!.replyToHeader).toEqual({});
  });

  it("the message is gone from Gmail: {} — and a robot From is then never answered quietly", async () => {
    const { thread, message } = await lead({ from: "no-reply@crm.wix.com", replyToHeader: null });
    const gone = { getMessage: async () => null };
    const { transport, calls } = fakeTransport([modelDraft()]);
    setModelTransportForTests(transport);
    expect(
      await createDraftForThread(thread.id, {
        trigger: "auto",
        readerFor: () => gone,
        ...deps(),
      }),
    ).toEqual({ status: "skipped", reason: "no_reply_address" });
    expect(calls).toHaveLength(0);
    const [stored] = await database.select().from(messages).where(eq(messages.id, message.id));
    expect(stored!.replyToHeader).toEqual({});
  });

  it("Gmail busy on the owner's tap: no model call, no draft, a plain reason", async () => {
    const { thread } = await lead({ from: "no-reply@crm.wix.com", replyToHeader: null });
    writer.replyToError = new MailboxRateLimitError();
    const { transport, calls } = fakeTransport([modelDraft()]);
    setModelTransportForTests(transport);
    expect(
      await createDraftForThread(thread.id, { trigger: "owner", workspaceId, ...deps() }),
    ).toEqual({ status: "skipped", reason: "gmail_busy" });
    writer.replyToError = new Error("Gmail API 500.");
    expect(
      await createDraftForThread(thread.id, { trigger: "owner", workspaceId, ...deps() }),
    ).toEqual({ status: "skipped", reason: "reply_to_unread" });
    expect(calls).toHaveLength(0);
    expect(writer.calls).toEqual([]);
  });

  it("Gmail busy in a job: thrown, so the job pauses (politely) — never a guess at From", async () => {
    const { thread } = await lead({ from: "form@squarespace.info", replyToHeader: null });
    writer.replyToError = new MailboxRateLimitError();
    const { transport, calls } = fakeTransport([modelDraft()]);
    setModelTransportForTests(transport);
    await expect(
      createDraftForThread(thread.id, { trigger: "auto", ...deps() }),
    ).rejects.toBeInstanceOf(MailboxRateLimitError);
    writer.replyToError = new Error("boom");
    await expect(createDraftForThread(thread.id, { trigger: "auto", ...deps() })).rejects.toThrow();
    expect(calls).toHaveLength(0);
    expect(await database.select().from(drafts)).toHaveLength(0);
  });
});

describe("no-reply addresses", () => {
  it("an Angi-style lead (no-reply From, no Reply-To): jobs skip it before the model", async () => {
    const { thread } = await lead({
      from: "noreply@angi.com",
      fromName: "Angi",
      replyToHeader: {},
    });
    const { transport, calls } = fakeTransport([modelDraft()]);
    setModelTransportForTests(transport);
    expect(await createDraftForThread(thread.id, { trigger: "auto", ...deps() })).toEqual({
      status: "skipped",
      reason: "no_reply_address",
    });
    expect(calls).toHaveLength(0);
  });

  it("round 2 (A9): the owner's own tap doesn't draft to a robot either — nobody reads it", async () => {
    const { thread } = await lead({
      from: "noreply@angi.com",
      fromName: "Angi",
      replyToHeader: {},
    });
    const { transport, calls } = fakeTransport([modelDraft()]);
    setModelTransportForTests(transport);
    expect(
      await createDraftForThread(thread.id, { trigger: "owner", workspaceId, ...deps() }),
    ).toEqual({ status: "skipped", reason: "no_reply_address" });
    expect(calls).toHaveLength(0);
    expect(writer.calls).not.toContain("createDraft");
  });
});

describe("H7: who it goes to, on every screen that approves a send", () => {
  it("batch rows carry the address; the sent screen names the customer", async () => {
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, workspaceId));
    const { thread } = await lead({
      from: "no-reply@crm.wix.com",
      fromName: "Wix Forms",
      replyToHeader: { address: "dana@example.com", name: "Dana Ruiz" },
    });
    setModelTransportForTests(fakeTransport([modelDraft()]).transport);
    const d = await draftOf(await createDraftForThread(thread.id, { trigger: "auto", ...deps() }));
    const rows = await batchCandidates(workspaceId, ["quote_request"]);
    expect(rows).toEqual([
      expect.objectContaining({ draftId: d.id, to: "Dana Ruiz", toAddress: "dana@example.com" }),
    ]);
    const sent = await sendDraft(workspaceId, d.id, deps());
    expect(sent).toMatchObject({ status: "sent", toName: "Dana Ruiz" });
    expect(writer.sent[0]!.raw).toBeTruthy();
    expect(FakeWriter.headersOf(writer.sent[0]!.raw)).toContain("To: dana@example.com");
  });
});
