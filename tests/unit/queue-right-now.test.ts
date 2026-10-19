import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { drafts, mailboxes, messages, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { countQueue, listQueue, queueCardIds, queueCounts, queueMembership } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { snoozeThread } from "@/server/snooze";
import { createTestDb } from "../support/db";

/** Check 9 P6: emergencies come first on the queue, with or without a draft. */
const NOW = new Date("2026-10-16T15:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
let database: Database;
let workspaceId: string;
let mailboxId: string;
let n = 0;

async function thread(over: Partial<typeof threads.$inferInsert> = {}) {
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: `g${++n}`,
      inInbox: true,
      category: "customer_question",
      summary: "A question.",
      classifiedAt: NOW,
      lastMessageAt: hoursAgo(1),
      ...over,
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `m${++n}`,
    direction: "in",
    fromAddress: `c${n}@example.com`,
    fromName: "Customer",
    replyToHeader: {},
    subject: "Help",
    bodyText: "Can you help?",
    labelIds: ["INBOX"],
    sentAt: over.lastMessageAt ?? hoursAgo(1),
  });
  return t!;
}
async function draftOn(threadId: string) {
  const [d] = await database
    .insert(drafts)
    .values({
      threadId,
      mailboxId,
      kind: "reply",
      gmailDraftId: `gd${++n}`,
      toAddress: "c@example.com",
      subject: "Re: Help",
      body: "On our way.",
      originalBody: "On our way.",
      reason: "r",
      flags: [],
      confidence: 80,
      promptVersion: "draft.v8",
    })
    .returning();
  return d!;
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
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
  await database
    .update(mailboxes)
    .set({ lastSyncedAt: hoursAgo(0.1) })
    .where(eq(mailboxes.id, mailboxId));
});

describe("Check 9 P6: Right now", () => {
  it("an emergency with a draft comes before older needs-you cards; counts don't change", async () => {
    const old1 = await thread({ needsOwner: true, lastMessageAt: hoursAgo(20) });
    const old2 = await thread({ needsOwner: true, lastMessageAt: hoursAgo(6) });
    const plainDraft = await thread({ lastMessageAt: hoursAgo(0.1) });
    await draftOn(plainDraft.id);
    // Burst pipe, 12 minutes old, needs the owner, with a draft.
    const pipe = await thread({
      needsOwner: true,
      priority: "high",
      needsOwnerReason: "Emergency: water is coming through the basement ceiling.",
      lastMessageAt: hoursAgo(0.2),
    });
    const pipeDraft = await draftOn(pipe.id);

    const m = await queueMembership(workspaceId, NOW);
    expect(m.now).toEqual([{ threadId: pipe.id, draftId: pipeDraft.id }]);
    expect(m.drafts[0]!.threadId).toBe(pipe.id); // first within its own list too
    expect(m.needsYou.map((x) => x.threadId)).toEqual([old2.id, old1.id]);
    // Counts total the same as before: two needs-you, two replies.
    expect(countQueue(m)).toEqual({ needsYou: 2, replies: 2, nudges: 0, drafts: 2 });
    expect(await queueCounts(workspaceId, NOW)).toEqual(countQueue(m));
    // The screen's card ids are unchanged by the view.
    expect(queueCardIds(m)).toEqual(new Set([old1.id, old2.id, plainDraft.id, pipe.id]));

    const q = await listQueue(workspaceId, NOW);
    expect(q.now.map((i) => i.threadId)).toEqual([pipe.id]);
    expect(q.now[0]!.draftId).toBe(pipeDraft.id);
  });

  it("emergencies without a draft (and the lane) are in Right now; lane first, then newest", async () => {
    const high = await thread({ needsOwner: true, priority: "high", lastMessageAt: hoursAgo(1) });
    const lane = await thread({
      needsOwner: true,
      priority: "high",
      lastMessageAt: hoursAgo(3),
      extracted: { urgency: "emergency" },
    });
    const highDraft = await thread({
      needsOwner: true,
      priority: "high",
      lastMessageAt: hoursAgo(0.5),
    });
    const d = await draftOn(highDraft.id);
    await thread({ needsOwner: true, lastMessageAt: hoursAgo(0.1) });

    const m = await queueMembership(workspaceId, NOW);
    expect(m.now).toEqual([
      { threadId: lane.id, draftId: null },
      { threadId: highDraft.id, draftId: d.id },
      { threadId: high.id, draftId: null },
    ]);
    expect(m.needsYou.slice(0, 2).map((x) => x.threadId)).toEqual([lane.id, high.id]);
  });

  it("a snoozed emergency stays hidden until tonight, and is out of Right now", async () => {
    const pipe = await thread({ needsOwner: true, priority: "high", lastMessageAt: hoursAgo(0.2) });
    await draftOn(pipe.id);
    expect((await snoozeThread(workspaceId, pipe.id, "tonight", NOW)).status).toBe("snoozed");
    const m = await queueMembership(workspaceId, NOW);
    expect(m.now).toEqual([]);
    expect(m.drafts).toEqual([]);
    expect(countQueue(m)).toEqual({ needsYou: 0, replies: 0, nudges: 0, drafts: 0 });
  });
});
