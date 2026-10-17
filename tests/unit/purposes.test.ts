import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { ModelDraft } from "@/ai/prompts/draft.v5";
import { DEPOSIT_GAP } from "@/ai/prompts/purpose.v1";
import {
  ensureDepositGap,
  isQuoteAcceptance,
  NO_PAYMENT_TERMS_FLAG,
  REVIEW_LINK_MISSING_FLAG,
} from "@/ai/purpose";
import type { Database } from "@/db";
import { activityLog, drafts, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  createDraftForThread,
  discardDraft,
  listQueue,
  queueSend,
  reconcileDrafts,
  reviseDraft,
  sendDraft,
  sentDraftSummary,
} from "@/server/drafts";
import { threadsToFollowUp } from "@/server/followups";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { businessProfileInput, saveBusinessProfile } from "@/server/profile";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const DAY = 86_400_000;
const NOW = new Date("2026-10-12T14:00:00Z");
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const REVIEW_URL = "https://g.page/r/elm-electric/review";

const reply = (over: Partial<ModelDraft> = {}): ModelDraft => ({
  body: "Hi Dana,\n\nGreat, thanks for going ahead. For the deposit: check or card is fine.\n\nThanks, Davi",
  reason: "Dana accepted the panel quote. Deposit details.",
  flags: [],
  confidence: 0.9,
  used_facts: ["payment_terms"],
  ...over,
});

let database: Database;
let workspaceId: string;
let mailboxId: string;
let writer: FakeWriter;
let g = 0;
const deps = (when: Date = NOW) => ({ writerFor: () => writer, now: () => when });

async function setStatus(status: (typeof workspaces.$inferSelect)["status"]) {
  const paid = status === "setup_paid" || status === "active";
  await database
    .update(workspaces)
    .set({ status, setupPaidVia: paid ? "stripe" : null })
    .where(eq(workspaces.id, workspaceId));
}

async function profile(over: { paymentTerms?: string; reviewUrl?: string } = {}) {
  await saveBusinessProfile(
    workspaceId,
    businessProfileInput.parse({
      businessName: "Elm Electric",
      trade: "electrical",
      services: "Panels",
      serviceArea: "",
      hours: "",
      leadTime: "",
      pricingNotes: "",
      paymentTerms: over.paymentTerms ?? "",
      policies: "",
      signature: "Davi",
      reviewUrl: over.reviewUrl ?? "",
      doNotPromise: "",
      vipSenders: "",
      amountThresholdDollars: "2500",
    }),
  );
}

/**
 * Dana asked for a quote, the owner quoted $3,100, and Dana's newest email accepts it
 * (sorted as `category`, quote_request by default).
 */
async function acceptedQuote(
  opts: {
    category?: string;
    extracted?: Record<string, unknown>;
    lastDirection?: "in" | "out";
    /** What the customer's acceptance says. */
    lastInbound?: string;
  } = {},
) {
  const id = `g${++g}`;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: id,
      inInbox: true,
      subject: "Panel upgrade",
      category: opts.category ?? "quote_request",
      summary: "Dana accepted the panel upgrade quote.",
      extracted: opts.extracted ?? { accepts_quote: true, quote_accepted: true },
      classifiedAt: NOW,
      lastMessageAt: new Date(NOW.getTime() - 3600_000),
    })
    .returning();
  await database.insert(messages).values([
    {
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-1`,
      direction: "in",
      fromAddress: "dana@customer.com",
      fromName: "Dana Ruiz",
      subject: "Panel upgrade",
      bodyText: "Can you quote a 200 amp panel upgrade?",
      sentAt: at(-6),
    },
    {
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-2`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["dana@customer.com"],
      subject: "Re: Panel upgrade",
      bodyText: "Hi Dana, the panel upgrade is $3,100 including the permit. Davi",
      sentAt: at(-4),
    },
    {
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-3`,
      rfc822MessageId: `<${id}-3@customer.com>`,
      direction: "in",
      fromAddress: "dana@customer.com",
      fromName: "Dana Ruiz",
      subject: "Re: Panel upgrade",
      bodyText: opts.lastInbound ?? "Let's do it. What do you need from me?",
      sentAt: new Date(NOW.getTime() - 3600_000),
    },
  ]);
  if (opts.lastDirection === "out") {
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-4`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["dana@customer.com"],
      subject: "Re: Panel upgrade",
      bodyText: "All done — thanks Dana!",
      sentAt: new Date(NOW.getTime() - 1800_000),
    });
  }
  return t!.id;
}

/** What sync records after a send: the owner's message in the thread. */
async function ownerMessage(threadId: string, when: Date, n: string) {
  await database.insert(messages).values({
    threadId,
    mailboxId,
    gmailMessageId: `out-${threadId}-${n}`,
    direction: "out",
    fromAddress: "owner@shop.com",
    toAddresses: ["dana@customer.com"],
    subject: "Re: Panel upgrade",
    bodyText: "Sent from the app.",
    sentAt: when,
  });
}

/**
 * Both follow-up nudges went out before the owner's last message: with a quiet week after
 * it (`QUIET`), the closing question can be asked (plan #26).
 */
async function nudgesSent(threadId: string) {
  for (const days of [-3, -2]) {
    await database.insert(drafts).values({
      threadId,
      mailboxId,
      kind: "followup",
      status: "sent",
      toAddress: "dana@customer.com",
      subject: "Re: Panel upgrade",
      body: "Just checking in on the quote.",
      reason: "Follow-up nudge.",
      createdAt: at(days),
      decidedAt: at(days),
    });
  }
}
/**
 * A week and a day after the owner's last message in `acceptedQuote({ lastDirection: "out" })`.
 * Past the 3-day trial, so tests asking then make the account paid first.
 */
const QUIET = at(8);

async function draftRow(id: string) {
  return (await database.select().from(drafts).where(eq(drafts.id, id)))[0]!;
}

async function created(threadId: string, model: ModelDraft = reply(), opts = {}) {
  const { transport, calls } = fakeTransport([model]);
  setModelTransportForTests(transport);
  const r = await createDraftForThread(threadId, { trigger: "auto", ...deps(), ...opts });
  if (r.status !== "created") throw new Error(`no draft: ${JSON.stringify(r)}`);
  return { draftId: r.draftId, calls };
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "100";
  delete process.env.FEATURE_CLOSING_QUESTION;
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
  writer = new FakeWriter();
});
afterEach(() => {
  delete process.env.FEATURE_CLOSING_QUESTION;
  setModelTransportForTests(undefined);
});

