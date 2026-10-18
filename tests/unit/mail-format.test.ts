import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { ModelDraft } from "@/ai/prompts/draft.v5";
import type { Database } from "@/db";
import { businessProfiles, drafts, mailboxes, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { createDraftForThread, listQueue, saveDraftEdit } from "@/server/drafts";
import { refreshSendAs } from "@/server/from-line";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

/** Wave 2 "Mail format": what the customer's email client sees on a stored Gmail draft. */

const NOW = new Date("2026-09-28T12:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const modelDraft = (over: Partial<ModelDraft> = {}): ModelDraft => ({
  body: "Hey Dana,\n\nWhat's the address?\n\nThanks, Mike",
  reason: "Quote request.",
  flags: [],
  confidence: 0.9,
  used_facts: [],
  ...over,
});

let database: Database;
let workspaceId: string;
let mailboxId: string;
let writer: FakeWriter;
const deps = () => ({ writerFor: () => writer, now: () => NOW });

const decodeWords = (v: string) =>
  v
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b: string) =>
      Buffer.from(b, "base64").toString("utf8"),
    );
const header = (raw: string, name: string) => {
  const head = FakeWriter.headersOf(raw);
  const m = head.match(new RegExp(`^${name}: (.*(?:\\r\\n[ \\t].*)*)`, "m"));
  return m ? decodeWords(m[1]!.replace(/\r\n[ \t]/g, " ")) : null;
};

async function seedThread(
  opts: { g?: string; to?: string[]; cc?: string[]; subject?: string; replyTo?: string } = {},
) {
  const g = opts.g ?? "gt1";
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: g,
      inInbox: true,
      subject: opts.subject ?? "Panel upgrade",
      category: "quote_request",
      summary: "Dana wants a quote.",
      classifiedAt: NOW,
      lastMessageAt: ago(1),
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `${g}-m1`,
    rfc822MessageId: `<${g}-m1@mail.x.com>`,
    direction: "in",
    fromAddress: "dana@x.com",
    fromName: "Dana Ruiz",
    toAddresses: opts.to ?? ["mike@rossi.com"],
    ccAddresses: opts.cc ?? [],
    replyToHeader: opts.replyTo ? { address: opts.replyTo } : {},
    subject: opts.subject ?? "Panel upgrade",
    bodyText: "Can you quote a panel upgrade?",
    sentAt: ago(2),
  });
  return t!;
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "100";
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({
    email: "mike@rossi.com",
    name: "Michael Rossi",
  });
  workspaceId = workspace.id;
  mailboxId = (
    await saveConnectedMailbox(workspace, {
      email: "mike@rossi.com",
      refreshToken: "rt",
      grantedScopes: [],
    })
  ).id;
  writer = new FakeWriter();
});

async function draftFor(threadId: string) {
  const { transport } = fakeTransport([modelDraft()]);
  setModelTransportForTests(transport);
  const r = await createDraftForThread(threadId, { trigger: "auto", ...deps() });
  expect(r.status).toBe("created");
  const [d] = await database.select().from(drafts).where(eq(drafts.threadId, threadId));
  return { draft: d!, raw: writer.drafts.get(d!.gmailDraftId!)!.raw };
}

describe("Check 43 P3: the From line carries the owner's name", () => {
  it("uses the Google account name until the owner picks one", async () => {
    const t = await seedThread();
    const { raw } = await draftFor(t.id);
    expect(header(raw, "From")).toBe('"Michael Rossi" <mike@rossi.com>');
  });

  it("uses the name from Settings, on the draft and on every rewrite", async () => {
    await database
      .insert(businessProfiles)
      .values({ workspaceId, fromName: "José Ramírez, Rossi Plumbing" });
    const t = await seedThread();
    const { draft, raw } = await draftFor(t.id);
    expect(header(raw, "From")).toBe("José Ramírez, Rossi Plumbing <mike@rossi.com>");
    expect(FakeWriter.headersOf(raw)).toMatch(/^[\x20-\x7e\r\n\t]*$/);
    await database
      .update(businessProfiles)
      .set({ fromName: "Mike Rossi" })
      .where(eq(businessProfiles.workspaceId, workspaceId));
    expect(await saveDraftEdit(workspaceId, draft.id, "New text, Mike", deps())).toBe("saved");
    const edited = writer.drafts.get(draft.gmailDraftId!)!.raw;
    expect(header(edited, "From")).toBe('"Mike Rossi" <mike@rossi.com>');
    expect(header(edited, "In-Reply-To")).toBe("<gt1-m1@mail.x.com>");
  });
});

