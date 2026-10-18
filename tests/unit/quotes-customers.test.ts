import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { Database } from "@/db";
import {
  activityLog,
  drafts,
  mailboxes,
  messages,
  priceHistory,
  threads,
  workspaces,
} from "@/db/schema";
import { MailboxAuthError } from "@/mailbox/connector";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { classifyPending } from "@/server/classification";
import { threadsToFollowUp } from "@/server/followups";
import { afterClassified } from "@/server/auto-outcomes";
import { flagPendingNudge } from "@/server/drafts";
import { customerByKey, customerDetail, listCustomers } from "@/server/customers";
import { ReadOnlyError } from "@/server/lifecycle";
import { saveConnectedMailbox } from "@/server/mailboxes";
import {
  amountFromOwnerText,
  canAutoSet,
  closeRate,
  formatCents,
  guessNoAnswer,
  isQuoteThread,
  keepQuoteAccepted,
  quoteStopsNudges,
  parseDollars,
  QUOTE_GUESS_FLAG,
  quoteAccepted,
  quoteStage,
  readOwnerAmount,
} from "@/server/quote-rules";
import {
  autoSetQuoteOutcome,
  captureQuoteAmounts,
  guessNoAnswers,
  listQuotes,
  setQuoteOutcome,
} from "@/server/quotes";
import { quoteThreadSql } from "@/server/thread-sql";
import { createTestDb } from "../support/db";
import { classification, fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const DAY = 86_400_000;
const NOW = new Date("2026-10-10T14:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

describe("quote rules", () => {
  const f = (o: Partial<Parameters<typeof quoteStage>[0]>) => ({
    outcome: null,
    lastInboundAt: daysAgo(5),
    lastOutboundAt: null,
    ...o,
  });
  it("works out where each quote stands", () => {
    expect(quoteStage(f({}), NOW, 3)).toBe("waiting_on_you");
    expect(quoteStage(f({ lastOutboundAt: daysAgo(1) }), NOW, 3)).toBe("talking");
    expect(quoteStage(f({ lastOutboundAt: daysAgo(4) }), NOW, 3)).toBe("quiet");
    expect(quoteStage(f({ lastOutboundAt: daysAgo(4), lastInboundAt: daysAgo(1) }), NOW, 3)).toBe(
      "waiting_on_you",
    );
    expect(quoteStage(f({ outcome: "won" }), NOW, 3)).toBe("won");
    expect(quoteStage(f({ outcome: "lost", lastOutboundAt: daysAgo(9) }), NOW, 3)).toBe("lost");
    expect(quoteStage(f({ outcome: "no_answer", lastOutboundAt: daysAgo(9) }), NOW, 3)).toBe(
      "no_answer",
    );
    // Anything else in the column is ignored rather than shown.
    expect(quoteStage(f({ outcome: "maybe" }), NOW, 3)).toBe("waiting_on_you");
  });

  it("guesses no answer a week after two nudges, or after three quiet weeks", () => {
    const q = (outAgo: number, sentNudges: number, inAgo = outAgo + 2) => ({
      lastInboundAt: daysAgo(inAgo),
      lastOutboundAt: daysAgo(outAgo),
      sentNudges,
    });
    expect(guessNoAnswer(q(7, 2), NOW)).toBe("two_nudges");
    expect(guessNoAnswer(q(6, 2), NOW)).toBeNull();
    expect(guessNoAnswer(q(10, 1), NOW)).toBeNull();
    // Follow-ups off (or the nudges were discarded): three weeks.
    expect(guessNoAnswer(q(21, 0), NOW)).toBe("three_weeks");
    expect(guessNoAnswer(q(20, 0), NOW)).toBeNull();
    // The customer wrote last → still open.
    expect(guessNoAnswer(q(30, 2, 1), NOW)).toBeNull();
    // The customer never wrote → nobody to have answered.
    expect(
      guessNoAnswer({ lastInboundAt: null, lastOutboundAt: daysAgo(30), sentNudges: 2 }, NOW),
    ).toBeNull();
    // The owner never wrote → no quote was given.
    expect(
      guessNoAnswer({ lastInboundAt: daysAgo(30), lastOutboundAt: null, sentNudges: 0 }, NOW),
    ).toBeNull();
  });

  it("close rate counts no answer as decided", () => {
    expect(closeRate({ won: 2, lost: 1, noAnswer: 1 })).toBe(50);
    expect(closeRate({ won: 0, lost: 0, noAnswer: 0 })).toBeNull();
    expect(closeRate({ won: 1, lost: 0, noAnswer: 2 })).toBe(33);
  });

  it("our guess never goes over the owner's choice (A13)", () => {
    expect(canAutoSet(null, null)).toBe(true);
    expect(canAutoSet("no_answer", "auto")).toBe(true);
    expect(canAutoSet("lost", "owner")).toBe(false);
    expect(canAutoSet(null, "owner")).toBe(false); // the owner reopened it
    expect(canAutoSet("lost", null)).toBe(false); // set before the column existed
  });
  it("reads the quoted amount from the owner's words", () => {
    expect(amountFromOwnerText("It's $2,400 incl. permit, $150 deposit")).toBe(240_000);
    expect(amountFromOwnerText("about $3.5k all in")).toBe(350_000);
    expect(amountFromOwnerText("I'll come take a look")).toBeNull();
    // Check 11 P2: the owner's own price, never the biggest number in the email.
    const cases: [string, number | null][] = [
      ["$900 for the faucet.\n\nJobs over $5,000 need a 30% deposit", 90_000],
      ["$900 for the faucet.\n--\nMike's Plumbing\nJobs over $5,000 need a 30% deposit", 90_000],
      [
        "Hi Dana, $2,400 for the panel.\n\nFrom: Dana Ruiz <dana@x.com>\nSent: Monday, October 5, 2026 9:14 AM\nTo: Mike\nOur budget is $8,000",
        240_000,
      ],
      [
        "Hi Dana, $2,400 for the panel.\n\nOn Mon, Oct 5, 2026 at 9:14 AM Dana Ruiz <\ndana@x.com> wrote:\nOur budget is $8,000",
        240_000,
      ],
      ["Normally $5,000 but I can do $4,200", 420_000],
      ["The right price is $2,100, not $2,600", 210_000],
      ["I charge $95 per hour", null],
      ["$125/hr with a $75 trip charge", null],
      ["Option A $650, Option B $3,900", null],
      ["$600 installed, $10,000 workmanship guarantee", 60_000],
      ["You'd save $2,000. Repair is $450.", 45_000],
      ["The panel costs me $1,800 from the supply house; my price installed is $1,500", 150_000],
      ["$ 3 200 for the deck boards", null],
      ["About $1,2k", null],
      ["$4,800 total, with a $500 deposit to book", 480_000],
      ["$12k for the addition", 1_200_000],
      ["$4,000 plus $250 tax, $4,250 total", 425_000],
      ["$1,450 for the vanity.\n\nSent from my iPhone\n\n> Our budget is $3,000", 145_000],
      // Check 39 P3: rebates, loans and monthly payments are never the price.
      [
        "$21,400 installed. After the $8,500 Mass Save rebate you'd be at $12,900, and the HEAT Loan covers up to $25,000 at 0%.",
        2_140_000,
      ],
      [
        "Single-zone mini-split $6,200 installed. You may get a $2,650 per ton rebate, up to $8,500 for the whole home.",
        620_000,
      ],
      ["3-ton heat pump $14,950. Basic rebate is $250 per ton.", 1_495_000],
      [
        "Boiler replacement $9,800. With the 0% HEAT Loan up to $25,000 you'd pay about $117 a month.",
        980_000,
      ],
      ["$219 a year, or $19 a month", 21_900],
      [
        "$7,450 for the AC. Income-eligible homes can get up to $16,000 through Mass Save.",
        745_000,
      ],
      ["Up to $25,000 at 0%.", null],
    ];
    const wrong = cases.filter(([text, want]) => amountFromOwnerText(text) !== want);
    expect(wrong.map(([t, w]) => [t, w, amountFromOwnerText(t)])).toEqual([]);
    // How sure: a marked total or a lone figure is 'total'; the last of several is 'picked'.
    expect(readOwnerAmount("$4,000 plus $250 tax, $4,250 total")).toEqual({
      cents: 425_000,
      note: "total",
    });
    expect(readOwnerAmount("That's $1,200.")).toEqual({ cents: 120_000, note: "total" });
    expect(readOwnerAmount("Kitchen $3,000, bath $1,800")).toEqual({
      cents: 180_000,
      note: "picked",
    });
    expect(formatCents(145_000)).toBe("$1,450");
    expect(formatCents(145_050)).toBe("$1,450.50");
    expect(parseDollars("$1,450")).toBe(145_000);
    expect(parseDollars("abc")).toBeNull();
    expect(parseDollars("")).toBeNull();
  });
});

let database: Database;
let workspaceId: string;
let mailboxId: string;
let g = 0;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
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
});

