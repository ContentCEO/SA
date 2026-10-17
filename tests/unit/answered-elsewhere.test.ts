import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { activityLog, drafts, messages } from "@/db/schema";
import { listActivity, monthSummary } from "@/server/activity";
import { runAutopilotSend } from "@/server/autopilot";
import { digestCounts } from "@/server/digest";
import {
  ANSWERED_ELSEWHERE_NOTE,
  countSentFollowups,
  deliverQueuedSend,
  queueSend,
  reconcileDrafts,
  sendDraft,
} from "@/server/drafts";
import { weeklyScorecard } from "@/server/scorecard";
import { at, NOW, READY_BODY, sendPathWorld } from "../support/send-path";

/**
 * Check 42 P1: a reply someone already sent from Gmail (the office, the owner at a computer) is
 * never followed by a second, tap-sent reply from the app. Check 14 P1: an owner who deleted our
 * draft and wrote their own reply in Gmail isn't counted as having sent our draft.
 */
describe("Check 42 P1: stop a second answer when someone already replied from Gmail", () => {
  let w: Awaited<ReturnType<typeof sendPathWorld>>;
  beforeEach(async () => {
    w = await sendPathWorld();
  });
  const logs = async (action: string) =>
    w.database.select().from(activityLog).where(eq(activityLog.action, action));

  it("an outbound email after the draft → reconcile sets it aside and deletes the Gmail draft", async () => {
    const { draft, thread } = await w.seed();
    await w.outbound(thread.id, at(-30));
    const r = await reconcileDrafts(w.mailbox.id, w.deps());
    expect(r.closed).toBe(1);
    const after = await w.row(draft.id);
    expect(after.status).toBe("expired");
    expect(after.closedNote).toBe(ANSWERED_ELSEWHERE_NOTE);
    expect(w.writer.calls).toContain("deleteDraft");
    expect(w.writer.drafts.has(draft.gmailDraftId!)).toBe(false);
    expect(w.writer.sent).toEqual([]);
  });

  it("an outbound email after the draft → queueSend says answered_elsewhere and sends nothing", async () => {
    const { draft, thread } = await w.seed();
    const out = await w.outbound(thread.id, at(-30));
    const r = await queueSend(w.workspace.id, draft.id, w.deps());
    expect(r).toEqual({ status: "answered_elsewhere", at: out.sentAt });
    expect(w.writer.calls).toEqual([]); // no Gmail call at all
    expect(w.writer.sent).toEqual([]);
    expect((await w.row(draft.id)).sendAfter).toBeNull();
    expect(await logs("send_approved")).toEqual([]);
    // A direct send is refused the same way.
    expect(await sendDraft(w.workspace.id, draft.id, w.deps())).toMatchObject({
      status: "answered_elsewhere",
    });
    expect(w.writer.sent).toEqual([]);
  });

  it("answered during the undo window → the window ends quietly, set aside, never sent", async () => {
    const { draft, thread } = await w.seed();
    expect((await queueSend(w.workspace.id, draft.id, w.deps())).status).toBe("queued");
    await w.outbound(thread.id, at(10));
    const r = await deliverQueuedSend(draft.id, w.deps(at(21)));
    expect(r).toEqual({ status: "stopped", why: "answered_elsewhere" });
    expect(w.writer.sent).toEqual([]);
    const after = await w.row(draft.id);
    expect(after.status).toBe("expired");
    expect(after.sendAfter).toBeNull();
    expect(after.sendClaimedAt).toBeNull();
    expect(w.writer.drafts.has(draft.gmailDraftId!)).toBe(false);
    const [stood] = await logs("send_stood_down");
    expect(stood!.detail).toEqual({ draftId: draft.id, reason: "answered_elsewhere" });
    expect(await logs("send_stopped")).toEqual([]);
    // A second delivery (duplicate event, backstop) finds nothing.
    expect(await deliverQueuedSend(draft.id, w.deps(at(400)))).toEqual({ status: "not_due" });
    expect(w.writer.sent).toEqual([]);
    const text = (await listActivity(w.workspace.id)).map((e) => e.text);
    expect(text).toContain(
      "Didn't send the reply to Dana: someone had already answered from Gmail",
    );
  });

  it("a practice copy (to the mailbox's own address only) does NOT count as an answer", async () => {
    const { draft, thread } = await w.seed();
    await w.outbound(thread.id, at(-30), { to: ["Owner@Shop.com"] });
    await reconcileDrafts(w.mailbox.id, w.deps());
    expect((await w.row(draft.id)).status).toBe("pending");
    expect((await queueSend(w.workspace.id, draft.id, w.deps())).status).toBe("queued");
  });

  it("a forward to the crew (a side conversation) does NOT count as an answer", async () => {
    const { draft, thread } = await w.seed();
    await w.outbound(thread.id, at(-30), { to: ["mike@shop.com"] });
    await reconcileDrafts(w.mailbox.id, w.deps());
    expect((await w.row(draft.id)).status).toBe("pending");
    expect((await queueSend(w.workspace.id, draft.id, w.deps())).status).toBe("queued");
  });

  it("an outbound email OLDER than the draft does NOT set it aside", async () => {
    const { draft, thread } = await w.seed();
    await w.outbound(thread.id, at(-1800));
    await reconcileDrafts(w.mailbox.id, w.deps());
    expect((await w.row(draft.id)).status).toBe("pending");
    expect((await queueSend(w.workspace.id, draft.id, w.deps())).status).toBe("queued");
  });

  it("an unsent Gmail draft on the thread isn't an answer", async () => {
    const { draft, thread } = await w.seed();
    const m = await w.outbound(thread.id, at(-30));
    await w.database
      .update(messages)
      .set({ labelIds: ["DRAFT"] })
      .where(eq(messages.id, m.id));
    expect((await queueSend(w.workspace.id, draft.id, w.deps())).status).toBe("queued");
  });

  it("autopilot behaviour is unchanged: newer mail stands it down, nothing sent", async () => {
    const { draft, thread } = await w.seed();
    await w.database
      .update(drafts)
      .set({ autoSendAt: at(-60) })
      .where(eq(drafts.id, draft.id));
    await w.outbound(thread.id, at(-30));
    const r = await runAutopilotSend(draft.id, w.deps());
    expect(r.status).toBe("stood_down");
    if (r.status === "stood_down")
      expect(r.reasons).toContain("There's newer mail in this conversation.");
    expect(w.writer.sent).toEqual([]);
  });
});

