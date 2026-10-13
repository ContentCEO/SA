import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { rateLimits, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { LIMITS } from "@/server/rate-limit";
import { createTestDb } from "../support/db";

/**
 * M11 C8: the owner's taps that write to Gmail (save an edit, discard a draft) are limited per
 * workspace. Driven through the real server actions, so removing the `hitLimit("gmailWrite", …)`
 * line from either one fails here.
 */

// The signed-in owner, without Auth.js: requireOwner() only reads `session.user.id`.
const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/auth", () => ({
  auth: async () => (session.userId ? { user: { id: session.userId } } : null),
}));

// redirect() ends the action; the test reads where it went.
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

// Stand-ins for the Gmail writes: the test only asks whether the action reached them.
const writes = vi.hoisted(() => ({
  saveDraftEdit: vi.fn(async () => "saved" as const),
  discardDraft: vi.fn(async () => undefined),
}));
vi.mock("@/server/drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/drafts")>()),
  saveDraftEdit: writes.saveDraftEdit,
  discardDraft: writes.discardDraft,
}));

const { saveDraftEditAction, discardDraftAction } = await import("@/app/(app)/queue/actions");

const DRAFT_ID = "00000000-0000-4000-8000-000000000001";
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
  throw new Error("the action didn't redirect");
};

describe("M11 C8: Gmail-writing taps are rate limited (through the actions)", () => {
  let database: Database;
  let workspaceId: string;
  const { max, windowSec } = LIMITS.gmailWrite;
  const windowMs = windowSec * 1000;
  let windowStart: Date;

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    database = await createTestDb();
    const { user, workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    session.userId = user.id;
    workspaceId = workspace.id;
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, workspaceId));
    writes.saveDraftEdit.mockClear();
    writes.discardDraft.mockClear();
    // Pin the clock mid-window so the actions count in the window seeded below.
    windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(windowStart.getTime() + windowMs / 2);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const save = () => saveDraftEditAction(form({ draftId: DRAFT_ID, body: "Hi Dana, Tuesday?" }));
  const discard = () => discardDraftAction(form({ draftId: DRAFT_ID }));

  it("under the limit, both taps reach Gmail (the test's own control)", async () => {
    expect(await whereTo(save)).toBe("/queue?done=saved");
    expect(await whereTo(discard)).toBe("/queue?done=discarded");
    expect(writes.saveDraftEdit).toHaveBeenCalledTimes(1);
    expect(writes.discardDraft).toHaveBeenCalledTimes(1);
    const [row] = await database.select().from(rateLimits);
    expect(row).toMatchObject({ key: `gmailWrite:${workspaceId}`, count: 2 });
  });

  it("GUARDRAIL: past the limit, both taps stop before any Gmail write", async () => {
    await database
      .insert(rateLimits)
      .values({ key: `gmailWrite:${workspaceId}`, windowStart, count: max });
    expect(await whereTo(save)).toBe("/queue?error=busy");
    expect(await whereTo(discard)).toBe("/queue?error=busy");
    expect(writes.saveDraftEdit).not.toHaveBeenCalled();
    expect(writes.discardDraft).not.toHaveBeenCalled();
  });

  it("another owner's taps aren't counted against this one", async () => {
    await database
      .insert(rateLimits)
      .values({ key: `gmailWrite:${workspaceId}`, windowStart, count: max });
    const other = await ensureUserAndWorkspace({ email: "other@shop.com" });
    session.userId = other.user.id;
    expect(await whereTo(discard)).toBe("/queue?done=discarded");
    expect(writes.discardDraft).toHaveBeenCalledWith(other.workspace.id, DRAFT_ID);
  });
});
