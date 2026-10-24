import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { drafts, messages, threads, workspaces } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import { mailboxClientFor } from "@/mailbox/clients";
import { buildReplyMime, toGmailRaw } from "@/mailbox/mime";
import { createOutlookClient } from "@/mailbox/outlook/api";
import { parseOwnMime, rawToBase64 } from "@/mailbox/outlook/mime-parts";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { SendingBlockedError } from "@/server/lifecycle";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { sendDraft } from "@/server/drafts";
import { runBackfill, runIncrementalSync } from "@/server/sync";
import { createTestDb } from "../support/db";
import { createFakeGraph, type FakeGraph } from "../support/fake-graph";

/**
 * Plan #49: Outlook's write side. Drafts from our own MIME, updated in place, deleted only while
 * still drafts, sent only as "send this draft" — and only through sendDraft's gate.
 */

const NOW = new Date("2026-10-20T16:00:00Z");
let graph: FakeGraph;

beforeEach(() => {
  vi.stubEnv("FEATURE_OUTLOOK", "1");
  vi.stubEnv("MS_CLIENT_ID", "ms-id");
  vi.stubEnv("MS_CLIENT_SECRET", "ms-secret");
  graph = createFakeGraph({ owner: "owner@shop.com", now: () => NOW });
});
afterEach(() => vi.unstubAllEnvs());

const client = () =>
  createOutlookClient({
    refreshToken: graph.grantRefreshToken(),
    fetchImpl: graph.fetch,
    sleep: async () => {},
    now: () => NOW,
  });

const dana = { name: "Dana Ruiz", address: "dana@example.com" };
const reply = (lead: { internetMessageId: string }, body: string, subject = "Re: Deck") =>
  toGmailRaw(
    buildReplyMime({
      from: "owner@shop.com",
      fromName: "Sam Rossi",
      to: '"Dana Ruiz" <dana@example.com>',
      subject,
      inReplyTo: lead.internetMessageId,
      body,
    }),
  );
const sendCalls = () => graph.state.calls.filter((c) => /\/send$|sendMail/.test(c.path));

describe("our own MIME", () => {
  it("is read back into the parts Graph's update takes", () => {
    const raw = toGmailRaw(
      buildReplyMime({
        from: "o@shop.com",
        to: '"Dana" <dana@example.com>',
        subject: "Re: Terrasse en bois — devis",
        body: "Bonjour Dana,\n\nÇa marche.\nSam",
      }),
    );
    const p = parseOwnMime(Buffer.from(raw, "base64url").toString("utf8"));
    expect(p.subject).toBe("Re: Terrasse en bois — devis");
    expect(p.to).toEqual([{ name: "Dana", email: "dana@example.com" }]);
    expect(p.text).toBe("Bonjour Dana,\n\nÇa marche.\nSam");
    expect(p.html).toContain("<p>Bonjour Dana,</p><p>Ça marche.<br>Sam</p>");
    expect(rawToBase64(raw)).toBe(Buffer.from(raw, "base64url").toString("base64"));
    expect(() => parseOwnMime("To: x\r\n\r\nplain")).toThrow(/Not our MIME/);
  });
});