async function convo(opts: {
  from: string;
  name: string;
  category: string;
  inAgo: number;
  outAgo?: number;
  reply?: string;
}) {
  const id = `g${++g}`;
  const last = Math.min(opts.inAgo, opts.outAgo ?? Infinity);
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: id,
      inInbox: true,
      subject: "Job",
      category: opts.category,
      summary: `${opts.name} wants something.`,
      lastMessageAt: daysAgo(last),
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `${id}-in`,
    direction: "in",
    fromAddress: opts.from,
    fromName: opts.name,
    bodyText: "Can you quote it?",
    sentAt: daysAgo(opts.inAgo),
  });
  if (opts.outAgo !== undefined) {
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-out`,
      direction: "out",
      fromAddress: "owner@shop.com",
      bodyText: opts.reply ?? "Sure.",
      sentAt: daysAgo(opts.outAgo),
    });
  }
  return t!.id;
}

describe("quote acceptance context (A5)", () => {
  it("a quote thread is a quote request, or anything that has ever had an outcome", () => {
    const t = (category: string | null, quoteOutcome: string | null, src: string | null = null) =>
      isQuoteThread({ category, quoteOutcome, quoteOutcomeSource: src });
    expect(t("quote_request", null)).toBe(true);
    expect(t("scheduling", "won", "auto")).toBe(true);
    // Our no-answer guess was cleared when the customer wrote back, and that reply was
    // sorted as scheduling: still a quote. Same for an owner's reopen.
    expect(t("scheduling", null, "auto")).toBe(true);
    expect(t("customer_question", null, "owner")).toBe(true);
    expect(t("scheduling", null)).toBe(false);
    expect(t(null, null)).toBe(false);
  });

  it("lost / no answer stop every nudge; won stops quote nudges but not the job's invoice", () => {
    const stops = (quoteOutcome: string | null, category: string) =>
      quoteStopsNudges({ quoteOutcome, category });
    expect(stops(null, "quote_request")).toBe(false);
    expect(stops("won", "quote_request")).toBe(true);
    expect(stops("lost", "quote_request")).toBe(true);
    expect(stops("no_answer", "quote_request")).toBe(true);
    expect(stops("won", "invoice_payment")).toBe(false);
    expect(stops("lost", "invoice_payment")).toBe(true);
    expect(stops("no_answer", "invoice_payment")).toBe(true);
  });

  const base = {
    acceptsQuote: true,
    injection: false,
    previous: { category: "quote_request", quoteOutcome: null, quoteOutcomeSource: null },
    category: "scheduling",
    ownerWroteBefore: true,
    priceGiven: true,
  };
  it("needs the signal, a quote context, an owner reply before it, and no injection", () => {
    expect(quoteAccepted(base)).toBe(true);
    expect(
      quoteAccepted({
        ...base,
        previous: { category: null, quoteOutcome: null, quoteOutcomeSource: null },
        category: "quote_request",
      }),
    ).toBe(true);
    expect(quoteAccepted({ ...base, acceptsQuote: false })).toBe(false);
    expect(quoteAccepted({ ...base, ownerWroteBefore: false })).toBe(false);
    expect(quoteAccepted({ ...base, injection: true })).toBe(false);
    // "I can come look Tuesday" → "Sounds good, book us in": no price given, no acceptance.
    expect(quoteAccepted({ ...base, priceGiven: false })).toBe(false);
    expect(
      quoteAccepted({
        ...base,
        previous: { category: "scheduling", quoteOutcome: null, quoteOutcomeSource: null },
      }),
    ).toBe(false);
    // A cleared guess still counts as a quote context.
    expect(
      quoteAccepted({
        ...base,
        previous: { category: "scheduling", quoteOutcome: null, quoteOutcomeSource: "auto" },
        category: "customer_question",
      }),
    ).toBe(true);
  });
  it("a fresh quote request without the signal is never an acceptance (precedence guard)", () => {
    expect(
      quoteAccepted({
        ...base,
        acceptsQuote: false,
        previous: { category: null, quoteOutcome: null, quoteOutcomeSource: null },
        category: "quote_request",
      }),
    ).toBe(false);
  });
  it("an earlier acceptance carries over unless the owner decided otherwise", () => {
    const accepted = {
      extracted: { quote_accepted: true },
      quoteOutcome: null,
      quoteOutcomeSource: null,
    };
    expect(keepQuoteAccepted(accepted)).toBe(true);
    expect(keepQuoteAccepted({ ...accepted, extracted: { accepts_quote: true } })).toBe(false);
    expect(keepQuoteAccepted({ ...accepted, extracted: null })).toBe(false);
    // Our own guesses never undo it; the owner's "won" keeps it.
    expect(
      keepQuoteAccepted({ ...accepted, quoteOutcome: "won", quoteOutcomeSource: "auto" }),
    ).toBe(true);
    expect(
      keepQuoteAccepted({ ...accepted, quoteOutcome: "no_answer", quoteOutcomeSource: "auto" }),
    ).toBe(true);
    expect(
      keepQuoteAccepted({ ...accepted, quoteOutcome: "won", quoteOutcomeSource: "owner" }),
    ).toBe(true);
    // The owner marked it lost / no answer, or reopened it.
    expect(
      keepQuoteAccepted({ ...accepted, quoteOutcome: "lost", quoteOutcomeSource: "owner" }),
    ).toBe(false);
    expect(
      keepQuoteAccepted({ ...accepted, quoteOutcome: "no_answer", quoteOutcomeSource: "owner" }),
    ).toBe(false);
    expect(
      keepQuoteAccepted({ ...accepted, quoteOutcome: null, quoteOutcomeSource: "owner" }),
    ).toBe(false);
    // An outcome without a source predates the column: the owner's.
    expect(keepQuoteAccepted({ ...accepted, quoteOutcome: "lost", quoteOutcomeSource: null })).toBe(
      false,
    );
  });
});

describe("quote tracker", () => {
  it("lists quotes with stages, amounts and 30-day totals", async () => {
    await convo({ from: "dana@x.com", name: "Dana Ruiz", category: "quote_request", inAgo: 2 });
    const quiet = await convo({
      from: "Priya@Y.com",
      name: "Priya",
      category: "quote_request",
      inAgo: 8,
      outAgo: 6,
      reply: "Hi Priya, $2,400 for the panel.\n\nOn Mon, Priya wrote:\n> is $5,000 ok?",
    });
    const won = await convo({
      from: "sam@z.com",
      name: "Sam",
      category: "quote_request",
      inAgo: 10,
      outAgo: 9,
      reply: "$900 total.",
    });
    await convo({ from: "ads@spam.com", name: "Ads", category: "noise", inAgo: 1 });

    expect(await setQuoteOutcome(workspaceId, won, "won", undefined, NOW)).toBe(true);
    const { quotes, totals } = await listQuotes(workspaceId, NOW);
    expect(quotes).toHaveLength(3);
    const by = Object.fromEntries(quotes.map((q) => [q.threadId, q]));
    expect(by[quiet]!.stage).toBe("quiet");
    expect(by[quiet]!.amountCents).toBe(240_000); // the customer's quoted $5,000 is ignored
    expect(by[won]!.stage).toBe("won");
    expect(totals).toMatchObject({
      requests: 3,
      quotedCount: 2,
      quotedCents: 330_000,
      wonCount: 1,
      wonCents: 90_000,
      winRatePct: 100,
    });
  });

  it("keeps the amount after the reply text is purged, and lets the owner correct it", async () => {
    const t = await convo({
      from: "dana@x.com",
      name: "Dana",
      category: "quote_request",
      inAgo: 3,
      outAgo: 2,
      reply: "That's $1,200.",
    });
    expect(await captureQuoteAmounts()).toBe(1);
    await database.update(messages).set({ bodyText: null }).where(eq(messages.threadId, t));
    await captureQuoteAmounts();
    expect((await listQuotes(workspaceId, NOW)).quotes[0]!.amountCents).toBe(120_000);
    await setQuoteOutcome(workspaceId, t, "won", 135_000, NOW);
    expect((await listQuotes(workspaceId, NOW)).quotes[0]!.amountCents).toBe(135_000);
    await setQuoteOutcome(workspaceId, t, null, undefined, NOW); // reopen
    expect((await listQuotes(workspaceId, NOW)).quotes[0]!.stage).toBe("talking");
  });

  it("price memory only learns clear prices: never a signature figure or our pick (Check 11 P2)", async () => {
    const sig = await convo({
      from: "dana@x.com",
      name: "Dana",
      category: "quote_request",
      inAgo: 3,
      outAgo: 2,
      reply: "$900 for the faucet.\n\nMike's Plumbing\nJobs over $5,000 need a 30% deposit",
    });
    const two = await convo({
      from: "kim@x.com",
      name: "Kim",
      category: "quote_request",
      inAgo: 3,
      outAgo: 2,
      reply: "Kitchen $3,000, bath $1,800",
    });
    for (const id of [sig, two])
      await database
        .update(threads)
        .set({ extracted: { service_requested: "faucet swap" } })
        .where(eq(threads.id, id));
    expect(await captureQuoteAmounts()).toBe(2);
    const memory = await database.select().from(priceHistory);
    expect(memory.map((r) => [r.threadId, r.amountCents])).toEqual([[sig, 90_000]]);
    const by = Object.fromEntries(
      (await listQuotes(workspaceId, NOW)).quotes.map((q) => [q.threadId, q]),
    );
    expect(by[sig]).toMatchObject({ amountCents: 90_000, amountUnsure: false });
    expect(by[two]).toMatchObject({ amountCents: 180_000, amountUnsure: true });
    // A second pass (and the backfill) still leaves the pick out.
    await captureQuoteAmounts();
    expect(await database.select().from(priceHistory)).toHaveLength(1);
  });

  it("an unsent Gmail draft is neither the owner's answer nor a price (stage, amount)", async () => {
    const t = await convo({
      from: "dana@x.com",
      name: "Dana",
      category: "quote_request",
      inAgo: 3,
    });
    // Stored by the old sync: the auto-draft, quoting the price list, never sent.
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `${t}-draft`,
      direction: "out",
      fromAddress: "owner@shop.com",
      labelIds: ["DRAFT"],
      bodyText: "That'll be $1,800.",
      sentAt: daysAgo(2),
    });
    const [q] = (await listQuotes(workspaceId, NOW)).quotes;
    expect(q).toMatchObject({ stage: "waiting_on_you", amountCents: null });
  });

  it("can't touch another workspace's thread", async () => {
    const t = await convo({ from: "d@x.com", name: "D", category: "quote_request", inAgo: 1 });
    const { workspace: other } = await ensureUserAndWorkspace({ email: "other@shop.com" });
    expect(await setQuoteOutcome(other.id, t, "won")).toBe(false);
    expect(await setQuoteOutcome(other.id, t, "no_answer")).toBe(false);
    expect((await listQuotes(other.id, NOW)).quotes).toHaveLength(0);
    const [row] = await database.select().from(threads).where(eq(threads.id, t));
    expect(row).toMatchObject({ quoteOutcome: null, quoteOutcomeSource: null });
  });

  it("the win rate counts no answer (ours or the owner's) as decided", async () => {
    const won = await convo({
      from: "sam@z.com",
      name: "Sam",
      category: "quote_request",
      inAgo: 10,
      outAgo: 9,
    });
    // Answered 25 days ago, never heard back: listQuotes guesses no answer.
    const quiet = await convo({
      from: "kim@z.com",
      name: "Kim",
      category: "quote_request",
      inAgo: 26,
      outAgo: 25,
    });
    await setQuoteOutcome(workspaceId, won, "won", undefined, NOW);
    const { quotes, totals } = await listQuotes(workspaceId, NOW);
    const by = Object.fromEntries(quotes.map((q) => [q.threadId, q]));
    expect(by[quiet]).toMatchObject({ stage: "no_answer", outcomeGuessed: true });
    expect(by[won]).toMatchObject({ stage: "won", outcomeGuessed: false });
    expect(totals.winRatePct).toBe(50);
  });

  it("the owner's mark is always the owner's — reopening too", async () => {
    const t = await convo({ from: "d@x.com", name: "D", category: "quote_request", inAgo: 2 });
    await setQuoteOutcome(workspaceId, t, "no_answer", undefined, NOW);
    let [row] = await database.select().from(threads).where(eq(threads.id, t));
    expect(row).toMatchObject({ quoteOutcome: "no_answer", quoteOutcomeSource: "owner" });
    await setQuoteOutcome(workspaceId, t, null, undefined, NOW);
    [row] = await database.select().from(threads).where(eq(threads.id, t));
    expect(row).toMatchObject({
      quoteOutcome: null,
      quoteOutcomeSource: "owner",
      quoteOutcomeAt: null,
    });
    const log = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "quote_marked"));
    expect(log.map((l) => l.detail)).toEqual([{ outcome: "no_answer" }, { outcome: null }]);
  });

  it("read-only accounts can't mark quotes (amendment Q9)", async () => {
    const t = await convo({ from: "d@x.com", name: "D", category: "quote_request", inAgo: 2 });
    await database
      .update(workspaces)
      .set({ status: "evaluation_expired" })
      .where(eq(workspaces.id, workspaceId));
    await expect(setQuoteOutcome(workspaceId, t, "won", undefined, NOW)).rejects.toBeInstanceOf(
      ReadOnlyError,
    );
    const [row] = await database.select().from(threads).where(eq(threads.id, t));
    expect(row!.quoteOutcome).toBeNull();
    expect(
      await database.select().from(activityLog).where(eq(activityLog.action, "quote_marked")),
    ).toEqual([]);
  });
});

describe("customer list", () => {
  it("groups by sender (case-insensitive), leaves out noise, and adds quote facts", async () => {
    const q = await convo({
      from: "Dana@X.com",
      name: "Dana Ruiz",
      category: "quote_request",
      inAgo: 5,
      outAgo: 4,
      reply: "$700",
    });
    await convo({ from: "dana@x.com", name: "Dana Ruiz", category: "scheduling", inAgo: 1 });
    await convo({
      from: "rep@supply.com",
      name: "Supply Co",
      category: "supplier_vendor",
      inAgo: 2,
    });
    await convo({ from: "ads@spam.com", name: "Ads", category: "noise", inAgo: 1 });
    await setQuoteOutcome(workspaceId, q, "won", undefined, NOW);

    const list = await listCustomers(workspaceId, NOW);
    expect(list.map((c) => c.address)).toEqual(["dana@x.com", "rep@supply.com"]);
    expect(list[0]).toMatchObject({ name: "Dana Ruiz", conversations: 2, wonCents: 70_000 });
    expect(list[1]!.isSupplier).toBe(true);

    const d = await customerDetail(workspaceId, "DANA@x.com");
    expect(d!.threads).toHaveLength(2);
    expect(d!.name).toBe("Dana Ruiz");
    expect(await customerDetail(workspaceId, "ads@spam.com")).toMatchObject({ threads: [] });
    expect(await customerDetail(workspaceId, "nobody@x.com")).toBeNull();
    expect((await customerByKey(workspaceId, list[0]!.key))!.address).toBe("dana@x.com");
    expect(await customerByKey(workspaceId, "not-a-key")).toBeNull();
  });

  it("never shows another workspace's customers", async () => {
    await convo({ from: "dana@x.com", name: "Dana", category: "quote_request", inAgo: 1 });
    const { workspace: other } = await ensureUserAndWorkspace({ email: "other@shop.com" });
    expect(await listCustomers(other.id, NOW)).toEqual([]);
    expect(await customerDetail(other.id, "dana@x.com")).toBeNull();
    const [mine] = await listCustomers(workspaceId, NOW);
    expect(await customerByKey(other.id, mine!.key)).toBeNull();
  });
});

describe("win/loss auto-guess", () => {
  const signals = classification().signals;
  const accepting = (over: Parameters<typeof classification>[0] = {}) =>
    classification({ signals: { ...signals, accepts_quote: true }, ...over });

  /** Dana asked for a price (5 days ago), the owner quoted (3 days ago); all sorted. */
  async function quoteGiven(
    over: Partial<typeof threads.$inferInsert> = {},
    { askAgo = 5, quoteAgo = 3 }: { askAgo?: number; quoteAgo?: number } = {},
  ) {
    const id = `qa${++g}`;
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: id,
        inInbox: true,
        subject: "Panel",
        category: "quote_request",
        classifiedAt: daysAgo(askAgo),
        lastMessageAt: daysAgo(quoteAgo),
        ...over,
      })
      .returning();
    await database.insert(messages).values([
      {
        threadId: t!.id,
        mailboxId,
        gmailMessageId: `${id}-ask`,
        direction: "in",
        fromAddress: "dana@x.com",
        fromName: "Dana Ruiz",
        bodyText: "Can you quote a panel upgrade?",
        labelIds: ["INBOX"],
        sentAt: daysAgo(askAgo),
        classifiedAt: daysAgo(askAgo),
      },
      {
        threadId: t!.id,
        mailboxId,
        gmailMessageId: `${id}-quote`,
        direction: "out",
        fromAddress: "owner@shop.com",
        toAddresses: ["dana@x.com"],
        bodyText: "It's $2,400.",
        sentAt: daysAgo(quoteAgo),
      },
    ]);
    return t!.id;
  }
  /** Dana writes again (unsorted until classifyPending runs). */
  async function customerWrites(threadId: string, ago: number) {
    await database.insert(messages).values({
      threadId,
      mailboxId,
      gmailMessageId: `w${++g}`,
      direction: "in",
      fromAddress: "dana@x.com",
      fromName: "Dana Ruiz",
      bodyText: "Let's do it.",
      labelIds: ["INBOX"],
      sentAt: daysAgo(ago),
    });
  }
  async function sentNudges(threadId: string, agos: number[]) {
    for (const ago of agos) {
      await database.insert(drafts).values({
        threadId,
        mailboxId,
        kind: "followup",
        gmailDraftId: `n${++g}`,
        toAddress: "dana@x.com",
        subject: "Re: Panel",
        body: "nudge",
        originalBody: "nudge",
        status: "sent",
        reason: "nudge",
        promptVersion: "followup.v3",
        createdAt: daysAgo(ago + 0.1),
        decidedAt: daysAgo(ago),
      });
      await database.insert(messages).values({
        threadId,
        mailboxId,
        gmailMessageId: `nm${++g}`,
        direction: "out",
        fromAddress: "owner@shop.com",
        bodyText: "nudge",
        sentAt: daysAgo(ago),
      });
    }
  }
  const classifyWith = async (...outputs: unknown[]) => {
    const fake = fakeTransport(outputs);
    setModelTransportForTests(fake.transport);
    await classifyPending(mailboxId, { now: NOW });
    return fake.calls;
  };
  const rowOf = async (id: string) =>
    (await database.select().from(threads).where(eq(threads.id, id)))[0]!;
  const guesses = async () =>
    database.select().from(activityLog).where(eq(activityLog.action, "quote_outcome_guessed"));

  beforeEach(() => {
    process.env.AI_DAILY_CALL_CAP = "100";
  });

  it("the customer says go ahead on a quote → won (our guess)", async () => {
    const t = await quoteGiven();
    await customerWrites(t, 1);
    await classifyWith(accepting());
    expect(await rowOf(t)).toMatchObject({
      quoteOutcome: "won",
      quoteOutcomeSource: "auto",
      quoteOutcomeAt: NOW,
    });
    const log = await guesses();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      workspaceId,
      threadId: t,
      actor: "squared_away",
      detail: { outcome: "won", why: "accepted" },
    });
    const [q] = (await listQuotes(workspaceId, NOW)).quotes;
    expect(q).toMatchObject({ stage: "won", outcomeGuessed: true });
  });

  it("…also when the acceptance is sorted as scheduling (the previous category decides)", async () => {
    const t = await quoteGiven();
    await customerWrites(t, 1);
    await classifyWith(accepting({ category: "scheduling" }));
    expect(await rowOf(t)).toMatchObject({
      category: "scheduling",
      quoteOutcome: "won",
      quoteOutcomeSource: "auto",
    });
  });

  it("a plain reply, or a fresh quote request, is never marked won", async () => {
    const t = await quoteGiven();
    await customerWrites(t, 1);
    await classifyWith(classification());
    expect((await rowOf(t)).quoteOutcome).toBeNull();
    // A brand-new request saying "go ahead" with no quote from the owner yet.
    const [fresh] = await database
      .insert(threads)
      .values({ mailboxId, gmailThreadId: "fresh", inInbox: true, lastMessageAt: daysAgo(1) })
      .returning();
    await customerWrites(fresh!.id, 1);
    await classifyWith(accepting());
    expect((await rowOf(fresh!.id)).quoteOutcome).toBeNull();
    expect(await guesses()).toEqual([]);
  });

  it("GUARDRAIL: 'Sounds good, book us in' after 'I can come look Tuesday' is a site visit, not a won quote", async () => {
    const t = await quoteGiven();
    // The owner's only reply offered a visit — no price anywhere.
    await database
      .update(messages)
      .set({ bodyText: "I can come take a look Tuesday morning. Davi" })
      .where(and(eq(messages.threadId, t), eq(messages.direction, "out")));
    await customerWrites(t, 1);
    await classifyWith(accepting());
    const row = await rowOf(t);
    // The signal is kept; the acceptance and everything it drives are not.
    expect(row.extracted).toMatchObject({ accepts_quote: true });
    expect(row.extracted).not.toHaveProperty("quote_accepted");
    expect(row).toMatchObject({ quoteOutcome: null, quoteOutcomeSource: null });
    expect(await guesses()).toEqual([]);

    // Once a price is known (captured or typed), the same words are an acceptance.
    await database.update(threads).set({ quoteAmountCents: 240_000 }).where(eq(threads.id, t));
    await customerWrites(t, 0.5);
    await classifyWith(accepting());
    expect(await rowOf(t)).toMatchObject({
      quoteOutcome: "won",
      quoteOutcomeSource: "auto",
      extracted: { quote_accepted: true, quote_accepted_at: daysAgo(0.5).toISOString() },
    });
  });

  it("an email that tries to instruct the assistant never marks a quote (A8)", async () => {
    const t = await quoteGiven();
    await customerWrites(t, 1);
    await classifyWith(
      accepting({
        signals: { ...signals, accepts_quote: true, tries_to_instruct_assistant: true },
      }),
    );
    expect((await rowOf(t)).quoteOutcome).toBeNull();
    expect(await guesses()).toEqual([]);
  });

  it("GUARDRAIL (A8): an injection email never marks, even with an acceptance carried over", async () => {
    const t = await quoteGiven();
    // Called directly with quote_accepted already set (as keepQuoteAccepted carries it from
    // an earlier email), so only afterClassified's own injection check stands in the way.
    await afterClassified({
      workspaceId,
      threadId: t,
      fromAddress: "dana@x.com",
      previous: { category: "quote_request", quoteOutcome: null, quoteOutcomeSource: null },
      result: {
        category: "scheduling",
        priority: "normal",
        needsOwner: true,
        needsOwnerReason: "Tries to instruct the assistant.",
        summary: "Dana says go ahead.",
        confidence: 0.9,
        extracted: {
          ...classification().extracted,
          accepts_quote: true,
          quote_accepted: true,
          injection: true,
        },
        unreadable: false,
      },
      now: NOW,
    });
    expect(await rowOf(t)).toMatchObject({ quoteOutcome: null, quoteOutcomeSource: null });
    expect(await guesses()).toEqual([]);

    // Through classification too: the thread carries an earlier acceptance, and the
    // customer's next email is an injection attempt that also "accepts".
    await database
      .update(threads)
      .set({ extracted: { quote_accepted: true } })
      .where(eq(threads.id, t));
    await customerWrites(t, 1);
    await classifyWith(
      accepting({
        signals: { ...signals, accepts_quote: true, tries_to_instruct_assistant: true },
      }),
    );
    expect(await rowOf(t)).toMatchObject({
      quoteOutcome: null,
      extracted: expect.objectContaining({ quote_accepted: true, injection: true }),
    });
    expect(await guesses()).toEqual([]);
  });

  describe("GUARDRAIL: auto never overwrites an owner choice", () => {
    /** The SQL guard itself refuses, whatever the early checks say, and nothing is logged. */
    async function sqlGuardRefuses(t: string) {
      const before = await rowOf(t);
      const logsBefore = await database.select().from(activityLog);
      expect(await autoSetQuoteOutcome(t, "won", NOW)).toBe(false);
      expect(await autoSetQuoteOutcome(t, "no_answer", NOW)).toBe(false);
      expect(await autoSetQuoteOutcome(t, "lost", NOW)).toBe(false);
      expect(await rowOf(t)).toEqual(before);
      expect(await database.select().from(activityLog)).toEqual(logsBefore);
    }

    it("the owner marked it lost → a later go-ahead leaves it lost", async () => {
      const t = await quoteGiven();
      await setQuoteOutcome(workspaceId, t, "lost", undefined, daysAgo(2));
      await customerWrites(t, 1);
      await classifyWith(accepting({ category: "scheduling" }));
      expect(await rowOf(t)).toMatchObject({ quoteOutcome: "lost", quoteOutcomeSource: "owner" });
      expect(await guesses()).toEqual([]);
      await sqlGuardRefuses(t);
    });

    it("an outcome set before the source column existed is the owner's (A13)", async () => {
      const t = await quoteGiven({ quoteOutcome: "lost", quoteOutcomeAt: daysAgo(2) });
      await customerWrites(t, 1);
      await classifyWith(accepting());
      expect(await rowOf(t)).toMatchObject({ quoteOutcome: "lost", quoteOutcomeSource: null });
      expect(await guesses()).toEqual([]);
      await sqlGuardRefuses(t);
    });

    it("the owner reopened it → we never guess no answer", async () => {
      const t = await quoteGiven({}, { askAgo: 26, quoteAgo: 25 });
      await setQuoteOutcome(workspaceId, t, "won", undefined, daysAgo(10));
      await setQuoteOutcome(workspaceId, t, null, undefined, daysAgo(9));
      expect(await guessNoAnswers(NOW)).toBe(0);
      expect(await rowOf(t)).toMatchObject({ quoteOutcome: null, quoteOutcomeSource: "owner" });
      // listQuotes guesses too — and leaves it alone as well.
      expect((await listQuotes(workspaceId, NOW)).quotes[0]!.stage).toBe("quiet");
      await sqlGuardRefuses(t);
    });

    it("the owner said no answer → a later go-ahead doesn't make it won", async () => {
      const t = await quoteGiven();
      await setQuoteOutcome(workspaceId, t, "no_answer", undefined, daysAgo(2));
      await customerWrites(t, 1);
      await classifyWith(accepting());
      expect(await rowOf(t)).toMatchObject({
        quoteOutcome: "no_answer",
        quoteOutcomeSource: "owner",
      });
      expect(await guesses()).toEqual([]);
      await sqlGuardRefuses(t);
    });
  });

  it("auto may update its own guess: no answer, then the customer says go ahead → won", async () => {
    const t = await quoteGiven({}, { askAgo: 12, quoteAgo: 11 });
    await sentNudges(t, [10, 8]);
    expect(await guessNoAnswers(NOW)).toBe(1);
    expect(await rowOf(t)).toMatchObject({ quoteOutcome: "no_answer", quoteOutcomeSource: "auto" });
    expect((await guesses())[0]!.detail).toEqual({ outcome: "no_answer", why: "two_nudges" });

    await customerWrites(t, 0.5);
    await classifyWith(accepting({ category: "scheduling" }));
    expect(await rowOf(t)).toMatchObject({ quoteOutcome: "won", quoteOutcomeSource: "auto" });
    expect((await guesses()).map((l) => l.detail.outcome).sort()).toEqual(["no_answer", "won"]);
    // …and a won guess is never turned back into no answer.
    expect(await guessNoAnswers(new Date(NOW.getTime() + 30 * DAY))).toBe(0);
  });

  it("no answer waits for two nudges + a week, or three weeks", async () => {
    const old = { askAgo: 15, quoteAgo: 12 };
    const twoNudges = await quoteGiven({}, old);
    await sentNudges(twoNudges, [9, 7]);
    const twoNudgesTooSoon = await quoteGiven({}, old);
    await sentNudges(twoNudgesTooSoon, [9, 6]);
    const oneNudge = await quoteGiven({}, old);
    await sentNudges(oneNudge, [10]);
    const threeWeeks = await quoteGiven({}, { askAgo: 23, quoteAgo: 21 });
    const answered = await quoteGiven({}, old);
    await sentNudges(answered, [10, 8]);
    await customerWrites(answered, 1);

    expect(await guessNoAnswers(NOW)).toBe(2);
    expect((await rowOf(twoNudges)).quoteOutcome).toBe("no_answer");
    expect((await rowOf(threeWeeks)).quoteOutcome).toBe("no_answer");
    expect((await rowOf(oneNudge)).quoteOutcome).toBeNull();
    expect((await rowOf(twoNudgesTooSoon)).quoteOutcome).toBeNull();
    expect((await rowOf(answered)).quoteOutcome).toBeNull();
    const why = (await guesses()).map((l) => l.detail.why).sort();
    expect(why).toEqual(["three_weeks", "two_nudges"]);
  });

  it("guessNoAnswers is idempotent: a second run sets nothing and logs nothing", async () => {
    const t = await quoteGiven({}, { askAgo: 15, quoteAgo: 12 });
    await sentNudges(t, [9, 7]);
    expect(await guessNoAnswers(NOW)).toBe(1);
    expect(await guessNoAnswers(NOW)).toBe(0);
    expect(await guessNoAnswers(new Date(NOW.getTime() + DAY))).toBe(0);
    expect(await guesses()).toHaveLength(1);
    // The same holds for won.
    expect(await autoSetQuoteOutcome(t, "won", NOW)).toBe(true);
    expect(await autoSetQuoteOutcome(t, "won", NOW)).toBe(false);
    expect(await guesses()).toHaveLength(2);
  });

  it("GUARDRAIL: read-only accounts get no auto-marks", async () => {
    const accepted = await quoteGiven();
    await customerWrites(accepted, 1);
    const quiet = await quoteGiven({}, { askAgo: 15, quoteAgo: 12 });
    await sentNudges(quiet, [9, 7]);
    await database
      .update(workspaces)
      .set({ status: "evaluation_expired" })
      .where(eq(workspaces.id, workspaceId));

    const calls = await classifyWith(accepting());
    expect(calls).toHaveLength(0);
    expect(await guessNoAnswers(NOW)).toBe(0);
    expect(await guessNoAnswers(NOW, workspaceId)).toBe(0);
    await listQuotes(workspaceId, NOW);
    expect((await rowOf(accepted)).quoteOutcome).toBeNull();
    expect((await rowOf(quiet)).quoteOutcome).toBeNull();
    expect(await guesses()).toEqual([]);
  });

  it("only guesses within the workspace it was asked about", async () => {
    const t = await quoteGiven({}, { askAgo: 15, quoteAgo: 12 });
    await sentNudges(t, [9, 7]);
    const { workspace: other } = await ensureUserAndWorkspace({ email: "other@shop.com" });
    expect(await guessNoAnswers(NOW, other.id)).toBe(0);
    expect((await rowOf(t)).quoteOutcome).toBeNull();
    expect(await guessNoAnswers(NOW, workspaceId)).toBe(1);
  });

  describe("the customer writes back after our no-answer guess", () => {
    it("re-opens the quote, and it can be chased again", async () => {
      // Quoted 22 days ago, never nudged (follow-ups were off): we guess no answer.
      const t = await quoteGiven({}, { askAgo: 23, quoteAgo: 22 });
      expect(await guessNoAnswers(NOW)).toBe(1);
      expect(await rowOf(t)).toMatchObject({
        quoteOutcome: "no_answer",
        quoteOutcomeSource: "auto",
      });

      // "Sorry, was away, still keen, can you do March?" — not an acceptance.
      await customerWrites(t, 0.5);
      await classifyWith(classification());
      expect(await rowOf(t)).toMatchObject({
        quoteOutcome: null,
        quoteOutcomeAt: null,
        // Still ours, so we may guess again if it goes quiet a second time.
        quoteOutcomeSource: "auto",
      });
      const [q] = (await listQuotes(workspaceId, NOW)).quotes;
      expect(q).toMatchObject({ stage: "waiting_on_you", outcomeGuessed: false });

      // The owner answers; once the follow-up days pass, it's due a nudge again.
      await database.insert(messages).values({
        threadId: t,
        mailboxId,
        gmailMessageId: `ans${++g}`,
        direction: "out",
        fromAddress: "owner@shop.com",
        bodyText: "March works.",
        sentAt: NOW,
      });
      const later = new Date(NOW.getTime() + 4 * DAY);
      expect(await guessNoAnswers(later)).toBe(0);
      expect(await threadsToFollowUp(mailboxId, later)).toEqual([t]);
    });

    it("stays on Quotes when that reply is sorted as something else, and a later go-ahead wins it", async () => {
      const t = await quoteGiven({}, { askAgo: 23, quoteAgo: 22 });
      expect(await guessNoAnswers(NOW)).toBe(1);

      // "Sorry, was away — can you do March?" sorted as scheduling, not an acceptance.
      await customerWrites(t, 0.5);
      await classifyWith(classification({ category: "scheduling" }));
      expect(await rowOf(t)).toMatchObject({
        category: "scheduling",
        quoteOutcome: null,
        quoteOutcomeSource: "auto",
      });
      const { quotes } = await listQuotes(workspaceId, NOW);
      expect(quotes.map((q) => q.threadId)).toEqual([t]);
      expect(quotes[0]).toMatchObject({ stage: "waiting_on_you", outcomeGuessed: false });
      expect((await listCustomers(workspaceId, NOW))[0]).toMatchObject({ openQuotes: 1 });

      // The owner answers, then Dana says go ahead — sorted as a question this time.
      await database.insert(messages).values({
        threadId: t,
        mailboxId,
        gmailMessageId: `ans${++g}`,
        direction: "out",
        fromAddress: "owner@shop.com",
        bodyText: "March works.",
        sentAt: daysAgo(0.3),
      });
      await customerWrites(t, 0.1);
      await classifyWith(accepting({ category: "customer_question" }));
      expect(await rowOf(t)).toMatchObject({
        category: "customer_question",
        quoteOutcome: "won",
        quoteOutcomeSource: "auto",
      });
      expect((await listQuotes(workspaceId, NOW)).quotes[0]).toMatchObject({
        threadId: t,
        stage: "won",
      });
    });

    it("a re-sorted quote can be guessed no answer again if it goes quiet a second time", async () => {
      const t = await quoteGiven({}, { askAgo: 23, quoteAgo: 22 });
      expect(await guessNoAnswers(NOW)).toBe(1);
      await customerWrites(t, 0.5);
      await classifyWith(classification({ category: "scheduling" }));
      await database.insert(messages).values({
        threadId: t,
        mailboxId,
        gmailMessageId: `ans${++g}`,
        direction: "out",
        fromAddress: "owner@shop.com",
        bodyText: "March works.",
        sentAt: daysAgo(0.3),
      });
      // Past the 3-day trial by then, so make it a paying account.
      await database
        .update(workspaces)
        .set({ status: "active" })
        .where(eq(workspaces.id, workspaceId));
      expect(await guessNoAnswers(new Date(NOW.getTime() + 22 * DAY))).toBe(1);
      expect(await rowOf(t)).toMatchObject({
        quoteOutcome: "no_answer",
        quoteOutcomeSource: "auto",
      });
    });

    it("an acceptance goes straight to won", async () => {
      const t = await quoteGiven({}, { askAgo: 23, quoteAgo: 22 });
      expect(await guessNoAnswers(NOW)).toBe(1);
      await customerWrites(t, 0.5);
      await classifyWith(accepting({ category: "scheduling" }));
      expect(await rowOf(t)).toMatchObject({ quoteOutcome: "won", quoteOutcomeSource: "auto" });
    });

    it("a reply we haven't sorted yet still re-opens it (the scan's backstop)", async () => {
      const t = await quoteGiven({}, { askAgo: 23, quoteAgo: 22 });
      expect(await guessNoAnswers(NOW)).toBe(1);
      await customerWrites(t, 0.5); // unsorted: the AI cap was reached, say
      expect(await guessNoAnswers(NOW)).toBe(0);
      expect(await rowOf(t)).toMatchObject({ quoteOutcome: null, quoteOutcomeSource: "auto" });
    });

    it("GUARDRAIL: the owner's own no answer is left alone", async () => {
      const t = await quoteGiven();
      await setQuoteOutcome(workspaceId, t, "no_answer", undefined, daysAgo(2));
      await customerWrites(t, 1);
      await classifyWith(classification());
      await guessNoAnswers(NOW);
      expect(await rowOf(t)).toMatchObject({
        quoteOutcome: "no_answer",
        quoteOutcomeSource: "owner",
      });
      expect((await listQuotes(workspaceId, NOW)).quotes[0]!.stage).toBe("no_answer");
    });
  });

  it("a page full of read-only and not-yet-due quotes never hides a due one", async () => {
    // Read-only accounts: an expired trial, and one whose 3 days ran out but no cron moved it yet.
    for (const [email, set] of [
      ["expired@shop.com", { status: "evaluation_expired" as const }],
      ["late@shop.com", { status: "evaluating" as const, evaluationEndsAt: daysAgo(1) }],
    ] as const) {
      const { workspace } = await ensureUserAndWorkspace({ email });
      const box = await saveConnectedMailbox(workspace, {
        email,
        refreshToken: "rt",
        grantedScopes: [],
      });
      await database.update(workspaces).set(set).where(eq(workspaces.id, workspace.id));
      for (let i = 0; i < 3; i++)
        await quoteGiven({ mailboxId: box.id }, { askAgo: 30, quoteAgo: 25 });
    }
    // Not due yet: quoted 5 days ago, and one nudge 10 days ago.
    for (let i = 0; i < 3; i++) await quoteGiven();
    const oneNudge = await quoteGiven({}, { askAgo: 15, quoteAgo: 12 });
    await sentNudges(oneNudge, [10]);
    // Due: more than one page of them.
    const due = [
      await quoteGiven({}, { askAgo: 30, quoteAgo: 25 }),
      await quoteGiven({}, { askAgo: 30, quoteAgo: 22 }),
      await quoteGiven({}, { askAgo: 40, quoteAgo: 35 }),
    ];

    expect(await guessNoAnswers(NOW, undefined, { pageSize: 2 })).toBe(3);
    for (const t of due) expect((await rowOf(t)).quoteOutcome).toBe("no_answer");
    const all = await database.select().from(threads);
    expect(
      all
        .filter((t) => t.quoteOutcome != null)
        .map((t) => t.id)
        .sort(),
    ).toEqual([...due].sort());
  });

  describe("Check 11 P1: an open quote stays on Quotes however the next email is sorted", () => {
    it.each(["scheduling", "customer_question"])(
      "the customer's next email sorted as %s keeps it listed, counted and open",
      async (category) => {
        const t = await quoteGiven();
        // "Could you do Thursday instead of Wednesday?"
        await customerWrites(t, 1);
        await classifyWith(classification({ category: category as "scheduling" }));
        expect(await rowOf(t)).toMatchObject({ category, quoteOutcome: null });
        const { quotes, totals } = await listQuotes(workspaceId, NOW);
        expect(quotes.map((q) => q.threadId)).toEqual([t]);
        expect(quotes[0]).toMatchObject({ stage: "waiting_on_you", amountCents: 240_000 });
        expect(totals.requests).toBe(1);
        expect((await listCustomers(workspaceId, NOW))[0]).toMatchObject({ openQuotes: 1 });
      },
    );

    it("a thread re-sorted as noise is not listed", async () => {
      const t = await quoteGiven();
      await customerWrites(t, 1);
      await classifyWith(classification({ category: "noise" }));
      expect(await rowOf(t)).toMatchObject({ category: "noise" });
      expect((await listQuotes(workspaceId, NOW)).quotes).toEqual([]);
    });

    it("a thread holding an email that tried to instruct us is not listed — unless the owner marked it", async () => {
      const t = await quoteGiven({ quoteRequestedAt: daysAgo(5), extracted: { injection: true } });
      expect((await listQuotes(workspaceId, NOW)).quotes).toEqual([]);
      await setQuoteOutcome(workspaceId, t, "lost", undefined, NOW);
      expect((await listQuotes(workspaceId, NOW)).quotes.map((q) => q.threadId)).toEqual([t]);
    });

    it("isQuoteThread and quoteThreadSql agree on every case", async () => {
      const cases: {
        category: string | null;
        quoteOutcome: string | null;
        quoteOutcomeSource: string | null;
        quoteRequestedAt: Date | null;
        extracted: Record<string, unknown> | null;
      }[] = [];
      for (const category of ["quote_request", "scheduling", "noise", null])
        for (const [quoteOutcome, quoteOutcomeSource] of [
          [null, null],
          ["won", "auto"],
          [null, "auto"],
          ["lost", "owner"],
          [null, "owner"],
          ["won", null],
        ] as const)
          for (const quoteRequestedAt of [null, daysAgo(3)])
            for (const extracted of [null, { injection: true }, { injection: false }])
              cases.push({
                category,
                quoteOutcome,
                quoteOutcomeSource,
                quoteRequestedAt,
                extracted,
              });
      const ids: string[] = [];
      for (const c of cases) {
        const [row] = await database
          .insert(threads)
          .values({
            mailboxId,
            gmailThreadId: `twin${++g}`,
            ...c,
            quoteOutcomeSource: c.quoteOutcomeSource as "owner" | "auto" | null,
          })
          .returning({ id: threads.id });
        ids.push(row!.id);
      }
      const inSql = new Set(
        (await database.select({ id: threads.id }).from(threads).where(quoteThreadSql())).map(
          (r) => r.id,
        ),
      );
      const disagree = cases.filter((c, i) => isQuoteThread(c) !== inSql.has(ids[i]!));
      expect(disagree).toEqual([]);
      // Spot checks of the rule itself.
      const q = (c: Partial<(typeof cases)[number]>) =>
        isQuoteThread({
          category: null,
          quoteOutcome: null,
          quoteOutcomeSource: null,
          quoteRequestedAt: null,
          extracted: null,
          ...c,
        });
      expect(q({ category: "scheduling", quoteRequestedAt: daysAgo(1) })).toBe(true);
      expect(q({ category: "noise", quoteRequestedAt: daysAgo(1) })).toBe(false);
      expect(q({ category: "quote_request", extracted: { injection: true } })).toBe(false);
      expect(q({ category: "noise", quoteOutcome: "won", quoteOutcomeSource: "owner" })).toBe(true);
      expect(q({ category: "noise", quoteOutcome: "won", quoteOutcomeSource: "auto" })).toBe(false);
    });
  });

  describe("a nudge waiting in the queue when the quote is decided", () => {
    async function pendingNudge(threadId: string) {
      const [d] = await database
        .insert(drafts)
        .values({
          threadId,
          mailboxId,
          kind: "followup",
          gmailDraftId: "gd-nudge",
          toAddress: "dana@x.com",
          subject: "Re: Panel",
          body: "Just checking in on that quote.",
          originalBody: "Just checking in on that quote.",
          status: "pending",
          reason: "nudge",
          promptVersion: "followup.v3",
          autoSendAt: new Date(NOW.getTime() + 10 * 60_000),
        })
        .returning();
      return d!;
    }
    const draftOf = async (id: string) =>
      (await database.select().from(drafts).where(eq(drafts.id, id)))[0]!;

    it("the owner's mark expires it, here and in Gmail", async () => {
      const t = await quoteGiven();
      const d = await pendingNudge(t);
      const writer = new FakeWriter();
      expect(
        await setQuoteOutcome(workspaceId, t, "won", undefined, NOW, { writerFor: () => writer }),
      ).toBe(true);
      expect(writer.calls).toEqual(["deleteDraft"]);
      expect(await draftOf(d.id)).toMatchObject({
        status: "expired",
        closedNote: "You marked this quote won.",
        decidedAt: NOW,
      });
    });

    it("lost Google access: the mark stands, the nudge closes, reconnect is asked", async () => {
      const t = await quoteGiven();
      const d = await pendingNudge(t);
      const writer = new FakeWriter();
      writer.deleteDraft = async () => {
        throw new MailboxAuthError();
      };
      await setQuoteOutcome(workspaceId, t, "lost", undefined, NOW, { writerFor: () => writer });
      expect(await rowOf(t)).toMatchObject({ quoteOutcome: "lost", quoteOutcomeSource: "owner" });
      expect((await draftOf(d.id)).status).toBe("expired");
      const [box] = await database.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
      expect(box!.status).toBe("reconnect_needed");
    });

    it("Gmail down or rate-limited: the mark stands and the nudge still closes", async () => {
      const t = await quoteGiven();
      const d = await pendingNudge(t);
      const writer = new FakeWriter();
      writer.deleteDraft = async () => {
        writer.calls.push("deleteDraft");
        throw new Error("Gmail 503");
      };
      expect(
        await setQuoteOutcome(workspaceId, t, "lost", undefined, NOW, { writerFor: () => writer }),
      ).toBe(true);
      expect(writer.calls).toEqual(["deleteDraft"]);
      expect(await draftOf(d.id)).toMatchObject({
        status: "expired",
        closedNote: "You marked this quote lost.",
      });
      const [box] = await database.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
      expect(box!.status).toBe("active");
    });

    it("a mailbox that needs reconnecting isn't asked; the nudge still closes", async () => {
      const t = await quoteGiven();
      const d = await pendingNudge(t);
      await database
        .update(mailboxes)
        .set({ status: "reconnect_needed" })
        .where(eq(mailboxes.id, mailboxId));
      const writer = new FakeWriter();
      await setQuoteOutcome(workspaceId, t, "no_answer", undefined, NOW, {
        writerFor: () => writer,
      });
      expect(writer.calls).toEqual([]);
      expect((await draftOf(d.id)).status).toBe("expired");
    });

    it("a won job's invoice nudge stays — it's still chased", async () => {
      const t = await quoteGiven({ category: "invoice_payment" });
      const d = await pendingNudge(t);
      const writer = new FakeWriter();
      await setQuoteOutcome(workspaceId, t, "won", undefined, NOW, { writerFor: () => writer });
      expect(writer.calls).toEqual([]);
      expect(await draftOf(d.id)).toMatchObject({ status: "pending", flags: [] });
    });

    it("our won guess on a job's invoice thread doesn't flag its nudge", async () => {
      const t = await quoteGiven({ category: "invoice_payment" });
      const d = await pendingNudge(t);
      expect(await autoSetQuoteOutcome(t, "won", NOW)).toBe(true);
      expect(await draftOf(d.id)).toMatchObject({ status: "pending", flags: [] });
    });

    it("reopening leaves it alone", async () => {
      const t = await quoteGiven();
      const d = await pendingNudge(t);
      const writer = new FakeWriter();
      await setQuoteOutcome(workspaceId, t, null, undefined, NOW, { writerFor: () => writer });
      expect(writer.calls).toEqual([]);
      expect((await draftOf(d.id)).status).toBe("pending");
    });

    it("our guess only flags it — nothing is deleted", async () => {
      const t = await quoteGiven({}, { askAgo: 23, quoteAgo: 22 });
      const d = await pendingNudge(t);
      expect(await guessNoAnswers(NOW)).toBe(1);
      expect(await draftOf(d.id)).toMatchObject({
        status: "pending",
        gmailDraftId: "gd-nudge",
        flags: [QUOTE_GUESS_FLAG],
        autoSendAt: null,
      });
      // Flagging twice never doubles the flag.
      expect(await flagPendingNudge(t, QUOTE_GUESS_FLAG)).toBe(true);
      expect((await draftOf(d.id)).flags).toEqual([QUOTE_GUESS_FLAG]);
    });
  });
});
