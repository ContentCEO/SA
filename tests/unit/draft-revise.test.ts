import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { ModelDraft } from "@/ai/prompts/draft.v5";
import { isTweak, TWEAKS } from "@/ai/prompts/revise.v1";
import { MAX_REVISIONS_PER_DRAFT } from "@/config/drafting";
import type { Database } from "@/db";
import { activityLog, drafts, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { describeActivity } from "@/server/activity";
import { createDraftForThread, reviseDraft } from "@/server/drafts";
import { ReadOnlyError } from "@/server/lifecycle";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const NOW = new Date("2026-10-10T16:00:00Z");
const draft = (body: string, over: Partial<ModelDraft> = {}): ModelDraft => ({
  body,
  reason: "Quote request. Asked for the address.",
  flags: [],
  confidence: 0.95,
  used_facts: [],
  ...over,
});

describe("#3 quick tweaks and #4 voice edits", () => {
  let database: Database;
  let workspaceId: string;
  let mailboxId: string;
  let writer: FakeWriter;
  const deps = () => ({ writerFor: () => writer, now: () => NOW });

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.AI_DAILY_CALL_CAP = "100";
    database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    workspaceId = workspace.id;
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, workspaceId));
    mailboxId = (
      await saveConnectedMailbox(workspace, {
        email: "owner@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
    writer = new FakeWriter();
  });

  /** A thread with one inbound email and a clean pending draft. */
  async function pendingDraft(first = "Hi Dana, happy to look. What's the address?") {
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: "t1",
        inInbox: true,
        subject: "Deck",
        category: "quote_request",
        classifiedAt: NOW,
        lastMessageAt: NOW,
      })
      .returning();
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: "m1",
      rfc822MessageId: "<m1@x.com>",
      direction: "in",
      fromAddress: "dana@x.com",
      fromName: "Dana",
      subject: "Deck",
      bodyText: "Can you quote a deck repair?",
      sentAt: new Date(NOW.getTime() - 3600_000),
    });
    setModelTransportForTests(fakeTransport([draft(first)]).transport);
    await createDraftForThread(t!.id, { trigger: "auto", ...deps() });
    const [d] = await database.select().from(drafts);
    return d!;
  }

  it("a tweak rewrites the draft here and in Gmail, and sends nothing", async () => {
    const d = await pendingDraft();
    const { transport, calls } = fakeTransport([draft("Hi Dana — address?")]);
    setModelTransportForTests(transport);
    writer.calls.length = 0;

    const r = await reviseDraft(workspaceId, d.id, { tweak: "shorter" }, deps());
    expect(r).toEqual({ status: "revised", flags: [] });
    expect(calls[0]!.user).toContain(TWEAKS.shorter.ask);
    expect(calls[0]!.user).toContain("What's the address?");
    const [after] = await database.select().from(drafts);
    expect(after!.body).toBe("Hi Dana — address?");
    expect(after!.status).toBe("pending");
    expect(after!.revisions).toBe(1);
    expect(FakeWriter.bodyOf(writer.drafts.get(d.gmailDraftId!)!.raw)).toBe("Hi Dana — address?");
    expect(writer.calls).toEqual(["getDraft", "updateDraft"]);
    expect(writer.sent).toEqual([]);
  });

  it("a tweak can't introduce a price: one retry, then a flag", async () => {
    const d = await pendingDraft();
    setModelTransportForTests(
      fakeTransport([draft("Hi Dana, it's $900."), draft("Hi Dana, it's $950 all in.")]).transport,
    );
    await reviseDraft(workspaceId, d.id, { tweak: "warmer" }, deps());
    const [after] = await database.select().from(drafts);
    expect(after!.flags.join(" ")).toContain("$950");
    expect(after!.confidence).toBeLessThanOrEqual(50);
  });

  it("a tweak can't launder a flag: a flagged draft's own text isn't evidence", async () => {
    const d = await pendingDraft();
    await database
      .update(drafts)
      .set({ body: "It's $700.", flags: ["Mentions $700 — not in the email."] })
      .where(eq(drafts.id, d.id));
    setModelTransportForTests(
      fakeTransport([draft("Hi Dana! It's $700."), draft("Hi Dana! It's $700.")]).transport,
    );
    await reviseDraft(workspaceId, d.id, { tweak: "warmer" }, deps());
    const [after] = await database.select().from(drafts);
    expect(after!.flags.join(" ")).toContain("$700");
  });

  it("what the owner says counts as a fact; the log never holds their words", async () => {
    const d = await pendingDraft();
    const said = "make it Tuesday at 8am and say it's $450";
    const { transport, calls } = fakeTransport([draft("Hi Dana, Tuesday at 8am, $450.")]);
    setModelTransportForTests(transport);
    const r = await reviseDraft(workspaceId, d.id, { spoken: said }, deps());
    expect(r).toEqual({ status: "revised", flags: [] });
    expect(calls[0]!.user).toContain(said);
    const logs = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "draft_revised"));
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0]!.detail)).not.toMatch(/Tuesday|450|Dana/);
    expect(logs[0]!.detail).toMatchObject({ via: "voice" });
    expect(
      describeActivity("draft_revised", logs[0]!.detail, { name: "Dana Lee", category: null }),
    ).toBe("You changed the draft to Dana by voice");
  });

  it(`stops after ${MAX_REVISIONS_PER_DRAFT} changes without calling the model`, async () => {
    const d = await pendingDraft();
    await database
      .update(drafts)
      .set({ revisions: MAX_REVISIONS_PER_DRAFT })
      .where(eq(drafts.id, d.id));
    const { transport, calls } = fakeTransport([draft("x")]);
    setModelTransportForTests(transport);
    expect(await reviseDraft(workspaceId, d.id, { tweak: "formal" }, deps())).toEqual({
      status: "limit",
    });
    expect(calls).toEqual([]);
  });

  it("a revision clears an autopilot countdown", async () => {
    const d = await pendingDraft();
    await database
      .update(drafts)
      .set({ autoSendAt: new Date(NOW.getTime() + 600_000) })
      .where(eq(drafts.id, d.id));
    setModelTransportForTests(fakeTransport([draft("Hi Dana — address?")]).transport);
    await reviseDraft(workspaceId, d.id, { tweak: "shorter" }, deps());
    const [after] = await database.select().from(drafts);
    expect(after!.autoSendAt).toBeNull();
  });

  it("read-only accounts can't revise, and nothing reaches the model or Gmail", async () => {
    const d = await pendingDraft();
    await database
      .update(workspaces)
      .set({ status: "canceled" })
      .where(eq(workspaces.id, workspaceId));
    const { transport, calls } = fakeTransport([draft("x")]);
    setModelTransportForTests(transport);
    writer.calls.length = 0;
    await expect(reviseDraft(workspaceId, d.id, { tweak: "shorter" }, deps())).rejects.toThrow(
      ReadOnlyError,
    );
    expect(calls).toEqual([]);
    expect(writer.calls).toEqual([]);
  });

  it("deleted in Gmail → the draft is discarded, not recreated", async () => {
    const d = await pendingDraft();
    writer.drafts.delete(d.gmailDraftId!);
    setModelTransportForTests(fakeTransport([draft("Hi Dana — address?")]).transport);
    expect(await reviseDraft(workspaceId, d.id, { tweak: "shorter" }, deps())).toEqual({
      status: "deleted_in_gmail",
    });
    const [after] = await database.select().from(drafts);
    expect(after!.status).toBe("discarded");
  });

  it("only the listed tweaks are accepted", () => {
    expect(isTweak("shorter")).toBe(true);
    expect(isTweak("send")).toBe(false);
    expect(isTweak("toString")).toBe(false);
  });
});
