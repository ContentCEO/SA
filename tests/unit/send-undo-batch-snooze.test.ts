import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { UNDO_WINDOW_SECONDS } from "@/config/drafting";
import type { Database } from "@/db";
import { activityLog, drafts, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { batchEligible, firstLine, type BatchCandidate } from "@/server/batch-rules";
import { namesAVisitTime } from "@/ai/draft-checks";
import {
  batchCandidates,
  batchReview,
  batchSend,
  bodyHash,
  deliverQueuedSend,
  listQueue,
  overdueQueuedSends,
  queueSend,
  reconcileDrafts,
  sendDraft,
  undoSend,
} from "@/server/drafts";
import { markNeedsOwner } from "@/server/classification";
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
      purpose?: "deposit" | "review_request" | "closing_question";
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
        purpose: over.purpose ?? null,
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
      acceptsQuote: false,
      purpose: null,
      visitTime: false,
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
      // A quote acceptance is a commitment: always one at a time, as with autopilot.
      expect(batchEligible({ ...base, acceptsQuote: true }, all)).toBe(false);
      // GUARDRAIL (#26 #28 #29): deposit, review and closing notes are always one at a time.
      expect(batchEligible({ ...base, purpose: "deposit" }, all)).toBe(false);
      expect(batchEligible({ ...base, purpose: "review_request" }, all)).toBe(false);
      expect(batchEligible({ ...base, purpose: "closing_question" }, all)).toBe(false);
      expect(
        batchEligible({ ...base, category: "invoice_payment", amountsInEmail: [1200] }, all),
      ).toBe(false);
      expect(batchEligible({ ...base, category: "invoice_payment" }, all)).toBe(true);
    });

    it("Check 41 P2: a scheduling reply that confirms a day or time goes one at a time", () => {
      expect(namesAVisitTime("Yes, still on for tomorrow morning.")).toBe(true);
      expect(namesAVisitTime("See you Tuesday at 8am.")).toBe(true);
      expect(namesAVisitTime("Thanks, noted, we'll skip you.")).toBe(false);
      expect(namesAVisitTime("I can be there at {{time}}.")).toBe(false);
      const visit = "Yes, we're still planning on tomorrow morning.";
      const sched = { ...base, category: "scheduling", body: visit, visitTime: true };
      // The customer wrote "tomorrow" first — still refused: it confirms the visit.
      expect(batchEligible(sched, all)).toBe(false);
      expect(
        batchEligible(
          {
            ...base,
            category: "scheduling",
            body: "Thanks, noted, we'll skip you.",
            visitTime: false,
          },
          all,
        ),
      ).toBe(true);
      // Other kinds naming a day are unchanged (still decided by flags).
      expect(
        batchEligible(
          { ...base, category: "customer_question", body: visit, visitTime: true },
          all,
        ),
      ).toBe(true);
    });

    it("Check 41 P2: batchSend refuses a day-confirming scheduling reply the browser sends", async () => {
      const ok = await seed();
      const rain = await seed({
        category: "scheduling",
        body: "Hi Dana,\nYes, still on for tomorrow morning.\nSam",
      });
      const review = await batchReview(workspaceId, all);
      expect(review.rows.map((r) => r.draftId)).toEqual([ok.draft.id]);
      expect(review.heldForVisitTime).toBe(1);
      const r = await batchSend(workspaceId, [ok.draft.id, rain.draft.id], all, deps());
      expect(r.queued.map((q) => q.draftId)).toEqual([ok.draft.id]);
      expect(r.refused).toBe(1);
      expect((await row(rain.draft.id)).sendAfter).toBeNull();
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

    it("GUARDRAIL: a ready deposit / review / closing note is never in a batch (#26 #28 #29)", async () => {
      const ok = await seed();
      const notes = [
        await seed({ purpose: "deposit" }),
        await seed({ purpose: "review_request" }),
        await seed({ purpose: "closing_question" }),
      ];
      // Each would be Ready on its own: clean, confident, no gaps, a picked category.
      expect((await batchCandidates(workspaceId, all)).map((c) => c.draftId)).toEqual([
        ok.draft.id,
      ]);
      const r = await batchSend(
        workspaceId,
        [ok, ...notes].map((x) => x.draft.id),
        all,
        deps(),
      );
      expect(r.queued.map((q) => q.draftId)).toEqual([ok.draft.id]);
      expect(r.refused).toBe(3);
      for (const x of notes) expect((await row(x.draft.id)).sendAfter).toBeNull();
    });

    it("GUARDRAIL: a ready ordinary reply to a quote acceptance is never in a batch (A5)", async () => {
      const ok = await seed();
      // No purpose (the deposit note already went, say), clean, confident, no gaps, a picked
      // category — only the customer's acceptance keeps it one at a time.
      const accepted = await seed({
        category: "scheduling",
        extracted: { accepts_quote: true, quote_accepted: true },
      });
      expect(accepted.draft.purpose).toBeNull();
      expect((await batchCandidates(workspaceId, all)).map((c) => c.draftId)).toEqual([
        ok.draft.id,
      ]);
      const r = await batchSend(workspaceId, [ok.draft.id, accepted.draft.id], all, deps());
      expect(r.queued.map((q) => q.draftId)).toEqual([ok.draft.id]);
      expect(r.refused).toBe(1);
      expect((await row(accepted.draft.id)).sendAfter).toBeNull();
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

  it(
    "M11 C9 (accepted on purpose): a read-only account may still snooze and say 'This one " +
      "needs me' — the screens offer both there; they only reorder the owner's own list, " +
      "with no Gmail call, no model call and no change to any draft",
    async () => {
      const { thread, draft } = await seed();
      const other = await seed();
      for (const values of [
        { status: "evaluation_expired" as const, evaluationEndsAt: later(-3600) },
        { status: "past_due" as const },
        { status: "paused" as const },
        { status: "canceled" as const },
      ]) {
        await database.update(workspaces).set(values).where(eq(workspaces.id, workspaceId));
        expect((await snoozeThread(workspaceId, thread.id, "after_job", NOW)).status).toBe(
          "snoozed",
        );
        expect(await markNeedsOwner(workspaceId, other.thread.id)).toBe(true);
      }
      expect(writer.calls).toEqual([]);
      const d = await row(draft.id);
      expect(d.status).toBe("pending");
      expect(d.body).toBe(READY_BODY);
      expect(d.sendAfter).toBeNull();
    },
  );

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

  describe("#10 offline okays", () => {
    const okay = (body: string, at: Date = NOW) => ({ seenHash: bodyHash(body), okayedAt: at });

    it("an okay for exactly the text on screen goes through the normal window", async () => {
      const { draft } = await seed();
      const r = await queueSend(workspaceId, draft.id, {
        ...deps(later(3600)),
        offline: okay(READY_BODY),
      });
      expect(r.status).toBe("queued");
      const [log] = await database
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "send_approved"));
      expect(log!.detail).toMatchObject({ offline: true });
    });

    it("never sends a draft that changed since the okay — here or in Gmail", async () => {
      const { draft } = await seed();
      await database
        .update(drafts)
        .set({ body: "A rewritten reply." })
        .where(eq(drafts.id, draft.id));
      expect(
        await queueSend(workspaceId, draft.id, { ...deps(), offline: okay(READY_BODY) }),
      ).toEqual({
        status: "changed_since_seen",
      });

      const b = await seed();
      writer.editInGmail(b.draft.gmailDraftId!, "Changed in Gmail.");
      expect(
        await queueSend(workspaceId, b.draft.id, { ...deps(), offline: okay(READY_BODY) }),
      ).toEqual({
        status: "changed_in_gmail",
      });
      expect(writer.sent).toEqual([]);
      expect((await row(draft.id)).sendAfter).toBeNull();
      expect((await row(b.draft.id)).sendAfter).toBeNull();
    });

    it("never sends to an address the owner didn't see: a re-pointed To is refused, online or offline", async () => {
      const { draft } = await seed();
      // Shown "To: dana@x.com"; the Reply-To backfill then re-pointed it.
      await database
        .update(drafts)
        .set({ toAddress: "dana.ruiz@home.com" })
        .where(eq(drafts.id, draft.id));
      writer.calls.length = 0;
      expect(await queueSend(workspaceId, draft.id, { ...deps(), seenTo: "dana@x.com" })).toEqual({
        status: "to_changed",
      });
      expect(
        await queueSend(workspaceId, draft.id, {
          ...deps(),
          offline: okay(READY_BODY),
          seenTo: "Dana@X.com",
        }),
      ).toEqual({ status: "to_changed" });
      expect(writer.calls).toEqual([]);
      expect((await row(draft.id)).sendAfter).toBeNull();
      // Looking again (the card now shows the new To) sends normally; case doesn't matter.
      const ok = await queueSend(workspaceId, draft.id, {
        ...deps(),
        seenTo: " Dana.Ruiz@home.com ",
      });
      expect(ok.status).toBe("queued");
    });

    it("an okay older than 12 hours, or for a draft that's gone, sends nothing", async () => {
      const { draft } = await seed();
      writer.calls.length = 0;
      expect(
        await queueSend(workspaceId, draft.id, {
          ...deps(later(13 * 3600)),
          offline: okay(READY_BODY, NOW),
        }),
      ).toEqual({ status: "intent_expired" });
      expect(writer.calls).toEqual([]);

      await database.update(drafts).set({ status: "discarded" }).where(eq(drafts.id, draft.id));
      expect(
        await queueSend(workspaceId, draft.id, { ...deps(), offline: okay(READY_BODY) }),
      ).toEqual({ status: "not_found" });
    });

    it("the gate still applies: an okay from before the account was blocked can't send", async () => {
      const { draft } = await seed();
      await database
        .update(workspaces)
        .set({ status: "past_due" })
        .where(eq(workspaces.id, workspaceId));
      await expect(
        queueSend(workspaceId, draft.id, { ...deps(), offline: okay(READY_BODY) }),
      ).rejects.toThrow(SendingBlockedError);
      expect(writer.calls).toEqual([]);
    });
  });
});