describe("Outlook drafts", () => {
  it("are made from our MIME, as text/plain base64, in the customer's conversation", async () => {
    const lead = graph.deliver({ from: dana, subject: "Deck", text: "Quote?" });
    const c = client();
    const d = await c.createDraft({ threadId: lead.conversationId, raw: reply(lead, "Hi Dana") });
    expect(d.draftId).toBe(d.messageId);
    const stored = graph.messages.get(d.draftId)!;
    expect(stored).toMatchObject({
      folder: "drafts",
      isDraft: true,
      conversationId: lead.conversationId,
      inReplyTo: lead.internetMessageId,
      subject: "Re: Deck",
      text: "Hi Dana",
    });
    expect(stored.to).toEqual([{ name: "Dana Ruiz", address: "dana@example.com" }]);
    // Never createReply (Microsoft's own quoted reply).
    expect(graph.state.calls.some((x) => /createReply/.test(x.path))).toBe(false);
    expect(await c.getDraft(d.draftId)).toEqual({
      draftId: d.draftId,
      messageId: d.draftId,
      threadId: lead.conversationId,
      bodyText: "Hi Dana",
    });
  });

  it("update keeps the same id (PATCH of the parts), and refuses a draft that was sent", async () => {
    const lead = graph.deliver({ from: dana, subject: "Deck", text: "Quote?" });
    const c = client();
    const d = await c.createDraft({ threadId: lead.conversationId, raw: reply(lead, "v1") });
    const u = await c.updateDraft(d.draftId, {
      threadId: lead.conversationId,
      raw: reply(lead, "v2\nline two"),
    });
    expect(u.messageId).toBe(d.draftId);
    expect(graph.messages.get(d.draftId)!.text).toBe("v2\nline two");
    expect(graph.messages.get(d.draftId)!.inReplyTo).toBe(lead.internetMessageId);
    const patch = graph.state.calls.find((x) => x.method === "PATCH");
    expect(patch?.path).toBe(`/me/messages/${d.draftId}`);
    await c.sendDraft(d.draftId);
    await expect(
      c.updateDraft(d.draftId, { threadId: lead.conversationId, raw: reply(lead, "v3") }),
    ).rejects.toThrow(/no longer exists/);
  });

  it("delete removes a draft, but never the Sent copy a sent draft became", async () => {
    const lead = graph.deliver({ from: dana, subject: "Deck", text: "Quote?" });
    const c = client();
    const a = await c.createDraft({ threadId: lead.conversationId, raw: reply(lead, "a") });
    await c.deleteDraft(a.draftId);
    expect(graph.messages.has(a.draftId)).toBe(false);
    await c.deleteDraft(a.draftId); // already gone: fine
    const b = await c.createDraft({ threadId: lead.conversationId, raw: reply(lead, "b") });
    await c.sendDraft(b.draftId);
    await c.deleteDraft(b.draftId);
    expect(graph.messages.get(b.draftId)).toMatchObject({ folder: "sentitems", isDraft: false });
    expect(graph.state.calls.filter((x) => x.method === "DELETE")).toHaveLength(1);
  });

  it("send = POST /send (202, no body); the sent id is the draft's immutable id", async () => {
    const lead = graph.deliver({ from: dana, subject: "Deck", text: "Quote?" });
    const c = client();
    const d = await c.createDraft({ threadId: lead.conversationId, raw: reply(lead, "Hi") });
    const sent = await c.sendDraft(d.draftId);
    expect(sent).toEqual({ messageId: d.draftId, threadId: lead.conversationId });
    expect(graph.state.sends).toEqual([
      expect.objectContaining({ id: d.draftId, to: ["dana@example.com"] }),
    ]);
    expect(await c.getDraft(d.draftId)).toBeNull(); // sent: no longer a draft
    await expect(c.sendDraft(d.draftId)).rejects.toThrow(/no longer exists/);
    expect(sendCalls()).toHaveLength(1);
    expect(graph.state.calls.filter((x) => x.path !== "/token" && x.noImmutableId)).toEqual([]);
  });

  it("lists a conversation's messages and the owner's own unsent drafts (ids and labels only)", async () => {
    const lead = graph.deliver({ from: dana, subject: "Deck", text: "Quote?" });
    const c = client();
    const ours = await c.createDraft({ threadId: lead.conversationId, raw: reply(lead, "x") });
    expect(await c.threadDraftMessageIds(lead.conversationId)).toEqual([ours.draftId]);
    const labels = await c.threadMessageLabels(lead.conversationId);
    expect(labels).toEqual([
      { id: lead.id, labelIds: ["INBOX"] },
      { id: ours.draftId, labelIds: ["DRAFT"] },
    ]);
    expect(await c.threadMessageLabels("conv-none")).toEqual([]);
  });

  it("a practice copy is made as a draft and sent (so it has an id)", async () => {
    const c = client();
    const raw = toGmailRaw(
      buildReplyMime({
        from: "owner@shop.com",
        to: "owner@shop.com",
        subject: "[Practice] Re: Deck",
        body: "x",
      }),
    );
    const r = await c.sendMessage(raw);
    expect(graph.state.sends).toEqual([
      expect.objectContaining({ id: r.messageId, to: ["owner@shop.com"] }),
    ]);
  });
});