describe("pure helpers", () => {
  it("ensureDepositGap puts the gap on its own line before the sign-off, once", () => {
    const body = "Hi Dana,\n\nGreat, thanks for going ahead.\n\nThanks, Davi";
    expect(ensureDepositGap(body)).toBe(
      `Hi Dana,\n\nGreat, thanks for going ahead.\n\n${DEPOSIT_GAP}\n\nThanks, Davi`,
    );
    expect(ensureDepositGap(ensureDepositGap(body))).toBe(ensureDepositGap(body));
    expect(ensureDepositGap("Thanks!")).toBe(`Thanks!\n\n${DEPOSIT_GAP}`);
  });

  it("a quote acceptance needs this email's signal AND a real quote behind it (A5)", () => {
    expect(isQuoteAcceptance({ extracted: { accepts_quote: true, quote_accepted: true } })).toBe(
      true,
    );
    // The model said "accepts" but there was no quote the owner gave.
    expect(isQuoteAcceptance({ extracted: { accepts_quote: true } })).toBe(false);
    // An earlier acceptance carried over; this email ("use the side gate") isn't one.
    expect(isQuoteAcceptance({ extracted: { quote_accepted: true } })).toBe(false);
    expect(isQuoteAcceptance({ extracted: null })).toBe(false);
  });
});

