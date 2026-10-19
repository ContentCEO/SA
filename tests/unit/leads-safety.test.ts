import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { ModelDraft } from "@/ai/prompts/draft.v5";
import type { Database } from "@/db";
import { drafts, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { guardrailReasons } from "@/server/autopilot";
import { classifyPending } from "@/server/classification";
import { listCustomers } from "@/server/customers";
import {
  createDraftForThread,
  MAYBE_TEXT_FLAG,
  queueSend,
  reconcileDrafts,
  sendDraft,
} from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import type { ReplyToHeader } from "@/server/reply-address-rules";
import { createTestDb } from "../support/db";
import { classification, fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

/**
 * Leads package: nothing is ever drafted or sent to an email-to-text gateway (it would text
 * the customer), a lead website's robot, or a voicemail email — refused in code at every
 * trigger, at the tap, in the queued send, in reconcile and in autopilot, with no Gmail and no
 * model call where refused.
 */
const NOW = new Date("2026-10-16T15:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const modelDraft = (over: Partial<ModelDraft> = {}): ModelDraft => ({
  body: "Hi Dana,\n\nHappy to take a look. What's the address?\n\nThanks, Mike",
  reason: "Quote request.",
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
  replyToHeader?: ReplyToHeader | null;
  category?: string;
  leadChannel?: string | null;
  labelIds?: string[];
  classified?: boolean;
}) {
  const g = `g${++n}`;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: g,
      inInbox: true,
      subject: "New lead",
      category: opts.classified === false ? null : (opts.category ?? "quote_request"),
      summary: "Dana wants a faucet replaced.",
      classifiedAt: opts.classified === false ? null : NOW,
      lastMessageAt: ago(1),
      leadChannel: opts.leadChannel ?? null,
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `${g}-m1`,
    rfc822MessageId: `<${g}-m1@x.test>`,
    direction: "in",
    fromAddress: opts.from,
    fromName: "Dana",
    replyToHeader: opts.replyToHeader === undefined ? {} : opts.replyToHeader,
    subject: "New lead",
    bodyText: "Can you replace a kitchen faucet? Call me at 978-201-9763.",
    labelIds: opts.labelIds ?? ["INBOX"],
    sentAt: ago(2),
  });
  return t!;
}

async function pendingDraft(threadId: string, to: string) {
  const { draftId } = await writer.createDraft({ threadId: "x", raw: "" });
  const [d] = await database
    .insert(drafts)
    .values({
      threadId,
      mailboxId,
      kind: "reply",
      gmailDraftId: draftId,
      toAddress: to,
      subject: "Re: New lead",
      body: "Hi",
      originalBody: "Hi",
      reason: "r",
      flags: [],
      confidence: 95,
      promptVersion: "draft.v6",
      createdAt: ago(1),
    })
    .returning();
  return d!;
}

const canSend = () =>
  database
    .update(workspaces)
    .set({ status: "active", setupPaidVia: "stripe", plan: "crew" })
    .where(eq(workspaces.id, workspaceId));

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

