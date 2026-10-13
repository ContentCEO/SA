import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { drafts, messages, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { isAutomatedSender, isNoReplyAddress as offerNoReply } from "@/server/offer-rules";
import { scorecardQueries, weekScorecards, weeklyScorecard } from "@/server/scorecard";
import { weekBounds } from "@/server/scorecard-rules";
import { isNoReplyAddress } from "@/server/sender-rules";
import { noReplySql } from "@/server/thread-sql";
import { createTestDb } from "../support/db";

const NY = "America/New_York";
const T = (s: string) => new Date(s);
const MIN = 60_000;

// Wed Oct 7 2026, 11am in New York. This week: Mon Oct 5 04:00Z → Mon Oct 12 04:00Z.
const NOW = T("2026-10-07T15:00:00Z");
const WEEK = weekBounds(NOW, NY);
const MON = (h: number, m = 0) => new Date(WEEK.start.getTime() + (h * 60 + m) * MIN); // local Mon
const day = (d: number, h: number, m = 0) =>
  new Date(MON(0).getTime() + d * 86_400_000 + (h * 60 + m) * MIN);

let database: Database;
let workspaceId: string;
let mailboxId: string;

async function owner(email: string) {
  const { workspace } = await ensureUserAndWorkspace({ email });
  const box = await saveConnectedMailbox(workspace, {
    email,
    refreshToken: "rt",
    grantedScopes: [],
  });
  return { workspaceId: workspace.id, mailboxId: box.id };
}

type ThreadOver = Partial<typeof threads.$inferInsert>;
async function thread(over: ThreadOver = {}, box = mailboxId) {
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId: box,
      gmailThreadId: `g-${randomUUID()}`,
      inInbox: true,
      category: "quote_request",
      ...over,
    })
    .returning();
  return t!.id;
}

const CUSTOMER = "SECRET-CUSTOMER@customer.com";

/**
 * An email on the thread; the owner's go to the customer unless `to` says otherwise. The
 * subject is the conversation's ("Re: …") unless a forward is being tested.
 */
async function msg(
  threadId: string,
  direction: "in" | "out",
  sentAt: Date,
  from = direction === "in" ? CUSTOMER : "owner@shop.com",
  box = mailboxId,
  to = direction === "in" ? "owner@shop.com" : CUSTOMER,
  subject = "Re: SECRET-SUBJECT",
) {
  await database.insert(messages).values({
    threadId,
    mailboxId: box,
    gmailMessageId: `m-${randomUUID()}`,
    direction,
    fromName: direction === "in" ? "SECRET-NAME" : "Owner",
    fromAddress: from,
    // As sync stores them: lowercased.
    toAddresses: [to.toLowerCase()],
    subject,
    bodyText: "SECRET-BODY",
    sentAt,
  });
}

type DraftOver = Partial<typeof drafts.$inferInsert>;
async function draft(threadId: string, over: DraftOver, box = mailboxId) {
  await database.insert(drafts).values({
    threadId,
    mailboxId: box,
    gmailDraftId: `d-${randomUUID()}`,
    toAddress: "SECRET-CUSTOMER@customer.com",
    subject: "Re",
    body: "SECRET-DRAFT",
    originalBody: "SECRET-DRAFT",
    reason: "r",
    promptVersion: "draft.v5",
    createdAt: WEEK.lastStart,
    ...over,
  });
}

const week = () => weeklyScorecard(workspaceId, WEEK.start, WEEK.end, NOW);

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
  ({ workspaceId, mailboxId } = await owner("owner@shop.com"));
});

