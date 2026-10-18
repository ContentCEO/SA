import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { businessProfiles, drafts, mailboxes, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { recordTermsAcceptance } from "@/server/terms";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";

// The signed-in owner, without Auth.js: the route only reads `session.user.id`.
const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/auth", () => ({
  auth: async () => (session.userId ? { user: { id: session.userId } } : null),
}));
// GUARDRAIL (plan M8 A1): the summary counts from the content-free membership. listQueue
// loads names, summaries and draft text, so calling it from here fails the test.
vi.mock("@/server/drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/drafts")>()),
  listQueue: () => {
    throw new Error("/api/push/summary must count with queueCounts, never listQueue");
  },
}));

const { GET } = await import("@/app/api/push/summary/route");

let database: Database;
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
const summary = async () => {
  const res = await GET();
  return {
    status: res.status,
    headers: res.headers,
    json: (await res.json()) as Record<string, unknown>,
  };
};

describe("/api/push/summary counts like the queue (plan #36, M8 A1)", () => {
  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    database = await createTestDb();
    const { user, workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    // Agreed to the current terms (an owner who hasn't gets a 403: terms-agreement.test.ts).
    await recordTermsAcceptance(user.id);
    session.userId = user.id;
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, workspace.id));
    mailboxId = (
      await saveConnectedMailbox(workspace, {
        email: "owner@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
  });

  it("a snoozed needs-you email and a reply in its undo window aren't waiting", async () => {
    await thread({ needsOwner: true, needsOwnerReason: "SECRET-REASON", snoozedUntil: at(180) });
    await draft((await thread()).id, { sendAfter: at(0.5) });

    const { status, json } = await summary();
    expect(status).toBe(200);
    expect(json.body).toBe("Your queue is up to date.");
    // Plan #38: nothing waiting → the badge clears.
    expect(json.count).toBe(0);
  });

  it("counts what is on the queue, and says nothing about it but numbers", async () => {
    await thread({ needsOwner: true, needsOwnerReason: "SECRET-REASON", snoozedUntil: at(180) });
    await thread({ needsOwner: true, needsOwnerReason: "SECRET-REASON" });
    await draft((await thread()).id);
    await draft((await thread()).id, { sendAfter: at(0.5) });

    const { json } = await summary();
    expect(json.body).toBe("1 email needs you · 1 reply ready to send");
    // Plan #38: the badge number = replies + needs-you, the same numbers as the body.
    expect(json.count).toBe(2);
    expect(JSON.stringify(json)).not.toMatch(/SECRET|@example\.com/i);
  });

  it("Check 19 P1: a fresh quote request with no draft yet is named, and the tap opens Quotes", async () => {
    const t = await thread({
      category: "quote_request",
      classifiedAt: at(-1),
      lastMessageAt: at(-2),
    });
    const { json } = await summary();
    expect(json.body).toBe("1 new quote request");
    expect(json.body).not.toBe("Your queue is up to date.");
    expect(json.url).toBe("/quotes");
    expect(JSON.stringify(json)).not.toMatch(/SECRET|@example\.com/i);
    // Once its reply is drafted it is a queue card like any other: counted once, as a reply.
    await draft(t.id);
    const after = (await summary()).json;
    expect(after.body).toBe("1 reply ready to send");
    expect(after.url).toBe("/queue");
  });

  it("signed out → 401", async () => {
    session.userId = null;
    expect((await summary()).status).toBe(401);
  });

  it("right after an emergency push: the emergency words and that card, nothing else (B5 part 2)", async () => {
    const t = await thread({
      needsOwner: true,
      needsOwnerReason: "SECRET-REASON",
      priority: "high",
      extracted: { urgency: "emergency", address: "SECRET 12 Elm St" },
      emergencyAlertedAt: at(-1),
    });
    await thread({ needsOwner: true, needsOwnerReason: "SECRET-REASON" });
    const { json } = await summary();
    expect(json.body).toBe("An emergency email just came in. Open Squared Away.");
    expect(json.url).toBe(`/queue?t=${t.id}#t-${t.id}`);
    expect(json.count).toBe(2);
    expect(JSON.stringify(json)).not.toMatch(/SECRET|@example\.com|Elm/i);
    // A later ordinary push takes the words back to counts.
    const [w] = await database.select().from(workspaces);
    await database.insert(businessProfiles).values({ workspaceId: w!.id, pushLastSentAt: at(0) });
    expect((await summary()).json.body).toBe("2 emails need you");
  });

  it("the route's source counts from the content-free membership and never listQueue", () => {
    const src = readFileSync("src/app/api/push/summary/route.ts", "utf8");
    expect(src).toMatch(
      /import\s*\{[^}]*\b(queueCounts|queueMembership)\b[^}]*\}\s*from\s*"@\/server\/drafts"/,
    );
    expect(src).not.toMatch(/\blistQueue\s*[(,}]/);
  });
});

