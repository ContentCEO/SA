import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { ModelDraft } from "@/ai/prompts/draft.v5";
import type { Database } from "@/db";
import {
  activityLog,
  drafts,
  messages,
  threads,
  usage,
  voiceProfiles,
  workspaces,
} from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  createDraftForThread,
  discardDraft,
  listQueue,
  reconcileDrafts,
  saveDraftEdit,
  sendDraft,
  threadsToAutoDraft,
} from "@/server/drafts";
import { SendingBlockedError } from "@/server/lifecycle";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { businessProfileInput, saveBusinessProfile } from "@/server/profile";
import { purgeExpiredBodies } from "@/server/sync";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const NOW = new Date("2026-09-28T12:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const modelDraft = (over: Partial<ModelDraft> = {}): ModelDraft => ({
  body: "Hey Dana,\n\nHappy to take a look. What's the address, and is the panel inside or in the garage?\n\nThanks, Davi",
  reason: "Quote request, panel upgrade. Asked for the address and panel location.",
  flags: [],
  confidence: 0.9,
  used_facts: [],
  ...over,
});

let database: Database;
let workspaceId: string;
let mailboxId: string;
let writer: FakeWriter;
const deps = () => ({ writerFor: () => writer, now: () => NOW });

async function setStatus(status: (typeof workspaces.$inferSelect)["status"]) {
  // Paid statuses come with a real (Stripe) setup payment, as in production.
  const paid = status === "setup_paid" || status === "active";
  await database
    .update(workspaces)
    .set({ status, setupPaidVia: paid ? "stripe" : null })
    .where(eq(workspaces.id, workspaceId));
}

