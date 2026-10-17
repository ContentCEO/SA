import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callStructured, setModelTransportForTests } from "@/ai/client";
import { classificationSchema } from "@/ai/prompts/classify.v4";
import { aiMaxRetries, aiTimeouts } from "@/config/models";
import type { Database } from "@/db";
import { usage } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { recordTermsAcceptance } from "@/server/terms";
import { createTestDb } from "../support/db";

/** Check 48 P4: no model call outlives its limit, a timeout is refunded, a tap gets plain words. */

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
const model = vi.hoisted(() => ({
  createDraftForThread: vi.fn(),
  reviseDraft: vi.fn(),
}));
vi.mock("@/server/drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/drafts")>()),
  createDraftForThread: model.createDraftForThread,
  reviseDraft: model.reviseDraft,
}));
const { draftReplyAction, reviseDraftAction } = await import("@/app/(app)/queue/actions");

let database: Database;
let workspaceId: string;
const NOW = new Date("2026-10-17T12:00:00Z");

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "10";
  database = await createTestDb();
  const { user, workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  await recordTermsAcceptance(user.id);
  session.userId = user.id;
  workspaceId = workspace.id;
});
afterEach(() => {
  setModelTransportForTests(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const req = (mode?: "interactive" | "job") => ({
  workspaceId,
  role: "classify" as const,
  promptVersion: "classify.v4",
  maxTokens: 10,
  system: [{ text: "x", cache: false }],
  user: "SECRET-EMAIL-TEXT",
  schema: classificationSchema,
  now: NOW,
  ...(mode ? { mode } : {}),
});
const calls = async () =>
  (await database.select().from(usage).where(eq(usage.workspaceId, workspaceId)))[0]?.aiCalls ?? 0;

/** Starts a call whose transport never answers; resolves once the transport was reached. */
async function hangingCall(mode?: "interactive" | "job") {
  let reached!: () => void;
  const atModel = new Promise<void>((r) => (reached = r));
  const seen: (number | undefined)[] = [];
  setModelTransportForTests((r) => {
    seen.push(r.timeoutMs);
    reached();
    return new Promise(() => {});
  });
  const outcome = callStructured(req(mode)).then(
    () => "resolved",
    (e: unknown) => e,
  );
  await atModel;
  return { outcome, seen };
}

describe("model call time limits (Check 48 P4)", () => {
  it("config: 45 s on a tap, 90 s in a job, one SDK retry", () => {
    expect(aiTimeouts).toEqual({ interactiveMs: 45_000, jobMs: 90_000 });
    expect(aiMaxRetries).toBe(1);
    const src = readFileSync("src/ai/client.ts", "utf8");
    expect(src).toContain("maxRetries: aiMaxRetries");
    expect(src).toContain("{ timeout: req.timeoutMs }");
  });

  it("an owner's tap that never answers ends at 45 s as a refunded, content-free timeout", async () => {
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { outcome, seen } = await hangingCall("interactive");
    expect(seen[0]).toBeLessThanOrEqual(45_000);
    await vi.advanceTimersByTimeAsync(44_000);
    let settled = false;
    void outcome.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    vi.useRealTimers();
    const err = await outcome;
    expect(err).toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    expect(await calls()).toBe(0); // refunded
    const failed = errors.find((l) => l[0] === "ai_call_failed");
    expect(failed![1]).toMatchObject({ error: "timeout" });
    expect(JSON.stringify(errors)).not.toContain("SECRET");
  });

  it("a job's call ends at 90 s (not 45)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { outcome, seen } = await hangingCall();
    expect(seen[0]).toBeGreaterThan(45_000);
    expect(seen[0]).toBeLessThanOrEqual(90_000);
    let settled = false;
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(31_000);
    vi.useRealTimers();
    expect(await outcome).toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    expect(await calls()).toBe(0);
  });

  it("the owner's Draft a reply and Change it get the plain retry message", async () => {
    const whereTo = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (err) {
        if (err instanceof Redirected) return err.url;
        throw err;
      }
      throw new Error("no redirect");
    };
    const form = (f: Record<string, string>) => {
      const d = new FormData();
      for (const [k, v] of Object.entries(f)) d.set(k, v);
      return d;
    };
    const id = "00000000-0000-4000-8000-000000000001";
    model.createDraftForThread.mockRejectedValueOnce(new Anthropic.APIConnectionTimeoutError());
    expect(await whereTo(() => draftReplyAction(form({ threadId: id })))).toBe(
      "/queue?error=ai_busy",
    );
    expect(model.createDraftForThread.mock.calls[0]![1]).toMatchObject({ aiMode: "interactive" });
    model.reviseDraft.mockRejectedValueOnce(new Anthropic.APIConnectionTimeoutError());
    expect(
      await whereTo(() => reviseDraftAction(form({ draftId: id, spoken: "make it shorter" }))),
    ).toBe("/queue?error=ai_busy");
    expect(model.reviseDraft.mock.calls[0]![3]).toEqual({ aiMode: "interactive" });
    // Our own bug is not dressed up as "try again".
    model.createDraftForThread.mockRejectedValueOnce(new Error("bug"));
    await expect(draftReplyAction(form({ threadId: id }))).rejects.toThrow("bug");
    expect(readFileSync("src/app/(app)/queue/page.tsx", "utf8")).toContain(
      'ai_busy: "Writing is slow right now, so nothing changed. Try again in a moment."',
    );
  });
});