describe("deposit (#28)", () => {
  it("an accepted quote gets deposit details: a normal reply with purpose deposit", async () => {
    await profile({ paymentTerms: "Due on completion; check or card" });
    const t = await acceptedQuote();
    const { draftId, calls } = await created(t);

    const d = await draftRow(draftId);
    expect(d).toMatchObject({
      purpose: "deposit",
      kind: "reply",
      promptVersion: "draft.v7+purpose.v2",
      status: "pending",
      toAddress: "dana@customer.com",
      flags: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user).toContain("## Task: deposit");
    expect(calls[0]!.system[0]!.text).toMatch(/^You write email replies/); // DRAFT_INSTRUCTIONS
    expect(calls[0]!.system[1]!.text).toContain(
      "- Payment terms: Due on completion; check or card",
    );
    // Threaded to the acceptance, as a real Gmail draft.
    const headers = FakeWriter.headersOf(writer.drafts.get(d.gmailDraftId!)!.raw);
    expect(headers).toContain(`In-Reply-To: <g${g}-3@customer.com>`);

    const [log] = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "draft_created"));
    expect(log!.detail).toMatchObject({ purpose: "deposit", trigger: "auto" });
    // Content-free.
    expect(JSON.stringify(log!.detail)).not.toMatch(/check or card|Let's do it/);

    // The queue labels it.
    const q = await listQueue(workspaceId, NOW);
    expect(q.drafts[0]).toMatchObject({ draftId, purpose: "deposit", kind: "reply" });
  });

  it("works when the acceptance was re-sorted as scheduling (A5)", async () => {
    await profile({ paymentTerms: "Card" });
    const t = await acceptedQuote({ category: "scheduling" });
    const { draftId, calls } = await created(t);
    expect((await draftRow(draftId)).purpose).toBe("deposit");
    expect(calls[0]!.user).toContain("## Task: deposit");
  });

  it("no deposit without a real acceptance: the signal alone, or an old carried-over one", async () => {
    await profile({ paymentTerms: "Card" });
    for (const extracted of [{ accepts_quote: true }, { quote_accepted: true }, {}]) {
      const t = await acceptedQuote({ extracted });
      const { draftId, calls } = await created(t, reply({ body: "Hi Dana,\n\nSure.\n\nDavi" }));
      expect((await draftRow(draftId)).purpose).toBeNull();
      expect((await draftRow(draftId)).promptVersion).toBe("draft.v7");
      expect(calls[0]!.user).not.toContain("## Task:");
    }
  });

  it("with no payment terms: a gap the owner must fill, the flag first, low confidence; sending waits", async () => {
    await profile({ paymentTerms: "" });
    const t = await acceptedQuote();
    // The model left the gap out.
    const { draftId, calls } = await created(
      t,
      reply({
        body: "Hi Dana,\n\nGreat, thanks for going ahead.\n\nThanks, Davi",
        confidence: 0.95,
      }),
    );
    expect(calls[0]!.user).toContain(DEPOSIT_GAP); // the task asks for it
    const d = await draftRow(draftId);
    expect(d.body).toContain(DEPOSIT_GAP);
    expect(d.flags[0]).toBe(NO_PAYMENT_TERMS_FLAG);
    expect(d.confidence).toBeLessThanOrEqual(30);
    // The Gmail draft carries the gap too (never text the owner hasn't seen).
    expect(FakeWriter.bodyOf(writer.drafts.get(d.gmailDraftId!)!.raw)).toContain(DEPOSIT_GAP);

    await setStatus("active");
    expect(await sendDraft(workspaceId, draftId, deps())).toEqual({ status: "gaps_unfilled" });
    expect(writer.calls).not.toContain("sendDraft");
  });

  it("the no-terms flag survives six other flags and still caps confidence (A6)", async () => {
    await profile({ paymentTerms: "" });
    const t = await acceptedQuote();
    const six = ["One.", "Two.", "Three.", "Four.", "Five.", "Six."];
    const { draftId } = await created(t, reply({ flags: six, confidence: 0.99 }));
    const d = await draftRow(draftId);
    expect(d.flags).toHaveLength(6);
    expect(d.flags[0]).toBe(NO_PAYMENT_TERMS_FLAG);
    expect(d.confidence).toBeLessThanOrEqual(30);
  });

  it("money in the payment terms isn't 'invented'; money that isn't is flagged", async () => {
    await profile({ paymentTerms: "50% deposit, $500 minimum" });
    const ok = await created(
      await acceptedQuote(),
      reply({ body: "Hi Dana,\n\nTo book it: a 50% deposit, $500 minimum.\n\nThanks, Davi" }),
    );
    expect((await draftRow(ok.draftId)).flags).toEqual([]);

    const bad = await created(
      await acceptedQuote(),
      reply({
        body: "Hi Dana,\n\nTo book it: a 50% deposit, $750 minimum, by Venmo.\n\nThanks, Davi",
      }),
    );
    const flags = (await draftRow(bad.draftId)).flags;
    expect(flags.some((f) => f.includes("$750"))).toBe(true);
    // A4: a payment method the terms never mention.
    expect(flags.some((f) => f.includes("Venmo") && f.includes("payment terms"))).toBe(true);
  });

  it("invented terms get one fresh attempt before they're flagged (A4)", async () => {
    await profile({ paymentTerms: "Check or card" });
    const t = await acceptedQuote();
    const { transport, calls } = fakeTransport([
      reply({ body: "Hi Dana,\n\nA 50% deposit by Zelle books it.\n\nDavi" }),
      reply({ body: "Hi Dana,\n\nCheck or card is fine for the deposit.\n\nDavi" }),
    ]);
    setModelTransportForTests(transport);
    const r = await createDraftForThread(t, { trigger: "auto", ...deps() });
    expect(r.status).toBe("created");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.user).toContain("broke the owner's rules");
    const d = await draftRow((r as { draftId: string }).draftId);
    expect(d.body).toContain("Check or card");
    expect(d.flags).toEqual([]);
  });

  it("the customer's own words are never payment terms: no terms + 'can I pay by Venmo?' (A4)", async () => {
    await profile({ paymentTerms: "" });
    const t = await acceptedQuote({
      lastInbound: "Let's do it. How much is the deposit, and can I pay it by Venmo?",
    });
    const venmo = reply({ body: "Hi Dana,\n\nVenmo works for the deposit.\n\nThanks, Davi" });
    const { transport, calls } = fakeTransport([venmo, venmo]);
    setModelTransportForTests(transport);
    const r = await createDraftForThread(t, { trigger: "auto", ...deps() });
    expect(calls).toHaveLength(2); // one regenerate
    expect(calls[1]!.user).toContain("broke the owner's rules");
    const d = await draftRow((r as { draftId: string }).draftId);
    expect(d.flags[0]).toBe(NO_PAYMENT_TERMS_FLAG);
    expect(d.flags.some((f) => f.includes("“Venmo”") && f.includes("payment terms"))).toBe(true);
  });

  it("terms 'check or card' + a customer offering 50% by Venmo: echoing it is flagged (A4)", async () => {
    await profile({ paymentTerms: "Due on completion; check or card" });
    const t = await acceptedQuote({
      lastInbound: "Great, let's do it — I'll send 50% by Venmo tonight. Let me check my calendar.",
    });
    const echo = reply({ body: "Hi Dana,\n\nPerfect, 50% by Venmo works.\n\nThanks, Davi" });
    const { transport, calls } = fakeTransport([echo, echo]);
    setModelTransportForTests(transport);
    const r = await createDraftForThread(t, { trigger: "auto", ...deps() });
    expect(calls).toHaveLength(2);
    const d = await draftRow((r as { draftId: string }).draftId);
    expect(d.flags.some((f) => /“50%”, “Venmo”.*payment terms/.test(f))).toBe(true);
    expect(d.confidence).toBeLessThanOrEqual(30);
  });

  it("an amount only the customer named is flagged; the owner's own quote is not (A4)", async () => {
    await profile({ paymentTerms: "Card" });
    for (const [said, body] of [
      ["Let's do it. I'll send a $500 deposit.", "A $500 deposit by card works."],
      ["Let's do it. Can I put $200 down to hold the spot?", "A $200 deposit works, thanks."],
    ] as const) {
      const t = await acceptedQuote({ lastInbound: said });
      const echo = reply({ body: `Hi Dana,\n\n${body}\n\nThanks, Davi` });
      const { transport, calls } = fakeTransport([echo, echo]);
      setModelTransportForTests(transport);
      const r = await createDraftForThread(t, { trigger: "auto", ...deps() });
      expect(calls).toHaveLength(2); // one fresh attempt
      const d = await draftRow((r as { draftId: string }).draftId);
      const amount = body.match(/\$\d+/)![0];
      expect(d.flags.some((f) => f.includes(`“${amount}”`) && f.includes("payment terms"))).toBe(
        true,
      );
      expect(d.confidence).toBeLessThanOrEqual(30);
    }

    // Control: the $3,100 the owner quoted is theirs to repeat.
    const ok = await created(
      await acceptedQuote(),
      reply({ body: "Hi Dana,\n\nThanks! The $3,100 by card is due on completion.\n\nDavi" }),
    );
    expect((await draftRow(ok.draftId)).flags).toEqual([]);
  });

  it("deposit details only once: after they went out, 'paid by check — when can you start?' gets an ordinary reply", async () => {
    await profile({ paymentTerms: "Check or card" });
    await setStatus("active");
    const t = await acceptedQuote();
    const first = await created(t);
    expect((await draftRow(first.draftId)).purpose).toBe("deposit");
    expect(await sendDraft(workspaceId, first.draftId, deps())).toMatchObject({ status: "sent" });
    await ownerMessage(t, new Date(NOW.getTime() - 1800_000), "deposit");
    // Dana pays and asks when; the classifier reads it as another acceptance.
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `paid-${t}`,
      rfc822MessageId: `<paid-${t}@customer.com>`,
      direction: "in",
      fromAddress: "dana@customer.com",
      fromName: "Dana Ruiz",
      subject: "Re: Panel upgrade",
      bodyText: "Sent the deposit by check. When can you start?",
      sentAt: new Date(NOW.getTime() - 600_000),
    });
    await database
      .update(threads)
      .set({ extracted: { accepts_quote: true, quote_accepted: true } })
      .where(eq(threads.id, t));

    for (const trigger of ["auto", "owner"] as const) {
      const { transport, calls } = fakeTransport([
        reply({ body: "Hi Dana,\n\nGot it, thanks. I'll be in touch about a start date.\n\nDavi" }),
      ]);
      setModelTransportForTests(transport);
      const r = await createDraftForThread(t, { trigger, workspaceId, ...deps() });
      expect(r.status).toBe("created");
      const d = await draftRow((r as { draftId: string }).draftId);
      expect(d.purpose).toBeNull();
      expect(d.promptVersion).toBe("draft.v7");
      expect(calls[0]!.user).not.toContain("## Task: deposit");
      // Clear it for the next trigger.
      await database.update(drafts).set({ status: "discarded" }).where(eq(drafts.id, d.id));
    }
  });

  it("a discarded deposit note still counts: the owner sent the details from Gmail, no second request", async () => {
    await profile({ paymentTerms: "Check or card" });
    const t = await acceptedQuote();
    const first = await created(t);
    expect((await draftRow(first.draftId)).purpose).toBe("deposit");
    // The owner discards it and writes the deposit details in Gmail instead.
    expect(await discardDraft(workspaceId, first.draftId, deps())).toBe("discarded");
    await ownerMessage(t, new Date(NOW.getTime() - 1800_000), "gmail-deposit");
    // "When can you start?" reads as another acceptance.
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `again-${t}`,
      direction: "in",
      fromAddress: "dana@customer.com",
      fromName: "Dana Ruiz",
      subject: "Re: Panel upgrade",
      bodyText: "Great. When can you start?",
      sentAt: new Date(NOW.getTime() - 600_000),
    });
    const { draftId, calls } = await created(
      t,
      reply({ body: "Hi Dana,\n\nI can start Monday.\n\nDavi" }),
    );
    expect((await draftRow(draftId)).purpose).toBeNull();
    expect(calls[0]!.user).not.toContain("## Task: deposit");
  });

  it("a deposit note that went stale (the customer wrote again first) is drafted afresh, not dropped", async () => {
    await profile({ paymentTerms: "Check or card" });
    const t = await acceptedQuote();
    const first = await created(t);
    expect((await draftRow(first.draftId)).purpose).toBe("deposit");
    // Before the owner taps anything, Dana writes again — another acceptance.
    const later = new Date(NOW.getTime() + 600_000);
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `again-${t}`,
      rfc822MessageId: `<again-${t}@customer.com>`,
      direction: "in",
      fromAddress: "dana@customer.com",
      fromName: "Dana Ruiz",
      subject: "Re: Panel upgrade",
      bodyText: "Monday works. When can you start?",
      sentAt: later,
    });
    const after = new Date(later.getTime() + 600_000);
    await reconcileDrafts(mailboxId, deps(after));
    expect((await draftRow(first.draftId)).status).toBe("expired");
    const { draftId, calls } = await created(t, reply(), { now: () => after });
    expect((await draftRow(draftId)).purpose).toBe("deposit");
    expect(calls[0]!.user).toContain("## Task: deposit");
  });

  it("'Sent the deposit by check. When can you start?' never gets a deposit request, even the first time", async () => {
    await profile({ paymentTerms: "Check or card" });
    const t = await acceptedQuote({
      lastInbound: "Sent the deposit by check. When can you start?",
      extracted: { accepts_quote: true, quote_accepted: true, payment_said: "paid" },
    });
    const { draftId, calls } = await created(
      t,
      reply({ body: "Hi Dana,\n\nGot it, thanks. Monday works.\n\nDavi" }),
    );
    expect((await draftRow(draftId)).purpose).toBeNull();
    expect(calls[0]!.user).not.toContain("## Task: deposit");
  });

  it("still one pending draft per thread", async () => {
    await profile({ paymentTerms: "Card" });
    const t = await acceptedQuote();
    await created(t);
    const { transport, calls } = fakeTransport([reply()]);
    setModelTransportForTests(transport);
    expect(await createDraftForThread(t, { trigger: "auto", ...deps() })).toEqual({
      status: "skipped",
      reason: "already_pending",
    });
    expect(calls).toHaveLength(0);
  });

  it("purpose drafts never bump followup_count", async () => {
    await profile({ paymentTerms: "Card" });
    await setStatus("active");
    const t = await acceptedQuote();
    const { draftId } = await created(t);
    expect(await sendDraft(workspaceId, draftId, deps())).toMatchObject({ status: "sent" });
    const [thread] = await database.select().from(threads).where(eq(threads.id, t));
    expect(thread!.followupCount).toBe(0);
    expect((await draftRow(draftId)).status).toBe("sent");
  });
});

