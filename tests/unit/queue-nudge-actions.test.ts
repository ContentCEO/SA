import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { drafts, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { recordTermsAcceptance } from "@/server/terms";
import { createTestDb } from "../support/db";
import { FakeWriter } from "../support/fake-writer";

/** Check 21 P8: "They said no" and "Already paid" on a nudge card. */
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
// The real marks, with Gmail played by a FakeWriter.
const gmail = vi.hoisted(() => ({ writer: null as unknown }));
vi.mock("@/server/quotes", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/quotes")>();
  return {
    ...real,
    setQuoteOutcome: (w: string, t: string, o: Parameters<typeof real.setQuoteOutcome>[2]) =>
      real.setQuoteOutcome(w, t, o, undefined, new Date(), {
        writerFor: () => gmail.writer as FakeWriter,
      }),
  };
});
vi.mock("@/server/money", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/money")>();
  return {
    ...real,
    setInvoicePaid: (w: string, t: string, paid: boolean) =>
      real.setInvoicePaid(w, t, paid, new Date(), { writerFor: () => gmail.writer as FakeWriter }),
  };
});

const { nudgeSaidNoAction, nudgeAlreadyPaidAction } = await import("@/app/(app)/queue/actions");

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

let database: Database;
let workspaceId: string;
let mailboxId: string;
let writer: FakeWriter;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
  const { user, workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  await recordTermsAcceptance(user.id);
  session.userId = user.id;
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
  gmail.writer = writer;
});

/** A quiet quote or invoice thread with a nudge waiting (and in "Gmail"). */
async function nudgeOn(category: "quote_request" | "invoice_payment") {
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: `g-${category}`,
      inInbox: true,
      category,
      extracted:
        category === "invoice_payment"
          ? { invoice: { number: "1042", amount: 900, due_date: null, status: "unpaid" } }
          : {},
      lastMessageAt: new Date(Date.now() - 5 * 86_400_000),
    })
    .returning();
  const [m] = await database
    .insert(messages)
    .values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `m-${category}`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["sam@x.com"],
      labelIds: ["SENT"],
      sentAt: new Date(Date.now() - 5 * 86_400_000),
    })
    .returning();
  const gd = await writer.createDraft({ threadId: t!.gmailThreadId, raw: "x" });
  const [d] = await database
    .insert(drafts)
    .values({
      threadId: t!.id,
      mailboxId,
      replyToMessageId: m!.id,
      kind: "followup",
      gmailDraftId: gd.draftId,
      toAddress: "sam@x.com",
      subject: "Re: Quote",
      body: "Hi Sam, just checking in.",
      originalBody: "same",
      reason: "Follow-up 1 of 2",
      promptVersion: "followup.v4",
    })
    .returning();
  return { thread: t!, draft: d! };
}
const row = async (id: string) =>
  (await database.select().from(drafts).where(eq(drafts.id, id)))[0]!;

describe("Check 21 P8: closing the matter from a nudge card", () => {
  it("They said no: marks Lost by the owner, closes the nudge here and in Gmail", async () => {
    const { thread, draft } = await nudgeOn("quote_request");
    const next = "00000000-0000-4000-8000-0000000000aa";
    const url = await whereTo(() =>
      nudgeSaidNoAction(form({ threadId: thread.id, nextThreadId: next })),
    );
    expect(url).toBe(`/queue?done=marked_lost&t=${next}`);
    const [t] = await database.select().from(threads).where(eq(threads.id, thread.id));
    expect(t).toMatchObject({ quoteOutcome: "lost", quoteOutcomeSource: "owner" });
    expect((await row(draft.id)).status).toBe("expired");
    expect(writer.drafts.has(draft.gmailDraftId!)).toBe(false);
  });

  it("Already paid: marks the invoice paid and closes the nudge", async () => {
    const { thread, draft } = await nudgeOn("invoice_payment");
    const url = await whereTo(() => nudgeAlreadyPaidAction(form({ threadId: thread.id })));
    expect(url).toBe(`/queue?done=marked_paid&t=${thread.id}`);
    const [t] = await database.select().from(threads).where(eq(threads.id, thread.id));
    expect(t!.invoicePaidAt).not.toBeNull();
    expect((await row(draft.id)).status).toBe("expired");
    expect(writer.drafts.has(draft.gmailDraftId!)).toBe(false);
  });

  it("both refuse on a read-only account, and change nothing", async () => {
    await database
      .update(workspaces)
      .set({ status: "evaluation_expired", setupPaidVia: null })
      .where(eq(workspaces.id, workspaceId));
    const quote = await nudgeOn("quote_request");
    const bill = await nudgeOn("invoice_payment");
    expect(await whereTo(() => nudgeSaidNoAction(form({ threadId: quote.thread.id })))).toBe(
      `/queue?error=readonly&t=${quote.thread.id}`,
    );
    expect(await whereTo(() => nudgeAlreadyPaidAction(form({ threadId: bill.thread.id })))).toBe(
      `/queue?error=readonly&t=${bill.thread.id}`,
    );
    const rows = await database.select().from(threads);
    expect(rows.every((r) => r.quoteOutcome === null && r.invoicePaidAt === null)).toBe(true);
    expect((await row(quote.draft.id)).status).toBe("pending");
    expect((await row(bill.draft.id)).status).toBe("pending");
    expect(writer.drafts.size).toBe(2);
  });
});
