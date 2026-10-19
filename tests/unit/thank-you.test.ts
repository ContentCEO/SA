import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import { checkDraft } from "@/ai/draft-checks";
import type { ModelDraft } from "@/ai/prompts/draft.v6";
import { PURPOSE_PROMPT_VERSION, thankYouTask } from "@/ai/prompts/purpose.v2";
import { REVIEW_LINK_MISSING_FLAG } from "@/ai/purpose";
import { draftTag } from "@/config/categories";
import type { Database } from "@/db";
import { activityLog, drafts, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { describeActivity } from "@/server/activity";
import { earnedCounts, guardrailReasons } from "@/server/autopilot";
import { batchEligible } from "@/server/batch-rules";
import { createDraftForThread, discardDraft, sendDraft } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { thankYouOfferReason } from "@/server/offer-rules";
import { recentReviewAddresses, thankYouAllowed, threadOffers } from "@/server/offers";
import { businessProfileInput, saveBusinessProfile } from "@/server/profile";
import { lockReviewAddress } from "@/server/review-lock";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

// The real lock, wrapped so a test can see the create path takes it.
vi.mock("@/server/review-lock", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/review-lock")>();
  return { ...real, lockReviewAddress: vi.fn(real.lockReviewAddress) };
});

const DAY = 86_400_000;
const NOW = new Date("2026-10-16T14:00:00Z");
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const REVIEW_URL = "https://g.page/r/elm-electric/review";
const DANA = "dana@customer.com";

const thanksWithLink = `Hi Dana,\n\nThanks so much for the payment. If you have a minute, a short review would mean a lot:\n${REVIEW_URL}\n\nDavi`;
const thanksPlain =
  "Hi Dana,\n\nGot your payment — thank you. It was good working with you.\n\nDavi";
const reply = (body: string): ModelDraft => ({
  body,
  reason: "Owner asked.",
  flags: [],
  confidence: 0.9,
  used_facts: [],
});

let database: Database;
let workspaceId: string;
let mailboxId: string;
let writer: FakeWriter;
let g = 0;
const deps = (when: Date = NOW) => ({ writerFor: () => writer, now: () => when });

async function profile(reviewUrl = REVIEW_URL) {
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
      paymentTerms: "",
      policies: "",
      signature: "Davi",
      reviewUrl,
      doNotPromise: "",
      vipSenders: "",
      amountThresholdDollars: "2500",
    }),
  );
}

/** An invoice the owner sent, the customer's "paid", and the owner's paid mark. */
async function paidInvoice(
  over: Partial<typeof threads.$inferInsert> = {},
  customer = DANA,
  from = customer,
) {
  const id = `g${++g}`;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: id,
      inInbox: true,
      subject: "Invoice 41",
      category: "invoice_payment",
      summary: "Dana paid invoice 41.",
      extracted: { invoice: { invoice_number: "41", amount: 900, status: "paid" } },
      classifiedAt: NOW,
      invoicePaidAt: at(-0.5),
      invoicePaidSource: "owner",
      lastMessageAt: at(-0.5),
      ...over,
    })
    .returning();
  const rows: (typeof messages.$inferInsert)[] = [
    {
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-1`,
      rfc822MessageId: `<${id}-1@mail.test>`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: [customer.toLowerCase()],
      subject: "Invoice 41",
      bodyText: "Invoice 41 attached: $900. Davi",
      labelIds: ["SENT"],
      sentAt: at(-5),
    },
    {
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-2`,
      rfc822MessageId: `<${id}-2@mail.test>`,
      direction: "in",
      fromAddress: from,
      fromName: "Dana Ruiz",
      toAddresses: ["owner@shop.com"],
      subject: "Re: Invoice 41",
      bodyText: "Paid the $900 just now. Thanks!",
      labelIds: ["INBOX"],
      replyToHeader: from === customer ? {} : { address: customer },
      sentAt: at(-0.5),
    },
  ];
  await database.insert(messages).values(rows);
  return t!.id;
}

const sayThanks = (t: string, trigger: "owner" | "auto" | "followup" = "owner") =>
  createDraftForThread(t, { trigger, workspaceId, purpose: "thank_you", ...deps() });