describe("purposes require the owner (GUARDRAIL)", () => {
  it("a job can never ask for a review request or closing question — no model call, no Gmail", async () => {
    process.env.FEATURE_CLOSING_QUESTION = "on";
    await profile({ reviewUrl: REVIEW_URL });
    const t = await acceptedQuote({ lastDirection: "out" });
    const { transport, calls } = fakeTransport([reply(), reply(), reply(), reply()]);
    setModelTransportForTests(transport);
    for (const trigger of ["auto", "followup"] as const) {
      for (const purpose of ["review_request", "closing_question"] as const) {
        expect(await createDraftForThread(t, { trigger, purpose, ...deps() } as never)).toEqual({
          status: "skipped",
          reason: "purpose_not_allowed",
        });
      }
    }
    // Nor may anyone ask for "deposit" (it's derived) or a made-up purpose.
    for (const purpose of ["deposit", "anything"]) {
      expect(
        await createDraftForThread(t, {
          trigger: "owner",
          workspaceId,
          purpose,
          ...deps(),
        } as never),
      ).toEqual({ status: "skipped", reason: "purpose_not_allowed" });
    }
    expect(calls).toHaveLength(0);
    expect(writer.calls).toEqual([]);
    expect(await database.select().from(drafts)).toEqual([]);
  });

  it("read-only accounts get nothing: no deposit, no review request, no model call", async () => {
    await profile({ paymentTerms: "Card", reviewUrl: REVIEW_URL });
    await database
      .update(workspaces)
      .set({ status: "evaluation_expired" })
      .where(eq(workspaces.id, workspaceId));
    const t = await acceptedQuote();
    const { transport, calls } = fakeTransport([reply(), reply()]);
    setModelTransportForTests(transport);
    expect(await createDraftForThread(t, { trigger: "auto", ...deps() })).toEqual({
      status: "skipped",
      reason: "read_only",
    });
    expect(
      await createDraftForThread(t, {
        trigger: "owner",
        workspaceId,
        purpose: "review_request",
        ...deps(),
      }),
    ).toEqual({ status: "skipped", reason: "read_only" });
    expect(calls).toHaveLength(0);
    expect(writer.calls).toEqual([]);
  });

  it("another workspace's owner can't ask for one", async () => {
    await profile({ reviewUrl: REVIEW_URL });
    const t = await acceptedQuote();
    const { workspace: other } = await ensureUserAndWorkspace({ email: "other@shop.com" });
    const { transport, calls } = fakeTransport([reply()]);
    setModelTransportForTests(transport);
    expect(
      await createDraftForThread(t, {
        trigger: "owner",
        workspaceId: other.id,
        purpose: "review_request",
        ...deps(),
      }),
    ).toEqual({ status: "skipped", reason: "not_found" });
    expect(calls).toHaveLength(0);
  });
});

