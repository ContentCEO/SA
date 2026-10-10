import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { UNDO_WINDOW_SECONDS } from "@/config/drafting";
import type { Database } from "@/db";
import { activityLog, drafts, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { batchEligible, firstLine, type BatchCandidate } from "@/server/batch-rules";
import {
  batchSend,
  deliverQueuedSend,
  listQueue,
  overdueQueuedSends,
  queueSend,
  reconcileDrafts,
  sendDraft,
  undoSend,
} from "@/server/drafts";
import { SendingBlockedError } from "@/server/lifecycle";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { sendRecord } from "@/server/send-record";
import { buildSendRecord } from "@/server/send-record-rules";
import { snoozeThread } from "@/server/snooze";
import { atLocalHour, snoozeOptions, snoozeUntil } from "@/server/snooze-rules";
import { createTestDb } from "../support/db";
import { FakeWriter } from "../support/fake-writer";

const NOW = new Date("2026-10-10T16:00:00Z"); // 12:00 noon in New York
const later = (s: number) => new Date(NOW.getTime() + s * 1000);
const READY_BODY = "Hi Dana,\nHappy to take a look. What's the address?\nThanks, Sam";

describe("plan M5 sending: undo (#7), batch (#5), snooze (#6)", () => {
  let database: Database;
  let workspaceId: string;
  let mailboxId: string;
  let writer: FakeWriter;
  const deps = (at: Date = NOW) => ({ writerFor: () => writer, now: () => at });
  let n = 0;

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    workspaceId = workspace.id;
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, workspaceId));
    mailboxId = (
      await saveConnectedMailbox(workspace, {
        email: "owner@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
    writer = new FakeWriter();
  });

  /** A thread with one inbound email and a pending draft that's also a Gmail draft. */
  async function seed(
    over: {
      category?: string;
      needsOwner?: boolean;
      priority?: string;
      extracted?: Record<string, unknown>;
      body?: string;
      flags?: string[];
      confidence?: number;
    } = {},
  ) {
    const g = `t${++n}`;
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: g,
        inInbox: true,
        subject: "Deck",
        category: (over.category ?? "quote_request") as "quote_request",
        needsOwner: over.needsOwner ?? false,
        priority: over.priority ?? "normal",
        extracted: over.extracted ?? {},
        classifiedAt: NOW,
        lastMessageAt: new Date(NOW.getTime() - n * 60_000),
      })
      .returning();
    const [m] = await database
      .insert(messages)
      .values({
        threadId: t!.id,
        mailboxId,
        gmailMessageId: `m-${g}`,
        rfc822MessageId: `<m-${g}@x.com>`,
        direction: "in",
        fromAddress: "dana@x.com",
        fromName: "Dana",
        subject: "Deck",
        bodyText: "Can you quote a deck repair?",
        sentAt: new Date(NOW.getTime() - 3600_000),
      })
      .returning();
    const body = over.body ?? READY_BODY;
    const gmail = await writer.createDraft({
      threadId: g,
      raw: Buffer.from(`To: dana@x.com\r\n\r\n${Buffer.from(body).toString("base64")}`).toString(
        "base64url",
      ),
    });
    const [d] = await database
      .insert(drafts)
      .values({
        threadId: t!.id,
        mailboxId,
        gmailDraftId: gmail.draftId,
        replyToMessageId: m!.id,
        toAddress: "dana@x.com",
        subject: "Re: Deck",
        body,
        originalBody: body,
        reason: "Asked for the address.",
        flags: over.flags ?? [],
        confidence: over.confidence ?? 92,
        createdAt: new Date(NOW.getTime() - 60_000),
      })
      .returning();
    writer.calls.length = 0;
    return { thread: t!, draft: d! };
  }
  const row = async (id: string) =>
    (await database.select().from(drafts).where(eq(drafts.id, id)))[0]!;

  describe("#7 undo send", () => {
    it("Send reply starts a window: nothing goes to Gmail, and the draft leaves the queue", async () => {
      const { draft } = await seed();
      const r = await queueSend(workspaceId, draft.id, deps());
      expect(r).toEqual({ status: "queued", sendAfter: later(UNDO_WINDOW_SECONDS) });
      expect(writer.calls).toEqual(["getDraft"]);
      expect(writer.sent).toEqual([]);
      expect((await listQueue(workspaceId, NOW)).drafts).toEqual([]);
      const [log] = await database
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "send_approved"));
      expect(log!.detail).toMatchObject({ draftId: draft.id, undoWindowSec: UNDO_WINDOW_SECONDS });
    });

    it("Undo puts it back unchanged, and the job then has nothing to send", async () => {
      const { draft } = await seed();
      await queueSend(workspaceId, draft.id, deps());
      expect(await undoSend(workspaceId, draft.id)).toBe(true);
      expect((await listQueue(workspaceId, NOW)).drafts.map((d) => d.draftId)).toEqual([draft.id]);
      expect(await deliverQueuedSend(draft.id, deps(later(30)))).toEqual({ status: "not_due" });
      expect(writer.sent).toEqual([]);
      expect((await row(draft.id)).status).toBe("pending");
    });

    it("sends once at the end of the window; a duplicate event can't send it twice", async () => {
      const { draft } = await seed();
      await queueSend(workspaceId, draft.id, deps());
      expect(await deliverQueuedSend(draft.id, deps(later(5)))).toEqual({ status: "not_due" });
      expect(await deliverQueuedSend(draft.id, deps(later(21)))).toEqual({ status: "sent" });
      expect(await deliverQueuedSend(draft.id, deps(later(22)))).toEqual({ status: "not_due" });
      expect(await deliverQueuedSend(draft.id, deps(later(400)))).toEqual({ status: "not_due" });
      expect(writer.sent).toHaveLength(1);
      expect((await row(draft.id)).status).toBe("sent");
      // Too late to undo once it's gone.
      expect(await undoSend(workspaceId, draft.id)).toBe(false);
    });

    it("tapping Send twice starts one window, and a direct send can't jump it", async () => {
      const { draft } = await seed();
      await queueSend(workspaceId, draft.id, deps());
      expect(await queueSend(workspaceId, draft.id, deps())).toEqual({ status: "already_sending" });
      expect(await sendDraft(workspaceId, draft.id, deps())).toEqual({
        status: "already_sending",
      });
      expect(writer.sent).toEqual([]);
    });

    it("the gate is checked again when the window ends: sending switched off → not sent", async () => {
      const { draft } = await seed();
      await queueSend(workspaceId, draft.id, deps());
      await database
        .update(workspaces)
        .set({ status: "past_due" })
        .where(eq(workspaces.id, workspaceId));
      writer.calls.length = 0;
      expect(await deliverQueuedSend(draft.id, deps(later(21)))).toEqual({
        status: "stopped",
        why: "blocked",
      });
      expect(writer.calls).toEqual([]);
      const after = await row(draft.id);
      expect(after.status).toBe("pending");
      expect(after.sendAfter).toBeNull();
    });

    it("a blocked account can't even start a window — and Gmail is never touched", async () => {
      const { draft } = await seed();
      await database
        .update(workspaces)
        .set({ status: "evaluating", evaluationEndsAt: later(86_400) })
        .where(eq(workspaces.id, workspaceId));
      await expect(queueSend(workspaceId, draft.id, deps())).rejects.toThrow(SendingBlockedError);
      expect(writer.calls).toEqual([]);
    });

    it("changed in Gmail during the window → the send stops and the owner sees the new text", async () => {
      const { draft } = await seed();
      await queueSend(workspaceId, draft.id, deps());
      writer.editInGmail(draft.gmailDraftId!, "Something else entirely.");
      await reconcileDrafts(mailboxId, deps(later(5)));
      const after = await row(draft.id);
      expect(after.sendAfter).toBeNull();
      expect(after.body).toBe("Something else entirely.");
      expect(await deliverQueuedSend(draft.id, deps(later(21)))).toEqual({ status: "not_due" });
      expect(writer.sent).toEqual([]);
    });

    it("the owner's filled-in text is what goes, and a lost event is picked up by the backstop", async () => {
      const { draft } = await seed({ body: "It's {{price}}." });
      expect(await queueSend(workspaceId, draft.id, deps())).toEqual({ status: "gaps_unfilled" });
      await queueSend(workspaceId, draft.id, { ...deps(), editedBody: "It's $450." });
      expect(await overdueQueuedSends(later(30))).toEqual([]);
      expect(await overdueQueuedSends(later(90))).toEqual([draft.id]);
      await deliverQueuedSend(draft.id, deps(later(90)));
      expect(FakeWriter.bodyOf(writer.sent[0]!.raw)).toBe("It's $450.");
    });
  });

  describe("#5 batch approve", () => {
    const base: BatchCandidate = {
      category: "quote_request",
      needsOwner: false,
      flags: [],
      confidencePct: 92,
      body: READY_BODY,
      amountsInEmail: [],
      untrusted: false,
      autopilotCounting: false,
    };
    const all = ["quote_request", "customer_question", "scheduling", "invoice_payment"];

    it("rules: only Ready, unflagged, gap-free drafts in picked categories", () => {
      expect(batchEligible(base, all)).toBe(true);
      expect(batchEligible(base, ["scheduling"])).toBe(false);
      expect(batchEligible({ ...base, category: "complaint" }, ["complaint"])).toBe(false);
      expect(batchEligible({ ...base, category: "noise" }, ["noise"])).toBe(false);
      expect(batchEligible({ ...base, needsOwner: true }, all)).toBe(false);
      expect(batchEligible({ ...base, flags: ["Check the date"] }, all)).toBe(false);
      expect(batchEligible({ ...base, body: "It's {{price}}." }, all)).toBe(false);
      expect(batchEligible({ ...base, confidencePct: 70 }, all)).toBe(false);
      expect(batchEligible({ ...base, untrusted: true }, all)).toBe(false);
      expect(batchEligible({ ...base, autopilotCounting: true }, all)).toBe(false);
      expect(
        batchEligible({ ...base, category: "invoice_payment", amountsInEmail: [1200] }, all),
      ).toBe(false);
      expect(batchEligible({ ...base, category: "invoice_payment" }, all)).toBe(true);
    });

    it("ineligible drafts are refused even when the browser sends their IDs", async () => {
      const ok = await seed();
      const complaint = await seed({ category: "complaint" });
      const flagged = await seed({ flags: ["Says Thursday"] });
      const needsYou = await seed({ needsOwner: true });
      const bill = await seed({
        category: "invoice_payment",
        extracted: { dollar_amounts: [900] },
      });
      const unsure = await seed({ confidence: 55 });
      const r = await batchSend(
        workspaceId,
        [ok, complaint, flagged, needsYou, bill, unsure].map((x) => x.draft.id),
        [...all, "complaint"],
        deps(),
      );
      expect(r.queued.map((q) => q.draftId)).toEqual([ok.draft.id]);
      expect(r.refused).toBe(5);
      for (const x of [complaint, flagged, needsYou, bill, unsure])
        expect((await row(x.draft.id)).sendAfter).toBeNull();
    });

    it("each batch send has its own window and its own log entry; blocked accounts send none", async () => {
      const a = await seed();
      const b = await seed();
      const r = await batchSend(workspaceId, [a.draft.id, b.draft.id], all, deps());
      expect(r.queued).toHaveLength(2);
      const logs = await database
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "send_approved"));
      expect(logs).toHaveLength(2);

      const c = await seed();
      await database
        .update(workspaces)
        .set({ status: "canceled" })
        .where(eq(workspaces.id, workspaceId));
      await expect(batchSend(workspaceId, [c.draft.id], all, deps())).rejects.toThrow(
        SendingBlockedError,
      );
      expect(writer.calls).toEqual([]);
    });

    it("the review list shows the greeting-free first line", () => {
      expect(firstLine(READY_BODY)).toBe("Happy to take a look. What's the address?");
    });
  });

  describe("#6 snooze", () => {
    const NY = "America/New_York";

    it("times are in the owner's zone, across DST", () => {
      expect(atLocalHour(NOW, NY, 0, 18).toISOString()).toBe("2026-10-10T22:00:00.000Z");
      expect(atLocalHour(NOW, NY, 1, 7).toISOString()).toBe("2026-10-11T11:00:00.000Z");
      // 2026-11-01: clocks go back; 7am the next morning is EST.
      const halloween = new Date("2026-10-31T16:00:00Z");
      expect(atLocalHour(halloween, NY, 1, 7).toISOString()).toBe("2026-11-01T12:00:00.000Z");
    });

    it("emergencies can't be put off past tonight; Tonight disappears after 6pm", () => {
      expect(snoozeOptions(NOW, NY, false).map((o) => o.choice)).toEqual([
        "tonight",
        "tomorrow",
        "after_job",
      ]);
      expect(snoozeOptions(NOW, NY, true).map((o) => o.choice)).toEqual(["tonight", "after_job"]);
      expect(snoozeUntil("tomorrow", NOW, NY, true)).toBeNull();
      const evening = new Date("2026-10-10T23:30:00Z"); // 7:30pm
      expect(snoozeOptions(evening, NY, false).map((o) => o.choice)).toEqual([
        "tomorrow",
        "after_job",
      ]);
      // 10pm: three hours would be past midnight, so an emergency has nothing to pick.
      expect(snoozeOptions(new Date("2026-10-11T02:00:00Z"), NY, true)).toEqual([]);
    });

    it("snoozed items leave the queue and come back on top", async () => {
      const first = await seed();
      const second = await seed();
      expect((await listQueue(workspaceId, NOW)).drafts.map((d) => d.draftId)).toEqual([
        first.draft.id,
        second.draft.id,
      ]);
      const r = await snoozeThread(workspaceId, second.thread.id, "after_job", NOW);
      expect(r.status).toBe("snoozed");
      expect((await listQueue(workspaceId, later(60))).drafts.map((d) => d.draftId)).toEqual([
        first.draft.id,
      ]);
      const back = (await listQueue(workspaceId, later(3 * 3600 + 1))).drafts;
      expect(back.map((d) => d.draftId)).toEqual([second.draft.id, first.draft.id]);
      expect(back[0]!.backFromSnooze).toBe(true);
    });

    it("the server refuses to snooze an emergency until tomorrow", async () => {
      const { thread } = await seed({ needsOwner: true, priority: "high" });
      expect(await snoozeThread(workspaceId, thread.id, "tomorrow", NOW)).toEqual({
        status: "not_allowed",
      });
      expect(await snoozeThread(workspaceId, thread.id, "tonight", NOW)).toMatchObject({
        status: "snoozed",
      });
    });
  });

  describe("#41 proof-of-okay record", () => {
    it("says you okayed it, from which device, what changed, the undo window and the Gmail id", async () => {
      const { draft } = await seed();
      await database.insert(activityLog).values({
        workspaceId,
        actor: "owner",
        action: "draft_revised",
        threadId: draft.threadId,
        detail: { draftId: draft.id, via: "shorter" },
      });
      await queueSend(workspaceId, draft.id, {
        ...deps(),
        device: "phone",
        editedBody: "Hi Dana — address?",
      });
      await deliverQueuedSend(draft.id, deps(later(21)));
      const r = await sendRecord(workspaceId, draft.id);
      expect(r).toMatchObject({
        approvedBy: "you",
        device: "phone",
        edited: true,
        changes: ["Shorter"],
        undoWindowSec: UNDO_WINDOW_SECONDS,
        holdWindowMin: null,
      });
      expect(r!.gmailMessageId).toMatch(/^sent-/);
      // Another workspace can't read it; an unsent draft has no record.
      const other = await ensureUserAndWorkspace({ email: "other@shop.com" });
      expect(await sendRecord(other.workspace.id, draft.id)).toBeNull();
      const unsent = await seed();
      expect(await sendRecord(workspaceId, unsent.draft.id)).toBeNull();
    });

    it("an autopilot send is never shown as yours", () => {
      const at = NOW;
      const r = buildSendRecord(
        { status: "sent", createdAt: at, decidedAt: at, sentGmailMessageId: "g1" },
        [
          { action: "autopilot_scheduled", actor: "squared_away", detail: {}, at },
          {
            action: "reply_sent",
            actor: "squared_away",
            detail: { autopilot: true, draftId: "d" },
            at,
          },
        ],
        10,
      );
      expect(r.approvedBy).toBe("autopilot");
      expect(r.holdWindowMin).toBe(10);
      expect(r.device).toBeNull();
    });
  });
});
