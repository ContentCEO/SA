import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { drafts, messages, rateLimits, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { queueCounts } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { LIMITS } from "@/server/rate-limit";
import { createTestDb } from "../support/db";

// The signed-in owner, without Auth.js: the routes only read `session.user.id`.
const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/auth", () => ({
  auth: async () => (session.userId ? { user: { id: session.userId } } : null),
}));
// GUARDRAIL (plan M8 A1/A32): the badge counts from the content-free membership. listQueue
// loads names, summaries and draft text, so calling it from here fails the test.
vi.mock("@/server/drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/drafts")>()),
  listQueue: () => {
    throw new Error("the badge must count with queueCounts, never listQueue");
  },
}));

const { GET: badgeGET } = await import("@/app/api/badge/route");
const { GET: summaryGET } = await import("@/app/api/push/summary/route");

let database: Database;
let workspaceId: string;
let mailboxId: string;
let n = 0;
const at = (minutesFromNow: number) => new Date(Date.now() + minutesFromNow * 60_000);

async function thread(over: Partial<typeof threads.$inferInsert> = {}) {
  n += 1;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: `g-${n}`,
      inInbox: true,
      subject: `SECRET-SUBJECT-${n}`,
      summary: "SECRET-SUMMARY",
      category: "customer_question",
      lastMessageAt: at(-60),
      ...over,
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `g-${n}-m`,
    direction: "in",
    fromName: "SECRET Customer",
    fromAddress: "SECRET@example.com",
    bodyText: "SECRET-BODY",
    sentAt: at(-60),
  });
  return t!;
}
async function draft(threadId: string, over: Partial<typeof drafts.$inferInsert> = {}) {
  n += 1;
  await database.insert(drafts).values({
    threadId,
    mailboxId,
    gmailDraftId: `d-${n}`,
    toAddress: "SECRET@example.com",
    subject: "Re: SECRET",
    body: "SECRET-DRAFT-BODY",
    originalBody: "SECRET-DRAFT-BODY",
    reason: "SECRET-DRAFT-REASON",
    promptVersion: "draft.v5",
    ...over,
  });
}
const call = async (get: () => Promise<Response>) => {
  const res = await get();
  return {
    status: res.status,
    headers: res.headers,
    json: (await res.json()) as Record<string, unknown>,
  };
};
const setStatus = (values: Partial<typeof workspaces.$inferInsert>) =>
  database.update(workspaces).set(values).where(eq(workspaces.id, workspaceId));

/** A mixed queue: 2 needs-you, a reply and a nudge waiting; plus what isn't on the queue. */
async function seedMixedQueue() {
  await thread({ needsOwner: true, needsOwnerReason: "SECRET-REASON" });
  await thread({ needsOwner: true, needsOwnerReason: "SECRET-REASON", category: "complaint" });
  await draft((await thread({ category: "quote_request" })).id);
  await draft((await thread({ category: "invoice_payment" })).id, { kind: "followup" });
  // Not waiting: snoozed, in the undo window, decided, out of the inbox.
  await thread({ needsOwner: true, needsOwnerReason: "SECRET-REASON", snoozedUntil: at(180) });
  await draft((await thread()).id, { sendAfter: at(0.5) });
  await draft((await thread({ snoozedUntil: at(180) })).id);
  await draft((await thread()).id, { status: "discarded", decidedAt: at(-5) });
  await thread({ needsOwner: true, needsOwnerReason: "SECRET-REASON", inInbox: false });
}