describe("email-to-text gateways", () => {
  it.each(["auto", "owner"] as const)(
    "a form whose Reply-To is a carrier gateway is never drafted (%s)",
    async (trigger) => {
      const t = await lead({
        from: "form-submission@forms.example",
        replyToHeader: { address: "9782019763@vtext.com" },
      });
      const { transport, calls } = fakeTransport([modelDraft()]);
      setModelTransportForTests(transport);
      const r = await createDraftForThread(t.id, { trigger, workspaceId, ...deps() });
      expect(r).toEqual({ status: "skipped", reason: "text_address" });
      expect(calls).toHaveLength(0);
      expect(writer.calls).toEqual([]);
    },
  );

  it("a nudge to a gateway customer is never drafted", async () => {
    const t = await lead({ from: "9782019763@vtext.com" });
    await database.insert(messages).values({
      threadId: t.id,
      mailboxId,
      gmailMessageId: "out-1",
      rfc822MessageId: "<out-1@x.test>",
      direction: "out",
      fromAddress: "mike@ruizplumbing.com",
      toAddresses: ["9782019763@vtext.com"],
      labelIds: ["SENT"],
      bodyText: "It's $450 for the faucet.",
      sentAt: ago(1.5),
    });
    const { transport, calls } = fakeTransport([modelDraft()]);
    setModelTransportForTests(transport);
    expect(await createDraftForThread(t.id, { trigger: "followup", ...deps() })).toEqual({
      status: "skipped",
      reason: "text_address",
    });
    expect(calls).toHaveLength(0);
  });

  it("a phone-number address: jobs skip it, the owner's tap drafts it flagged", async () => {
    const t = await lead({ from: "9782019763@mms.carrier.example" });
    setModelTransportForTests(fakeTransport([]).transport);
    expect(await createDraftForThread(t.id, { trigger: "auto", ...deps() })).toEqual({
      status: "skipped",
      reason: "maybe_text_address",
    });
    setModelTransportForTests(fakeTransport([modelDraft()]).transport);
    const r = await createDraftForThread(t.id, { trigger: "owner", workspaceId, ...deps() });
    expect(r.status).toBe("created");
    const [d] = await database.select().from(drafts).where(eq(drafts.threadId, t.id));
    expect(d!.flags[0]).toBe(MAYBE_TEXT_FLAG);
  });

  it("a phone-number address the owner has written to before is allowed", async () => {
    const t = await lead({ from: "9782019763@mms.carrier.example" });
    await database.insert(messages).values({
      threadId: t.id,
      mailboxId,
      gmailMessageId: "old-out",
      direction: "out",
      fromAddress: "mike@ruizplumbing.com",
      toAddresses: ["9782019763@mms.carrier.example"],
      labelIds: ["SENT"],
      bodyText: "See you Tuesday",
      sentAt: ago(24 * 20),
    });
    setModelTransportForTests(fakeTransport([modelDraft()]).transport);
    expect((await createDraftForThread(t.id, { trigger: "auto", ...deps() })).status).toBe(
      "created",
    );
  });

  it("a draft to a gateway is refused at the tap, in the queued send and by reconcile", async () => {
    await canSend();
    const t = await lead({ from: "dana@example.com" });
    const d = await pendingDraft(t.id, "9782019763@vtext.com");
    expect(await queueSend(workspaceId, d.id, deps())).toEqual({ status: "text_address" });
    expect(writer.calls).toEqual(["createDraft"]);
    expect(await sendDraft(workspaceId, d.id, deps())).toEqual({ status: "text_address" });
    expect(writer.calls).toEqual(["createDraft"]);
    expect(writer.sent).toHaveLength(0);
    const [closed] = await database.select().from(drafts).where(eq(drafts.id, d.id));
    expect(closed!.status).toBe("discarded");

    const d2 = await pendingDraft(t.id, "5551234567@tmomail.net");
    await reconcileDrafts(mailboxId, deps());
    const [gone] = await database.select().from(drafts).where(eq(drafts.id, d2.id));
    expect(gone!.status).toBe("expired");
    expect(writer.drafts.has(d2.gmailDraftId!)).toBe(false);
  });

  it("reconcile expires an old draft to a lead website's robot", async () => {
    const t = await lead({ from: "dana@example.com" });
    const d = await pendingDraft(t.id, "leads@thumbtack.com");
    await reconcileDrafts(mailboxId, deps());
    const [gone] = await database.select().from(drafts).where(eq(drafts.id, d.id));
    expect(gone!.status).toBe("expired");
  });

  it("autopilot refuses a lead-channel thread and a gateway address", () => {
    const reasons = guardrailReasons({
      category: "scheduling",
      needsOwner: false,
      kind: "reply",
      confidencePct: 95,
      flags: [],
      amountsInEmail: [],
      purpose: null,
      draftBody: "Tuesday works.",
      knownCustomer: true,
      leadChannel: true,
      textAddress: true,
    });
    expect(reasons).toEqual([
      "Lead-site and voicemail emails always wait for you.",
      "That address may turn into a text message, so it waits for you.",
    ]);
  });
});