describe("weeklyScorecard: replies and follow-ups sent (#32)", () => {
  it("counts sent replies (any purpose) and follow-ups separately, by decided_at in [start, end)", async () => {
    const t = await thread();
    await draft(t, { status: "sent", decidedAt: WEEK.start }); // the first instant counts
    await draft(t, { status: "edited_and_sent", decidedAt: day(1, 9) });
    await draft(t, { status: "sent", purpose: "deposit", decidedAt: day(2, 8) });
    await draft(t, { status: "sent", kind: "followup", decidedAt: day(1, 10) });
    await draft(t, { status: "edited_and_sent", kind: "followup", decidedAt: day(2, 9) });
    // Outside the week: end exactly is next week's; a millisecond before start is last week's.
    await draft(t, { status: "sent", decidedAt: WEEK.end });
    await draft(t, { status: "sent", decidedAt: new Date(WEEK.start.getTime() - 1) });
    // Never sent: pending, discarded, expired never count, whatever their timestamps.
    await draft(t, { status: "pending", decidedAt: day(1, 9) });
    await draft(await thread(), { status: "pending", sendAfter: day(1, 9), decidedAt: null });
    await draft(t, { status: "discarded", decidedAt: day(1, 9) });
    await draft(t, { status: "expired", kind: "followup", decidedAt: day(1, 9) });

    const s = await week();
    expect(s.repliesSent).toBe(3);
    expect(s.followupsSent).toBe(2);
    // Time saved = 3 minutes × (replies + follow-ups sent), the same rule as the month.
    expect(s.minutesSaved).toBe(3 * (3 + 2));
  });

  it("returns exactly the scorecard's numbers, nothing else", async () => {
    const t = await thread();
    await msg(t, "in", day(0, 9));
    await msg(t, "out", day(0, 10));
    await draft(t, { status: "sent", decidedAt: day(0, 10) });
    const s = await week();
    expect(Object.keys(s).sort()).toEqual(
      ["followupsSent", "minutesSaved", "quotesOut", "repliesSent", "response"].sort(),
    );
    expect(Object.keys(s.response).sort()).toEqual(["answered", "avgMinutes", "unanswered"]);
    expect(JSON.stringify(s)).not.toMatch(/SECRET|@/);
  });
});

describe("weeklyScorecard: quotes out (#32)", () => {
  it("counts quote threads answered this week, once each; never cold emails or other categories", async () => {
    // Inbound Monday, two owner replies Tuesday and Wednesday: one quote out.
    const a = await thread();
    await msg(a, "in", day(0, 9));
    await msg(a, "out", day(1, 9));
    await msg(a, "out", day(2, 9));
    // Cold outbound (no earlier inbound), even with a customer reply after it: not a quote out.
    const cold = await thread();
    await msg(cold, "out", day(1, 9));
    await msg(cold, "in", day(1, 12));
    // A customer question answered this week: not a quote.
    const q = await thread({ category: "customer_question" });
    await msg(q, "in", day(0, 9));
    await msg(q, "out", day(0, 10));
    // Sorted as scheduling now, but it has a quote outcome (isQuoteThread rule): counts.
    const won = await thread({
      category: "scheduling",
      quoteOutcome: "won",
      quoteOutcomeSource: "owner",
    });
    await msg(won, "in", day(0, 8));
    await msg(won, "out", day(1, 8));
    // Answered last week only: not this week's.
    const old = await thread();
    await msg(old, "in", day(-3, 9));
    await msg(old, "out", day(-2, 9));
    // Answered at the week's end exactly: next week's.
    const late = await thread();
    await msg(late, "in", day(6, 9));
    await msg(late, "out", WEEK.end);

    expect((await week()).quotesOut).toBe(2);
    expect((await weeklyScorecard(workspaceId, WEEK.lastStart, WEEK.start, NOW)).quotesOut).toBe(1);
  });

  it("a quote request later re-sorted as scheduling still counts (sticky quote_requested_at, A11)", async () => {
    // Quote request → owner reply → the customer's "Thursday works?" re-sorted to scheduling.
    const t = await thread({ category: "scheduling", quoteRequestedAt: day(0, 9) });
    await msg(t, "in", day(0, 9));
    await msg(t, "out", day(0, 11));
    await msg(t, "in", day(1, 9));
    const s = await week();
    expect(s.quotesOut).toBe(1);
    expect(s.response).toEqual({ avgMinutes: 120, answered: 1, unanswered: 0 });
  });
});

describe("weeklyScorecard: a quote request is dated from when it was asked for", () => {
  it("a new job asked for on an older thread counts in the week of the request, not the old chat's", async () => {
    // Last week the customer asked a question and the owner answered an hour later. This week
    // they ask for a quote on the same Gmail thread (classification marks the request's time).
    const t = await thread({ quoteRequestedAt: day(1, 9) });
    await msg(t, "in", day(-5, 9));
    await msg(t, "out", day(-5, 10));
    await msg(t, "in", day(1, 9));

    // Not yet answered: this week has one waiting request; last week has none.
    let s = await week();
    expect(s.quotesOut).toBe(0);
    expect(s.response).toEqual({ avgMinutes: null, answered: 0, unanswered: 1 });
    let last = await weeklyScorecard(workspaceId, WEEK.lastStart, WEEK.start, NOW);
    expect(last.quotesOut).toBe(0);
    expect(last.response).toEqual({ avgMinutes: null, answered: 0, unanswered: 0 });

    // The owner quotes two hours later: this week's quote out, timed from the request.
    await msg(t, "out", day(1, 11));
    s = await week();
    expect(s.quotesOut).toBe(1);
    expect(s.response).toEqual({ avgMinutes: 120, answered: 1, unanswered: 0 });
    last = await weeklyScorecard(workspaceId, WEEK.lastStart, WEEK.start, NOW);
    expect(last.quotesOut).toBe(0);
    expect(last.response.answered).toBe(0);
  });
});