describe("Check 14 P1: the owner's own Gmail reply isn't our draft sent", () => {
  let w: Awaited<ReturnType<typeof sendPathWorld>>;
  beforeEach(async () => {
    w = await sendPathWorld();
  });
  const gone = (gmailDraftId: string) => w.writer.drafts.delete(gmailDraftId);
  const tz = "America/New_York";

  it("draft gone + an outbound with the same text → sent via gmail, counted, decided when it went", async () => {
    const { draft, thread } = await w.seed();
    gone(draft.gmailDraftId!);
    const out = await w.outbound(thread.id, at(-30), {
      body: `${READY_BODY}\n\nOn Fri, Dana wrote:\n> Can you quote a deck repair?`,
    });
    await reconcileDrafts(w.mailbox.id, w.deps());
    const after = await w.row(draft.id);
    expect(after.status).toBe("sent");
    expect(after.sentVia).toBe("gmail");
    expect(after.decidedAt).toEqual(out.sentAt);
    const month = await monthSummary(w.workspace.id, NOW, tz);
    expect(month.sent).toBe(1);
    expect(month.minutesSaved).toBe(3);
    const [log] = await w.database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "reply_sent_from_gmail"));
    expect(log!.detail).toEqual({ draftId: draft.id });
  });

  it("draft gone + an outbound with different text → own_words: not sent, not time saved, plain Activity line", async () => {
    const { draft, thread } = await w.seed();
    gone(draft.gmailDraftId!);
    const out = await w.outbound(thread.id, at(-30), { body: "Hey, call me at noon." });
    await reconcileDrafts(w.mailbox.id, w.deps());
    const after = await w.row(draft.id);
    expect(after.status).toBe("sent"); // caps stay conservative
    expect(after.sentVia).toBe("own_words");
    expect(after.decidedAt).toEqual(out.sentAt);
    const month = await monthSummary(w.workspace.id, NOW, tz);
    expect(month.sent).toBe(0);
    expect(month.minutesSaved).toBe(0);
    const week = await weeklyScorecard(w.workspace.id, at(-6 * 86400), at(86400), NOW);
    expect(week.repliesSent).toBe(0);
    expect(week.minutesSaved).toBe(0);
    expect((await digestCounts(w.workspace.id, at(3600), tz)).sentYesterday).toBe(0);
    const entries = await listActivity(w.workspace.id);
    const line = entries.find((e) => e.text === "You answered Dana yourself in Gmail");
    expect(line).toBeTruthy();
    expect(line!.recordId).toBeNull();
    expect(
      await w.database
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "reply_sent_from_gmail")),
    ).toEqual([]);
  });

  it("a follow-up closed as own_words still counts toward the two-nudge cap", async () => {
    const { draft, thread } = await w.seed({ kind: "followup", category: "quote_request" });
    gone(draft.gmailDraftId!);
    await w.outbound(thread.id, at(-30), { body: "Totally different words." });
    await reconcileDrafts(w.mailbox.id, w.deps());
    expect((await w.row(draft.id)).sentVia).toBe("own_words");
    expect(await countSentFollowups(thread.id)).toBe(1);
  });

  it("an outbound with no stored text and another message id → own_words", async () => {
    const { draft, thread } = await w.seed();
    gone(draft.gmailDraftId!);
    await w.outbound(thread.id, at(-30), { body: null });
    await reconcileDrafts(w.mailbox.id, w.deps());
    expect((await w.row(draft.id)).sentVia).toBe("own_words");
  });

  it("Gmail kept our draft's id but the text changed → edited_and_sent via gmail", async () => {
    const { draft, thread } = await w.seed();
    gone(draft.gmailDraftId!);
    await w.outbound(thread.id, at(-30), {
      gmailMessageId: draft.gmailMessageId!,
      body: "Hi Dana, I changed this in Gmail.",
    });
    await reconcileDrafts(w.mailbox.id, w.deps());
    const after = await w.row(draft.id);
    expect(after.status).toBe("edited_and_sent");
    expect(after.sentVia).toBe("gmail");
  });

  it("an app send records sent_via app; autopilot's records autopilot", async () => {
    const { draft } = await w.seed();
    await queueSend(w.workspace.id, draft.id, w.deps());
    expect((await deliverQueuedSend(draft.id, w.deps(at(21)))).status).toBe("sent");
    expect((await w.row(draft.id)).sentVia).toBe("app");
    const two = await w.seed();
    const r = await sendDraft(w.workspace.id, two.draft.id, { ...w.deps(), by: "autopilot" });
    expect(r.status).toBe("sent");
    expect((await w.row(two.draft.id)).sentVia).toBe("autopilot");
    // Exactly one Gmail send per draft.
    expect(w.writer.sent).toHaveLength(2);
  });
});
