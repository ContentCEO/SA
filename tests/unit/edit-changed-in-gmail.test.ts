import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import { drafts } from "@/db/schema";
import { bodyHash, reviseDraft, saveDraftEdit } from "@/server/drafts";
import { recordTermsAcceptance } from "@/server/terms";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";
import { READY_BODY, sendPathWorld } from "../support/send-path";

/**
 * Check 42 P2: Save in the editor and the quick changes never write over a draft someone
 * changed in Gmail (or on another device) since the app last saw it.
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

const GMAIL_TEXT = "Hi Dana,\nIt's $240 installed.\nThanks, Sam";
const modelDraft = (body: string) => ({
  body,
  reason: "Quote request.",
  flags: [],
  confidence: 0.95,
  used_facts: [],
});

describe("Check 42 P2: never overwrite a draft someone changed in Gmail", () => {
  let w: Awaited<ReturnType<typeof sendPathWorld>>;
  beforeEach(async () => {
    process.env.AI_DAILY_CALL_CAP = "100";
    w = await sendPathWorld();
  });
  const gmailText = (gmailDraftId: string) =>
    FakeWriter.bodyOf(w.writer.drafts.get(gmailDraftId)!.raw);

  it("edited in Gmail, then Save in the app → changed_in_gmail; Gmail keeps its text", async () => {
    const { draft } = await w.seed();
    w.writer.editInGmail(draft.gmailDraftId!, GMAIL_TEXT);
    const r = await saveDraftEdit(w.workspace.id, draft.id, "Hi Dana, other text.", w.deps());
    expect(r).toBe("changed_in_gmail");
    expect(w.writer.calls).not.toContain("updateDraft");
    expect(gmailText(draft.gmailDraftId!)).toBe(GMAIL_TEXT);
    expect((await w.row(draft.id)).body).toBe(GMAIL_TEXT);
  });

  it("edited in Gmail, then a quick change → changed_in_gmail, and the model is never called", async () => {
    const { draft } = await w.seed();
    const { transport, calls } = fakeTransport([modelDraft("Hi Dana, shorter.")]);
    setModelTransportForTests(transport);
    w.writer.editInGmail(draft.gmailDraftId!, GMAIL_TEXT);
    const r = await reviseDraft(w.workspace.id, draft.id, { tweak: "shorter" }, w.deps());
    expect(r).toEqual({ status: "changed_in_gmail" });
    expect(calls).toHaveLength(0);
    expect(w.writer.calls).not.toContain("updateDraft");
    expect(gmailText(draft.gmailDraftId!)).toBe(GMAIL_TEXT);
    const after = await w.row(draft.id);
    expect(after.body).toBe(GMAIL_TEXT);
    expect(after.revisions).toBe(0);
  });

  it("edited in Gmail while the model was writing → the rewrite isn't written over it", async () => {
    const { draft } = await w.seed();
    const { transport } = fakeTransport([modelDraft("Hi Dana, shorter.")]);
    setModelTransportForTests(async (req) => {
      w.writer.editInGmail(draft.gmailDraftId!, GMAIL_TEXT);
      return transport(req);
    });
    const r = await reviseDraft(w.workspace.id, draft.id, { tweak: "shorter" }, w.deps());
    expect(r).toEqual({ status: "changed_in_gmail" });
    expect(gmailText(draft.gmailDraftId!)).toBe(GMAIL_TEXT);
    expect((await w.row(draft.id)).body).toBe(GMAIL_TEXT);
  });

  it("saved on another device since the editor opened → changed_since_opened, nothing written", async () => {
    const { draft } = await w.seed();
    const opened = bodyHash(READY_BODY);
    // The other device's save: both the app's copy and Gmail have its text.
    w.writer.editInGmail(draft.gmailDraftId!, GMAIL_TEXT);
    await w.database.update(drafts).set({ body: GMAIL_TEXT }).where(eq(drafts.id, draft.id));
    expect(
      await saveDraftEdit(w.workspace.id, draft.id, "Mine.", { ...w.deps(), openedHash: opened }),
    ).toBe("changed_since_opened");
    const { transport, calls } = fakeTransport([modelDraft("x")]);
    setModelTransportForTests(transport);
    expect(
      await reviseDraft(
        w.workspace.id,
        draft.id,
        { tweak: "warmer" },
        { ...w.deps(), openedHash: opened },
      ),
    ).toEqual({ status: "changed_since_opened" });
    expect(calls).toHaveLength(0);
    expect(w.writer.calls).toEqual([]);
    expect(gmailText(draft.gmailDraftId!)).toBe(GMAIL_TEXT);
  });

  it("a normal save still works, with or without the opened fingerprint", async () => {
    const { draft } = await w.seed();
    expect(
      await saveDraftEdit(w.workspace.id, draft.id, "Hi Dana, Thursday works.", {
        ...w.deps(),
        openedHash: bodyHash(READY_BODY),
      }),
    ).toBe("saved");
    expect(gmailText(draft.gmailDraftId!)).toBe("Hi Dana, Thursday works.");
    expect(await saveDraftEdit(w.workspace.id, draft.id, "Hi Dana, Friday.", w.deps())).toBe(
      "saved",
    );
    expect((await w.row(draft.id)).body).toBe("Hi Dana, Friday.");
  });

  it("through the Edit box: the newest text comes back, and what was typed is kept", async () => {
    await recordTermsAcceptance(w.user.id);
    session.userId = w.user.id;
    const { editorAction } = await import("@/app/(app)/queue/actions");
    const { draft } = await w.seed();
    // Saved from another device: the app's copy moved on (no Gmail call is needed to see it).
    await w.database.update(drafts).set({ body: GMAIL_TEXT }).where(eq(drafts.id, draft.id));
    const f = new FormData();
    f.set("draftId", draft.id);
    f.set("opened", bodyHash(READY_BODY));
    f.set("body", "Hi Dana, my own words. P.S. thanks!");
    const state = await editorAction({ message: null, latest: null, typed: null }, f);
    expect(state.message).toContain("This reply changed while you were editing.");
    expect(state.latest).toEqual({ body: GMAIL_TEXT, hash: bodyHash(GMAIL_TEXT) });
    expect(state.typed).toBe("Hi Dana, my own words. P.S. thanks!");
    expect(w.writer.calls).toEqual([]);
  });
});