describe("mailboxClientFor builds the Outlook client (one provider switch)", () => {
  it("for provider outlook, and with the switch off it contacts no Microsoft host", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const f = vi.fn(graph.fetch);
    vi.stubGlobal("fetch", f);
    const box = {
      id: "m1",
      provider: "outlook" as const,
      encryptedRefreshToken: encryptSecret(graph.grantRefreshToken()),
    };
    const c = mailboxClientFor(box);
    expect((await c.getProfile()).emailAddress).toBe("owner@shop.com");
    expect(String(f.mock.calls[0]![0])).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    );
    f.mockClear();
    vi.stubEnv("FEATURE_OUTLOOK", "");
    await expect(mailboxClientFor(box).getProfile()).rejects.toThrow(/not switched on/);
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("GUARDRAIL: an Outlook send goes through sendDraft's gate", () => {
  let database: Database;
  let workspaceId: string;
  let mailboxId: string;

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    workspaceId = workspace.id;
    const m = await saveConnectedMailbox(
      workspace,
      { email: "owner@shop.com", refreshToken: "rt", grantedScopes: [] },
      "outlook",
    );
    mailboxId = m.id;
  });

  async function seedDraft() {
    const lead = graph.deliver({
      from: dana,
      subject: "Deck",
      text: "Quote?",
      at: new Date(NOW.getTime() - 3_600_000),
    });
    const deps = { readerFor: () => client(), now: () => NOW };
    await runBackfill(mailboxId, deps);
    const [t] = await database.select().from(threads);
    const [msg] = await database.select().from(messages);
    const body = "Hi Dana,\nHappy to look. What's the address?\nSam";
    const d = await client().createDraft({ threadId: lead.conversationId, raw: reply(lead, body) });
    const [row] = await database
      .insert(drafts)
      .values({
        threadId: t!.id,
        mailboxId,
        gmailDraftId: d.draftId,
        gmailMessageId: d.messageId,
        replyToMessageId: msg!.id,
        toAddress: "dana@example.com",
        subject: "Re: Deck",
        body,
        originalBody: body,
        reason: "Asked for the address.",
        flags: [],
        confidence: 92,
        kind: "reply",
        createdAt: new Date(NOW.getTime() - 60_000),
      })
      .returning();
    graph.state.calls.length = 0;
    return { lead, draft: row! };
  }

  it("during the trial: 403 (SendingBlockedError) and not one Microsoft call", async () => {
    await database
      .update(workspaces)
      .set({ status: "evaluating", evaluationEndsAt: new Date(Date.now() + 3 * 86_400_000) })
      .where(eq(workspaces.id, workspaceId));
    const { draft } = await seedDraft();
    await expect(
      sendDraft(workspaceId, draft.id, { writerFor: () => client(), now: () => NOW }),
    ).rejects.toBeInstanceOf(SendingBlockedError);
    expect(graph.state.calls).toEqual([]);
    expect(graph.state.sends).toEqual([]);
  });

  it("once setup is paid: sent through Graph, stored as the owner's mail, and synced once", async () => {
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, workspaceId));
    const { lead, draft } = await seedDraft();
    const out = await sendDraft(workspaceId, draft.id, {
      writerFor: () => client(),
      now: () => NOW,
    });
    expect(out.status).toBe("sent");
    expect(graph.state.sends).toEqual([
      expect.objectContaining({ id: draft.gmailDraftId, to: ["dana@example.com"] }),
    ]);
    const [after] = await database.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(after!.status).toBe("sent");
    expect(after!.sentGmailMessageId).toBe(draft.gmailDraftId);
    await runIncrementalSync(mailboxId, { readerFor: () => client(), now: () => NOW });
    const rows = await database.select().from(messages);
    const sentRow = rows.find((r) => r.gmailMessageId === draft.gmailDraftId)!;
    expect(sentRow).toMatchObject({ direction: "out", labelIds: ["SENT"] });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.threadId)).size).toBe(1);
    expect(lead.conversationId).toBe(graph.messages.get(draft.gmailDraftId!)!.conversationId);
  });
});