describe("weeklyScorecard: a forward to the crew answers nobody", () => {
  it("forwarding the request to the crew (and the crew's reply) is no answer and no response time; replying is", async () => {
    const t = await thread();
    await msg(t, "in", day(0, 9));
    // 9:05: the owner forwards the lead to their estimator (Gmail keeps it in the thread);
    // 9:30 the estimator replies to the forward, in the same thread.
    const fwd = "Fwd: SECRET-SUBJECT";
    await msg(t, "out", day(0, 9, 5), "owner@shop.com", mailboxId, "crew@shop.com", fwd);
    await msg(t, "in", day(0, 9, 30), "crew@shop.com", mailboxId, "owner@shop.com", `Re: ${fwd}`);
    // 9:40: the owner answers the estimator ("RE: FW:", any case) — still not the customer.
    await msg(t, "out", day(0, 9, 40), "owner@shop.com", mailboxId, "crew@shop.com", "RE: FW: x");
    let s = await week();
    expect(s.quotesOut).toBe(0);
    expect(s.response).toEqual({ avgMinutes: null, answered: 0, unanswered: 1 });

    // 11:00: the real reply, to the customer.
    await msg(t, "out", day(0, 11));
    s = await week();
    expect(s.quotesOut).toBe(1);
    expect(s.response).toEqual({ avgMinutes: 120, answered: 1, unanswered: 0 });
  });

  it("forwarding something to the customer (To or Cc) answers them", async () => {
    const t = await thread();
    await msg(t, "in", day(0, 9));
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `m-${randomUUID()}`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["spouse@customer.com"],
      // Any case: addresses compare lowercased.
      ccAddresses: [CUSTOMER],
      subject: "Fwd: SECRET-SUBJECT",
      sentAt: day(0, 9, 30),
    });
    expect((await week()).response).toEqual({ avgMinutes: 30, answered: 1, unanswered: 0 });
  });

  it("a 'Re:' sent only to the crew on the owner's own domain is no answer: the request stays unanswered", async () => {
    const t = await thread();
    await msg(t, "in", day(0, 9));
    // The owner hits Reply and changes To to the estimator; the estimator replies.
    await msg(t, "out", day(0, 9, 5), "owner@shop.com", mailboxId, "crew@shop.com");
    await msg(t, "in", day(0, 9, 30), "crew@shop.com", mailboxId, "owner@shop.com");
    let s = await week();
    expect(s.quotesOut).toBe(0);
    expect(s.response).toEqual({ avgMinutes: null, answered: 0, unanswered: 1 });
    await msg(t, "out", day(0, 10));
    s = await week();
    expect(s.quotesOut).toBe(1);
    expect(s.response).toEqual({ avgMinutes: 60, answered: 1, unanswered: 0 });
  });

  it("a lead forwarded in by a property manager, Cc'ing the tenant: the owner's reply to the tenant is the answer", async () => {
    const t = await thread();
    const fwd = "Fwd: SECRET-SUBJECT";
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `m-${randomUUID()}`,
      direction: "in",
      fromAddress: "office@pm.example",
      toAddresses: ["owner@shop.com"],
      ccAddresses: ["tenant@home.example"],
      subject: fwd,
      sentAt: day(0, 9),
    });
    await msg(
      t,
      "out",
      day(0, 9, 20),
      "owner@shop.com",
      mailboxId,
      "tenant@home.example",
      `Re: ${fwd}`,
    );
    const s = await week();
    expect(s.quotesOut).toBe(1);
    expect(s.response).toEqual({ avgMinutes: 20, answered: 1, unanswered: 0 });
  });

  it("a contact-form lead answered from Gmail (to the Reply-To address) counts as answered and as a quote out", async () => {
    // The form's relay sends it; the owner's Re: goes to the customer's own address (the
    // Reply-To, which isn't stored), never back to the relay.
    const t = await thread();
    await msg(t, "in", day(0, 9), "wordpress@SECRET-site.com");
    await msg(t, "out", day(0, 9, 45), "owner@shop.com", mailboxId, CUSTOMER);
    const s = await week();
    expect(s.quotesOut).toBe(1);
    expect(s.response).toEqual({ avgMinutes: 45, answered: 1, unanswered: 0 });
  });
});

