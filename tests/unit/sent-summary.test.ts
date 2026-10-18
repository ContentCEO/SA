import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { activityLog, drafts } from "@/db/schema";
import {
  deliverQueuedSend,
  lateSends,
  queueSend,
  sentDraftSummary,
  undoSend,
} from "@/server/drafts";
import { at, NOW, sendPathWorld } from "../support/send-path";

/** Check 9 P10: tell the owner when a send was stopped or is running late. */
describe("Check 9 P10: sentDraftSummary and late sends", () => {
  let w: Awaited<ReturnType<typeof sendPathWorld>>;
  beforeEach(async () => {
    w = await sendPathWorld();
  });

  it("a send stopped after the window (changed in Gmail) says why, instead of vanishing", async () => {
    const { draft } = await w.seed();
    await queueSend(w.workspace.id, draft.id, w.deps());
    w.writer.editInGmail(draft.gmailDraftId!, "Hi Dana, the office changed this.");
    expect(await deliverQueuedSend(draft.id, w.deps(at(21)))).toEqual({
      status: "stopped",
      why: "changed_in_gmail",
    });
    const s = await sentDraftSummary(w.workspace.id, draft.id, at(25));
    expect(s).toMatchObject({ stopped: { why: "changed_in_gmail" }, sendingAt: null, late: false });
    expect(s!.toName).toBe("Dana");
    // Tapped again and undone: the newest step wins, nothing to explain.
    await queueSend(w.workspace.id, draft.id, w.deps(at(30)));
    expect(await undoSend(w.workspace.id, draft.id)).toBe(true);
    expect(await sentDraftSummary(w.workspace.id, draft.id, at(35))).toBeNull();
  });

  it("a send set aside because someone answered from Gmail says so", async () => {
    const { draft, thread } = await w.seed();
    await queueSend(w.workspace.id, draft.id, w.deps());
    await w.outbound(thread.id, at(5));
    await deliverQueuedSend(draft.id, w.deps(at(21)));
    expect(await sentDraftSummary(w.workspace.id, draft.id, at(25))).toMatchObject({
      stopped: { why: "answered_elsewhere" },
    });
  });

  it("a plain pending draft (never tapped) and a discarded one give nothing", async () => {
    const { draft } = await w.seed();
    expect(await sentDraftSummary(w.workspace.id, draft.id)).toBeNull();
    await w.database.update(drafts).set({ status: "discarded" }).where(eq(drafts.id, draft.id));
    expect(await sentDraftSummary(w.workspace.id, draft.id)).toBeNull();
  });

  it("late: the window ended over a minute ago and no job holds it", async () => {
    const { draft } = await w.seed();
    await queueSend(w.workspace.id, draft.id, w.deps());
    expect((await sentDraftSummary(w.workspace.id, draft.id, at(30)))!.late).toBe(false);
    expect((await sentDraftSummary(w.workspace.id, draft.id, at(90)))!.late).toBe(true);
    expect(await lateSends(w.workspace.id, at(90))).toEqual([{ draftId: draft.id, to: "Dana" }]);
    // A job holding it (a fresh claim) isn't late; Stop it still works until claimed.
    await w.database
      .update(drafts)
      .set({ sendClaimedAt: at(85) })
      .where(eq(drafts.id, draft.id));
    expect((await sentDraftSummary(w.workspace.id, draft.id, at(90)))!.late).toBe(false);
    expect(await lateSends(w.workspace.id, at(90))).toEqual([]);
    await w.database.update(drafts).set({ sendClaimedAt: null }).where(eq(drafts.id, draft.id));
    expect(await undoSend(w.workspace.id, draft.id)).toBe(true);
    expect(await lateSends(w.workspace.id, at(90))).toEqual([]);
    expect(w.writer.sent).toEqual([]);
    const logs = await w.database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "send_undone"));
    expect(logs).toHaveLength(1);
    void NOW;
  });
});
