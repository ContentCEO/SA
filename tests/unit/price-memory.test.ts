import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { ModelDraft } from "@/ai/prompts/draft.v5";
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
import type { MailboxConnector } from "@/mailbox/connector";
import type { OutgoingEmail } from "@/lib/email";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { adminOverview } from "@/server/admin";
import { classifyPending } from "@/server/classification";
import { buildDigest, digestCounts } from "@/server/digest";
import { buildMonthlySummary } from "@/server/monthly-rules";
import { monthlyStats, sendMonthlySummaries } from "@/server/monthly-summary";
import { queueThreadUrl } from "@/server/digest-rules";
import { createDraftForThread, listQueue, reviseDraft } from "@/server/drafts";
import { captureEditSignals } from "@/server/edit-learning";
import { disconnectMailbox, saveConnectedMailbox } from "@/server/mailboxes";
import { priceMemoryFor, similarPricesFor } from "@/server/price-memory";
import {
  priceMemoryLabel,
  serviceSimilarity,
  serviceTokens,
  similarPrices,
  SIMILAR_AT,
  type PastPrice,
} from "@/server/price-memory-rules";
import { businessProfileInput, saveBusinessProfile } from "@/server/profile";
import { pushSummaryText } from "@/server/push-alerts";
import { captureQuoteAmounts, setQuoteOutcome } from "@/server/quotes";
import { freshLeads, leadAlertBody, leadCounts } from "@/server/sms-alerts";
import { purgeExpiredBodies } from "@/server/sync";
import { createTestDb } from "../support/db";
import { classification, fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const DAY = 86_400_000;
const NOW = new Date("2026-10-12T14:00:00Z");
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const REVIEW_URL = "https://g.page/r/elm-electric/review";

let database: Database;
let workspaceId: string;
let mailboxId: string;
let writer: FakeWriter;
let g = 0;
const deps = (when: Date = NOW) => ({ writerFor: () => writer, now: () => when });

type Msg = { direction: "in" | "out"; days: number; body: string | null };

async function makeThread(over: Partial<typeof threads.$inferInsert>, msgs: Msg[] = []) {
  const id = `g${++g}`;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: id,
      inInbox: true,
      subject: "Panel upgrade",
      lastMessageAt: msgs.length ? at(Math.max(...msgs.map((m) => m.days))) : NOW,
      ...over,
    })
    .returning();
  let n = 0;
  for (const m of msgs) {
    n++;
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-${n}`,
      rfc822MessageId: `<${id}-${n}@${m.direction === "in" ? "customer.com" : "shop.com"}>`,
      direction: m.direction,
      fromAddress: m.direction === "in" ? "dana@customer.com" : "owner@shop.com",
      fromName: m.direction === "in" ? "Dana Ruiz" : null,
      toAddresses: m.direction === "out" ? ["dana@customer.com"] : [],
      subject: "Panel upgrade",
      bodyText: m.body,
      sentAt: at(m.days),
    });
  }
  return t!.id;
}

async function historyRows() {
  return database.select().from(priceHistory);
}

async function setStatus(status: (typeof workspaces.$inferSelect)["status"]) {
  const paid = status === "setup_paid" || status === "active";
  await database
    .update(workspaces)
    .set({ status, setupPaidVia: paid ? "stripe" : null })
    .where(eq(workspaces.id, workspaceId));
}

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
  writer = new FakeWriter();
});
afterEach(() => setModelTransportForTests(undefined));

describe("similarity (pure)", () => {
  it("'Replace kitchen faucet' is like 'kitchen faucet replacement'; 'deck staining' isn't like 'panel upgrade'", () => {
    expect(
      serviceSimilarity("Replace kitchen faucet", "kitchen faucet replacement"),
    ).toBeGreaterThanOrEqual(SIMILAR_AT);
    expect(serviceSimilarity("deck staining", "panel upgrade")).toBe(0);
    expect(serviceSimilarity("", "panel upgrade")).toBe(0);
    expect(serviceSimilarity("a quote please", "panel upgrade")).toBe(0);
  });

  it("stopwords and plain plurals don't count", () => {
    expect(serviceTokens("A new quote for the gutters, please")).toEqual(["gutter"]);
    expect(serviceTokens("Estimate: panel upgrade for my house")).toEqual([
      "panel",
      "upgrade",
      "house",
    ]);
    // "glass" isn't a plural.
    expect(serviceTokens("glass shower door")).toEqual(["glass", "shower", "door"]);
    expect(serviceSimilarity("the gutters", "gutter")).toBe(1);
    // Two jobs that are both "installs" aren't alike for that.
    expect(serviceSimilarity("ceiling fan install", "water heater install")).toBe(0);
  });

  it("one shared generic word between two multi-word jobs isn't a match", () => {
    for (const [a, b] of [
      ["kitchen faucet", "kitchen remodel"],
      ["lighting upgrade", "panel upgrade"],
      ["bathroom fan", "bathroom remodel"],
      ["water heater", "water softener"],
      ["subpanel upgrade", "panel upgrade"],
    ]) {
      expect(serviceSimilarity(a!, b!), `${a} / ${b}`).toBe(0);
      expect(serviceSimilarity(b!, a!), `${b} / ${a}`).toBe(0);
    }
    // Still alike: the same job in other words, or the same job with more detail.
    expect(serviceSimilarity("Replace kitchen faucet", "kitchen faucet replacement")).toBe(1);
    expect(serviceSimilarity("panel upgrade", "200 amp panel upgrade")).toBe(1);
    expect(serviceSimilarity("water heater", "tankless water heater")).toBe(1);
    // A one-word job matches on its one word.
    expect(serviceSimilarity("faucet", "kitchen faucet")).toBe(1);
    // Two of three words is a weaker match, but a match.
    expect(serviceSimilarity("panel surge breaker", "panel surge protector")).toBeCloseTo(2 / 3);
  });

  it("top 3 by score, then newest; never the thread being answered; nothing below the bar", () => {
    const h = (service: string, dollars: number, month: number, threadId: string): PastPrice => ({
      service,
      amountCents: dollars * 100,
      quotedAt: new Date(Date.UTC(2026, month, 15)),
      threadId,
    });
    const history = [
      h("panel upgrade", 1800, 2, "t1"), // exact, March
      h("200 amp panel upgrade", 2100, 5, "t2"), // exact on the shorter side, June
      h("panel", 1500, 7, "t3"), // 1/1, August
      h("panel upgrade and EV charger", 3200, 8, "self"), // the thread itself
      h("deck staining", 900, 8, "t4"), // unrelated
      h("subpanel upgrade", 1200, 8, "t5"), // only "upgrade" in common — not similar
      h("lighting upgrade", 1100, 8, "t6"), // only "upgrade" in common — not similar
    ];
    expect(
      similarPrices("Panel upgrade", history, { excludeThreadId: "self" }).map(
        (p) => p.amountCents,
      ),
    ).toEqual([150000, 210000, 180000]);
    // Room for more doesn't let a one-generic-word match in.
    expect(
      similarPrices("Panel upgrade", history, { excludeThreadId: "self", limit: 4 }).map(
        (p) => p.amountCents,
      ),
    ).toEqual([150000, 210000, 180000]);
    expect(similarPrices("tile backsplash", history)).toEqual([]);
    // A weaker match (2 of 3 words) comes after a full one, even when it's newer.
    expect(
      similarPrices("panel surge upgrade", [
        h("panel upgrade", 1800, 2, "a"), // 2/2, March
        h("panel surge breaker", 2400, 8, "b"), // 2/3, August
      ]).map((p) => p.amountCents),
    ).toEqual([180000, 240000]);
  });

  it("the label: the figure, and the month in the owner's zone (with the year if it isn't this one)", () => {
    const p = { amountCents: 180000, quotedAt: new Date("2026-03-01T03:00:00Z") };
    expect(priceMemoryLabel(p, "Europe/London", NOW)).toEqual({ value: "$1,800", month: "Mar" });
    // Still February the 28th in Los Angeles.
    expect(priceMemoryLabel(p, "America/Los_Angeles", NOW)).toEqual({
      value: "$1,800",
      month: "Feb",
    });
    expect(
      priceMemoryLabel(
        { amountCents: 245050, quotedAt: new Date("2025-03-15T12:00:00Z") },
        "UTC",
        NOW,
      ),
    ).toEqual({ value: "$2,450.50", month: "Mar 2025" });
    // A broken zone falls back to Eastern instead of throwing.
    expect(priceMemoryLabel(p, "Not/AZone", NOW).month).toBe("Feb");
  });
});

/** A quote thread the owner answered with a figure. */
const quoted = (
  over: Partial<typeof threads.$inferInsert> = {},
  reply = "It's $1,800 for the panel upgrade. Davi",
) =>
  makeThread(
    { category: "quote_request", extracted: { service_requested: "  Panel upgrade " }, ...over },
    [
      { direction: "in", days: -6, body: "How much for a panel upgrade?" },
      { direction: "out", days: -5, body: reply },
    ],
  );

describe("capture: only from the owner's own sent quotes", () => {
  it("one row per quote thread: the amount, the kind of job and when it was quoted; re-runs add nothing", async () => {
    const t = await quoted();
    expect(await captureQuoteAmounts(workspaceId)).toBe(1);
    const rows = await historyRows();
    expect(rows).toEqual([
      expect.objectContaining({
        workspaceId,
        threadId: t,
        service: "Panel upgrade",
        amountCents: 180000,
        quotedAt: at(-5),
      }),
    ]);
    expect(await captureQuoteAmounts(workspaceId)).toBe(0);
    expect(await captureQuoteAmounts()).toBe(0);
    expect(await historyRows()).toHaveLength(1);
  });

  it("no kind of job on the thread → the amount is kept, but no price memory", async () => {
    const t = await quoted({ extracted: { service_requested: null } });
    const blank = await quoted({ extracted: { service_requested: "   " } });
    expect(await captureQuoteAmounts(workspaceId)).toBe(2);
    expect(await historyRows()).toEqual([]);
    const [row] = await database.select().from(threads).where(eq(threads.id, t));
    expect(row!.quoteAmountCents).toBe(180000);
    expect(blank).toBeTruthy();
  });

  it("a Won amount the owner types never goes in (it may be the final bill, not the quote)", async () => {
    await setStatus("active");
    const t = await makeThread(
      { category: "quote_request", extracted: { service_requested: "Panel upgrade" } },
      [
        { direction: "in", days: -6, body: "How much for a panel upgrade?" },
        { direction: "out", days: -5, body: "I'll come look Tuesday. Davi" },
      ],
    );
    expect(await setQuoteOutcome(workspaceId, t, "won", 250000, NOW)).toBe(true);
    await captureQuoteAmounts(workspaceId);
    await captureQuoteAmounts();
    expect(await historyRows()).toEqual([]);
    const [row] = await database.select().from(threads).where(eq(threads.id, t));
    expect(row!.quoteAmountCents).toBe(250000);
    // The mark is yes/no — the amount itself never goes into the log.
    const [log] = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "quote_marked"));
    expect(log!.detail).toEqual({ outcome: "won", amountTyped: true });
  });

  it("a captured quote stays in price memory when the owner later marks it Won with another amount", async () => {
    await setStatus("active");
    const t = await quoted();
    await captureQuoteAmounts(workspaceId);
    await setQuoteOutcome(workspaceId, t, "won", 260000, NOW);
    await captureQuoteAmounts(workspaceId);
    expect((await historyRows()).map((r) => r.amountCents)).toEqual([180000]);
  });

  it.each([
    ["says nothing", null],
    ["gives a blank", "   "],
  ])(
    "a won quote the customer's 'go ahead' re-sorted as scheduling is still captured (A17; the model %s)",
    async (_, service) => {
      // Sorted as a quote request; the owner quoted $1,800.
      const t = await quoted({ classifiedAt: at(-6) });
      await database
        .update(messages)
        .set({ classifiedAt: at(-6) })
        .where(eq(messages.threadId, t));
      // "Go ahead, when can you start?" — sorted before any capture ran. The email doesn't say
      // what the job is (service_requested null or blank): the kind of job carries over.
      await database.insert(messages).values({
        threadId: t,
        mailboxId,
        gmailMessageId: `go-${t}`,
        direction: "in",
        fromAddress: "dana@customer.com",
        fromName: "Dana Ruiz",
        bodyText: "Go ahead, when can you start?",
        labelIds: ["INBOX"],
        sentAt: at(-1),
      });
      setModelTransportForTests(
        fakeTransport([
          classification({
            category: "scheduling",
            summary: "Dana says go ahead.",
            signals: { ...classification().signals, accepts_quote: true },
            extracted: { ...classification().extracted, service_requested: service },
          }),
        ]).transport,
      );
      await classifyPending(mailboxId, { now: NOW });
      const [sorted] = await database.select().from(threads).where(eq(threads.id, t));
      expect(sorted).toMatchObject({
        category: "scheduling",
        quoteOutcome: "won",
        quoteOutcomeSource: "auto",
        extracted: { service_requested: "  Panel upgrade ", quote_accepted: true },
      });
      expect(await captureQuoteAmounts(workspaceId)).toBe(1);
      expect(await historyRows()).toEqual([
        expect.objectContaining({ threadId: t, amountCents: 180000, service: "Panel upgrade" }),
      ]);
    },
  );

  it("deposit details the app sent are never the quote (a PDF quote has no $ in the email)", async () => {
    const t = await quoted({}, "Quote attached. Davi");
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `dep-${t}`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["dana@customer.com"],
      bodyText: "A deposit of $1,200 holds your spot. Davi",
      sentAt: at(-2),
    });
    await database.insert(drafts).values({
      threadId: t,
      mailboxId,
      kind: "reply",
      purpose: "deposit",
      status: "sent",
      toAddress: "dana@customer.com",
      subject: "Re: Panel upgrade",
      body: "A deposit of $1,200 holds your spot. Davi",
      reason: "Deposit details.",
      sentGmailMessageId: `dep-${t}`,
      createdAt: at(-2),
      decidedAt: at(-2),
    });
    expect(await captureQuoteAmounts(workspaceId)).toBe(0);
    expect(await historyRows()).toEqual([]);
    const [row] = await database.select().from(threads).where(eq(threads.id, t));
    expect(row!.quoteAmountCents).toBeNull();
  });

  it("after the acceptance, the owner's deposit or invoice isn't the quote: the figure before it is", async () => {
    const msgs: Msg[] = [
      { direction: "in", days: -6, body: "How much for a panel upgrade?" },
      { direction: "out", days: -5, body: "$2,400 for the panel upgrade. Davi" },
      { direction: "in", days: -3, body: "Go ahead!" },
      // Typed in Gmail (no app draft): only the acceptance time tells it apart.
      {
        direction: "out",
        days: -2,
        body: "Great — a $1,200 deposit by check holds the date. Davi",
      },
    ];
    // Accepted 3 days ago (our guess marked it won a moment later)…
    const auto = await makeThread(
      {
        category: "scheduling",
        quoteOutcome: "won",
        quoteOutcomeSource: "auto",
        quoteOutcomeAt: at(-1),
        extracted: {
          service_requested: "Panel upgrade",
          quote_accepted: true,
          quote_accepted_at: at(-3).toISOString(),
        },
      },
      msgs,
    );
    // …or the owner marked it won 3 days ago (no acceptance time on file).
    const owner = await makeThread(
      {
        category: "scheduling",
        quoteOutcome: "won",
        quoteOutcomeSource: "owner",
        quoteOutcomeAt: at(-3),
        extracted: { service_requested: "Panel upgrade" },
      },
      msgs,
    );
    expect(await captureQuoteAmounts(workspaceId)).toBe(2);
    const rows = await database.select().from(threads);
    expect(rows.find((r) => r.id === auto)!.quoteAmountCents).toBe(240000);
    expect(rows.find((r) => r.id === owner)!.quoteAmountCents).toBe(240000);
    expect((await historyRows()).map((r) => r.amountCents)).toEqual([240000, 240000]);
  });

  it("other kinds of thread are never captured", async () => {
    await quoted({ category: "customer_question" });
    expect(await captureQuoteAmounts(workspaceId)).toBe(0);
    expect(await historyRows()).toEqual([]);
  });

  it("backfill: quotes captured before price memory existed get a row, dated by the owner's last reply", async () => {
    const withReply = await quoted({ quoteAmountCents: 150000 });
    const noMail = await makeThread({
      category: "quote_request",
      extracted: { service_requested: "Rewire kitchen" },
      quoteAmountCents: 99000,
      quoteOutcome: "won",
      quoteOutcomeSource: "owner",
      quoteOutcomeAt: at(-40),
    });
    // The owner typed this one when marking it Won — after price memory existed.
    const typed = await makeThread({
      category: "quote_request",
      extracted: { service_requested: "Panel upgrade" },
      quoteAmountCents: 400000,
    });
    await database.insert(activityLog).values({
      workspaceId,
      actor: "owner",
      action: "quote_marked",
      threadId: typed,
      detail: { outcome: "won", amountTyped: true },
    });
    expect(await captureQuoteAmounts(workspaceId)).toBe(0); // nothing new captured…
    const rows = await historyRows();
    // …but the two older amounts are now remembered (as already captured, never re-read).
    expect(rows.map((r) => [r.threadId, r.amountCents, r.quotedAt.toISOString()]).sort()).toEqual(
      [
        [withReply, 150000, at(-5).toISOString()],
        [noMail, 99000, at(-40).toISOString()],
      ].sort(),
    );
    await captureQuoteAmounts(workspaceId);
    expect(await historyRows()).toHaveLength(2);
  });

  it("outlives the body purge: the email text goes, the remembered price stays", async () => {
    const t = await quoted();
    await captureQuoteAmounts(workspaceId);
    await purgeExpiredBodies(at(60));
    const [m] = await database
      .select()
      .from(messages)
      .where(eq(messages.threadId, t))
      .orderBy(messages.sentAt);
    expect(m!.bodyText).toBeNull();
    expect(await historyRows()).toHaveLength(1);
  });

  it("goes with the mailbox when the owner disconnects it (A20)", async () => {
    await quoted();
    await captureQuoteAmounts(workspaceId);
    expect(await historyRows()).toHaveLength(1);
    const connector = {
      provider: "gmail",
      requiredScopes: [],
      authorizationUrl: () => "",
      exchangeCode: vi.fn(),
      revoke: vi.fn().mockResolvedValue(undefined),
    } as unknown as MailboxConnector;
    expect(await disconnectMailbox(workspaceId, mailboxId, connector)).toBe(true);
    expect(await database.select().from(mailboxes)).toHaveLength(0);
    expect(await historyRows()).toEqual([]);
  });
});

describe("reading it back (owner's screen only)", () => {
  it("similar past prices for each thread, never its own, never another workspace's", async () => {
    const asking = await makeThread({
      category: "quote_request",
      extracted: { service_requested: "panel upgrade" },
    });
    const march = await makeThread({ category: "quote_request" });
    const june = await makeThread({ category: "quote_request" });
    const deck = await makeThread({ category: "quote_request" });
    await database.insert(priceHistory).values([
      {
        workspaceId,
        threadId: march,
        service: "Panel upgrade",
        amountCents: 180000,
        quotedAt: new Date("2026-03-14T15:00:00Z"),
      },
      {
        workspaceId,
        threadId: june,
        service: "200 amp panel upgrade",
        amountCents: 210000,
        quotedAt: new Date("2026-06-10T15:00:00Z"),
      },
      { workspaceId, threadId: deck, service: "Deck staining", amountCents: 90000, quotedAt: NOW },
      {
        workspaceId,
        threadId: asking,
        service: "panel upgrade",
        amountCents: 500000,
        quotedAt: NOW,
      },
    ]);
    // Someone else's shop quoted a panel upgrade too.
    const other = await ensureUserAndWorkspace({ email: "other@shop.com" });
    const otherBox = await saveConnectedMailbox(other.workspace, {
      email: "other@shop.com",
      refreshToken: "rt2",
      grantedScopes: [],
    });
    const [ot] = await database
      .insert(threads)
      .values({ mailboxId: otherBox.id, gmailThreadId: "o1", category: "quote_request" })
      .returning();
    await database.insert(priceHistory).values({
      workspaceId: other.workspace.id,
      threadId: ot!.id,
      service: "panel upgrade",
      amountCents: 666600,
      quotedAt: NOW,
    });

    const shown = await priceMemoryFor(workspaceId, [asking, deck], {
      timeZone: "America/New_York",
      now: NOW,
    });
    expect(shown.get(asking)).toEqual([
      { cents: 210000, value: "$2,100", month: "Jun" },
      { cents: 180000, value: "$1,800", month: "Mar" },
    ]);
    // The deck job has no other deck job behind it.
    expect(shown.has(deck)).toBe(false);
    // Another workspace's thread id gets nothing from here.
    expect((await priceMemoryFor(workspaceId, [ot!.id], { timeZone: "UTC" })).size).toBe(0);
    expect(
      (await similarPricesFor(other.workspace.id, [{ threadId: "x", service: "panel upgrade" }]))
        .get("x")!
        .map((p) => p.amountCents),
    ).toEqual([666600]);
    expect(await similarPricesFor(workspaceId, [{ threadId: asking, service: null }])).toEqual(
      new Map(),
    );
  });
});

/* ------------------------------------------------------------------------------------------
 * GUARDRAILS: price memory never leaves the owner's screen.
 * ---------------------------------------------------------------------------------------- */

const LEAKS = ["7,777", "7777", "777700", "9,133", "9133", "913300"];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const clean = (s: string) => s.replace(UUID, "<id>");

function expectNoLeak(text: string) {
  for (const leak of LEAKS) expect(clean(text)).not.toContain(leak);
}

/** Every request the model got: system blocks and the user turn. */
function expectNoHistoryIn(calls: { system: { text: string }[]; user: string }[]) {
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) expectNoLeak(JSON.stringify({ system: c.system, user: c.user }));
}

/** Two remembered panel-upgrade prices ($7,777 and $9,133) on other threads. */
async function seedHistory() {
  for (const [service, amountCents, days] of [
    ["Panel upgrade", 777700, -40],
    ["200 amp panel upgrade", 913300, -20],
  ] as const) {
    const t = await makeThread({ category: "quote_request", inInbox: false, subject: "Old quote" });
    await database.insert(priceHistory).values({
      workspaceId,
      threadId: t,
      service,
      amountCents,
      quotedAt: at(days),
    });
  }
}

const reply = (over: Partial<ModelDraft> = {}): ModelDraft => ({
  body: "Hi Dana,\n\nThanks — the panel upgrade is {{price}} including the permit.\n\nThanks, Davi",
  reason: "Dana wants a panel upgrade quote.",
  flags: [],
  confidence: 0.9,
  used_facts: [],
  ...over,
});

async function profile() {
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
      paymentTerms: "Check or card",
      policies: "",
      signature: "Davi",
      reviewUrl: REVIEW_URL,
      doNotPromise: "",
      vipSenders: "",
      amountThresholdDollars: "2500",
    }),
  );
}

/** A new quote request for a panel upgrade, waiting on the owner. */
const newRequest = () =>
  makeThread(
    {
      category: "quote_request",
      summary: "Dana wants a panel upgrade quote.",
      extracted: { service_requested: "panel upgrade" },
      classifiedAt: NOW,
    },
    [{ direction: "in", days: -0.1, body: "Can you quote a 200 amp panel upgrade?" }],
  );

/** The customer accepted the owner's quote ($3,100); `lastOut` adds the owner's thanks after. */
const acceptedQuote = (extracted: Record<string, unknown>, lastOut = false) =>
  makeThread(
    {
      category: "quote_request",
      summary: "Dana accepted the panel upgrade quote.",
      extracted: { service_requested: "panel upgrade", ...extracted },
      classifiedAt: NOW,
    },
    [
      { direction: "in", days: -6, body: "Can you quote a 200 amp panel upgrade?" },
      {
        direction: "out",
        days: -4,
        body: "Hi Dana, the panel upgrade is $3,100 including the permit. Davi",
      },
      { direction: "in", days: -0.05, body: "Let's do it. What do you need from me?" },
      ...(lastOut
        ? [{ direction: "out" as const, days: -0.02, body: "All done — thanks Dana!" }]
        : []),
    ],
  );

describe("GUARDRAIL: the drafter, follow-ups, notes, rewrites and the sorter never receive price history", () => {
  beforeEach(async () => {
    await setStatus("active");
    await profile();
    await seedHistory();
  });

  it("the seeded prices really are what the owner would see for this job (so the test means something)", async () => {
    const t = await newRequest();
    expect((await priceMemoryFor(workspaceId, [t], { timeZone: "UTC", now: NOW })).get(t)).toEqual([
      { cents: 913300, value: "$9,133", month: "Sep" },
      { cents: 777700, value: "$7,777", month: "Sep" },
    ]);
  });

  it("an automatic reply to a quote request", async () => {
    const t = await newRequest();
    const { transport, calls } = fakeTransport([reply()]);
    setModelTransportForTests(transport);
    expect((await createDraftForThread(t, { trigger: "auto", ...deps() })).status).toBe("created");
    expectNoHistoryIn(calls);
  });

  it("the owner's 'Draft a reply'", async () => {
    const t = await newRequest();
    const { transport, calls } = fakeTransport([reply()]);
    setModelTransportForTests(transport);
    expect(
      (await createDraftForThread(t, { trigger: "owner", workspaceId, ...deps() })).status,
    ).toBe("created");
    expectNoHistoryIn(calls);
  });

  it("a follow-up nudge on a quiet quote", async () => {
    const t = await makeThread(
      {
        category: "quote_request",
        summary: "Dana wants a panel upgrade quote.",
        extracted: { service_requested: "panel upgrade" },
        classifiedAt: at(-5),
      },
      [
        { direction: "in", days: -5, body: "Can you quote a 200 amp panel upgrade?" },
        { direction: "out", days: -4, body: "Hi Dana, it's $2,400 including the permit. Davi" },
      ],
    );
    const { transport, calls } = fakeTransport([
      reply({ body: "Hi Dana,\n\nJust checking you got the quote.\n\nDavi" }),
    ]);
    setModelTransportForTests(transport);
    expect((await createDraftForThread(t, { trigger: "followup", ...deps() })).status).toBe(
      "created",
    );
    expectNoHistoryIn(calls);
  });

  it("deposit details on an accepted quote", async () => {
    const t = await acceptedQuote({ accepts_quote: true, quote_accepted: true });
    const { transport, calls } = fakeTransport([
      reply({ body: "Hi Dana,\n\nGreat. Check or card is fine for the deposit.\n\nDavi" }),
    ]);
    setModelTransportForTests(transport);
    const r = await createDraftForThread(t, { trigger: "auto", ...deps() });
    expect(r.status).toBe("created");
    const [d] = await database.select().from(drafts).where(eq(drafts.threadId, t));
    expect(d!.purpose).toBe("deposit");
    expectNoHistoryIn(calls);
  });

  it("a review request", async () => {
    const t = await acceptedQuote({ job_done: true }, true);
    const { transport, calls } = fakeTransport([
      reply({
        body: `Hi Dana,\n\nThanks again. A short review would mean a lot:\n${REVIEW_URL}\n\nDavi`,
      }),
    ]);
    setModelTransportForTests(transport);
    const r = await createDraftForThread(t, {
      trigger: "owner",
      workspaceId,
      purpose: "review_request",
      ...deps(),
    });
    expect(r.status).toBe("created");
    const [d] = await database.select().from(drafts).where(eq(drafts.threadId, t));
    expect(d!.purpose).toBe("review_request");
    expectNoHistoryIn(calls);
  });

  it("a quick tweak on a draft (revise.v1)", async () => {
    const t = await newRequest();
    const { transport, calls } = fakeTransport([
      reply(),
      reply({ body: "Hi Dana,\n\nThe panel upgrade is {{price}}.\n\nDavi" }),
    ]);
    setModelTransportForTests(transport);
    const r = await createDraftForThread(t, { trigger: "auto", ...deps() });
    const draftId = (r as { draftId: string }).draftId;
    expect((await reviseDraft(workspaceId, draftId, { tweak: "shorter" }, deps())).status).toBe(
      "revised",
    );
    expect(calls).toHaveLength(2);
    expectNoHistoryIn(calls);
  });

  it("learning from the owner's edits (edit-tone.v1)", async () => {
    const t = await newRequest();
    await database.insert(drafts).values({
      threadId: t,
      mailboxId,
      toAddress: "dana@customer.com",
      subject: "Re: Panel upgrade",
      body: "Hi Dana, what's the address?",
      originalBody: "Hi Dana, thanks so much for reaching out! What's the address?",
      reason: "r",
      status: "edited_and_sent",
      decidedAt: at(-1),
    });
    const { transport, calls } = fakeTransport([{ tone_shift: "cooler" }]);
    setModelTransportForTests(transport);
    expect(await captureEditSignals(NOW)).toBe(1);
    expectNoHistoryIn(calls);
  });

  it("sorting a new email", async () => {
    const t = await makeThread({ category: null }, [
      { direction: "in", days: -0.1, body: "Can you quote a 200 amp panel upgrade?" },
    ]);
    const { transport, calls } = fakeTransport([classification()]);
    setModelTransportForTests(transport);
    expect((await classifyPending(mailboxId, { now: NOW })).classified).toBe(1);
    const [row] = await database.select().from(threads).where(eq(threads.id, t));
    expect(row!.category).toBe("quote_request");
    expectNoHistoryIn(calls);
  });
});

describe("GUARDRAIL: never in the morning summary, admin, phone notifications or text alerts", () => {
  it("none of them carry a remembered price", async () => {
    await profile();
    await seedHistory();
    // A fresh quote request that needs the owner, so every summary has something to say.
    await makeThread(
      {
        category: "quote_request",
        needsOwner: true,
        needsOwnerReason: "Big job.",
        summary: "Dana wants a panel upgrade quote.",
        extracted: { service_requested: "panel upgrade" },
        classifiedAt: NOW,
      },
      [{ direction: "in", days: -0.1, body: "Can you quote a 200 amp panel upgrade?" }],
    );

    const counts = await digestCounts(workspaceId, NOW);
    const digest = buildDigest(
      counts,
      {
        queueUrl: "https://app.example/queue",
        quotesUrl: "https://app.example/quotes",
        settingsUrl: "https://app.example/settings",
        threadUrl: (id) => queueThreadUrl("https://app.example/queue", id),
      },
      { now: NOW, timeZone: "America/New_York" },
    );
    const queue = await listQueue(workspaceId, NOW);
    const push = pushSummaryText({ replies: queue.drafts.length, needsYou: queue.needsYou.length });
    const sms = leadAlertBody(
      leadCounts(await freshLeads(workspaceId, null, NOW)),
      "https://app.example",
    );
    const [admin] = await adminOverview(NOW);

    expect(counts.needsYou).toHaveLength(1); // the thread was counted…
    expect(queue.needsYou).toHaveLength(1);
    expect(sms).toMatch(/1/);
    // …and no remembered price went anywhere.
    for (const out of [
      digest.text,
      digest.html,
      push,
      sms,
      JSON.stringify(queue),
      JSON.stringify(admin),
    ])
      expectNoLeak(out);
  });

  it("the monthly summary (plan #35) carries no remembered price either", async () => {
    await profile();
    await seedHistory();
    await setStatus("active");
    // An October quote request for a panel, and a won quote with its amount.
    await makeThread(
      {
        category: "quote_request",
        extracted: { service_requested: "panel upgrade" },
        quoteOutcome: "won",
        quoteOutcomeAt: NOW,
        quoteAmountCents: 777700,
      },
      [{ direction: "in", days: -0.1, body: "Can you quote a 200 amp panel upgrade?" }],
    );
    const start = new Date("2026-10-01T04:00:00Z");
    const end = new Date("2026-11-01T04:00:00Z");
    const stats = await monthlyStats(workspaceId, "electrical", start, end);
    expect(stats.quoteRequests).toBeGreaterThan(0);
    const email = buildMonthlySummary(stats, "October", {
      activityUrl: "https://app.example/activity",
      settingsUrl: "https://app.example/settings#digest",
    });
    const sent: OutgoingEmail[] = [];
    await sendMonthlySummaries(new Date("2026-11-01T12:05:00Z"), {
      send: async (e) => {
        sent.push(e);
        return "sent";
      },
    });
    expect(sent).toHaveLength(1);
    for (const out of [
      JSON.stringify(stats),
      email.subject,
      email.text,
      email.html,
      sent[0]!.text,
      sent[0]!.html,
    ])
      expectNoLeak(out);
  });
});

/* ------------------------------------------------------------------------------------------
 * GUARDRAIL: the module boundary (A19). Only these files may touch price memory.
 * ---------------------------------------------------------------------------------------- */

const ROOT = join(__dirname, "../..");
const ALLOWED = new Set([
  "src/db/schema.ts",
  "src/server/price-memory.ts",
  "src/server/quotes.ts",
  "src/app/(app)/queue/page.tsx",
  "src/app/(app)/inbox/page.tsx",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

const IMPORTS_IT = /(from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*price-memory['"]/;
const touches = (text: string) =>
  IMPORTS_IT.test(text) || text.includes("priceHistory") || text.includes("price_history");

describe("GUARDRAIL: price-memory module boundary", () => {
  const files = [...sourceFiles(join(ROOT, "src")), ...sourceFiles(join(ROOT, "scripts"))].map(
    (f) => ({ path: relative(ROOT, f).split("\\").join("/"), text: readFileSync(f, "utf8") }),
  );

  it("only the schema, the two price-memory modules and the Queue and Inbox pages touch it", () => {
    const touching = files.filter((f) => touches(f.text)).map((f) => f.path);
    expect(touching.filter((p) => !ALLOWED.has(p))).toEqual([]);
    // The guard isn't vacuous: each allowed file really does touch it.
    expect(touching.sort()).toEqual([...ALLOWED].sort());
  });

  it("the drafter, the AI layer, digest, admin, alerts and push code are all in the scan", () => {
    const paths = new Set(files.map((f) => f.path));
    for (const p of [
      "src/server/drafts.ts",
      "src/server/classification.ts",
      "src/server/digest.ts",
      "src/server/admin.ts",
      "src/server/sms-alerts.ts",
      "src/server/push-alerts.ts",
      "src/server/leads-at-risk.ts",
      "src/server/scorecard.ts",
      "src/server/monthly-summary.ts",
      "src/server/monthly-rules.ts",
      "src/server/edit-learning.ts",
      "src/app/api/push/summary/route.ts",
      "src/ai/client.ts",
    ])
      expect(paths.has(p)).toBe(true);
  });

  it("the matcher catches relative and dynamic imports, and raw SQL", () => {
    expect(touches(`import { similarPricesFor } from "./price-memory";`)).toBe(true);
    expect(touches(`const m = await import("@/server/price-memory");`)).toBe(true);
    expect(touches("sql`select * from price_history`")).toBe(true);
    // The pure rules hold no data and may be used anywhere.
    expect(touches(`import { serviceTokens } from "./price-memory-rules";`)).toBe(false);
  });

  it("quotes.ts only writes it: it never reads price memory back out", () => {
    const quotes = files.find((f) => f.path === "src/server/quotes.ts")!.text;
    expect(quotes).not.toMatch(/\.from\(\s*priceHistory\s*\)/);
    expect(quotes).not.toMatch(/select\s+(?!1\b)[^`]*from\s+price_history/i);
  });

  it("the read side is server-only", () => {
    const mod = files.find((f) => f.path === "src/server/price-memory.ts")!.text;
    expect(mod).toMatch(/^import "server-only";/);
  });
});