describe("review request and closing question plumbing (#29 #26)", () => {
  const ask = (t: string, purpose: "review_request" | "closing_question") =>
    createDraftForThread(t, { trigger: "owner", workspaceId, purpose, ...deps() });

  it("review request: the owner's link in the task, sent to the customer, even after the owner wrote last", async () => {
    await profile({ reviewUrl: REVIEW_URL });
    const t = await acceptedQuote({ extracted: { job_done: true }, lastDirection: "out" });
    const body = `Hi Dana,\n\nThanks again. If you have a minute, a short review would mean a lot:\n${REVIEW_URL}\n\nDavi`;
    const { transport, calls } = fakeTransport([reply({ body })]);
    setModelTransportForTests(transport);
    const r = await ask(t, "review_request");
    expect(r.status).toBe("created");
    expect(calls[0]!.user).toContain("## Task: review request");
    expect(calls[0]!.user).toContain(REVIEW_URL);
    // The link goes in the task only, never the cached business block.
    expect(calls[0]!.system[1]!.text).not.toContain(REVIEW_URL);
    const d = await draftRow((r as { draftId: string }).draftId);
    expect(d).toMatchObject({ purpose: "review_request", kind: "reply", flags: [] });
    expect(d.toAddress).toBe("dana@customer.com");
    const [log] = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "draft_created"));
    expect(log!.detail).toMatchObject({ purpose: "review_request", trigger: "owner" });
  });

  it("review request without a link on file: skipped before any model call", async () => {
    await profile({ reviewUrl: "" });
    const t = await acceptedQuote({ extracted: { job_done: true } });
    const { transport, calls } = fakeTransport([reply()]);
    setModelTransportForTests(transport);
    expect(await ask(t, "review_request")).toEqual({
      status: "skipped",
      reason: "no_review_link",
    });
    expect(calls).toHaveLength(0);
    expect(writer.calls).toEqual([]);
  });

  it("review request whose text lost the link, or added another: flagged first, low confidence", async () => {
    await profile({ reviewUrl: REVIEW_URL });
    const t = await acceptedQuote({ extracted: { job_done: true } });
    const { transport } = fakeTransport([
      reply({
        body: "Hi Dana,\n\nWould you leave us a review? https://elsewhere.example.com/r Get 10% off your next job!\n\nDavi",
        confidence: 0.95,
      }),
      reply({
        body: "Hi Dana,\n\nWould you leave us a review? https://elsewhere.example.com/r Get 10% off your next job!\n\nDavi",
        confidence: 0.95,
      }),
    ]);
    setModelTransportForTests(transport);
    const r = await ask(t, "review_request");
    const d = await draftRow((r as { draftId: string }).draftId);
    expect(d.flags[0]).toBe(REVIEW_LINK_MISSING_FLAG);
    expect(d.flags.some((f) => f.includes("isn't your review link"))).toBe(true);
    expect(d.flags.some((f) => f.includes("never offers"))).toBe(true);
    expect(d.confidence).toBeLessThanOrEqual(30);
  });

  it("closing question is off unless FEATURE_CLOSING_QUESTION is on", async () => {
    const t = await acceptedQuote({ extracted: {}, lastDirection: "out" });
    const { transport, calls } = fakeTransport([reply()]);
    setModelTransportForTests(transport);
    expect(await ask(t, "closing_question")).toEqual({
      status: "skipped",
      reason: "feature_off",
    });
    expect(calls).toHaveLength(0);
  });

  it("closing question (flag on): follows the owner's last message; its own activity; never a nudge", async () => {
    process.env.FEATURE_CLOSING_QUESTION = "on";
    await setStatus("active");
    // The customer wrote last → nothing to ask yet.
    const answered = await acceptedQuote({ extracted: {} });
    await nudgesSent(answered);
    setModelTransportForTests(fakeTransport([reply()]).transport);
    expect(
      await createDraftForThread(answered, {
        trigger: "owner",
        workspaceId,
        purpose: "closing_question",
        ...deps(QUIET),
      }),
    ).toEqual({ status: "skipped", reason: "not_eligible" });

    const t = await acceptedQuote({ extracted: {}, lastDirection: "out" });
    await nudgesSent(t);
    const body =
      "Hi Dana,\n\nDid you go another way, or did the timing change? Either is fine.\n\nDavi";
    const { transport, calls } = fakeTransport([reply({ body })]);
    setModelTransportForTests(transport);
    const r = await createDraftForThread(t, {
      trigger: "owner",
      workspaceId,
      purpose: "closing_question",
      ...deps(QUIET),
    });
    expect(r.status).toBe("created");
    expect(calls[0]!.user).toContain("## Task: closing question");
    const d = await draftRow((r as { draftId: string }).draftId);
    expect(d).toMatchObject({ purpose: "closing_question", kind: "reply" });
    expect(d.toAddress).toBe("dana@customer.com");
    const logs = await database.select().from(activityLog);
    expect(logs.some((l) => l.action === "closing_question")).toBe(true);
    expect(logs.some((l) => l.action === "followup_drafted" || l.action === "draft_created")).toBe(
      false,
    );

    expect(await sendDraft(workspaceId, d.id, deps(QUIET))).toMatchObject({ status: "sent" });
    const [thread] = await database.select().from(threads).where(eq(threads.id, t));
    expect(thread!.followupCount).toBe(0);
    const summary = await sentDraftSummary(workspaceId, d.id);
    expect(summary).toMatchObject({
      purpose: "closing_question",
      nudgeOn: null,
      lastNudgeUsed: false,
    });
  });

  it("a waiting review request goes when the owner writes to them some other way", async () => {
    await profile({ reviewUrl: REVIEW_URL });
    const t = await acceptedQuote({ extracted: { job_done: true } });
    setModelTransportForTests(
      fakeTransport([reply({ body: `Hi Dana, a review? ${REVIEW_URL} Davi` })]).transport,
    );
    const r = await ask(t, "review_request");
    const d = await draftRow((r as { draftId: string }).draftId);
    await ownerMessage(t, at(1), "gmail");
    await reconcileDrafts(mailboxId, deps(at(1)));
    const after = await draftRow(d.id);
    expect(after.status).toBe("expired");
    expect(after.closedNote).toBe("You wrote to them since, so this note was out of date.");
    expect(writer.calls).toContain("deleteDraft");
  });
});

