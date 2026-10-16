import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { Database } from "@/db";
import { activityLog, drafts, mailboxes, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";
import { classification, fakeTransport } from "../support/fake-model";

/**
 * GUARDRAIL (Milestone 11 S1, amendments A1/A2): /api/test-hooks/run is absent (404) unless
 * the app is in local e2e mode and the secret matches. (Other machines are kept off by the
 * loopback bind in playwright.config.ts — tests/unit/e2e-harness.test.ts — not by the route.)
 * When it does run, it calls the real job functions with the real clock and every gate.
 */

// 'voice' is made to throw on demand, to prove a failure answers with the error's name only.
const voice = vi.hoisted(() => ({ throwIt: false }));
vi.mock("@/server/voice", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/voice")>();
  return {
    ...real,
    learnVoice: async (...args: Parameters<typeof real.learnVoice>) => {
      if (voice.throwIt) {
        class BoomError extends Error {
          name = "BoomError";
        }
        throw new BoomError("SECRET owner@shop.com body text");
      }
      return real.learnVoice(...args);
    },
  };
});

const route = await import("@/app/api/test-hooks/run/route");
const { POST } = route;

const SECRET = randomBytes(24).toString("base64url"); // 32 characters
const E2E_ENV = {
  SA_E2E: "1",
  SA_E2E_GOOGLE_BASE_URL: "http://127.0.0.1:3301",
  SA_E2E_ANTHROPIC_BASE_URL: "http://127.0.0.1:3301",
  SA_E2E_HOOK_SECRET: SECRET,
  DATABASE_URL: "postgres://postgres@localhost:5432/squared_away_launch",
  VERCEL: undefined,
  VERCEL_ENV: undefined,
};
function stubEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

let database: Database;
let workspaceId: string;
let mailboxId: string;
// Any call to Google or Anthropic from this file is a failure: nothing may leave.
const fetchSpy = vi.fn(async () => {
  throw new Error("no network in this test");
});