async function seedThread(
  opts: { category?: string; needsOwner?: boolean; lastDirection?: "in" | "out"; g?: string } = {},
) {
  const g = opts.g ?? "gt1";
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: g,
      inInbox: true,
      subject: "Panel upgrade",
      category: opts.category ?? "quote_request",
      needsOwner: opts.needsOwner ?? false,
      summary: "Dana wants a panel upgrade quote.",
      classifiedAt: NOW,
      lastMessageAt: ago(1),
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `${g}-m1`,
    rfc822MessageId: `<${g}-m1@mail.x.com>`,
    references: `<${g}-m0@mail.x.com>`,
    direction: "in",
    fromAddress: "dana@x.com",
    fromName: "Dana Ruiz",
    subject: "Panel upgrade",
    bodyText: "Hi, can you quote a 200 amp panel upgrade? SECRET-CUSTOMER-BODY",
    sentAt: ago(2),
  });
  if (opts.lastDirection === "out") {
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${g}-m2`,
      direction: "out",
      fromAddress: "owner@shop.com",
      subject: "Re: Panel upgrade",
      bodyText: "on it",
      sentAt: ago(1),
    });
  }
  return t!;
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

describe("writing drafts", () => {
  it("creates a real Gmail draft in the right thread, threaded to the customer's message", async () => {
    await saveBusinessProfile(
      workspaceId,
      businessProfileInput.parse({
        businessName: "Elm Electric",
        trade: "electrical",
        services: "Panels",
        serviceArea: "",
        hours: "",
        leadTime: "",
        pricingNotes: "$95 service call",
        paymentTerms: "",
        policies: "",
        signature: "Davi\nElm Electric",
        doNotPromise: "Same-day service",
        vipSenders: "",
        amountThresholdDollars: "2500",
      }),
    );
    await database.insert(voiceProfiles).values({
      workspaceId,
      status: "ready",
      greetingStyle: "Hey",
      signoffStyle: "Thanks, Davi",
      phrasesAvoided: ["kindly"],
    });
    const t = await seedThread();
    const { transport, calls } = fakeTransport([modelDraft()]);
    setModelTransportForTests(transport);

    const r = await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    expect(r.status).toBe("created");

    // Prompt: Sonnet, cached workspace block carries profile + voice, conversation fenced as data.
    expect(calls[0]!.model).toBe("claude-sonnet-5");
    expect(calls[0]!.system[1]).toMatchObject({ cache: true });
    expect(calls[0]!.system[1]!.text).toContain('"Same-day service"');
    expect(calls[0]!.system[1]!.text).toContain("Usual greeting: Hey");
    expect(calls[0]!.user).toContain("<conversation>");

    // Gmail: one draft, right thread, right headers.
    const [stored] = [...writer.drafts.values()];
    expect(stored!.threadId).toBe("gt1");
    const headers = FakeWriter.headersOf(stored!.raw);
    expect(headers).toContain("To: dana@x.com");
    expect(headers).toContain("Subject: Re: Panel upgrade");
    expect(headers).toContain("In-Reply-To: <gt1-m1@mail.x.com>");
    expect(headers).toContain("References: <gt1-m0@mail.x.com> <gt1-m1@mail.x.com>");

    const [d] = await database.select().from(drafts);
    expect(d).toMatchObject({
      status: "pending",
      gmailDraftId: "d1",
      confidence: 90,
      promptVersion: "draft.v5",
    });
    const [u] = await database.select().from(usage);
    expect(u!.draftsCreated).toBe(1);
    const logs = JSON.stringify(await database.select().from(activityLog));
    expect(logs).not.toContain("SECRET-CUSTOMER-BODY");
  });

  it("never auto-drafts noise, complaints, or anything that needs the owner", async () => {
    const { transport, calls } = fakeTransport([modelDraft(), modelDraft(), modelDraft()]);
    setModelTransportForTests(transport);
    const noise = await seedThread({ category: "noise", g: "a" });
    const complaint = await seedThread({ category: "complaint", needsOwner: true, g: "b" });
    const flagged = await seedThread({ category: "quote_request", needsOwner: true, g: "c" });
    expect(await createDraftForThread(noise.id, { trigger: "auto", ...deps() })).toEqual({
      status: "skipped",
      reason: "noise",
    });
    expect(await createDraftForThread(complaint.id, { trigger: "auto", ...deps() })).toMatchObject({
      status: "skipped",
    });
    expect(await createDraftForThread(flagged.id, { trigger: "auto", ...deps() })).toEqual({
      status: "skipped",
      reason: "needs_owner",
    });
    expect(calls).toHaveLength(0);
    expect(writer.calls).toHaveLength(0);
  });

  it("lets the owner ask for a draft on a flagged thread — but only their own", async () => {
    setModelTransportForTests(fakeTransport([modelDraft()]).transport);
    const t = await seedThread({ category: "complaint", needsOwner: true });
    const other = await ensureUserAndWorkspace({ email: "someone@else.com" });
    expect(
      await createDraftForThread(t.id, {
        trigger: "owner",
        workspaceId: other.workspace.id,
        ...deps(),
      }),
    ).toEqual({
      status: "skipped",
      reason: "not_found",
    });
    expect(
      await createDraftForThread(t.id, { trigger: "owner", workspaceId, ...deps() }),
    ).toMatchObject({ status: "created" });
  });

  it("doesn't draft twice, or after the owner already replied", async () => {
    setModelTransportForTests(fakeTransport([modelDraft(), modelDraft()]).transport);
    const t = await seedThread();
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    expect(await createDraftForThread(t.id, { trigger: "auto", ...deps() })).toEqual({
      status: "skipped",
      reason: "already_pending",
    });
    const replied = await seedThread({ g: "r", lastDirection: "out" });
    expect(await createDraftForThread(replied.id, { trigger: "auto", ...deps() })).toEqual({
      status: "skipped",
      reason: "owner_replied_last",
    });
    expect(writer.drafts.size).toBe(1);
  });

  it("flags a made-up price and drops confidence", async () => {
    setModelTransportForTests(
      fakeTransport([modelDraft({ body: "Hey Dana, that'll run about $1,800. Thanks, Davi" })])
        .transport,
    );
    const t = await seedThread();
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    const [d] = await database.select().from(drafts);
    expect(d!.flags.join(" ")).toContain("$1,800");
    expect(d!.confidence).toBeLessThanOrEqual(30);
  });
});

describe("sending — the gate", () => {
  async function pendingDraft() {
    setModelTransportForTests(fakeTransport([modelDraft()]).transport);
    const t = await seedThread();
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    const [d] = await database.select().from(drafts);
    writer.calls = [];
    return d!;
  }

  it.each([
    "invited",
    "evaluating",
    "evaluation_expired",
    "past_due",
    "canceled",
    "paused",
  ] as const)(
    "refuses to send while the workspace is %s, without touching Gmail",
    async (status) => {
      const d = await pendingDraft();
      await setStatus(status);
      await expect(sendDraft(workspaceId, d.id, deps())).rejects.toBeInstanceOf(
        SendingBlockedError,
      );
      expect(writer.calls).toEqual([]);
      expect(writer.sent).toHaveLength(0);
      const [after] = await database.select().from(drafts);
      expect(after!.status).toBe("pending");
    },
  );

  it.each(["setup_paid", "active"] as const)("sends once the workspace is %s", async (status) => {
    const d = await pendingDraft();
    await setStatus(status);
    const r = await sendDraft(workspaceId, d.id, deps());
    expect(r).toMatchObject({ status: "sent", edited: false, toName: "Dana Ruiz" });
    expect(writer.sent).toHaveLength(1);
    const [after] = await database.select().from(drafts);
    expect(after).toMatchObject({ status: "sent", sentGmailMessageId: "sent-d1" });
    const [log] = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "reply_sent"));
    expect(log!.detail).toMatchObject({ editedByOwner: false });
    const [thread] = await database.select().from(threads);
    expect(thread!.awaitingReplySince).toEqual(NOW);
  });

  it("an active account without a real setup payment can't send, and Gmail is never touched", async () => {
    const d = await pendingDraft();
    for (const status of ["setup_paid", "active"] as const) {
      await database
        .update(workspaces)
        .set({ status, setupPaidVia: null, setupPaidAt: NOW }) // e.g. marked paid by hand
        .where(eq(workspaces.id, workspaceId));
      await expect(sendDraft(workspaceId, d.id, deps())).rejects.toBeInstanceOf(
        SendingBlockedError,
      );
    }
    expect(writer.calls).toEqual([]);
  });

  it("records edited-and-sent and updates the Gmail draft before sending", async () => {
    const d = await pendingDraft();
    await setStatus("active");
    const r = await sendDraft(workspaceId, d.id, {
      ...deps(),
      editedBody: "Hey Dana — send me a photo of the panel. Davi",
    });
    expect(r).toMatchObject({ status: "sent", edited: true });
    expect(writer.calls).toEqual(["getDraft", "updateDraft", "sendDraft"]);
    expect(FakeWriter.bodyOf(writer.sent[0]!.raw)).toBe(
      "Hey Dana — send me a photo of the panel. Davi",
    );
    const [after] = await database.select().from(drafts);
    expect(after!.status).toBe("edited_and_sent");
    const [log] = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "reply_sent"));
    expect(log!.detail).toMatchObject({ editedByOwner: true });
    expect(JSON.stringify(log!.detail)).not.toContain("photo");
  });

  it("won't send blind if the draft was changed in Gmail — shows the new text instead", async () => {
    const d = await pendingDraft();
    await setStatus("active");
    writer.editInGmail(d.gmailDraftId!, "Owner rewrote this in Gmail.");
    expect(await sendDraft(workspaceId, d.id, deps())).toEqual({ status: "changed_in_gmail" });
    expect(writer.sent).toHaveLength(0);
    const [after] = await database.select().from(drafts);
    expect(after).toMatchObject({ status: "pending", body: "Owner rewrote this in Gmail." });
    // Second tap, now that they've seen it, sends their version.
    expect(await sendDraft(workspaceId, d.id, deps())).toMatchObject({
      status: "sent",
      edited: true,
    });
  });

  it("handles a draft deleted in Gmail", async () => {
    const d = await pendingDraft();
    await setStatus("active");
    writer.drafts.clear();
    expect(await sendDraft(workspaceId, d.id, deps())).toEqual({ status: "deleted_in_gmail" });
    const [after] = await database.select().from(drafts);
    expect(after!.status).toBe("discarded");
  });

  it("won't let another workspace send, edit or discard it", async () => {
    const d = await pendingDraft();
    await setStatus("active");
    const other = await ensureUserAndWorkspace({ email: "someone@else.com" });
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, other.workspace.id));
    expect(await sendDraft(other.workspace.id, d.id, deps())).toEqual({ status: "not_found" });
    expect(await saveDraftEdit(other.workspace.id, d.id, "x", deps())).toBe("not_found");
    expect(await discardDraft(other.workspace.id, d.id, deps())).toBe("not_found");
    expect(writer.calls).toEqual([]);
  });

  it("discard removes it from Gmail too", async () => {
    const d = await pendingDraft();
    expect(await discardDraft(workspaceId, d.id, deps())).toBe("discarded");
    expect(writer.drafts.size).toBe(0);
    expect((await listQueue(workspaceId)).drafts).toHaveLength(0);
  });

  it("saving an edit updates Gmail without sending", async () => {
    const d = await pendingDraft();
    expect(await saveDraftEdit(workspaceId, d.id, "New text", deps())).toBe("saved");
    expect(FakeWriter.bodyOf(writer.drafts.get(d.gmailDraftId!)!.raw)).toBe("New text");
    expect(writer.sent).toHaveLength(0);
  });
});

describe("reconciling with Gmail", () => {
  async function draftOn(g: string) {
    setModelTransportForTests(fakeTransport([modelDraft()]).transport);
    const t = await seedThread({ g });
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    const [d] = await database.select().from(drafts).where(eq(drafts.threadId, t.id));
    return { t, d: d! };
  }

  it("notices drafts deleted, sent, edited in Gmail, or outdated by a new customer email", async () => {
    const deleted = await draftOn("a");
    const sentInGmail = await draftOn("b");
    const edited = await draftOn("c");
    const outdated = await draftOn("d");
    const later = new Date(NOW.getTime() + 3600_000);

    writer.drafts.delete(deleted.d.gmailDraftId!);
    writer.drafts.delete(sentInGmail.d.gmailDraftId!);
    await database.insert(messages).values({
      threadId: sentInGmail.t.id,
      mailboxId,
      gmailMessageId: "b-out",
      direction: "out",
      sentAt: later,
    });
    writer.editInGmail(edited.d.gmailDraftId!, "Edited in Gmail");
    await database.insert(messages).values({
      threadId: outdated.t.id,
      mailboxId,
      gmailMessageId: "d-in",
      direction: "in",
      fromAddress: "dana@x.com",
      bodyText: "Actually, also the garage",
      sentAt: later,
    });

    const r = await reconcileDrafts(mailboxId, deps());
    expect(r.closed).toBe(3);
    expect(r.expiredThreads).toEqual([outdated.t.id]);
    const byThread = Object.fromEntries(
      (await database.select().from(drafts)).map((d) => [d.threadId, d]),
    );
    expect(byThread[deleted.t.id]!.status).toBe("discarded");
    expect(byThread[sentInGmail.t.id]!.status).toBe("sent");
    expect(byThread[edited.t.id]).toMatchObject({ status: "pending", body: "Edited in Gmail" });
    expect(byThread[outdated.t.id]!.status).toBe("expired");
    expect(writer.drafts.has(outdated.d.gmailDraftId!)).toBe(false);
  });
});

describe("what gets auto-drafted", () => {
  it("picks classified, draftable threads once per customer message", async () => {
    const t = await seedThread();
    await seedThread({ g: "noise", category: "noise" });
    expect(await threadsToAutoDraft(mailboxId)).toEqual([t.id]);
    setModelTransportForTests(fakeTransport([modelDraft()]).transport);
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    expect(await threadsToAutoDraft(mailboxId)).toEqual([]);

    // Customer writes again and it's re-classified → eligible again.
    const later = new Date(NOW.getTime() + 3600_000);
    await database.insert(messages).values({
      threadId: t.id,
      mailboxId,
      gmailMessageId: "again",
      direction: "in",
      sentAt: later,
      bodyText: "one more thing",
    });
    expect(await threadsToAutoDraft(mailboxId)).toEqual([]); // not classified since
    await database
      .update(threads)
      .set({ classifiedAt: new Date(later.getTime() + 1000) })
      .where(eq(threads.id, t.id));
    expect(await threadsToAutoDraft(mailboxId)).toEqual([t.id]);
  });
});

describe("emails that tried to instruct the assistant, and building departments", () => {
  it("are never drafted by a job — only when the owner taps Draft a reply", async () => {
    const tricky = await seedThread({ g: "inj", category: "quote_request", needsOwner: false });
    await database
      .update(threads)
      .set({ extracted: { injection: true } })
      .where(eq(threads.id, tricky.id));
    const town = await seedThread({ g: "town", category: "scheduling" });
    await database
      .update(threads)
      .set({ extracted: { municipal: true } })
      .where(eq(threads.id, town.id));

    const { transport, calls } = fakeTransport([modelDraft()]);
    setModelTransportForTests(transport);
    for (const trigger of ["auto", "followup"] as const) {
      expect(await createDraftForThread(tricky.id, { trigger, ...deps() })).toMatchObject({
        status: "skipped",
        reason: "untrusted",
      });
      expect(await createDraftForThread(town.id, { trigger, ...deps() })).toMatchObject({
        status: "skipped",
        reason: "municipal",
      });
    }
    expect(calls).toHaveLength(0); // the model never saw them
    expect(writer.drafts.size).toBe(0);

    expect(
      await createDraftForThread(town.id, { trigger: "owner", workspaceId, ...deps() }),
    ).toMatchObject({ status: "created" });
  });
});

describe("retention", () => {
  it("purges draft text and expires stale pending drafts", async () => {
    setModelTransportForTests(fakeTransport([modelDraft()]).transport);
    const t = await seedThread();
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    vi.useRealTimers();
    await purgeExpiredBodies(new Date(NOW.getTime() + 31 * 86_400_000), 30);
    const [d] = await database.select().from(drafts);
    expect(d).toMatchObject({ status: "expired", body: null, originalBody: null });
  });
});
