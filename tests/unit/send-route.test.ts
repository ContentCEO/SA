import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { drafts, mailboxes, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { recordTermsAcceptance } from "@/server/terms";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";
import { FakeWriter } from "../support/fake-writer";

/**
 * Milestone 11 S4 / C5: POST /api/drafts/[id]/send — the JSON way to send. Same-origin only
 * (a missing, "null" or garbled Origin is a plain 403, never a 500), signed in, and the send
 * gate before any Gmail call.
 */

// The signed-in owner, without Auth.js: the route only reads `session.user.id`.
const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/auth", () => ({
  auth: async () => (session.userId ? { user: { id: session.userId, sv: 0 } } : null),
}));
// Every Gmail call the route could make lands here, so the test can prove none happened.
const gmail = vi.hoisted(() => ({ writer: null as FakeWriter | null, built: 0 }));
vi.mock("@/mailbox/gmail/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mailbox/gmail/api")>()),
  createGmailReader: () => {
    gmail.built++;
    return gmail.writer!;
  },
}));

// The background job isn't under test: record what the route queues instead of calling Inngest.
const queued = vi.hoisted(() => [] as unknown[]);
vi.mock("@/jobs/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/jobs/client")>()),
  enqueue: async (event: unknown) => {
    queued.push(event);
  },
}));

const { POST } = await import("@/app/api/drafts/[id]/send/route");

const HOST = "sa.example.com";
let database: Database;
let workspaceId: string;
let draftId: string;

function send(headers: Record<string, string>, body: unknown = {}) {
  const req = new NextRequest(`https://${HOST}/api/drafts/${draftId}/send`, {
    method: "POST",
    headers: { host: HOST, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ id: draftId }) });
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
  gmail.writer = new FakeWriter();
  gmail.built = 0;
  queued.length = 0;
  const remote = await gmail.writer.createDraft({
    threadId: "g1",
    raw: Buffer.from(
      `To: dana@x.com\r\n\r\n${Buffer.from("Tuesday at 9 works.").toString("base64")}`,
    ).toString("base64url"),
  });
  gmail.writer.calls.length = 0;
  const { user, workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  // Agreed to the current terms (an owner who hasn't gets a 403: terms-agreement.test.ts).
  await recordTermsAcceptance(user.id);
  session.userId = user.id;
  workspaceId = workspace.id;
  const mailbox = await saveConnectedMailbox(workspace, {
    email: "owner@shop.com",
    refreshToken: "rt",
    grantedScopes: [],
  });
  const [t] = await database
    .insert(threads)
    .values({ mailboxId: mailbox.id, gmailThreadId: "g1", inInbox: true, category: "scheduling" })
    .returning();
  const [m] = await database
    .insert(messages)
    .values({
      threadId: t!.id,
      mailboxId: mailbox.id,
      gmailMessageId: "g1-m",
      direction: "in",
      fromAddress: "dana@x.com",
      sentAt: new Date(Date.now() - 3600_000),
    })
    .returning();
  const [d] = await database
    .insert(drafts)
    .values({
      threadId: t!.id,
      mailboxId: mailbox.id,
      gmailDraftId: remote.draftId,
      replyToMessageId: m!.id,
      toAddress: "dana@x.com",
      subject: "Re: Tuesday",
      body: "Tuesday at 9 works.",
      originalBody: "Tuesday at 9 works.",
      reason: "Confirms the time.",
      promptVersion: "draft.v5",
    })
    .returning();
  draftId = d!.id;
});
afterEach(() => vi.unstubAllGlobals());

const status = (values: Partial<typeof workspaces.$inferInsert>) =>
  database.update(workspaces).set(values).where(eq(workspaces.id, workspaceId));

describe("C5: the send API refuses anything but a same-origin request, without throwing", () => {
  for (const [name, headers] of [
    ["Origin: null (sandboxed frame, file://)", { origin: "null" }],
    ["a garbled Origin", { origin: "::not a url::" }],
    ["a cross-site Origin", { origin: "https://evil.example" }],
    ["a look-alike Origin", { origin: `https://${HOST}.evil.example` }],
    ["no Origin at all", {}],
  ] as [string, Record<string, string>][]) {
    it(`${name} → 403, nothing read or sent`, async () => {
      await status({ status: "active", setupPaidVia: "stripe" });
      const res = await send(headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Cross-site request refused." });
      expect(gmail.built).toBe(0);
      expect(queued).toEqual([]);
      const [d] = await database.select().from(drafts).where(eq(drafts.id, draftId));
      expect(d!.sendAfter).toBeNull();
    });
  }

  it("same origin but signed out → 401", async () => {
    session.userId = null;
    expect((await send({ origin: `https://${HOST}` })).status).toBe(401);
  });

  it("GUARDRAIL: same origin during the evaluation → 403 with zero Gmail calls", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    await status({ status: "evaluating", evaluationEndsAt: new Date(Date.now() + 86_400_000) });
    const res = await send({ origin: `https://${HOST}` });
    expect(res.status).toBe(403);
    expect(gmail.built).toBe(0);
    expect(gmail.writer!.calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    const [d] = await database.select().from(drafts).where(eq(drafts.id, draftId));
    expect(d!.status).toBe("pending");
    expect(d!.sendAfter).toBeNull();
    expect(queued).toEqual([]);
  });

  it("same origin, paid and active → 202 and the undo window starts (control case)", async () => {
    await status({ status: "active", setupPaidVia: "stripe" });
    const res = await send({ origin: `https://${HOST}` });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { status: string }).status).toBe("queued");
    expect(queued).toHaveLength(1);
    // Nothing has gone to the customer yet: the undo window comes first.
    expect(gmail.writer!.sent).toEqual([]);
  });

  it("plan #47: an inbox paused on the plan → 403 mailbox_paused, with no Gmail call and nothing queued", async () => {
    await status({ status: "active", setupPaidVia: "stripe" });
    await database
      .update(mailboxes)
      .set({ planPausedAt: new Date() })
      .where(eq(mailboxes.workspaceId, workspaceId));
    const res = await send({ origin: `https://${HOST}` });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ status: "mailbox_paused" });
    expect(gmail.writer!.calls).toEqual([]);
    expect(queued).toEqual([]);
  });
});