async function hook(body: unknown, opts: { secret?: string | null; method?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  if (secret !== null) headers["x-e2e-hook-secret"] = secret;
  const res = await POST(
    new Request("http://localhost:3300/api/test-hooks/run", {
      method: opts.method ?? "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

async function seedInbound() {
  const [t] = await database
    .insert(threads)
    .values({ mailboxId, gmailThreadId: "gt-1", inInbox: true, lastMessageAt: new Date() })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: "gm-1",
    direction: "in",
    fromAddress: "dana@example.com",
    fromName: "Dana",
    // As sync stores it now: Reply-To read, none there (so drafting needs no Gmail read).
    replyToHeader: {},
    subject: "Panel upgrade",
    bodyText: "Could you quote a 200 amp panel upgrade?",
    labelIds: ["INBOX"],
    sentAt: new Date(Date.now() - 60 * 60_000),
  });
  return t!;
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "100";
  voice.throwIt = false;
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  workspaceId = workspace.id;
  mailboxId = (
    await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    })
  ).id;
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockClear();
  stubEnv(E2E_ENV);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("/api/test-hooks/run is a 404 everywhere but a local e2e run", () => {
  const step = () => ({ step: "classify", mailboxId });

  it("has no GET (or any other) handler — POST only", () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic"]);
  });

  it("404 without the flag, even with the right secret and loopback fakes", async () => {
    stubEnv({ SA_E2E: undefined });
    expect((await hook(step())).status).toBe(404);
    stubEnv({ SA_E2E: "true" });
    expect((await hook(step())).status).toBe(404);
  });

  it("404 on Vercel (production, preview, or VERCEL=1) even with the flag and the secret", async () => {
    for (const env of [{ VERCEL_ENV: "production" }, { VERCEL_ENV: "preview" }, { VERCEL: "1" }]) {
      vi.unstubAllEnvs();
      stubEnv({ ...E2E_ENV, ...env });
      expect((await hook(step())).status, JSON.stringify(env)).toBe(404);
    }
  });

  it("404 with flag + secret but no fake base URLs, or a non-loopback one", async () => {
    stubEnv({ SA_E2E_GOOGLE_BASE_URL: undefined, SA_E2E_ANTHROPIC_BASE_URL: undefined });
    expect((await hook(step())).status).toBe(404);
    vi.unstubAllEnvs();
    stubEnv({ ...E2E_ENV, SA_E2E_ANTHROPIC_BASE_URL: "http://localhost.evil.com" });
    expect((await hook(step())).status).toBe(404);
  });

  it("404 when the database isn't on this machine", async () => {
    stubEnv({ DATABASE_URL: "postgresql://u:p@ep-x-pooler.us-east-2.aws.neon.tech/neondb" });
    expect((await hook(step())).status).toBe(404);
  });

  it("404 for a missing, wrong or short secret", async () => {
    expect((await hook(step(), { secret: null })).status).toBe(404);
    expect((await hook(step(), { secret: "" })).status).toBe(404);
    expect((await hook(step(), { secret: `${SECRET}x` })).status).toBe(404);
    expect((await hook(step(), { secret: SECRET.slice(0, -1) })).status).toBe(404);
    // A secret under 32 characters switches the route off, even when the header matches it.
    const short = "s".repeat(31);
    stubEnv({ SA_E2E_HOOK_SECRET: short });
    expect((await hook(step(), { secret: short })).status).toBe(404);
  });

  it("none of the 404s touched the database's mail or the network", async () => {
    await seedInbound();
    stubEnv({ SA_E2E: undefined });
    expect((await hook(step())).status).toBe(404);
    const [m] = await database.select().from(messages);
    expect(m!.classifiedAt).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("in local e2e mode it runs the real job steps", () => {
  it("'classify' sorts the waiting mail through the model", async () => {
    const t = await seedInbound();
    const { transport, calls } = fakeTransport([classification()]);
    setModelTransportForTests(transport);
    const r = await hook({ step: "classify", mailboxId });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, classified: 1, capped: false, remaining: 0 });
    expect(calls).toHaveLength(1);
    const [row] = await database.select().from(threads).where(eq(threads.id, t.id));
    expect(row!.category).toBe("quote_request");
    // Ids and counts only: no text, names or addresses come back.
    expect(JSON.stringify(r.json)).not.toMatch(/Dana|@|panel/i);
  });

  it("'deliver' honours the real undo window: not_due, and nothing is sent", async () => {
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, workspaceId));
    const t = await seedInbound();
    const [d] = await database
      .insert(drafts)
      .values({
        threadId: t.id,
        mailboxId,
        gmailDraftId: "gd-1",
        toAddress: "dana@example.com",
        subject: "Re: Panel upgrade",
        body: "Happy to help.",
        originalBody: "Happy to help.",
        reason: "Quote request",
        promptVersion: "draft.v5",
        sendAfter: new Date(Date.now() + 20_000),
      })
      .returning();

    const r = await hook({ step: "deliver", draftId: d!.id });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ ok: false, status: "not_due" });

    const [after] = await database.select().from(drafts).where(eq(drafts.id, d!.id));
    expect(after).toMatchObject({
      status: "pending",
      sendClaimedAt: null,
      sentGmailMessageId: null,
    });
    expect(after!.sendAfter).not.toBeNull();
    const sent = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "reply_sent"));
    expect(sent).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("'backfill' on a read-only (expired) account returns that status, never success", async () => {
    await database
      .update(workspaces)
      .set({ status: "evaluation_expired" })
      .where(eq(workspaces.id, workspaceId));
    const r = await hook({ step: "backfill", mailboxId });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ ok: false, status: "skipped", reason: "read_only" });
    const [box] = await database.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(box!.backfillCompletedAt).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("'draft' where the model fails answers 409 with each thread's real reason", async () => {
    const t = await seedInbound();
    // One classification, then nothing usable for the draft (the first try and its retry).
    const { transport, calls } = fakeTransport([classification(), null, null, null, null]);
    setModelTransportForTests(transport);
    expect((await hook({ step: "classify", mailboxId })).status).toBe(200);

    const r = await hook({ step: "draft", mailboxId });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({
      ok: false,
      created: 0,
      drafts: [{ threadId: t.id, status: "skipped", reason: "model_failed" }],
    });
    expect(calls.length).toBeGreaterThan(1);
    expect(await database.select().from(drafts)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("'draft' on a read-only account or a lost mailbox says so (409), touching nothing", async () => {
    const t = await seedInbound();
    await database
      .update(threads)
      .set({ category: "quote_request", classifiedAt: new Date() })
      .where(eq(threads.id, t.id));
    const { transport, calls } = fakeTransport([]);
    setModelTransportForTests(transport);

    await database
      .update(workspaces)
      .set({ status: "evaluation_expired" })
      .where(eq(workspaces.id, workspaceId));
    let r = await hook({ step: "draft", mailboxId });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ ok: false, status: "skipped", reason: "read_only" });

    await database
      .update(workspaces)
      .set({ status: "invited" })
      .where(eq(workspaces.id, workspaceId));
    await database
      .update(mailboxes)
      .set({ status: "reconnect_needed" })
      .where(eq(mailboxes.id, mailboxId));
    r = await hook({ step: "draft", mailboxId });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ ok: false, status: "skipped", reason: "mailbox_inactive" });

    expect(calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await database.select().from(drafts)).toEqual([]);
  });

  it("'draft' with nothing due is a plain success", async () => {
    const r = await hook({ step: "draft", mailboxId });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, created: 0, drafts: [] });
  });

  it("'sync' before the backfill has finished says not_ready (409)", async () => {
    const r = await hook({ step: "sync", mailboxId });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ ok: false, status: "skipped", reason: "not_ready" });
  });

  it("a malformed step is a 400; a failure answers with the error's name only", async () => {
    expect((await hook({ step: "send", draftId: mailboxId })).status).toBe(400);
    expect((await hook({ step: "classify", mailboxId: "not-a-uuid" })).status).toBe(400);
    expect((await hook(null)).status).toBe(400);

    voice.throwIt = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await hook({ step: "voice", workspaceId });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: "BoomError" });
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/SECRET|@|body text/);
    errors.mockRestore();
  });
});