describe("no nudges after a purpose note went out (A3)", () => {
  async function sentPurpose(purpose: "deposit" | "review_request" | null) {
    await profile({ paymentTerms: "Card", reviewUrl: REVIEW_URL });
    await setStatus("active");
    const t = await acceptedQuote(
      purpose === "deposit" ? {} : { extracted: purpose ? { job_done: true } : {} },
    );
    let draftId: string;
    if (purpose === "review_request") {
      setModelTransportForTests(
        fakeTransport([reply({ body: `Hi Dana, a review? ${REVIEW_URL} Davi` })]).transport,
      );
      const r = await createDraftForThread(t, {
        trigger: "owner",
        workspaceId,
        purpose,
        ...deps(),
      });
      draftId = (r as { draftId: string }).draftId;
    } else {
      draftId = (await created(t, reply({ body: "Hi Dana,\n\nGreat.\n\nDavi" }))).draftId;
    }
    expect((await draftRow(draftId)).purpose).toBe(purpose);
    expect(await sendDraft(workspaceId, draftId, deps())).toMatchObject({ status: "sent" });
    // Gmail's copy of what we just sent, as the next sync records it.
    await ownerMessage(t, new Date(NOW.getTime() + 60_000), "sent");
    return { t, draftId };
  }

  it("control: an ordinary reply on a quote thread is nudged after the wait", async () => {
    const { t, draftId } = await sentPurpose(null);
    expect(await threadsToFollowUp(mailboxId, at(5))).toEqual([t]);
    expect((await sentDraftSummary(workspaceId, draftId))!.nudgeOn).not.toBeNull();
  });

  it("a sent deposit: never nudged — not by the scan, not by the drafter, not promised", async () => {
    const { t, draftId } = await sentPurpose("deposit");
    expect(await threadsToFollowUp(mailboxId, at(5))).toEqual([]);
    const { transport, calls } = fakeTransport([reply()]);
    setModelTransportForTests(transport);
    expect(await createDraftForThread(t, { trigger: "followup", ...deps(at(5)) })).toEqual({
      status: "skipped",
      reason: "followup_not_allowed",
    });
    expect(calls).toHaveLength(0);
    expect(await sentDraftSummary(workspaceId, draftId)).toMatchObject({
      purpose: "deposit",
      nudgeOn: null,
      lastNudgeUsed: false,
    });
  });

  it("a sent review request: never nudged", async () => {
    const { t, draftId } = await sentPurpose("review_request");
    expect(await threadsToFollowUp(mailboxId, at(5))).toEqual([]);
    setModelTransportForTests(fakeTransport([reply()]).transport);
    expect(await createDraftForThread(t, { trigger: "followup", ...deps(at(5)) })).toEqual({
      status: "skipped",
      reason: "followup_not_allowed",
    });
    expect(await sentDraftSummary(workspaceId, draftId)).toMatchObject({
      nudgeOn: null,
      lastNudgeUsed: false,
    });
  });

  it("a sent deposit stops only the quote's nudges: the won job's invoice is still chased", async () => {
    const { t } = await sentPurpose("deposit");
    // Later: "Can you send the final invoice?" — sorted invoice_payment; the owner sends it.
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `inv-ask-${t}`,
      rfc822MessageId: `<inv-ask-${t}@customer.com>`,
      direction: "in",
      fromAddress: "dana@customer.com",
      fromName: "Dana Ruiz",
      subject: "Re: Panel upgrade",
      bodyText: "All done, thanks! Can you send the final invoice?",
      sentAt: at(1),
    });
    await database
      .update(threads)
      .set({
        category: "invoice_payment",
        quoteOutcome: "won",
        quoteOutcomeSource: "auto",
        extracted: { invoice_thread: true, quote_accepted: true },
        classifiedAt: at(1),
      })
      .where(eq(threads.id, t));
    await ownerMessage(t, at(2), "invoice");
    const [invoiceReply] = await database
      .insert(drafts)
      .values({
        threadId: t,
        mailboxId,
        kind: "reply",
        status: "sent",
        toAddress: "dana@customer.com",
        subject: "Re: Panel upgrade",
        body: "Invoice attached. Davi",
        reason: "Invoice.",
        createdAt: at(1.5),
        decidedAt: at(2),
      })
      .returning();
    // Quiet for the follow-up wait → chased, by the scan, the drafter and the promise.
    expect(await threadsToFollowUp(mailboxId, at(6))).toEqual([t]);
    expect((await sentDraftSummary(workspaceId, invoiceReply!.id))!.nudgeOn).not.toBeNull();
    const { transport } = fakeTransport([
      reply({ body: "Hi Dana,\n\nJust checking in on the invoice.\n\nDavi" }),
    ]);
    setModelTransportForTests(transport);
    expect(await createDraftForThread(t, { trigger: "followup", ...deps(at(6)) })).toMatchObject({
      status: "created",
    });
  });

  it("the customer's newest email said they paid (not marked paid): never nudged, never promised", async () => {
    const { t, draftId } = await sentPurpose(null);
    // "Sent the deposit, thanks!" — a deposit isn't the job being paid, so no paid mark,
    // but they aren't chased right after paying.
    await database
      .update(threads)
      .set({ extracted: { payment_said: "paid" } })
      .where(eq(threads.id, t));
    expect(
      (await database.select().from(threads).where(eq(threads.id, t)))[0]!.invoicePaidAt,
    ).toBeNull();
    expect(await threadsToFollowUp(mailboxId, at(5))).toEqual([]);
    const { transport, calls } = fakeTransport([reply()]);
    setModelTransportForTests(transport);
    expect(await createDraftForThread(t, { trigger: "followup", ...deps(at(5)) })).toEqual({
      status: "skipped",
      reason: "followup_not_allowed",
    });
    expect(calls).toHaveLength(0);
    expect((await sentDraftSummary(workspaceId, draftId))!.nudgeOn).toBeNull();
  });

  it("a deposit still in its undo window promises no nudge, even on an undecided quote", async () => {
    await profile({ paymentTerms: "Card" });
    await setStatus("active");
    const t = await acceptedQuote();
    const { draftId } = await created(t, reply({ body: "Hi Dana,\n\nGreat.\n\nDavi" }));
    expect((await draftRow(draftId)).purpose).toBe("deposit");
    expect(await queueSend(workspaceId, draftId, deps())).toMatchObject({ status: "queued" });
    const d = await draftRow(draftId);
    expect(d).toMatchObject({ status: "pending" });
    expect(d.sendAfter).not.toBeNull();
    // Nothing else stops the nudges: the quote is undecided and nothing has gone out yet.
    const [thread] = await database.select().from(threads).where(eq(threads.id, t));
    expect(thread).toMatchObject({ category: "quote_request", quoteOutcome: null });
    expect(await sentDraftSummary(workspaceId, draftId)).toMatchObject({
      purpose: "deposit",
      sendingAt: d.sendAfter,
      nudgeOn: null,
      lastNudgeUsed: false,
    });
  });

  it("an ordinary reply sent after the deposit went out promises no nudge either", async () => {
    const { t } = await sentPurpose("deposit");
    // "Great. When can you start?" — the deposit note already went, so an ordinary reply.
    const when = new Date(NOW.getTime() + 5 * 60_000);
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `again-${t}`,
      rfc822MessageId: `<again-${t}@customer.com>`,
      direction: "in",
      fromAddress: "dana@customer.com",
      fromName: "Dana Ruiz",
      subject: "Re: Panel upgrade",
      bodyText: "Great. When can you start?",
      sentAt: new Date(NOW.getTime() + 2 * 60_000),
    });
    const { draftId } = await created(
      t,
      reply({ body: "Hi Dana,\n\nI'll confirm a start date shortly.\n\nDavi" }),
      deps(when),
    );
    expect((await draftRow(draftId)).purpose).toBeNull();
    expect(await sendDraft(workspaceId, draftId, deps(when))).toMatchObject({ status: "sent" });
    const [thread] = await database.select().from(threads).where(eq(threads.id, t));
    expect(thread).toMatchObject({ category: "quote_request", quoteOutcome: null });
    expect(await sentDraftSummary(workspaceId, draftId)).toMatchObject({
      purpose: null,
      nudgeOn: null,
      lastNudgeUsed: false,
    });
  });

  it("a discarded purpose note doesn't count: only one that went out stops nudges", async () => {
    const { t, draftId } = await sentPurpose(null);
    await database.insert(drafts).values({
      threadId: t,
      mailboxId,
      toAddress: "dana@customer.com",
      subject: "Re",
      body: "b",
      originalBody: "b",
      status: "discarded",
      reason: "r",
      purpose: "review_request",
      createdAt: at(-1),
    });
    expect(await threadsToFollowUp(mailboxId, at(5))).toEqual([t]);
    expect((await sentDraftSummary(workspaceId, draftId))!.nudgeOn).not.toBeNull();
  });
});

