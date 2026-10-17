import { describe, expect, it, vi } from "vitest";
import { QUEUE_ERRORS } from "@/app/(app)/queue/queue-messages";

/**
 * Check 9 P3 (through the actions): a Gmail hiccup during Send reply, Discard or a quick change
 * ends on a notice that says nothing was sent — a redirect, never a throw to the crash page.
 */
const session = vi.hoisted(() => ({ ws: "00000000-0000-4000-8000-0000000000aa" }));
vi.mock("@/server/session", () => ({
  requireOwner: async () => ({ workspace: { id: session.ws } }),
}));
vi.mock("@/server/rate-limit", () => ({ hitLimit: async () => ({ allowed: true }) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
class Redirected extends Error {
  constructor(readonly url: string) {
    super("redirect");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirected(url);
  },
}));
const outcome = vi.hoisted(() => ({ status: "gmail_busy" as string }));
vi.mock("@/server/drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/drafts")>()),
  queueSend: async () => ({ status: outcome.status }),
  discardDraft: async () => outcome.status,
  reviseDraft: async () => ({ status: outcome.status }),
}));

const { sendDraftAction, discardDraftAction, reviseDraftAction } =
  await import("@/app/(app)/queue/actions");
const DRAFT = "00000000-0000-4000-8000-000000000001";
const form = (f: Record<string, string>) => {
  const d = new FormData();
  for (const [k, v] of Object.entries(f)) d.set(k, v);
  return d;
};
const whereTo = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (err) {
    if (err instanceof Redirected) return err.url;
    throw err;
  }
  throw new Error("no redirect");
};

describe("Check 9 P3: queue actions turn Gmail hiccups into a notice", () => {
  for (const status of ["gmail_busy", "gmail_failed"]) {
    it(`Send reply: ${status} → the notice, and it says nothing was sent`, async () => {
      outcome.status = status;
      const url = await whereTo(() =>
        sendDraftAction(form({ draftId: DRAFT, seen: "a".repeat(64) })),
      );
      expect(url).toBe(`/queue?error=${status}`);
      expect(QUEUE_ERRORS[status]).toMatch(/nothing was sent/i);
    });
    it(`Discard: ${status} → the notice; the draft is still there`, async () => {
      outcome.status = status;
      const url = await whereTo(() => discardDraftAction(form({ draftId: DRAFT })));
      expect(url).toBe(`/queue?error=${status}_discard`);
      expect(QUEUE_ERRORS[`${status}_discard`]).toMatch(/still here/);
    });
    it(`Change it: ${status} → the notice`, async () => {
      outcome.status = status;
      const url = await whereTo(() =>
        reviseDraftAction(form({ draftId: DRAFT, tweak: "shorter" })),
      );
      expect(url).toBe(`/queue?error=${status}`);
    });
  }

  it("every refusal a Send reply tap can reach says whether anything was sent", () => {
    for (const key of [
      "gaps",
      "busy",
      "blocked",
      "changed",
      "deleted",
      "to_changed",
      "reconnect",
      "empty",
      "gone",
      "gmail_busy",
      "gmail_failed",
      "no_reply_address",
      "textaddr",
      "paused",
      "unknown",
    ])
      expect(QUEUE_ERRORS[key], key).toMatch(/nothing was sent|nothing was sent or written/i);
  });
});