describe("weeklyScorecard: quotes out counts each quote once, in the week it went out", () => {
  it("a week with only a nudge (or later chat) on an older quote shows 0 quotes out", async () => {
    // Quote request Sep 30, quoted Oct 1 (last week); this week only a nudge and a chat email.
    const t = await thread({ category: "scheduling", quoteRequestedAt: day(-5, 9) });
    await msg(t, "in", day(-5, 9));
    await msg(t, "out", day(-4, 9));
    await msg(t, "out", day(0, 9)); // the nudge, as sync brings it in
    await draft(t, { status: "sent", kind: "followup", decidedAt: day(0, 9) });
    await msg(t, "in", day(1, 9));
    await msg(t, "out", day(1, 10)); // "See you Tuesday."

    const s = await week();
    expect(s.followupsSent).toBe(1);
    expect(s.quotesOut).toBe(0);
    expect((await weeklyScorecard(workspaceId, WEEK.lastStart, WEEK.start, NOW)).quotesOut).toBe(1);
  });
});

describe("weeklyScorecard: answered from the app before the next sync (A12)", () => {
  it("a reply sent from the app counts as the answer even before sync brings in its email", async () => {
    const t = await thread();
    await msg(t, "in", day(0, 9));
    await draft(t, { status: "sent", decidedAt: day(0, 9, 45) });
    const s = await week();
    expect(s.response).toEqual({ avgMinutes: 45, answered: 1, unanswered: 0 });
    expect(s.quotesOut).toBe(1);
    expect(s.repliesSent).toBe(1);
  });

  it("the earlier of the sent draft and the synced email is the answer", async () => {
    const t = await thread();
    await msg(t, "in", day(0, 9));
    await msg(t, "out", day(0, 9, 20)); // sync's sent_at, a little before decided_at was stamped
    await draft(t, { status: "edited_and_sent", decidedAt: day(0, 9, 21) });
    expect((await week()).response).toEqual({ avgMinutes: 20, answered: 1, unanswered: 0 });
  });

  it("a send waiting out its undo window counts as answered; a draft not yet okayed doesn't", async () => {
    const queued = await thread();
    await msg(queued, "in", day(2, 9)); // Wed 9am; NOW is Wed 11am
    await draft(queued, { status: "pending", sendAfter: new Date(NOW.getTime() + 20_000) });
    const waiting = await thread();
    await msg(waiting, "in", day(2, 9));
    await draft(waiting, { status: "pending" });
    const discarded = await thread();
    await msg(discarded, "in", day(2, 9));
    await draft(discarded, { status: "discarded", decidedAt: day(2, 10) });

    const s = await week();
    // The queued one is timed to now at the latest (2 h), never to a moment still ahead.
    expect(s.response).toEqual({ avgMinutes: 120, answered: 1, unanswered: 2 });
    expect(s.quotesOut).toBe(1);
  });

  it("a request the owner settled without an email (marked Lost or Won) is never 'still waiting'", async () => {
    const lost = await thread({ quoteOutcome: "lost", quoteOutcomeSource: "owner" });
    await msg(lost, "in", day(0, 9));
    const won = await thread({
      category: "scheduling",
      quoteRequestedAt: day(0, 9),
      quoteOutcome: "won",
      quoteOutcomeSource: "owner",
    });
    await msg(won, "in", day(0, 9));
    // Our guess isn't the owner's word: still waiting.
    const guessed = await thread({ quoteOutcome: "no_answer", quoteOutcomeSource: "auto" });
    await msg(guessed, "in", day(0, 9));
    // Settled AND answered by email: in the average as usual.
    const both = await thread({ quoteOutcome: "won", quoteOutcomeSource: "owner" });
    await msg(both, "in", day(0, 9));
    await msg(both, "out", day(0, 10));

    expect((await week()).response).toEqual({ avgMinutes: 60, answered: 1, unanswered: 1 });
  });
});

