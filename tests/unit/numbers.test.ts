import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { activityLog, drafts, messages, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { scorecardQueries, weeklyScorecard } from "@/server/scorecard";
import {
  asWrittenSentence,
  quoteSpeed,
  quoteSpeedSentence,
  scorecardLines,
  weekBounds,
} from "@/server/scorecard-rules";
import { createTestDb } from "../support/db";

const H = 3_600_000;
const NOW = new Date("2026-10-07T15:00:00Z");
const WEEK = weekBounds(NOW, "America/New_York");
const at = (h: number) => new Date(WEEK.start.getTime() + h * H);

describe("C8 quote speed (pure)", () => {
  it("24 hours on the clock; waiting ones count only once their day is up", () => {
    const from = new Date("2026-10-05T12:00:00Z");
    const pairs = [
      { from, to: new Date(from.getTime() + 24 * H - 60_000) },
      { from, to: new Date(from.getTime() + 24 * H + 60_000) },
    ];
    const now = new Date("2026-10-07T12:00:00Z");
    expect(
      quoteSpeed(pairs, [new Date(now.getTime() - 23 * H), new Date(now.getTime() - 25 * H)], now),
    ).toEqual({
      fast: 1,
      counted: 3,
    });
  });

  it("sentences: percent from 5, last week bracket, nothing to count → null", () => {
    expect(quoteSpeedSentence({ fast: 4, counted: 5 }, { fast: 3, counted: 6 }, "this week")).toBe(
      "You answered 4 of 5 quote requests within 24 hours this week (80%) (last week: 3 of 6).",
    );
    expect(quoteSpeedSentence({ fast: 1, counted: 2 }, null, "last week")).toBe(
      "You answered 1 of 2 quote requests within 24 hours last week.",
    );
    expect(quoteSpeedSentence({ fast: 0, counted: 0 }, null, "this week")).toBeNull();
  });
});

describe("H8 sent without changes (pure)", () => {
  it("under 5 → null; up / down / same", () => {
    expect(asWrittenSentence({ asWritten: 4, counted: 4 }, null, "this week")).toBeNull();
    expect(
      asWrittenSentence({ asWritten: 7, counted: 9 }, { asWritten: 3, counted: 5 }, "this week"),
    ).toBe("7 of 9 drafts went out without changes this week (78%), up from 60% last week.");
    expect(
      asWrittenSentence({ asWritten: 3, counted: 6 }, { asWritten: 4, counted: 5 }, "this week"),
    ).toBe("3 of 6 drafts went out without changes this week (50%), down from 80% last week.");
    expect(
      asWrittenSentence({ asWritten: 5, counted: 5 }, { asWritten: 4, counted: 4 }, "this week"),
    ).toBe("5 of 5 drafts went out without changes this week (100%).");
  });

  it("the Monday email's lines carry both, counts only", () => {
    const lines = scorecardLines(
      {
        repliesSent: 6,
        followupsSent: 0,
        quotesOut: 1,
        response: { avgMinutes: 60, answered: 1, unanswered: 0 },
        minutesSaved: 18,
        speed: { fast: 1, counted: 1 },
        asWritten: { asWritten: 5, counted: 6 },
      },
      "Last week",
    );
    expect(lines).toContain("You answered 1 of 1 quote request within 24 hours last week.");
    expect(lines).toContain("5 of 6 drafts went out without changes last week (83%).");
  });
});

describe("weeklyScorecard C8 / H8 (PGlite)", () => {
  let database: Database;
  let workspaceId: string;
  let mailboxId: string;
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

  async function request(inAt: Date, outAt: Date | null) {
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: `g-${randomUUID()}`,
        inInbox: true,
        category: "quote_request",
      })
      .returning();
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `m-${randomUUID()}`,
      direction: "in",
      fromAddress: "dana@customer.com",
      toAddresses: ["owner@shop.com"],
      sentAt: inAt,
    });
    if (outAt)
      await database.insert(messages).values({
        threadId: t!.id,
        mailboxId,
        gmailMessageId: `m-${randomUUID()}`,
        direction: "out",
        fromAddress: "owner@shop.com",
        toAddresses: ["dana@customer.com"],
        subject: "Re: quote",
        sentAt: outAt,
      });
    return t!.id;
  }

  it("counts fast, slow and overdue requests; one still inside its day waits", async () => {
    await request(at(1), at(3)); // fast
    await request(at(2), at(2 + 30)); // slow
    await request(at(4), null); // waiting > 24h at NOW (Wednesday)
    await request(new Date(NOW.getTime() - 2 * H), null); // waiting < 24h
    const s = await weeklyScorecard(workspaceId, WEEK.start, WEEK.end, NOW);
    expect(s.speed).toEqual({ fast: 1, counted: 3 });
  });

  it("H8: app sends only, never autopilot, gap drafts left out, purged old rows drop out", async () => {
    const [t] = await database
      .insert(threads)
      .values({ mailboxId, gmailThreadId: "g1", inInbox: true, category: "scheduling" })
      .returning();
    const send = async (
      over: Partial<typeof drafts.$inferInsert>,
      detail: Record<string, unknown> | null,
    ) => {
      const [d] = await database
        .insert(drafts)
        .values({
          threadId: t!.id,
          mailboxId,
          toAddress: "dana@customer.com",
          subject: "Re",
          body: "Hi",
          originalBody: "Hi",
          reason: "r",
          status: "sent",
          decidedAt: at(5),
          sentGmailMessageId: `s-${randomUUID()}`,
          ...over,
        })
        .returning();
      if (detail)
        await database.insert(activityLog).values({
          workspaceId,
          actor: "owner",
          action: "reply_sent",
          threadId: t!.id,
          detail: { draftId: d!.id, ...detail },
        });
    };
    for (let i = 0; i < 4; i++) await send({}, { hadGaps: false });
    await send({ status: "edited_and_sent" }, { hadGaps: false });
    await send({ status: "edited_and_sent" }, { hadGaps: false });
    await send({}, { hadGaps: false, autopilot: true }); // autopilot: out
    await send({ status: "edited_and_sent" }, { hadGaps: true }); // gaps: out
    await send({ originalBody: null }, { hadGaps: true }); // purged, gaps recorded: out
    await send({ sentGmailMessageId: null }, null); // reconcile "sent from Gmail": out
    await send({ originalBody: null }, null); // old row, purged, no key: drops out
    const s = await weeklyScorecard(workspaceId, WEEK.start, WEEK.end, NOW);
    expect(s.asWritten).toEqual({ asWritten: 4, counted: 6 });
  });

  it("binds no Date into raw SQL (A10)", () => {
    const q = scorecardQueries(workspaceId, WEEK.start, WEEK.end, NOW).asWritten.toSQL();
    for (const p of q.params) expect(p instanceof Date).toBe(false);
  });
});