describe("a tweak keeps every purpose guard (A4, A6)", () => {
  it("deposit (terms 'Card'): a tweak that adds Venmo is retried once, then flagged", async () => {
    await profile({ paymentTerms: "Card" });
    const t = await acceptedQuote();
    const { draftId } = await created(
      t,
      reply({ body: "Hi Dana,\n\nGreat. Card is fine for the deposit.\n\nThanks, Davi" }),
    );
    expect((await draftRow(draftId)).flags).toEqual([]);
    const venmo = reply({
      body: "Hi Dana!\n\nSo glad you're going ahead. Send the deposit by Venmo.\n\nThanks, Davi",
    });
    const { transport, calls } = fakeTransport([venmo, venmo]);
    setModelTransportForTests(transport);
    const r = await reviseDraft(workspaceId, draftId, { tweak: "warmer" }, deps());
    expect(r.status).toBe("revised");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.user).toContain("broke the owner's rules");
    const d = await draftRow(draftId);
    expect(d.flags.some((f) => f.includes("“Venmo”") && f.includes("payment terms"))).toBe(true);
    expect(d.confidence).toBeLessThanOrEqual(30);
  });

  it("deposit with no terms: a tweak that drops the gap gets it back, flag first; sending waits", async () => {
    await profile({ paymentTerms: "" });
    const t = await acceptedQuote();
    const { draftId } = await created(t);
    expect((await draftRow(draftId)).body).toContain(DEPOSIT_GAP);
    const { transport } = fakeTransport([
      reply({
        body: "Hi Dana,\n\nThanks for going ahead!\n\nThanks, Davi",
        flags: ["One.", "Two.", "Three.", "Four.", "Five.", "Six."],
        confidence: 0.99,
      }),
    ]);
    setModelTransportForTests(transport);
    expect(await reviseDraft(workspaceId, draftId, { tweak: "shorter" }, deps())).toMatchObject({
      status: "revised",
    });
    const d = await draftRow(draftId);
    expect(d.body).toContain(DEPOSIT_GAP);
    expect(d.flags).toHaveLength(6);
    expect(d.flags[0]).toBe(NO_PAYMENT_TERMS_FLAG);
    expect(d.confidence).toBeLessThanOrEqual(30);
    expect(FakeWriter.bodyOf(writer.drafts.get(d.gmailDraftId!)!.raw)).toContain(DEPOSIT_GAP);

    await setStatus("active");
    expect(await sendDraft(workspaceId, draftId, deps())).toEqual({ status: "gaps_unfilled" });
    expect(writer.calls).not.toContain("sendDraft");
  });

  async function reviewDraft() {
    await profile({ reviewUrl: REVIEW_URL });
    const t = await acceptedQuote({ extracted: { job_done: true } });
    setModelTransportForTests(
      fakeTransport([reply({ body: `Hi Dana,\n\nA short review? ${REVIEW_URL}\n\nDavi` })])
        .transport,
    );
    const r = await createDraftForThread(t, {
      trigger: "owner",
      workspaceId,
      purpose: "review_request",
      ...deps(),
    });
    const id = (r as { draftId: string }).draftId;
    expect((await draftRow(id)).flags).toEqual([]);
    return id;
  }

  it("review request: a 'shorter' that drops the link is flagged first, low confidence", async () => {
    const id = await reviewDraft();
    setModelTransportForTests(
      fakeTransport([reply({ body: "Hi Dana, a short review? Davi", confidence: 0.95 })]).transport,
    );
    await reviseDraft(workspaceId, id, { tweak: "shorter" }, deps());
    const d = await draftRow(id);
    expect(d.flags[0]).toBe(REVIEW_LINK_MISSING_FLAG);
    expect(d.confidence).toBeLessThanOrEqual(30);
  });

  it("review request: a 'warmer' that offers 10% off is flagged", async () => {
    const id = await reviewDraft();
    const bribe = reply({
      body: `Hi Dana!\n\nA short review? ${REVIEW_URL} Here's 10% off your next job as thanks.\n\nDavi`,
    });
    const { transport, calls } = fakeTransport([bribe, bribe]);
    setModelTransportForTests(transport);
    await reviseDraft(workspaceId, id, { tweak: "warmer" }, deps());
    expect(calls).toHaveLength(2);
    const d = await draftRow(id);
    expect(d.flags.some((f) => f.includes("never offers"))).toBe(true);
    expect(d.flags).not.toContain(REVIEW_LINK_MISSING_FLAG);
    expect(d.confidence).toBeLessThanOrEqual(30);
  });

  it("a saved link with a trailing slash still counts as there", async () => {
    await profile({ reviewUrl: `${REVIEW_URL}/` });
    const t = await acceptedQuote({ extracted: { job_done: true } });
    setModelTransportForTests(
      fakeTransport([reply({ body: `Hi Dana,\n\nA short review? ${REVIEW_URL}.\n\nDavi` })])
        .transport,
    );
    const r = await createDraftForThread(t, {
      trigger: "owner",
      workspaceId,
      purpose: "review_request",
      ...deps(),
    });
    expect((await draftRow((r as { draftId: string }).draftId)).flags).toEqual([]);
  });
});