describe("/api/badge — the home-screen number (plan #38, M8 A32)", () => {
  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    database = await createTestDb();
    const { user, workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    session.userId = user.id;
    workspaceId = workspace.id;
    await setStatus({ status: "active" });
    mailboxId = (
      await saveConnectedMailbox(workspace, {
        email: "owner@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
  });

  it("GUARDRAIL: exactly { count } — replies + needs-you, the queue's own numbers, nothing else", async () => {
    await seedMixedQueue();
    const { status, headers, json } = await call(badgeGET);
    expect(status).toBe(200);
    expect(headers.get("cache-control")).toContain("no-store");
    expect(Object.keys(json)).toEqual(["count"]);
    expect(json.count).toBe(4);
    const totals = await queueCounts(workspaceId);
    expect(json.count).toBe(totals.drafts + totals.needsYou);
    expect(JSON.stringify(json)).not.toMatch(/SECRET|@/i);
    // The notification summary carries the same number.
    expect((await call(summaryGET)).json.count).toBe(4);
  });

  it("snoozed and undo-window items aren't counted", async () => {
    await thread({ needsOwner: true, needsOwnerReason: "SECRET-REASON", snoozedUntil: at(180) });
    await draft((await thread()).id, { sendAfter: at(0.5) });
    await draft((await thread({ snoozedUntil: at(180) })).id);
    expect((await call(badgeGET)).json.count).toBe(0);
    expect((await call(summaryGET)).json.count).toBe(0);
  });

  it("A19: no 50-row cap — 55 needs-you emails → 55", async () => {
    for (let i = 0; i < 55; i += 1) {
      await thread({ needsOwner: true, needsOwnerReason: "SECRET-REASON" });
    }
    expect((await call(badgeGET)).json.count).toBe(55);
    expect((await call(summaryGET)).json.count).toBe(55);
  });

  it("signed out, or the account is gone → 401 (the page clears the badge)", async () => {
    session.userId = null;
    expect((await call(badgeGET)).status).toBe(401);
    session.userId = "00000000-0000-4000-8000-000000000000";
    expect((await call(badgeGET)).status).toBe(401);
  });

  it("an evaluation still running or set up and paid keeps its badge", async () => {
    await seedMixedQueue();
    for (const values of [
      { status: "invited" as const },
      { status: "evaluating" as const, evaluationEndsAt: at(60 * 24) },
      { status: "setup_paid" as const },
    ]) {
      await setStatus(values);
      expect((await call(badgeGET)).json.count, values.status).toBe(4);
    }
  });

  describe("A6/A7: a read-only account's badge clears (count 0) on both routes", () => {
    const readOnly: [string, Partial<typeof workspaces.$inferInsert>][] = [
      // Stored as evaluating, but the clock ran out: expired before any job records it.
      ["evaluation over (stored evaluating)", { status: "evaluating", evaluationEndsAt: at(-1) }],
      ["evaluation_expired", { status: "evaluation_expired", evaluationEndsAt: at(-60) }],
      ["past_due", { status: "past_due" }],
      ["paused", { status: "paused" }],
      ["canceled", { status: "canceled" }],
    ];
    for (const [name, values] of readOnly) {
      it(name, async () => {
        await seedMixedQueue();
        await setStatus(values);
        const badge = await call(badgeGET);
        expect(badge.status).toBe(200);
        expect(badge.json).toEqual({ count: 0 });
        const summary = await call(summaryGET);
        expect(summary.status).toBe(200);
        expect(summary.json.count).toBe(0);
      });
    }
  });

  it("M11 C8: past the poll limit both routes answer 429 with Retry-After, uncached", async () => {
    // Use up this window's allowance (the badge and the push summary share one bucket).
    const { max, windowSec } = LIMITS.poll;
    const windowMs = windowSec * 1000;
    // Pin the clock mid-window so the routes' own window is the one seeded here.
    const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(windowStart.getTime() + windowMs / 2);
    try {
      await database.insert(rateLimits).values({
        key: `poll:${workspaceId}`,
        windowStart,
        count: max,
      });
      for (const get of [badgeGET, summaryGET]) {
        const res = await call(get);
        expect(res.status).toBe(429);
        expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
        expect(Number(res.headers.get("Retry-After"))).toBeLessThanOrEqual(windowSec);
        expect(res.headers.get("Cache-Control")).toBe("no-store");
        expect(res.json).not.toHaveProperty("count");
      }
      // Another owner isn't affected.
      const other = await ensureUserAndWorkspace({ email: "other@shop.com" });
      session.userId = other.user.id;
      expect((await call(badgeGET)).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the route's source counts with the content-free helpers and never listQueue", () => {
    for (const file of ["src/app/api/badge/route.ts", "src/server/badge.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/\blistQueue\s*[(,}]/);
    }
    expect(readFileSync("src/server/badge.ts", "utf8")).toMatch(
      /import\s*\{[^}]*\bqueueCounts\b[^}]*\}\s*from\s*"\.\/drafts"/,
    );
    expect(readFileSync("src/server/badge.ts", "utf8")).toContain("jobsAllowed");
  });
});