function model(...bodies: string[]) {
  const { transport, calls } = fakeTransport(bodies.map(reply));
  setModelTransportForTests(transport);
  return calls;
}
const draftRow = async (id: string) =>
  (await database.select().from(drafts).where(eq(drafts.id, id)))[0]!;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "100";
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
  await database
    .update(workspaces)
    .set({ status: "active", setupPaidVia: "stripe", plan: "crew" })
    .where(eq(workspaces.id, workspaceId));
  writer = new FakeWriter();
  vi.mocked(lockReviewAddress).mockClear();
});
afterEach(() => setModelTransportForTests(undefined));

describe("rules", () => {
  const base = {
    category: "invoice_payment",
    untrusted: false,
    invoicePaid: true,
    customerAddress: DANA,
    senderAddress: DANA,
    thankedBefore: false,
  };
  it("a paid invoice from a real customer, once per thread", () => {
    expect(thankYouOfferReason(base)).toBeNull();
    expect(thankYouOfferReason({ ...base, thankedBefore: true })).toBe("already_asked");
    expect(thankYouOfferReason({ ...base, invoicePaid: false })).toBe("not_eligible");
    expect(thankYouOfferReason({ ...base, untrusted: true })).toBe("not_eligible");
    expect(thankYouOfferReason({ ...base, category: "supplier_vendor" })).toBe("not_eligible");
    expect(thankYouOfferReason({ ...base, category: "noise" })).toBe("not_eligible");
    expect(thankYouOfferReason({ ...base, customerAddress: "no-reply@billing.test" })).toBe(
      "not_eligible",
    );
    expect(
      thankYouOfferReason({ ...base, senderAddress: "receipts@stripe.com", customerAddress: DANA }),
    ).toBe("not_eligible");
  });

  it("the prompt asks for nothing without a link, and for exactly the link with one", () => {
    expect(PURPOSE_PROMPT_VERSION).toBe("purpose.v2");
    const plain = thankYouTask({ reviewUrl: null });
    expect(plain).toContain("## Task: thank you");
    expect(plain).toContain("Ask for nothing: no review, no referral, no link");
    expect(plain).not.toContain("https://");
    const withAsk = thankYouTask({ reviewUrl: REVIEW_URL });
    expect(withAsk).toContain(`written on its own line: ${REVIEW_URL}`);
    expect(withAsk).toContain("No discount, gift, coupon");
    // Both: no amount, invoice number or way to pay.
    for (const t of [plain, withAsk]) expect(t).toContain("Don't mention any amount");
    // purpose.v1 stays as it was (a new prompt is a new file).
    expect(readFileSync("src/ai/prompts/purpose.v1.ts", "utf8")).not.toContain("thank");
  });

  it("labels: the queue tag and the Activity line", () => {
    expect(draftTag({ category: "invoice_payment", kind: "reply", purpose: "thank_you" })).toBe(
      "Thank-you for the payment",
    );
    expect(
      draftTag({ category: "invoice_payment", kind: "reply", purpose: "thank_you_review" }),
    ).toBe("Thank-you + review request");
    expect(
      describeActivity("draft_created", { purpose: "thank_you" }, { name: "Dana Ruiz" } as never),
    ).toBe("Drafted a thank-you for the payment to Dana");
    expect(
      describeActivity("draft_created", { purpose: "thank_you_review" }, {
        name: "Dana Ruiz",
      } as never),
    ).toBe("Drafted a thank-you for the payment, with a review request to Dana");
  });
});