/* Plan #34: leads at risk on the phone, and where a tap goes (A25, A26). */
describe("/api/push/summary with leads at risk", () => {
  // Tuesday 1:01pm New York; the customer wrote at 9:00am (4 business hours and a minute).
  const NOW = new Date("2026-10-13T17:01:00Z");
  const NINE = new Date("2026-10-13T13:00:00Z");
  const ALLOWED = /^\/(queue|quotes)$|^\/queue\?t=([0-9a-f-]{36})#t-\2$/;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    database = await createTestDb();
    const { user, workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    // Agreed to the current terms (an owner who hasn't gets a 403: terms-agreement.test.ts).
    await recordTermsAcceptance(user.id);
    session.userId = user.id;
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, workspace.id));
    mailboxId = (
      await saveConnectedMailbox(workspace, {
        email: "owner@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
    await database.update(mailboxes).set({ lastSyncedAt: NOW }).where(eq(mailboxes.id, mailboxId));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const quoteRequest = async (over: Partial<typeof threads.$inferInsert> = {}) => {
    const t = await thread({ category: "quote_request", lastMessageAt: NINE, ...over });
    await database.update(messages).set({ sentAt: NINE }).where(eq(messages.threadId, t.id));
    return t;
  };

  it("GUARDRAIL: exactly title, body, url and count; counts only; the link is on the allow-list", async () => {
    const t = await quoteRequest({ needsOwner: true, needsOwnerReason: "SECRET-REASON" });
    const { status, headers, json } = await summary();
    expect(status).toBe(200);
    // Never kept by a cache: the link points at a card that may be gone by the next push.
    expect(headers.get("cache-control")).toContain("no-store");
    expect(Object.keys(json).sort()).toEqual(["body", "count", "title", "url"]);
    // An at-risk lead isn't counted twice: the badge is what's on the queue.
    expect(json.count).toBe(1);
    expect(json.body).toBe("1 quote request has waited over 4 hours · 1 email needs you");
    expect(json.url).toBe(`/queue?t=${t.id}#t-${t.id}`);
    expect(json.url).toMatch(ALLOWED);
    expect(JSON.stringify(json)).not.toMatch(/SECRET|@/i);
  });

  it("an at-risk lead with a draft waiting links to its draft card", async () => {
    const t = await quoteRequest();
    await draft(t.id);
    const { json } = await summary();
    expect(json.body).toBe("1 quote request has waited over 4 hours · 1 reply ready to send");
    expect(json.url).toBe(`/queue?t=${t.id}#t-${t.id}`);
  });

  it("A26: an at-risk lead with no card on the queue (no draft, not needs-you) → the quote tracker", async () => {
    const t = await quoteRequest();
    // Something else is on the queue — the link still doesn't point at a card that isn't there.
    const other = await thread({ needsOwner: true, needsOwnerReason: "SECRET-REASON" });
    const { json } = await summary();
    expect(json.body).toBe("1 quote request has waited over 4 hours · 1 email needs you");
    expect(json.url).toBe("/quotes");
    expect(json.url).not.toContain(t.id);
    expect(json.url).not.toContain(other.id);
  });

  it("A12: a lead whose draft was discarded is still waiting, off the queue → the quote tracker", async () => {
    const t = await quoteRequest();
    await draft(t.id, { status: "discarded", decidedAt: at(-30) });
    const { json } = await summary();
    expect(json.body).toBe("1 quote request has waited over 4 hours");
    expect(json.url).toBe("/quotes");
  });

  it("no lead at risk: the first needs-you card, else the queue", async () => {
    expect((await summary()).json.url).toBe("/queue");
    const t = await thread({ needsOwner: true, needsOwnerReason: "SECRET-REASON" });
    const { json } = await summary();
    expect(json.body).toBe("1 email needs you");
    expect(json.url).toBe(`/queue?t=${t.id}#t-${t.id}`);
  });
});