describe("C5 why you lost it", () => {
  it("sentence: none → null, fixed order, dominant reason", async () => {
    const { lostReasonsSentence, shownLostReason } = await import("@/server/quote-rules");
    expect(lostReasonsSentence({})).toBeNull();
    expect(lostReasonsSentence({ timing: 1, price: 2 })).toBe(
      "Lost this month: 2 on price, 1 on timing.",
    );
    expect(lostReasonsSentence({ price: 4, timing: 1, someone_else: 2 })).toBe(
      "Lost this month: 4 on price, 1 on timing, 2 went with someone else. You lost 4 on price this month.",
    );
    expect(shownLostReason("won", "price")).toBeNull();
    expect(shownLostReason("lost", "price")).toBe("price");
    expect(shownLostReason("lost", "nonsense")).toBeNull();
  });

  it("'Other' (Davi, 2026-10-16): a fourth button, counted, never the headline", async () => {
    const {
      lostReasonsSentence,
      shownLostReason,
      LOST_REASONS,
      LOST_REASON_BUTTONS,
      LOST_REASON_WORDS,
    } = await import("@/server/quote-rules");
    expect(LOST_REASONS).toEqual(["price", "timing", "someone_else", "other"]);
    expect(LOST_REASON_BUTTONS.other).toBe("Other");
    expect(`Lost: ${LOST_REASON_WORDS.other}`).toBe("Lost: another reason");
    expect(shownLostReason("lost", "other")).toBe("other");
    expect(lostReasonsSentence({ other: 1 })).toBe("Lost this month: 1 for another reason.");
    expect(lostReasonsSentence({ price: 1, other: 2 })).toBe(
      "Lost this month: 1 on price, 2 for other reasons.",
    );
    // "Other" counts toward the total, so it can stop a named reason from being "most of them".
    expect(lostReasonsSentence({ price: 3, other: 4 })).toBe(
      "Lost this month: 3 on price, 4 for other reasons.",
    );
    expect(lostReasonsSentence({ someone_else: 3, other: 1 })).toBe(
      "Lost this month: 3 went with someone else, 1 for another reason. 3 went with someone else this month.",
    );
    // The Lost card offers every reason, and the action accepts each one.
    const page = readFileSync("src/app/(app)/quotes/page.tsx", "utf8");
    expect(page).toContain("{LOST_REASONS.map((r) => (");
    expect(readFileSync("src/app/(app)/quotes/actions.ts", "utf8")).toContain(
      "reason: z.enum(LOST_REASONS)",
    );
  });

  it("only on a lost quote; scoped; re-marking clears it; stale reasons never show or count", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    const box = await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    });
    const { setLostReason, setQuoteOutcome, listQuotes } = await import("@/server/quotes");
    const { lostReasonsBetween } = await import("@/server/activity");
    const { eq } = await import("drizzle-orm");
    const [t] = await database
      .insert(threads)
      .values({ mailboxId: box.id, gmailThreadId: "q1", inInbox: true, category: "quote_request" })
      .returning();
    const now = new Date();
    expect(await setLostReason(workspace.id, t!.id, "price", now)).toBe("not_lost");
    await setQuoteOutcome(workspace.id, t!.id, "lost", undefined, now);
    expect(await setLostReason(workspace.id, t!.id, "price", now)).toBe("ok");
    expect(await setLostReason(workspace.id, t!.id, "price", now)).toBe("ok");
    const logs = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "quote_lost_reason"));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.detail).toEqual({ reason: "price" });
    const other = await ensureUserAndWorkspace({ email: "other@shop.com" });
    expect(await setLostReason(other.workspace.id, t!.id, "timing", now)).toBe("not_found");
    const monthStart = new Date(now.getTime() - 86_400_000);
    expect(await lostReasonsBetween(workspace.id, monthStart, null)).toEqual({ price: 1 });
    // Old code may leave a reason on a quote it reopened as won: never shown, never counted.
    await database.update(threads).set({ quoteOutcome: "won" }).where(eq(threads.id, t!.id));
    expect((await listQuotes(workspace.id)).quotes[0]!.lostReason).toBeNull();
    expect(await lostReasonsBetween(workspace.id, monthStart, null)).toEqual({});
    // A fresh mark starts without one.
    await setQuoteOutcome(workspace.id, t!.id, "lost", undefined, now);
    const [row] = await database.select().from(threads).where(eq(threads.id, t!.id));
    expect(row!.quoteLostReason).toBeNull();
  });
});