describe("a waiting closing question goes when the owner writes some other way (#26)", () => {
  it("expired, noted, and the Gmail draft deleted", async () => {
    process.env.FEATURE_CLOSING_QUESTION = "on";
    await setStatus("active");
    const t = await acceptedQuote({ extracted: {}, lastDirection: "out" });
    await nudgesSent(t);
    setModelTransportForTests(
      fakeTransport([reply({ body: "Hi Dana,\n\nDid the timing change? Either is fine.\n\nDavi" })])
        .transport,
    );
    const r = await createDraftForThread(t, {
      trigger: "owner",
      workspaceId,
      purpose: "closing_question",
      ...deps(QUIET),
    });
    expect(r).toEqual({ status: "created", draftId: expect.any(String) });
    const id = (r as { draftId: string }).draftId;
    await ownerMessage(t, at(9), "gmail");
    await reconcileDrafts(mailboxId, deps(at(9)));
    const after = await draftRow(id);
    expect(after.status).toBe("expired");
    expect(after.closedNote).toBe("You wrote to them since, so this note was out of date.");
    expect(writer.calls).toContain("deleteDraft");
  });
});

describe("website form leads: every kind of draft goes to the Reply-To (review B1)", () => {
  /** The same conversation, but every customer email came through a Wix form. */
  async function viaForm(threadId: string) {
    await database
      .update(messages)
      .set({
        fromAddress: "no-reply@crm.wix.com",
        fromName: "Wix Forms",
        replyToHeader: { address: "dana@customer.com", name: "Dana Ruiz" },
      })
      .where(and(eq(messages.threadId, threadId), eq(messages.direction, "in")));
  }
  const mimeTo = (draftId: string | null) =>
    FakeWriter.headersOf(writer.drafts.get(draftId ?? "")!.raw)
      .split("\r\n")
      .find((l) => l.startsWith("To: "));

  it("deposit details", async () => {
    await profile({ paymentTerms: "Card or check" });
    const t = await acceptedQuote();
    await viaForm(t);
    setModelTransportForTests(fakeTransport([reply()]).transport);
    const r = await createDraftForThread(t, { trigger: "auto", ...deps() });
    const d = await draftRow((r as { draftId: string }).draftId);
    expect(d.purpose).toBe("deposit");
    expect(d.toAddress).toBe("dana@customer.com");
    expect(mimeTo(d.gmailDraftId)).toBe("To: dana@customer.com");
  });

  it("review request (the owner wrote to the form's customer before)", async () => {
    await profile({ reviewUrl: REVIEW_URL });
    const t = await acceptedQuote({ extracted: { job_done: true } });
    await viaForm(t);
    setModelTransportForTests(
      fakeTransport([reply({ body: `Hi Dana, a review? ${REVIEW_URL} Davi` })]).transport,
    );
    const r = await createDraftForThread(t, {
      trigger: "owner",
      workspaceId,
      purpose: "review_request",
      ...deps(),
    });
    expect(r.status).toBe("created");
    const d = await draftRow((r as { draftId: string }).draftId);
    expect(d.toAddress).toBe("dana@customer.com");
    expect(mimeTo(d.gmailDraftId)).toBe("To: dana@customer.com");
  });

  it("follow-up nudge and closing question", async () => {
    process.env.FEATURE_CLOSING_QUESTION = "on";
    await setStatus("active");
    const nudged = await acceptedQuote({ extracted: {}, lastDirection: "out" });
    await viaForm(nudged);
    setModelTransportForTests(
      fakeTransport([reply({ body: "Hi Dana,\n\nJust checking in on the quote.\n\nDavi" })])
        .transport,
    );
    const n = await createDraftForThread(nudged, { trigger: "followup", ...deps(at(4)) });
    expect(n.status).toBe("created");
    const nd = await draftRow((n as { draftId: string }).draftId);
    expect(nd).toMatchObject({ kind: "followup", toAddress: "dana@customer.com" });
    expect(mimeTo(nd.gmailDraftId)).toBe("To: dana@customer.com");

    const t = await acceptedQuote({ extracted: {}, lastDirection: "out" });
    await viaForm(t);
    await nudgesSent(t);
    setModelTransportForTests(
      fakeTransport([reply({ body: "Hi Dana,\n\nDid you go another way?\n\nDavi" })]).transport,
    );
    const r = await createDraftForThread(t, {
      trigger: "owner",
      workspaceId,
      purpose: "closing_question",
      ...deps(QUIET),
    });
    expect(r.status).toBe("created");
    const d = await draftRow((r as { draftId: string }).draftId);
    expect(d.toAddress).toBe("dana@customer.com");
    // The sent screen names the customer, never "Wix Forms".
    expect(await sendDraft(workspaceId, d.id, deps(QUIET))).toMatchObject({
      status: "sent",
      toName: "Dana Ruiz",
    });
  });
});
