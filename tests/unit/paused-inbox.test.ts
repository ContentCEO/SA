import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { activityLog, drafts, mailboxes, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  deliverQueuedSend,
  listQueue,
  pausedInboxDraftCount,
  queueCounts,
  queueMembership,
  queueSend,
  sendDraft,
} from "@/server/drafts";
import { mailboxHealth } from "@/server/mailbox-health";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";
import { FakeWriter } from "../support/fake-writer";

/**
 * Plan #47 offer A, §3.8: an inbox paused for being over the plan sends nothing (no Gmail
 * call), is off the queue and every count, and the queue says how many replies wait there.
 */

const NOW = new Date("2026-10-16T16:00:00Z");
const BODY = "Hi Dana,\nTuesday at 9 works.\nThanks, Sam";

describe("plan #47: a paused inbox", () => {
  let database: Database;
  let workspaceId: string;
  let boxA: string;
  let boxB: string;
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
      .set({ status: "active", setupPaidVia: "stripe", plan: "crew" })
      .where(eq(workspaces.id, workspaceId));
    const crew = { ...workspace, plan: "crew" as const };
    boxA = (
      await saveConnectedMailbox(crew, {
        email: "owner@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
    boxB = (
      await saveConnectedMailbox(crew, {
        email: "office@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
    writer = new FakeWriter();
  });

  const pause = (id: string) =>
    database
      .update(mailboxes)
      .set({ status: "paused", pausedReason: "over_plan" })
      .where(eq(mailboxes.id, id));

  async function seed(mailboxId: string, over: { needsOwner?: boolean } = {}) {
    const g = `t${++n}`;
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: g,
        inInbox: true,
        subject: "Deck",
        category: "scheduling",
        needsOwner: over.needsOwner ?? false,
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
        direction: "in",
        fromAddress: "dana@x.com",
        sentAt: new Date(NOW.getTime() - 3600_000),
      })
      .returning();
    if (over.needsOwner) return { thread: t!, draft: null };
    const gmail = await writer.createDraft({
      threadId: g,
      raw: Buffer.from(`To: dana@x.com\r\n\r\n${Buffer.from(BODY).toString("base64")}`).toString(
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
        body: BODY,
        originalBody: BODY,
        reason: "Confirms the time.",
        confidence: 92,
        createdAt: new Date(NOW.getTime() - 60_000),
      })
      .returning();
    writer.calls.length = 0;
    return { thread: t!, draft: d! };
  }

  it("Send reply on a paused inbox → inbox_paused, with no Gmail call and nothing queued", async () => {
    const { draft } = await seed(boxB);
    await pause(boxB);
    expect(await queueSend(workspaceId, draft!.id, deps())).toEqual({ status: "inbox_paused" });
    expect(await sendDraft(workspaceId, draft!.id, deps())).toEqual({ status: "inbox_paused" });
    expect(writer.calls).toEqual([]);
    expect(writer.sent).toEqual([]);
    const [d] = await database.select().from(drafts).where(eq(drafts.id, draft!.id));
    expect(d!.status).toBe("pending");
    expect(d!.sendAfter).toBeNull();
  });

  it("a send in its undo window when the inbox pauses stops through the normal path", async () => {
    const { draft } = await seed(boxB);
    const q = await queueSend(workspaceId, draft!.id, deps());
    expect(q.status).toBe("queued");
    await pause(boxB);
    writer.calls.length = 0;
    const r = await deliverQueuedSend(draft!.id, deps(new Date(NOW.getTime() + 60_000)));
    expect(r).toEqual({ status: "stopped", why: "inbox_paused" });
    expect(writer.sent).toEqual([]);
    const [d] = await database.select().from(drafts).where(eq(drafts.id, draft!.id));
    expect(d!.status).toBe("pending");
    expect(d!.sendAfter).toBeNull();
    const logs = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "send_stopped"));
    expect(logs.map((l) => l.detail)).toEqual([{ draftId: draft!.id, why: "inbox_paused" }]);
  });

  it("the queue, its counts (badge, digest, push) and needs-you leave paused inboxes out", async () => {
    const on = await seed(boxA);
    await seed(boxB);
    await seed(boxB);
    await seed(boxB, { needsOwner: true });
    expect((await queueCounts(workspaceId, NOW)).drafts).toBe(3);
    expect((await queueCounts(workspaceId, NOW)).needsYou).toBe(1);
    expect(await pausedInboxDraftCount(workspaceId)).toBe(0);

    await pause(boxB);
    const counts = await queueCounts(workspaceId, NOW);
    expect(counts).toMatchObject({ drafts: 1, needsYou: 0 });
    const members = await queueMembership(workspaceId, NOW);
    expect(members.drafts.map((d) => d.draftId)).toEqual([on.draft!.id]);
    const screen = await listQueue(workspaceId, NOW);
    expect(screen.drafts.map((d) => d.draftId)).toEqual([on.draft!.id]);
    expect(screen.needsYou).toEqual([]);
    expect(await pausedInboxDraftCount(workspaceId)).toBe(2);
  });

  it("Settings' health lines don't call a paused inbox's quiet a problem", () => {
    const h = mailboxHealth(
      {
        status: "paused",
        backfillCompletedAt: new Date(NOW.getTime() - 86_400_000),
        lastSyncedAt: new Date(NOW.getTime() - 5 * 86_400_000),
        watchExpiresAt: null,
        lastSyncErrorCode: null,
      },
      NOW,
      false,
    );
    expect(h.needsReconnect).toBe(false);
    expect(h.lines.find((l) => l.label === "Last checked")).toEqual({
      label: "Last checked",
      text: "Not while it's paused.",
      problem: false,
    });
  });
});