describe("Check 42 P4: reply from the address the customer wrote to", () => {
  const mailbox = async () =>
    (await database.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)))[0]!;
  const reads = (list: string[] | Error) => () => ({
    listSendAs: async () => {
      if (list instanceof Error) throw list;
      return list;
    },
  });

  it("answers from office@ when the customer wrote to office@, and keeps it on rewrites", async () => {
    expect(
      await refreshSendAs(await mailbox(), reads(["mike@rossi.com", "office@rossi.com"])),
    ).toBe("ok");
    const t = await seedThread({ to: ["office@rossi.com"] });
    const { draft, raw } = await draftFor(t.id);
    expect(header(raw, "From")).toBe('"Michael Rossi" <office@rossi.com>');
    expect(draft.fromAddress).toBe("office@rossi.com");
    expect(await saveDraftEdit(workspaceId, draft.id, "New text", deps())).toBe("saved");
    expect(header(writer.drafts.get(draft.gmailDraftId!)!.raw, "From")).toBe(
      '"Michael Rossi" <office@rossi.com>',
    );
    const q = await listQueue(workspaceId, NOW);
    expect(q.drafts[0]!.fromAddress).toBe("office@rossi.com");
  });

  it("changes nothing for a customer who wrote to the connected address", async () => {
    await refreshSendAs(await mailbox(), reads(["mike@rossi.com", "office@rossi.com"]));
    const t = await seedThread({ to: ["mike@rossi.com"], cc: ["office@rossi.com"] });
    const { draft, raw } = await draftFor(t.id);
    expect(header(raw, "From")).toBe('"Michael Rossi" <mike@rossi.com>');
    expect(draft.fromAddress).toBeNull();
  });

  it("a failed send-as read keeps From as the connected address and drafting works", async () => {
    expect(await refreshSendAs(await mailbox(), reads(new Error("boom")))).toBe("failed");
    expect((await mailbox()).sendAs).toEqual([]);
    const t = await seedThread({ to: ["office@rossi.com"] });
    const { draft, raw } = await draftFor(t.id);
    expect(header(raw, "From")).toBe('"Michael Rossi" <mike@rossi.com>');
    expect(draft.fromAddress).toBeNull();
  });
});

describe("Check 43 P5: a form lead's reply subject", () => {
  it("a Reply-To lead gets 'Your request to <shop>', with the threading kept", async () => {
    await database
      .update(workspaces)
      .set({ businessName: "Rossi Plumbing" })
      .where(eq(workspaces.id, workspaceId));
    const t = await seedThread({
      subject: "Form Submission - Request a quote",
      replyTo: "dana.home@example.com",
    });
    const { draft, raw } = await draftFor(t.id);
    expect(draft.toAddress).toBe("dana.home@example.com");
    expect(draft.subject).toBe("Your request to Rossi Plumbing");
    expect(header(raw, "Subject")).toBe("Your request to Rossi Plumbing");
    expect(header(raw, "In-Reply-To")).toBe("<gt1-m1@mail.x.com>");
    const q = await listQueue(workspaceId, NOW);
    expect(q.drafts[0]!.subject).toBe("Your request to Rossi Plumbing");
  });

  it("an ordinary email keeps Re:", async () => {
    const t = await seedThread({ subject: "Form Submission - Request a quote" });
    const { raw } = await draftFor(t.id);
    // Written by the customer themselves (no Reply-To): their subject, as they wrote it.
    expect(header(raw, "Subject")).toBe("Re: Form Submission - Request a quote");
  });
});
