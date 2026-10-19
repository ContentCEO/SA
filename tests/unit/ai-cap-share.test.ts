import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import {
  AiCapReachedError,
  aiCallsToday,
  dailyAiCallCap,
  dailyAiCallCapSql,
  reserveAiCall,
  utcDay,
} from "@/ai/usage";
import { SORT_SHARE, sortCallLimit } from "@/config/models";
import type { Database } from "@/db";
import { mailboxes, messages, threads, usage, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { classifyPending } from "@/server/classification";
import { createTestDb } from "../support/db";
import { classification, fakeTransport } from "../support/fake-model";

/**
 * Check 29 P4: sorting may use at most 80% of the day's AI limit, so drafts and voice always
 * have calls left. Check 29 P5: the limit is per running inbox, up to a ceiling.
 */

const NOW = new Date("2026-10-18T15:00:00Z");
let database: Database;
let workspaceId: string;
let n = 0;

async function addMailbox(over: Partial<typeof mailboxes.$inferInsert> = {}) {
  const [m] = await database
    .insert(mailboxes)
    .values({
      workspaceId,
      email: `box${++n}@shop.com`,
      encryptedRefreshToken: "x",
      scopes: "x",
      ...over,
    })
    .returning();
  return m!;
}

async function callsToday() {
  const [row] = await database
    .select({ calls: usage.aiCalls })
    .from(usage)
    .where(and(eq(usage.workspaceId, workspaceId), eq(usage.period, utcDay(NOW))));
  return row?.calls ?? 0;
}

const refused = async (p: Promise<unknown>) => {
  await expect(p).rejects.toBeInstanceOf(AiCapReachedError);
};

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
  workspaceId = (await ensureUserAndWorkspace({ email: "owner@shop.com" })).workspace.id;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.AI_DAILY_CALL_CAP;
  delete process.env.AI_DAILY_CALL_CAP_MAX;
  vi.restoreAllMocks();
});

describe("sorting's share of the day's limit (Check 29 P4)", () => {
  beforeEach(async () => {
    process.env.AI_DAILY_CALL_CAP = "10";
    await addMailbox();
  });

  it("sorting stops after 8 of 10; drafts get the last two; the total never passes 10", async () => {
    expect(SORT_SHARE).toBe(0.8);
    for (let i = 0; i < 8; i++) await reserveAiCall(workspaceId, NOW, "sort");
    await refused(reserveAiCall(workspaceId, NOW, "sort"));
    expect(await callsToday()).toBe(8);
    await reserveAiCall(workspaceId, NOW, "draft");
    await reserveAiCall(workspaceId, NOW, "draft");
    await refused(reserveAiCall(workspaceId, NOW, "draft"));
    await refused(reserveAiCall(workspaceId, NOW, "sort"));
    expect(await callsToday()).toBe(10);
  });

  it("voice learning gets a call after sorting used its share", async () => {
    for (let i = 0; i < 8; i++) await reserveAiCall(workspaceId, NOW, "sort");
    await refused(reserveAiCall(workspaceId, NOW, "sort"));
    await reserveAiCall(workspaceId, NOW, "voice");
    await reserveAiCall(workspaceId, NOW, "other");
    await refused(reserveAiCall(workspaceId, NOW, "voice"));
    expect(await callsToday()).toBe(10);
  });

  it("the 80% alert still fires at 80% of the full limit", async () => {
    for (let i = 0; i < 7; i++) await reserveAiCall(workspaceId, NOW, "draft");
    const flag = async () =>
      (
        await database
          .select({ at: usage.capAlertedAt })
          .from(usage)
          .where(eq(usage.workspaceId, workspaceId))
      )[0]!.at;
    expect(await flag()).toBeNull();
    await reserveAiCall(workspaceId, NOW, "sort");
    expect(await flag()).not.toBeNull();
  });

  it("classifyPending stops at sorting's share and reports capped", async () => {
    const [box] = await database.select().from(mailboxes);
    for (let i = 0; i < 10; i++) {
      const [t] = await database
        .insert(threads)
        .values({ mailboxId: box!.id, gmailThreadId: `t${i}`, inInbox: true, lastMessageAt: NOW })
        .returning();
      await database.insert(messages).values({
        threadId: t!.id,
        mailboxId: box!.id,
        gmailMessageId: `m${i}`,
        direction: "in",
        fromAddress: `c${i}@example.com`,
        subject: "Panel",
        bodyText: "Can you quote a panel?",
        labelIds: ["INBOX"],
        sentAt: new Date(NOW.getTime() - (i + 1) * 60_000),
      });
    }
    const { transport, calls } = fakeTransport(Array.from({ length: 10 }, () => classification()));
    setModelTransportForTests(transport);
    const r = await classifyPending(box!.id, { now: NOW });
    expect(r).toMatchObject({ classified: 8, capped: true });
    expect(calls).toHaveLength(8);
    // Two left for drafts and voice.
    expect(await aiCallsToday(workspaceId, NOW)).toEqual({ calls: 8, cap: 10 });
  });
});

describe("the limit grows with running inboxes (Check 29 P5)", () => {
  it("500 per inbox, at least one, up to 3000; only running inboxes count", async () => {
    expect(await dailyAiCallCap(workspaceId)).toBe(500); // none connected yet
    await addMailbox();
    expect(await dailyAiCallCap(workspaceId)).toBe(500);
    await addMailbox();
    await addMailbox();
    expect(await dailyAiCallCap(workspaceId)).toBe(1500);
    // Access lost or paused on the plan: not running, not counted.
    await addMailbox({ status: "reconnect_needed" });
    await addMailbox({ planPausedAt: NOW });
    expect(await dailyAiCallCap(workspaceId)).toBe(1500);
    for (let i = 0; i < 9; i++) await addMailbox();
    expect(await dailyAiCallCap(workspaceId)).toBe(3000);
    process.env.AI_DAILY_CALL_CAP_MAX = "4000";
    expect(await dailyAiCallCap(workspaceId)).toBe(4000);
  });

  it("the SQL twin gives the same number (admin costs, the unsorted sweep)", async () => {
    for (let i = 0; i < 3; i++) await addMailbox();
    await addMailbox({ status: "reconnect_needed" });
    const [row] = await database
      .select({ cap: dailyAiCallCapSql('"workspaces"."id"') })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(Number(row!.cap)).toBe(await dailyAiCallCap(workspaceId));
    expect(Number(row!.cap)).toBe(1500);
  });

  it("refusals and the owner's note use the shop's own limit", async () => {
    process.env.AI_DAILY_CALL_CAP = "2";
    for (let i = 0; i < 3; i++) await addMailbox();
    expect(sortCallLimit(6)).toBe(4);
    for (let i = 0; i < 4; i++) await reserveAiCall(workspaceId, NOW, "sort");
    await refused(reserveAiCall(workspaceId, NOW, "sort"));
    await reserveAiCall(workspaceId, NOW, "draft");
    await reserveAiCall(workspaceId, NOW, "draft");
    await refused(reserveAiCall(workspaceId, NOW, "draft"));
    expect(await aiCallsToday(workspaceId, NOW)).toEqual({ calls: 6, cap: 6 });
  });
});
