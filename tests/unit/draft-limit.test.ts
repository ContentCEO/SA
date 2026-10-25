import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { rateLimits } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { draftLimitText, draftLimitUntil } from "@/server/draft-limit-rules";
import { hitLimit, LIMITS, MAX_WINDOW_SEC } from "@/server/rate-limit";
import { recordTermsAcceptance } from "@/server/terms";
import { createTestDb } from "../support/db";

/**
 * Check 40 P3: a storm-day owner can tap Draft a reply 90 times an hour; only taps that reach
 * the model count; the refusal names the time they can ask again, in their own zone.
 */

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/auth", () => ({
  auth: async () => (session.userId ? { user: { id: session.userId, sv: 0 } } : null),
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
type Opts = { beforeModelCall?: () => Promise<boolean> };
/** What the stand-in createDraftForThread does: reach the model, or stop before it. */
const stand = vi.hoisted(() => ({ mode: "model" as "model" | "already_pending", modelCalls: 0 }));
vi.mock("@/server/drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/drafts")>()),
  createDraftForThread: async (_id: string, opts: Opts) => {
    if (stand.mode === "already_pending") return { status: "skipped", reason: "already_pending" };
    if (opts.beforeModelCall && !(await opts.beforeModelCall()))
      return { status: "skipped", reason: "rate_limited" };
    stand.modelCalls += 1;
    return { status: "created", draftId: "d1" };
  },
  pendingDraftCreatedAt: async () => new Date(),
}));
const { draftReplyAction } = await import("@/app/(app)/queue/actions");
const { askForReviewAction } = await import("@/app/(app)/inbox/actions");

const THREAD = "00000000-0000-4000-8000-000000000001";
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const whereTo = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (err) {
    if (err instanceof Redirected) return err.url;
    throw err;
  }
  return null;
};

let database: Database;
let workspaceId: string;
beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
  const { user, workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  await recordTermsAcceptance(user.id);
  session.userId = user.id;
  workspaceId = workspace.id;
  stand.mode = "model";
  stand.modelCalls = 0;
});

describe("LIMITS.draft", () => {
  it("is 90 an hour, a window under a day", () => {
    expect(LIMITS.draft).toEqual({ max: 90, windowSec: 3600 });
    expect(LIMITS.draft.windowSec).toBeLessThanOrEqual(MAX_WINDOW_SEC);
  });

  it("90 taps pass and the 91st is refused, with the wait to the top of the hour", async () => {
    const now = new Date("2026-10-18T14:20:00Z");
    for (let i = 0; i < 90; i++)
      expect((await hitLimit("draft", workspaceId, now)).allowed).toBe(true);
    const refused = await hitLimit("draft", workspaceId, now);
    expect(refused).toEqual({ allowed: false, retryAfterSec: 40 * 60 });
  });
});

describe("GUARDRAIL: only a tap that reaches the model counts", () => {
  const counted = async () => (await database.select().from(rateLimits))[0]?.count ?? 0;

  it("an already-pending tap doesn't count; a drafted one does", async () => {
    stand.mode = "already_pending";
    await whereTo(() => draftReplyAction(form({ threadId: THREAD })));
    expect(await counted()).toBe(0);
    stand.mode = "model";
    expect(await whereTo(() => draftReplyAction(form({ threadId: THREAD })))).toMatch(
      /^\/queue\?done=drafted/,
    );
    expect(await counted()).toBe(1);
  });

  it("past the limit: no model call, and the notice carries the time the window ends", async () => {
    const now = Date.now();
    for (let i = 0; i < 90; i++) await hitLimit("draft", workspaceId);
    for (const tap of [
      () => draftReplyAction(form({ threadId: THREAD })),
      () => askForReviewAction(form({ threadId: THREAD })),
    ]) {
      const url = (await whereTo(tap))!;
      expect(url).toMatch(/^\/queue\?error=draft_limit&until=\d+$/);
      const until = Number(new URL(url, "http://x").searchParams.get("until"));
      const hourEnd = Math.ceil((now + 1) / 3_600_000) * 3_600_000;
      expect(Math.abs(until - hourEnd)).toBeLessThan(5_000);
    }
    expect(stand.modelCalls).toBe(0);
  });

  it("the real createDraftForThread asks only right before the model (a missing thread never does)", async () => {
    const real = await vi.importActual<typeof import("@/server/drafts")>("@/server/drafts");
    const beforeModelCall = vi.fn(async () => true);
    const r = await real.createDraftForThread(THREAD, {
      trigger: "owner",
      workspaceId,
      beforeModelCall,
    });
    expect(r).toEqual({ status: "skipped", reason: "not_found" });
    expect(beforeModelCall).not.toHaveBeenCalled();
  });
});

describe("the notice names the time", () => {
  const now = new Date("2026-10-18T13:20:00Z"); // 9:20am in Boston
  it("in the owner's time zone", () => {
    const until = draftLimitUntil(40 * 60, now);
    expect(draftLimitText(String(until), "America/New_York", now)).toBe(
      "You've asked for a lot of drafts this hour. You can ask again at 10:00am.",
    );
    expect(draftLimitText(String(until), "America/Chicago", now)).toBe(
      "You've asked for a lot of drafts this hour. You can ask again at 9:00am.",
    );
  });
  it("a missing, garbled or far-off time says no time", () => {
    for (const bad of [undefined, "x", String(now.getTime() - 1), String(now.getTime() + 9e9)])
      expect(draftLimitText(bad, "America/New_York", now)).toBe(
        "You've asked for a lot of drafts this hour. Try again in a little while.",
      );
  });
});