describe("weeklyScorecard: response time (#33)", () => {
  it("runs from the customer's FIRST email to the owner's first reply after it; unanswered is honest", async () => {
    // Customer writes twice (9:00, 10:00), owner replies once at 11:00: 120 min from the first.
    const a = await thread();
    await msg(a, "in", day(0, 9));
    await msg(a, "in", day(0, 10));
    await msg(a, "out", day(0, 11));
    await msg(a, "out", day(0, 12)); // a second reply changes nothing
    // 30 minutes.
    const b = await thread();
    await msg(b, "in", day(1, 9));
    await msg(b, "out", day(1, 9, 30));
    // An owner email BEFORE the request doesn't count as the reply.
    const c = await thread();
    await msg(c, "out", day(0, 7));
    await msg(c, "in", day(0, 8));
    await msg(c, "out", day(0, 9));
    // Still waiting: no reply yet, and a reply "after now" (a clock skew) doesn't count.
    const d = await thread();
    await msg(d, "in", day(2, 8));
    const e = await thread();
    await msg(e, "in", day(2, 9));
    await msg(e, "out", new Date(NOW.getTime() + 60 * MIN));
    // Not a quote request: never in the average or the waiting count.
    const f = await thread({ category: "customer_question" });
    await msg(f, "in", day(0, 9));

    const s = await week();
    expect(s.response).toEqual({
      avgMinutes: Math.round((120 + 30 + 60) / 3),
      answered: 3,
      unanswered: 2,
    });
  });

  it("an unsent Gmail draft (DRAFT label) isn't the answer: not in response time or quotes out", async () => {
    // Old sync stored every Gmail draft — the app's own auto-draft too — as an 'out' message.
    const ownerRow = (threadId: string, labelIds: string[], sentAt: Date) =>
      database.insert(messages).values({
        threadId,
        mailboxId,
        gmailMessageId: `m-${randomUUID()}`,
        direction: "out",
        fromAddress: "owner@shop.com",
        toAddresses: [CUSTOMER.toLowerCase()],
        labelIds,
        sentAt,
      });
    // Drafted a minute after the request, never sent: still waiting, not "1 min".
    const drafted = await thread();
    await msg(drafted, "in", day(0, 9));
    await ownerRow(drafted, ["DRAFT"], day(0, 9, 1));
    // Drafted at 9:01, actually sent at 10:00 (Gmail's SENT copy): 60 minutes.
    const sent = await thread();
    await msg(sent, "in", day(1, 9));
    await ownerRow(sent, ["DRAFT"], day(1, 9, 1));
    await ownerRow(sent, ["SENT"], day(1, 10));

    const s = await week();
    expect(s.response).toEqual({ avgMinutes: 60, answered: 1, unanswered: 1 });
    expect(s.quotesOut).toBe(1);
  });

  it("a lead platform's no-reply notice is never answered here, so it never counts (A13)", async () => {
    const lead = await thread();
    await msg(lead, "in", day(0, 9), "noreply@thumbtack.com");
    const loud = await thread();
    await msg(loud, "in", day(0, 9), "No-Reply+leads@Angi.com");
    // A person writing later on the same thread doesn't make the platform notice a request.
    await msg(loud, "in", day(0, 10), "real.person@customer.com");
    const person = await thread();
    await msg(person, "in", day(0, 9), "dana@customer.com");

    const s = await week();
    expect(s.response).toEqual({ avgMinutes: null, answered: 0, unanswered: 1 });
  });

  it("a request in late Sunday night, answered Monday, belongs to LAST week (the week of the request)", async () => {
    const now = T("2026-10-13T15:00:00Z"); // Tue Oct 13, 11am in New York
    const t = await thread();
    await msg(t, "in", T("2026-10-12T03:00:00Z")); // Sun Oct 11, 11pm EDT
    await msg(t, "out", T("2026-10-12T12:00:00Z")); // Mon Oct 12, 8am EDT

    const { thisWeek, lastWeek, bounds } = await weekScorecards(workspaceId, now, NY);
    expect(bounds.start.toISOString()).toBe("2026-10-12T04:00:00.000Z");
    expect(lastWeek.response).toEqual({ avgMinutes: 540, answered: 1, unanswered: 0 });
    expect(thisWeek.response).toEqual({ avgMinutes: null, answered: 0, unanswered: 0 });
    // The reply itself went out this week, so the quote is "out" this week.
    expect(thisWeek.quotesOut).toBe(1);
    expect(lastWeek.quotesOut).toBe(0);
  });

  it("uses calendar time across the fall-back night (the extra hour counts)", async () => {
    const now = T("2026-11-01T15:00:00Z"); // Sun Nov 1, 10am EST
    const t = await thread();
    await msg(t, "in", T("2026-11-01T03:30:00Z")); // Sat Oct 31, 11:30pm EDT
    await msg(t, "out", T("2026-11-01T13:30:00Z")); // Sun Nov 1, 8:30am EST (9 h on the clock)
    const { thisWeek } = await weekScorecards(workspaceId, now, NY);
    expect(thisWeek.response).toEqual({ avgMinutes: 600, answered: 1, unanswered: 0 });
  });
});