describe("Say thanks on a paid invoice", () => {
  it("every review rule allows it: one note, with the review ask, under the per-address lock", async () => {
    await profile();
    const t = await paidInvoice();
    expect((await threadOffers(workspaceId, [t], NOW)).get(t)).toMatchObject({ thankYou: true });
    expect(await thankYouAllowed(workspaceId, t, NOW)).toEqual({ why: null, withReview: true });
    const calls = model(thanksWithLink);
    const r = await sayThanks(t);
    expect(r).toEqual({ status: "created", draftId: expect.any(String) });
    expect(calls[0]!.user).toContain("## Task: thank you");
    expect(calls[0]!.user).toContain(REVIEW_URL);
    const d = await draftRow((r as { draftId: string }).draftId);
    expect(d.promptVersion).toMatch(/\+purpose\.v2$/);
    expect(d).toMatchObject({ purpose: "thank_you_review", kind: "reply", toAddress: DANA });
    expect(d.flags).toEqual([]);
    expect(lockReviewAddress).toHaveBeenCalledTimes(1);
    // It counts as this customer's review request: none again for 12 months.
    expect((await recentReviewAddresses(workspaceId, NOW)).has(DANA)).toBe(true);
    const other = await paidInvoice({}, DANA);
    expect(await thankYouAllowed(workspaceId, other, NOW)).toEqual({
      why: null,
      withReview: false,
    });
    // Waiting in the queue now, so not offered again on this thread.
    expect((await threadOffers(workspaceId, [t], NOW)).get(t)?.thankYou).toBe(false);
  });

  it("no review link on file: a plain thank-you (no link, nothing asked, no lock)", async () => {
    await profile("");
    const t = await paidInvoice();
    const calls = model(thanksPlain);
    const r = await sayThanks(t);
    expect(r.status).toBe("created");
    expect(calls[0]!.user).toContain("Ask for nothing");
    expect(calls[0]!.user).not.toContain("https://");
    expect((await draftRow((r as { draftId: string }).draftId)).purpose).toBe("thank_you");
    expect(lockReviewAddress).not.toHaveBeenCalled();
    expect((await recentReviewAddresses(workspaceId, NOW)).size).toBe(0);
  });

  it("GUARDRAIL: a customer who complained in the last 12 months gets thanks, never a review ask", async () => {
    await profile();
    // Another job of Dana's, a complaint 2 months ago.
    await paidInvoice({ complainedAt: at(-60), category: "complaint", invoicePaidAt: null });
    const t = await paidInvoice();
    expect(await thankYouAllowed(workspaceId, t, NOW)).toEqual({ why: null, withReview: false });
    const calls = model(thanksPlain);
    const r = await sayThanks(t);
    expect((await draftRow((r as { draftId: string }).draftId)).purpose).toBe("thank_you");
    expect(calls[0]!.user).not.toContain(REVIEW_URL);
  });

  it("GUARDRAIL: someone the owner never wrote to gets thanks only (the review rules want a known customer)", async () => {
    await profile();
    const t = await paidInvoice({}, "new@customer.com");
    await database.delete(messages).where(eq(messages.direction, "out"));
    expect(await thankYouAllowed(workspaceId, t, NOW)).toEqual({ why: null, withReview: false });
  });

  it("not offered and refused before any model call: unpaid, not owed, receipts, robots, suppliers, injection, municipal, utility", async () => {
    await profile();
    const cases = [
      await paidInvoice({ invoicePaidAt: null, invoicePaidSource: null }, "a@customer.com"),
      await paidInvoice({ invoicePaidSource: "not_owed" }, "b@customer.com"),
      await paidInvoice({}, "c@customer.com", "receipts@stripe.com"),
      await paidInvoice({}, "no-reply@portal.test"),
      await paidInvoice({ category: "supplier_vendor" }, "d@customer.com"),
      await paidInvoice({ extracted: { injection: true } }, "e@customer.com"),
      await paidInvoice({ extracted: { municipal: true } }, "f@customer.com"),
      // Integrator, merge C: the electric company (Check 37 P3) like a town office.
      await paidInvoice({ extracted: { utility: true } }, "g@customer.com"),
    ];
    const offers = await threadOffers(workspaceId, cases, NOW);
    const calls = model(thanksPlain);
    for (const t of cases) {
      expect(offers.get(t)?.thankYou, t).toBe(false);
      expect(await sayThanks(t)).toEqual({ status: "skipped", reason: "not_eligible" });
    }
    expect(calls).toHaveLength(0);
    expect(writer.calls).toEqual([]);
  });

  it("GUARDRAIL: owner tap only — never a job, and no job passes a purpose", async () => {
    await profile();
    const t = await paidInvoice();
    const calls = model(thanksPlain);
    for (const trigger of ["auto", "followup"] as const) {
      expect(await sayThanks(t, trigger)).toEqual({
        status: "skipped",
        reason: "purpose_not_allowed",
      });
    }
    expect(calls).toHaveLength(0);
    expect(readFileSync("src/jobs/functions.ts", "utf8")).not.toMatch(/purpose:/);
  });

  it("GUARDRAIL: once per thread — after a discard too; a stale (expired) one doesn't count", async () => {
    await profile("");
    const t = await paidInvoice();
    model(thanksPlain, thanksPlain, thanksPlain);
    const first = await sayThanks(t);
    await discardDraft(workspaceId, (first as { draftId: string }).draftId, deps());
    expect((await threadOffers(workspaceId, [t], NOW)).get(t)?.thankYou).toBe(false);
    expect(await sayThanks(t)).toEqual({ status: "skipped", reason: "already_asked" });
    await database
      .update(drafts)
      .set({ status: "expired" })
      .where(eq(drafts.id, (first as { draftId: string }).draftId));
    expect((await sayThanks(t)).status).toBe("created");
  });

  it("the database refuses a second thank-you on a thread (the index), so a race reads 'already asked'", async () => {
    await profile("");
    const t = await paidInvoice();
    const base = {
      threadId: t,
      mailboxId,
      kind: "reply" as const,
      toAddress: DANA,
      subject: "Re: Invoice 41",
      reason: "Thanks.",
    };
    await database.insert(drafts).values({ ...base, purpose: "thank_you", status: "sent" });
    await expect(
      database.insert(drafts).values({ ...base, purpose: "thank_you_review", status: "discarded" }),
    ).rejects.toThrow();
  });

  it("GUARDRAIL: never autopilot, never batch, never earns autopilot, never a nudge", async () => {
    const g = guardrailReasons({
      category: "invoice_payment",
      needsOwner: false,
      kind: "reply",
      confidencePct: 99,
      flags: [],
      amountsInEmail: [],
      draftBody: thanksPlain,
      knownCustomer: true,
      purpose: "thank_you",
    });
    expect(g).toContain("Deposit, review and closing notes always wait for you.");
    expect(
      batchEligible(
        {
          category: "invoice_payment",
          kind: "reply",
          purpose: "thank_you_review",
        } as never,
        ["invoice_payment"],
      ),
    ).toBe(false);

    await profile("");
    const t = await paidInvoice({ followupCount: 1 });
    model(thanksPlain);
    const r = await sayThanks(t);
    const id = (r as { draftId: string }).draftId;
    expect((await sendDraft(workspaceId, id, deps())).status).toBe("sent");
    const [thread] = await database.select().from(threads).where(eq(threads.id, t));
    expect(thread!.followupCount).toBe(1);
    expect((await earnedCounts(workspaceId)).get("invoice_payment") ?? 0).toBe(0);
    const [log] = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "draft_created"));
    expect(log!.detail).toMatchObject({ purpose: "thank_you", trigger: "owner" });
  });

  it("the same terms checks as a review request: nothing offered, no other link, no amount", () => {
    const thanks = {
      sourceText: "Paid the $900 just now. Thanks!",
      doNotPromise: [],
      phrasesAvoided: [],
      neverSay: [],
      checkTerms: true,
      termsSource: "",
      ownerWrote: "",
    };
    expect(
      checkDraft(`${thanksPlain}\n\n10% off your next job!`, { ...thanks, review: { url: null } })
        .hits,
    ).toContain("terms");
    expect(
      checkDraft(`${thanksPlain}\nhttps://example.com/deal`, { ...thanks, review: { url: null } })
        .flags,
    ).toContain("Has a link that isn't your review link. Check it.");
    expect(
      checkDraft("Thanks for the $900, Dana!", { ...thanks, review: { url: null } }).hits,
    ).toContain("terms");
    expect(checkDraft(thanksWithLink, { ...thanks, review: { url: REVIEW_URL } }).flags).toEqual(
      [],
    );
  });

  it("a thank-you with the ask that lost its link is flagged before it can go", async () => {
    await profile();
    const t = await paidInvoice();
    model(thanksPlain);
    const r = await sayThanks(t);
    const d = await draftRow((r as { draftId: string }).draftId);
    expect(d.purpose).toBe("thank_you_review");
    expect(d.flags[0]).toBe(REVIEW_LINK_MISSING_FLAG);
  });
});

describe("Money's paid rows", () => {
  it("offer one Say thanks button, never the separate Ask for a review; Inbox keeps its own", () => {
    const money = readFileSync("src/app/(app)/money/page.tsx", "utf8");
    expect(money).toContain("{ review: false, closingQuestion: false, thankYou: offers.thankYou }");
    const buttons = readFileSync("src/components/app/offer-buttons.tsx", "utf8");
    expect(buttons).toContain("Say thanks");
    expect(buttons).toContain("action={sayThanksAction}");
    const inbox = readFileSync("src/app/(app)/inbox/page.tsx", "utf8");
    expect(inbox).toContain("offers={inboxOffers(offers.get(row.id))}");
    expect(inbox).toContain("{ ...o, thankYou: false }");
  });
});