describe("lead websites and voicemail emails are answered off email", () => {
  it.each([
    ["thumbtack", "lead_site"],
    ["google_voice", "phone_message"],
    ["phone_text", "phone_message"],
  ])("%s → %s for every trigger, before any Gmail read", async (channel, reason) => {
    const t = await lead({
      from: "someone@example.com",
      leadChannel: channel,
      replyToHeader: null,
    });
    const { transport, calls } = fakeTransport([modelDraft()]);
    setModelTransportForTests(transport);
    for (const trigger of ["auto", "owner"] as const) {
      expect(await createDraftForThread(t.id, { trigger, workspaceId, ...deps() })).toEqual({
        status: "skipped",
        reason,
      });
    }
    expect(calls).toHaveLength(0);
    expect(writer.replyToReads).toEqual([]);
    expect(writer.calls).toEqual([]);
  });

  it("a thread sorted before lead channels existed is caught by its address", async () => {
    const t = await lead({ from: "dana.r@messages.thumbtack.com" });
    setModelTransportForTests(fakeTransport([modelDraft()]).transport);
    expect(await createDraftForThread(t.id, { trigger: "owner", workspaceId, ...deps() })).toEqual({
      status: "skipped",
      reason: "lead_site",
    });
  });
});

describe("classification stores where a lead came from", () => {
  it("a voicemail in Promotions is still read; a site's marketing there stays junk", async () => {
    const vm = await lead({
      from: "voice-noreply@google.com",
      classified: false,
      labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
    });
    const site = await lead({
      from: "no-reply@thumbtack.com",
      classified: false,
      labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
    });
    // Its own marketing, not a lead (a site's lead in Promotions is read since Check 22 P1).
    await database
      .update(messages)
      .set({ subject: "Upgrade your plan today", bodyText: "Get more jobs with Pro." })
      .where(eq(messages.threadId, site.id));
    const { transport, calls } = fakeTransport([
      classification({ category: "quote_request", needs_owner_reason: "Dana at 12 Elm" }),
    ]);
    setModelTransportForTests(transport);
    await classifyPending(mailboxId, { now: NOW });
    expect(calls).toHaveLength(1);
    const [v] = await database.select().from(threads).where(eq(threads.id, vm.id));
    expect(v!.leadChannel).toBe("google_voice");
    expect(v!.needsOwner).toBe(true);
    expect(v!.needsOwnerReason).toBe("Voicemail. Call them back.");
    expect((v!.extracted as { owner_rule_hits?: string[] }).owner_rule_hits).toContain("phone");
    const [s] = await database.select().from(threads).where(eq(threads.id, site.id));
    expect(s!.category).toBe("noise");
    expect(s!.leadChannel).toBe("thumbtack");
  });

  it("a lead site's quote request needs the owner with our fixed words", async () => {
    const t = await lead({ from: "no-reply@thumbtack.com", classified: false });
    setModelTransportForTests(
      fakeTransport([
        classification({
          category: "quote_request",
          needs_owner: true,
          needs_owner_reason: "Dana Ruiz in Lowell wants a faucet",
        }),
      ]).transport,
    );
    await classifyPending(mailboxId, { now: NOW });
    const [r] = await database.select().from(threads).where(eq(threads.id, t.id));
    expect(r!.needsOwnerReason).toBe("Came through Thumbtack. Answer them there.");
    expect((r!.extracted as { owner_rule_hits?: string[] }).owner_rule_hits).toEqual([
      "site",
      "model",
    ]);
  });

  it("Customers leaves out lead-site and voicemail senders", async () => {
    await lead({ from: "voice-noreply@google.com", leadChannel: "google_voice" });
    await lead({ from: "leads@houzz.com", leadChannel: "houzz" });
    await lead({ from: "dana@example.com" });
    const list = await listCustomers(workspaceId, NOW);
    expect(list.map((c) => c.address)).toEqual(["dana@example.com"]);
  });
});