describe("K2 which lead sources pay", () => {
  it("rules: lead sites count only the owner's Won, never say 0 won; fold past 6; hidden under 2", async () => {
    const { leadPayRows, leadPaySentence } = await import("@/server/quote-rules");
    const row = (
      label: string,
      offEmail: boolean,
      o: Partial<{ outcome: string; outcomeSource: string; amountCents: number }> = {},
    ) => ({
      label,
      offEmail,
      outcome: o.outcome ?? null,
      outcomeSource: o.outcomeSource ?? null,
      amountCents: o.amountCents ?? null,
    });
    expect(leadPayRows([row("Direct email", false)])).toBeNull();
    const rows = leadPayRows([
      ...Array.from({ length: 6 }, () => row("Thumbtack", true)),
      row("Thumbtack", true, { outcome: "won", outcomeSource: "auto", amountCents: 50_000 }),
      row("Direct email", false, { outcome: "won", outcomeSource: "auto", amountCents: 620_000 }),
      row("Direct email", false),
    ])!;
    expect(rows.map(leadPaySentence)).toEqual([
      "Direct email: 2 requests, 1 won, $6,200.",
      "Thumbtack: 7 requests. Tap Won on Quotes to count jobs you won here.",
    ]);
    const marked = leadPayRows([
      row("Thumbtack", true, { outcome: "won", outcomeSource: "owner", amountCents: 310_000 }),
      row("Direct email", false),
    ])!;
    expect(leadPaySentence(marked[0]!)).toBe("Thumbtack: 1 request, 1 you marked won, $3,100.");
    const many = leadPayRows(["A", "B", "C", "D", "E", "F", "G", "H"].map((l) => row(l, false)))!;
    expect(many).toHaveLength(6);
    expect(many.at(-1)).toMatchObject({ label: "Everywhere else", requests: 3 });
  });

  it("query: labels by domain, a no-reply form with a Reply-To is a Website form, 90 days, no address leaves", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    const box = await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    });
    const { leadSourcePay } = await import("@/server/lead-pay");
    const now = new Date("2026-10-16T12:00:00Z");
    const add = async (
      from: string,
      sentAt: Date,
      over: Partial<typeof threads.$inferInsert> = {},
      replyTo: { address?: string } = {},
    ) => {
      const [t] = await database
        .insert(threads)
        .values({
          mailboxId: box.id,
          gmailThreadId: `g-${randomUUID()}`,
          inInbox: true,
          category: "quote_request",
          ...over,
        })
        .returning();
      await database.insert(messages).values({
        threadId: t!.id,
        mailboxId: box.id,
        gmailMessageId: `m-${randomUUID()}`,
        direction: "in",
        fromAddress: from,
        replyToHeader: replyTo,
        sentAt,
      });
    };
    await add("leads@mail.thumbtack.com", new Date(now.getTime() - 5 * 86_400_000));
    await add(
      "no-reply@squarespace.info",
      new Date(now.getTime() - 5 * 86_400_000),
      {},
      { address: "dana@x.com" },
    );
    await add("pat@pat.com", new Date(now.getTime() - 5 * 86_400_000), {
      quoteOutcome: "won",
      quoteOutcomeSource: "owner",
      quoteAmountCents: 100_000,
    });
    await add("old@old.com", new Date(now.getTime() - 100 * 86_400_000));
    const rows = await leadSourcePay(workspace.id, now);
    expect(rows!.map((r) => r.label).sort()).toEqual(["Direct email", "Thumbtack", "Website form"]);
    expect(JSON.stringify(rows)).not.toContain("@");
  });
});
