import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { drafts, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
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
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

describe("/api/push/summary counts like the queue (plan #36, M8 A1)", () => {
  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    database = await createTestDb();
    const { user, workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    session.userId = user.id;
    await database
      .update(workspaces)
      .set({ status: "active" })
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
  });

  it("counts what is on the queue, and says nothing about it but numbers", async () => {
    await thread({ needsOwner: true, needsOwnerReason: "SECRET-REASON", snoozedUntil: at(180) });
    await thread({ needsOwner: true, needsOwnerReason: "SECRET-REASON" });
    await draft((await thread()).id);
    await draft((await thread()).id, { sendAfter: at(0.5) });

    const { json } = await summary();
    expect(json.body).toBe("1 email needs you · 1 reply ready to send");
    expect(JSON.stringify(json)).not.toMatch(/SECRET|@example\.com/i);
  });

  it("signed out → 401", async () => {
    session.userId = null;
    expect((await summary()).status).toBe(401);
  });

  it("the route's source imports queueCounts and never listQueue", () => {
    const src = readFileSync("src/app/api/push/summary/route.ts", "utf8");
    expect(src).toMatch(/import\s*\{[^}]*\bqueueCounts\b[^}]*\}\s*from\s*"@\/server\/drafts"/);
    expect(src).not.toMatch(/\blistQueue\s*[(,}]/);
  });
});