describe("weeklyScorecard is scoped to the workspace", () => {
  it("never counts another workspace's mail or drafts", async () => {
    const other = await owner("other@shop.com");
    const t = await thread({}, other.mailboxId);
    await msg(t, "in", day(0, 9), "x@customer.com", other.mailboxId);
    await msg(t, "out", day(0, 10), "other@shop.com", other.mailboxId);
    await msg(
      await thread({}, other.mailboxId),
      "in",
      day(1, 9),
      "y@customer.com",
      other.mailboxId,
    );
    await draft(t, { status: "sent", decidedAt: day(0, 10) }, other.mailboxId);
    await draft(t, { status: "sent", kind: "followup", decidedAt: day(0, 10) }, other.mailboxId);

    expect(await week()).toEqual({
      repliesSent: 0,
      followupsSent: 0,
      quotesOut: 0,
      response: { avgMinutes: null, answered: 0, unanswered: 0 },
      minutesSaved: 0,
    });
    const theirs = await weeklyScorecard(other.workspaceId, WEEK.start, WEEK.end, NOW);
    expect(theirs).toMatchObject({ repliesSent: 1, followupsSent: 1, quotesOut: 1 });
    expect(theirs.response).toEqual({ avgMinutes: 60, answered: 1, unanswered: 1 });
  });
});

describe("no Date ever reaches the driver (A10)", () => {
  it("every bound value in the scorecard queries is a string, not a Date", () => {
    const q = scorecardQueries(workspaceId, WEEK.start, WEEK.end, NOW);
    for (const query of [q.sent, q.quotesOut, q.response]) {
      const { params } = query.toSQL();
      expect(params.length).toBeGreaterThan(0);
      for (const p of params) expect(p).not.toBeInstanceOf(Date);
    }
    const all = [q.sent, q.quotesOut, q.response].flatMap((x) => x.toSQL().params);
    for (const d of [WEEK.start, WEEK.end, NOW]) expect(all).toContain(d.toISOString());
  });

  it("the response query selects only timestamps, never an address or text", async () => {
    const t = await thread();
    await msg(t, "in", day(0, 9));
    const rows = await scorecardQueries(workspaceId, WEEK.start, WEEK.end, NOW).response;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(["firstIn", "firstOut", "settled"]);
  });
});

describe("the no-reply rule is one rule (A13)", () => {
  const cases = [
    "noreply@thumbtack.com",
    "no-reply@angi.com",
    "NoReply+lead@homeadvisor.com",
    "do-not-reply@x.com",
    "donotreply@x.com",
    "notifications@x.com",
    "notification.bot@x.com",
    "mailer-daemon@googlemail.com",
    " noreply@x.com ",
    "dana@customer.com",
    "noreplyguy@x.com",
    "replies@x.com",
    "notify@x.com",
    "@noreply.com",
    "noreply",
    "a@noreply@x.com",
    "",
  ];

  it("offer-rules re-exports the shared helper and still treats no-reply as automated", () => {
    expect(offerNoReply).toBe(isNoReplyAddress);
    expect(isAutomatedSender("noreply@thumbtack.com")).toBe(true);
    expect(isAutomatedSender("receipts@stripe.com")).toBe(true);
    expect(isAutomatedSender("dana@customer.com")).toBe(false);
    expect(isNoReplyAddress("noreply@thumbtack.com")).toBe(true);
    expect(isNoReplyAddress("noreplyguy@x.com")).toBe(false);
    expect(isNoReplyAddress(null)).toBe(false);
  });

  it("the SQL twin agrees with the JavaScript rule on every case", async () => {
    const t = await thread();
    for (const [i, a] of cases.entries())
      await msg(t, "in", new Date(day(0, 9).getTime() + i * MIN), a);
    const rows = await database
      .select({
        address: messages.fromAddress,
        noReply: sql<boolean>`${noReplySql(sql`${messages.fromAddress}`)}`,
      })
      .from(messages);
    expect(rows).toHaveLength(cases.length);
    for (const r of rows)
      expect([r.address, r.noReply]).toEqual([r.address, isNoReplyAddress(r.address)]);
  });
});
