import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, drafts, workspaces } from "@/db/schema";
import { BATCH_CATEGORIES } from "@/server/batch-rules";
import { batchSend, bodyHash, queueSend } from "@/server/drafts";
import { recordTermsAcceptance } from "@/server/terms";
import { NOW, READY_BODY, sendPathWorld } from "../support/send-path";

/**
 * Check 9 P1: a tap on Send reply only queues the text the card showed. The card, the Edit box
 * and the review page post the fingerprint of the text on screen; a draft whose text changed
 * since (a sync took Gmail's version, another device changed it) is refused with nothing sent.
 */

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/auth", () => ({
  auth: async () => (session.userId ? { user: { id: session.userId } } : null),
}));
class Redirected extends Error {
  constructor(readonly url: string) {
    super("redirect");
  }
}
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Redirected(url);
  },
}));
vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  headers: async () => new Headers({ "user-agent": "iPhone" }),
}));
// The Inngest event is not what this test is about.
vi.mock("@/jobs/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/jobs/client")>()),
  enqueue: async () => undefined,
}));

const B_TEXT = "Hi Dana,\nI can do it for $900.\nThanks, Sam";

describe("Check 9 P1: refuse a send when the card showed different text", () => {
  let w: Awaited<ReturnType<typeof sendPathWorld>>;
  beforeEach(async () => {
    w = await sendPathWorld();
  });

  const changeEverywhere = async (draftId: string, gmailDraftId: string, text: string) => {
    // The office edits the draft in Gmail and a sync takes that text: both now read B.
    w.writer.editInGmail(gmailDraftId, text);
    await w.database.update(drafts).set({ body: text }).where(eq(drafts.id, draftId));
  };

  it("(a) the page showed A, the draft and Gmail now say B → changed_since_seen, nothing sent", async () => {
    const { draft } = await w.seed();
    const seen = bodyHash(READY_BODY);
    await changeEverywhere(draft.id, draft.gmailDraftId!, B_TEXT);
    const r = await queueSend(w.workspace.id, draft.id, { ...w.deps(), seenHash: seen });
    expect(r).toEqual({ status: "changed_since_seen" });
    expect(w.writer.calls).toEqual([]); // not even a Gmail read
    expect(w.writer.sent).toEqual([]);
    const after = await w.row(draft.id);
    expect(after.sendAfter).toBeNull();
    expect(after.status).toBe("pending");
    const approvals = await w.database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "send_approved"));
    expect(approvals).toEqual([]);
  });

  it("(b) a matching fingerprint queues as before", async () => {
    const { draft } = await w.seed();
    const r = await queueSend(w.workspace.id, draft.id, {
      ...w.deps(),
      seenHash: bodyHash(READY_BODY),
    });
    expect(r.status).toBe("queued");
    expect((await w.row(draft.id)).sendAfter).not.toBeNull();
  });

  it("(c) batch: one stale row is refused, the others are queued", async () => {
    const a = await w.seed();
    const b = await w.seed();
    const c = await w.seed();
    const seen = new Map(
      [a, b, c].map((x) => [x.draft.id, { hash: bodyHash(READY_BODY), to: "dana@x.com" }]),
    );
    await changeEverywhere(b.draft.id, b.draft.gmailDraftId!, "Hi Dana,\nSure, sounds good.\nSam");
    const r = await batchSend(
      w.workspace.id,
      [a.draft.id, b.draft.id, c.draft.id],
      BATCH_CATEGORIES,
      { ...w.deps(), seen },
    );
    expect(r.queued.map((q) => q.draftId).sort()).toEqual([a.draft.id, c.draft.id].sort());
    expect(r.refused).toBe(1);
    expect((await w.row(b.draft.id)).sendAfter).toBeNull();
    expect(w.writer.sent).toEqual([]);
  });

  it("batch: a reply the page didn't show (no fingerprint) or whose address changed is refused", async () => {
    const a = await w.seed();
    const b = await w.seed();
    const seen = new Map([[a.draft.id, { hash: bodyHash(READY_BODY), to: "someone@else.com" }]]);
    const r = await batchSend(w.workspace.id, [a.draft.id, b.draft.id], BATCH_CATEGORIES, {
      ...w.deps(),
      seen,
    });
    expect(r).toEqual({ queued: [], refused: 2 });
  });

  it("text that changes between the check and the queue write is caught by the write itself", async () => {
    const { draft } = await w.seed();
    // A reconcile lands while queueSend waits on Gmail: the stored text moves under it.
    const realGet = w.writer.getDraft.bind(w.writer);
    w.writer.getDraft = async (id: string) => {
      const got = await realGet(id);
      await w.database.update(drafts).set({ body: B_TEXT }).where(eq(drafts.id, draft.id));
      return got;
    };
    const r = await queueSend(w.workspace.id, draft.id, {
      ...w.deps(),
      seenHash: bodyHash(READY_BODY),
    });
    expect(r).toEqual({ status: "changed_since_seen" });
    const after = await w.row(draft.id);
    expect(after.sendAfter).toBeNull();
    expect(after.body).toBe(B_TEXT);
  });

  it("an autopilot claim taken while the tap waits on Gmail wins: the tap queues nothing", async () => {
    const { draft } = await w.seed();
    await w.database.update(drafts).set({ autoSendAt: NOW }).where(eq(drafts.id, draft.id));
    const realGet = w.writer.getDraft.bind(w.writer);
    w.writer.getDraft = async (id: string) => {
      const got = await realGet(id);
      // Check 9 P2: the autopilot run claims it right now.
      await w.database
        .update(drafts)
        .set({ autoSendClaimedAt: NOW })
        .where(eq(drafts.id, draft.id));
      return got;
    };
    const r = await queueSend(w.workspace.id, draft.id, {
      ...w.deps(),
      seenHash: bodyHash(READY_BODY),
    });
    expect(r).toEqual({ status: "already_sending" });
    const after = await w.row(draft.id);
    expect(after.sendAfter).toBeNull();
    expect(after.autoSendAt).toEqual(NOW);
    expect(w.writer.sent).toEqual([]);
  });

  describe("through the server actions", () => {
    beforeEach(async () => {
      await recordTermsAcceptance(w.user.id);
      session.userId = w.user.id;
    });
    const whereTo = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (err) {
        if (err instanceof Redirected) return err.url;
        throw err;
      }
      throw new Error("the action didn't redirect");
    };
    const form = (fields: [string, string][]) => {
      const f = new FormData();
      for (const [k, v] of fields) f.append(k, v);
      return f;
    };

    it("Send reply posts the fingerprint; a stale one lands on the 'changed' notice", async () => {
      const { sendDraftAction } = await import("@/app/(app)/queue/actions");
      const { draft } = await w.seed();
      // Refused before any Gmail call, so the action's real Gmail client is never reached.
      await changeEverywhere(draft.id, draft.gmailDraftId!, B_TEXT);
      const url = await whereTo(() =>
        sendDraftAction(
          form([
            ["draftId", draft.id],
            ["seen", bodyHash(READY_BODY)],
            ["seenTo", "dana@x.com"],
          ]),
        ),
      );
      expect(url).toBe("/queue?error=changed");
      expect((await w.row(draft.id)).sendAfter).toBeNull();
      // No fingerprint at all (an old page): nothing is queued either.
      const url2 = await whereTo(() => sendDraftAction(form([["draftId", draft.id]])));
      expect(url2).toBe("/queue?error=changed");
      expect((await w.row(draft.id)).sendAfter).toBeNull();
      expect(w.writer.sent).toEqual([]);
    });

    it("the 'changed' notice says nothing was sent", async () => {
      const { QUEUE_ERRORS } = await import("@/app/(app)/queue/queue-messages");
      expect(QUEUE_ERRORS.changed).toBe(
        "That draft changed since you opened it, so nothing was sent. Here's the latest version. Read it, then tap Send reply again.",
      );
    });
  });

  it("blocked accounts still get the gate before the fingerprint matters", async () => {
    const { draft } = await w.seed();
    await w.database
      .update(workspaces)
      .set({ status: "past_due" })
      .where(eq(workspaces.id, w.workspace.id));
    await expect(
      queueSend(w.workspace.id, draft.id, { ...w.deps(), seenHash: bodyHash(READY_BODY) }),
    ).rejects.toThrow();
    expect(w.writer.calls).toEqual([]);
    void NOW;
  });
});
