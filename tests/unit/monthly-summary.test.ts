import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_KINDS, OTHER_JOB_KIND } from "@/config/job-kinds";
import { DIRECT_EMAIL, LEAD_SOURCES } from "@/config/lead-sources";
import { TRADES, type Trade } from "@/config/trades";
import type { Database } from "@/db";
import { activityLog, businessProfiles, messages, threads, workspaces } from "@/db/schema";
import { reportSummaryFailures } from "@/jobs/functions";
import { appUrl } from "@/lib/app-url";
import type { OutgoingEmail } from "@/lib/email";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { closeRateBetween, describeActivity, monthCloseRate } from "@/server/activity";
import { sendDigests } from "@/server/digest";
import { saveConnectedMailbox } from "@/server/mailboxes";
import {
  buildMonthlySummary,
  monthlyDue,
  monthlyLines,
  previousMonth,
  type MonthlyStats,
} from "@/server/monthly-rules";
import { monthlyStats, monthlyStatsQueries, sendMonthlySummaries } from "@/server/monthly-summary";
import { createTestDb } from "../support/db";

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const T = (s: string) => new Date(s);

// Sun Nov 1 2026, 7:05am in New York (EST: DST ended at 06:00Z that morning).
const NOW = T("2026-11-01T12:05:00Z");
// October in New York: Oct 1 00:00 EDT → Nov 1 00:00 EDT.
const OCT = { start: T("2026-10-01T04:00:00Z"), end: T("2026-11-01T04:00:00Z") };
const oct = (d: number, h = 12) => T(`2026-10-${String(d).padStart(2, "0")}T${h}:00:00Z`);
const sep = (d: number) => T(`2026-09-${String(d).padStart(2, "0")}T15:00:00Z`);

const settings = (over: Partial<Parameters<typeof monthlyDue>[0]> = {}) => ({
  digestEnabled: true,
  digestHour: 7,
  timeZone: NY,
  monthlySummaryLastSentFor: null,
  ...over,
});

describe("previousMonth (owner's time zone, DST-safe)", () => {
  it("Nov 1 in New York → October, from midnight EDT to midnight EDT", () => {
    const m = previousMonth(NOW, NY);
    expect(m.start.toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(m.end.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(m.key).toBe("2026-10");
  });

  it("Jan 1 → December of the year before", () => {
    const m = previousMonth(T("2026-01-01T15:00:00Z"), NY);
    expect(m.key).toBe("2025-12");
    expect(m.start.toISOString()).toBe("2025-12-01T05:00:00.000Z");
    expect(m.end.toISOString()).toBe("2026-01-01T05:00:00.000Z");
  });

  it("uses the owner's month, not UTC's: 9pm Oct 31 in LA is still October there", () => {
    // 2026-11-01T04:00Z = Oct 31, 9pm PDT → the month before is September.
    expect(previousMonth(T("2026-11-01T04:00:00Z"), LA).key).toBe("2026-09");
    expect(previousMonth(T("2026-11-01T08:00:00Z"), LA).key).toBe("2026-10");
  });

  it("an unknown zone falls back to Eastern instead of failing", () => {
    expect(previousMonth(NOW, "Mars/Base")).toEqual(previousMonth(NOW, NY));
  });
});

describe("monthlyDue", () => {
  it("New York: due on the 1st only at/after the owner's hour, for last month", () => {
    // 11:30Z on Nov 1 = 6:30am EST.
    expect(monthlyDue(settings(), T("2026-11-01T11:30:00Z"))).toEqual({
      due: false,
      monthKey: "2026-10",
    });
    expect(monthlyDue(settings(), NOW)).toEqual({ due: true, monthKey: "2026-10" });
  });

  it("catches up on the 2nd and 3rd — but only at/after the hour, never at night (A15)", () => {
    // Nov 2, 00:30 local.
    expect(monthlyDue(settings(), T("2026-11-02T05:30:00Z")).due).toBe(false);
    // Nov 2 at the digest hour.
    expect(monthlyDue(settings(), T("2026-11-02T12:00:00Z")).due).toBe(true);
    expect(monthlyDue(settings(), T("2026-11-03T20:00:00Z")).due).toBe(true);
    // Nov 4: too late — next month's summary instead.
    expect(monthlyDue(settings(), T("2026-11-04T13:00:00Z")).due).toBe(false);
    // Mid-month never.
    expect(monthlyDue(settings(), T("2026-10-15T13:00:00Z")).due).toBe(false);
  });

  it("once per month, and only with the morning summary switched on", () => {
    expect(monthlyDue(settings({ monthlySummaryLastSentFor: "2026-10" }), NOW).due).toBe(false);
    // Last month's marker doesn't stop this month's.
    expect(monthlyDue(settings({ monthlySummaryLastSentFor: "2026-09" }), NOW).due).toBe(true);
    expect(monthlyDue(settings({ digestEnabled: false }), NOW).due).toBe(false);
    expect(monthlyDue(settings({ digestHour: 9 }), NOW).due).toBe(false);
  });

  it("Los Angeles: 2026-11-01T12:30Z is 4:30am PST — not due until the hour", () => {
    expect(monthlyDue(settings({ timeZone: LA }), T("2026-11-01T12:30:00Z")).due).toBe(false);
    expect(monthlyDue(settings({ timeZone: LA }), T("2026-11-01T15:00:00Z"))).toEqual({
      due: true,
      monthKey: "2026-10",
    });
  });
});

const STATS: MonthlyStats = {
  quoteRequests: 7,
  jobKinds: [
    { label: "Panel upgrades", count: 4 },
    { label: "EV chargers", count: 2 },
    { label: OTHER_JOB_KIND, count: 1 },
  ],
  leadSources: [
    { label: "Thumbtack", count: 3 },
    { label: DIRECT_EMAIL, count: 2 },
  ],
  repeatCustomers: 2,
  won: 3,
  lost: 1,
  noAnswer: 1,
  ratePct: 60,
};
const URLS = {
  activityUrl: "https://app.example/activity",
  settingsUrl: "https://app.example/settings#digest",
};

describe("buildMonthlySummary (pure)", () => {
  it("plain lines: requests, busiest kinds, sources, repeat customers, win rate", () => {
    expect(monthlyLines(STATS)).toEqual([
      "7 quote requests.",
      "Busiest: Panel upgrades (4), EV chargers (2), Other jobs (1).",
      "Where they came from: Thumbtack (3), Direct email (2).",
      "2 repeat customers wrote in again.",
      "You won 3 of 5 quotes decided (60%).",
    ]);
    const e = buildMonthlySummary(STATS, "October", URLS);
    expect(e.subject).toBe("Your October in numbers");
    expect(e.worthSending).toBe(true);
    for (const l of monthlyLines(STATS)) {
      expect(e.text).toContain(l);
      expect(e.html).toContain(l);
    }
  });

  it("singulars, and lines with nothing to say are left out", () => {
    expect(
      monthlyLines({
        ...STATS,
        quoteRequests: 1,
        jobKinds: [{ label: "Panel upgrades", count: 1 }],
        leadSources: [{ label: DIRECT_EMAIL, count: 1 }],
        repeatCustomers: 1,
        won: 1,
        lost: 0,
        noAnswer: 0,
        ratePct: 100,
      }),
    ).toEqual([
      "1 quote request.",
      "Busiest: Panel upgrades (1).",
      "Where they came from: Direct email (1).",
      "1 repeat customer wrote in again.",
      "You won 1 of 1 quote decided (100%).",
    ]);
    expect(
      monthlyLines({
        ...STATS,
        quoteRequests: 0,
        jobKinds: [],
        leadSources: [],
        won: 0,
        lost: 1,
        noAnswer: 0,
        ratePct: 0,
        repeatCustomers: 0,
      }),
    ).toEqual(["No quote requests came in by email.", "You won 0 of 1 quote decided (0%)."]);
  });

  it("an empty month isn't worth an email", () => {
    const empty: MonthlyStats = {
      quoteRequests: 0,
      jobKinds: [],
      leadSources: [],
      repeatCustomers: 0,
      won: 0,
      lost: 0,
      noAnswer: 0,
      ratePct: null,
    };
    expect(buildMonthlySummary(empty, "October", URLS).worthSending).toBe(false);
    expect(
      buildMonthlySummary({ ...empty, repeatCustomers: 1 }, "October", URLS).worthSending,
    ).toBe(true);
    expect(
      buildMonthlySummary({ ...empty, noAnswer: 1, ratePct: 0 }, "October", URLS).worthSending,
    ).toBe(true);
  });

  it("escapes everything in the HTML", () => {
    const e = buildMonthlySummary(
      { ...STATS, jobKinds: [{ label: 'A & <b>"B"</b>', count: 1 }] },
      "October",
      URLS,
    );
    expect(e.html).toContain("A &amp; &lt;b&gt;&quot;B&quot;&lt;/b&gt;");
    expect(e.html).not.toContain("<b>");
  });

  it("the Activity line names the monthly summary", () => {
    expect(describeActivity("monthly_summary_sent", {}, null)).toBe("Sent your monthly summary");
  });
});

/* ------------------------------------------------------------------------------------------
 * In the database
 * ---------------------------------------------------------------------------------------- */

let database: Database;
let workspaceId: string;
let mailboxId: string;
let sent: OutgoingEmail[];
const sender = async (e: OutgoingEmail) => {
  sent.push(e);
  return "sent" as const;
};

async function owner(email: string, trade: Trade | null = "electrical") {
  const { workspace } = await ensureUserAndWorkspace({ email });
  const box = await saveConnectedMailbox(workspace, {
    email,
    refreshToken: "rt",
    grantedScopes: [],
  });
  await database
    .update(workspaces)
    .set({ status: "active", setupPaidVia: "stripe", trade })
    .where(eq(workspaces.id, workspace.id));
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
      subject: "SECRET-SUBJECT",
      summary: "SECRET-SUMMARY",
      ...over,
    })
    .returning();
  return t!.id;
}

async function msg(
  threadId: string,
  sentAt: Date,
  from: string,
  direction: "in" | "out" = "in",
  box = mailboxId,
) {
  await database.insert(messages).values({
    threadId,
    mailboxId: box,
    gmailMessageId: `m-${randomUUID()}`,
    direction,
    fromName: "SECRET-NAME",
    fromAddress: from,
    subject: "SECRET-SUBJECT",
    bodyText: "SECRET-BODY",
    sentAt,
  });
}

/** A quote request: a thread plus its customer's first email. */
async function request(sentAt: Date, from: string, over: ThreadOver = {}, box = mailboxId) {
  const t = await thread(over, box);
  await msg(t, sentAt, from, "in", box);
  return t;
}

const marker = async (ws = workspaceId) =>
  (
    await database
      .select({ m: businessProfiles.monthlySummaryLastSentFor })
      .from(businessProfiles)
      .where(eq(businessProfiles.workspaceId, ws))
  )[0]?.m ?? null;
const monthlyRows = (ws = workspaceId) =>
  database
    .select()
    .from(activityLog)
    .where(eq(activityLog.workspaceId, ws))
    .then((rows) => rows.filter((r) => r.action === "monthly_summary_sent"));

const stats = (trade: Trade | null = "electrical") =>
  monthlyStats(workspaceId, trade, OCT.start, OCT.end);

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
  ({ workspaceId, mailboxId } = await owner("owner@shop.com"));
  sent = [];
});
afterEach(() => vi.restoreAllMocks());

describe("monthlyStats: quote requests, busiest kinds and lead sources", () => {
  it("maps kinds by trade and sources by the first sender's domain; only the month, only this workspace", async () => {
    // First email from Thumbtack's no-reply; a later one from the customer doesn't change it.
    const t1 = await request(oct(5), "noreply@thumbtack.com", { jobKind: "Panel upgrades" });
    await msg(t1, oct(6), "dana@gmail.com");
    // The very first instant of the month counts.
    await request(OCT.start, "leads@mail.thumbtack.com", { jobKind: "Panel upgrades" });
    // No stored kind (older thread): worked out from the service, then dropped.
    await request(oct(10), "bob@gmail.com", {
      extracted: { service_requested: "Tesla wall charger" },
    });
    await request(oct(11), "x@houzz.com", { extracted: { service_requested: "SECRET-xyz" } });
    // A stored label that isn't one of this trade's is worked out again.
    await request(oct(12), "a@yelp.com", {
      jobKind: "Decks and porches",
      extracted: { service_requested: "new 200 amp panel" },
    });
    // Re-sorted later (a reply about scheduling): still a quote request (A11).
    await request(oct(20), "c@thumbtack.com", {
      category: "scheduling",
      quoteRequestedAt: oct(20),
      jobKind: "EV chargers",
    });

    // Not October's: Sep 30 11:59pm in New York (even with a later October email), Nov 1.
    const late = await request(T("2026-10-01T03:59:59Z"), "z@thumbtack.com", {
      jobKind: "Panel upgrades",
    });
    await msg(late, oct(3), "z@thumbtack.com");
    await request(OCT.end, "z@thumbtack.com", { jobKind: "Panel upgrades" });
    // Not a quote request.
    await request(oct(15), "q@thumbtack.com", { category: "customer_question" });
    // Another owner's.
    const other = await owner("other@shop.com");
    await request(oct(15), "o@thumbtack.com", { jobKind: "Panel upgrades" }, other.mailboxId);

    const s = await stats();
    expect(s.quoteRequests).toBe(6);
    expect(s.jobKinds).toEqual([
      { label: "Panel upgrades", count: 3 },
      { label: "EV chargers", count: 2 },
      { label: OTHER_JOB_KIND, count: 1 },
    ]);
    // Top 3; ties alphabetical.
    expect(s.leadSources).toEqual([
      { label: "Thumbtack", count: 3 },
      { label: DIRECT_EMAIL, count: 1 },
      { label: "Houzz", count: 1 },
    ]);
  });

  it("returns exactly the MonthlyStats keys — labels and counts, never text or addresses (A2)", async () => {
    await request(oct(5), "SECRET@thumbtack.com", {
      extracted: { service_requested: "SECRET-SERVICE 200A panel for Dana at 12 Elm St $4,800" },
    });
    await request(oct(6), "secret-person@gmail.com", {});
    const s = await stats();
    expect(Object.keys(s).sort()).toEqual(
      [
        "jobKinds",
        "leadSources",
        "lost",
        "noAnswer",
        "quoteRequests",
        "ratePct",
        "repeatCustomers",
        "won",
      ].sort(),
    );
    for (const x of [...s.jobKinds, ...s.leadSources])
      expect(Object.keys(x).sort()).toEqual(["count", "label"]);
    expect(JSON.stringify(s)).not.toMatch(/SECRET|secret|@|gmail|thumbtack\.com|Elm|4,800/);
  });

  it("A2: the requests query hands the app a domain, never a customer's address", async () => {
    await request(oct(5), "SECRET@thumbtack.com", {});
    await request(oct(6), "dana@gmail.com", {});
    const rows = await monthlyStatsQueries(workspaceId, "electrical", OCT.start, OCT.end).requests;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["domain", "jobKind", "service"]);
      expect(row.domain ?? "").not.toContain("@");
    }
    expect(rows.map((r) => r.domain).sort()).toEqual(["gmail.com", "thumbtack.com"]);
    expect(JSON.stringify(rows)).not.toMatch(/SECRET|dana/i);
  });

  it("A10: no Date reaches the driver from the monthly queries", () => {
    const q = monthlyStatsQueries(workspaceId, "electrical", OCT.start, OCT.end);
    for (const query of [q.requests, q.repeat]) {
      const { params } = query.toSQL();
      expect(params.length).toBeGreaterThan(0);
      for (const p of params) expect(p).not.toBeInstanceOf(Date);
    }
  });
});

describe("monthlyStats: repeat customers", () => {
  it("counts an address that wrote before the month on another thread, once, case-insensitively", async () => {
    // Ann wrote in September (any thread), then a quote request and a question in October.
    const old = await thread({ category: "scheduling" });
    await msg(old, sep(10), "ann@x.com");
    await request(oct(3), "ANN@X.com");
    await request(oct(9), "Ann@x.com", { category: "customer_question" });
    // A first-time October sender.
    await request(oct(4), "new@x.com");
    // One conversation spanning Sep 28 → Oct 2 is not a repeat customer (A17).
    const span = await request(sep(28), "pat@x.com");
    await msg(span, oct(2), "pat@x.com");
    // Noise and supplier threads don't count, even from earlier senders.
    const s1 = await thread({ category: "noise" });
    await msg(s1, sep(5), "sam@x.com");
    await request(oct(5), "sam@x.com", { category: "noise" });
    const v1 = await thread({ category: "supplier_vendor" });
    await msg(v1, sep(5), "sup@x.com");
    await request(oct(5), "sup@x.com", { category: "supplier_vendor" });
    // A lead platform's no-reply address isn't a customer.
    await request(sep(6), "noreply@thumbtack.com");
    await request(oct(6), "noreply@thumbtack.com");
    // Nor is any other no-reply sender (a domain that isn't a lead platform).
    const n1 = await thread({ category: "customer_question" });
    await msg(n1, sep(8), "no-reply@somestore.com");
    await request(oct(8), "no-reply@somestore.com", { category: "customer_question" });
    // Nor is a lead platform writing from a fixed address (or a subdomain of one).
    await request(sep(6), "leads@homeadvisor.com");
    await request(oct(6), "Leads@HomeAdvisor.com");
    await request(sep(6), "team@mail.bark.com");
    await request(oct(6), "team@mail.bark.com");
    // Google's lead hosts match exactly.
    await request(sep(6), "leads@localservices.google.com");
    await request(oct(6), "leads@localservices.google.com");
    // Wrote before only to ANOTHER owner: not this owner's repeat customer.
    const other = await owner("other@shop.com");
    await request(sep(7), "bea@x.com", {}, other.mailboxId);
    await request(oct(7), "bea@x.com");
    // Wrote again after the month: not counted for October.
    await request(T("2026-11-01T05:00:00Z"), "ann@x.com");

    expect((await stats()).repeatCustomers).toBe(1);
  });
});

describe("monthlyStats: win rate (closeRateBetween)", () => {
  it("only outcomes decided inside the owner's month count", async () => {
    await thread({ quoteOutcome: "won", quoteOutcomeAt: oct(3) });
    // Oct 31 11pm in New York (Nov 1 in UTC): still October.
    await thread({ quoteOutcome: "won", quoteOutcomeAt: T("2026-11-01T03:00:00Z") });
    await thread({ quoteOutcome: "lost", quoteOutcomeAt: oct(15) });
    // Sep 30 11pm in New York; Nov 1 1am in New York.
    await thread({ quoteOutcome: "no_answer", quoteOutcomeAt: T("2026-10-01T03:00:00Z") });
    await thread({ quoteOutcome: "won", quoteOutcomeAt: T("2026-11-01T05:00:00Z") });
    // Another owner's.
    const other = await owner("other@shop.com");
    await thread({ quoteOutcome: "lost", quoteOutcomeAt: oct(10) }, other.mailboxId);

    const s = await stats();
    expect({ won: s.won, lost: s.lost, noAnswer: s.noAnswer, ratePct: s.ratePct }).toEqual({
      won: 2,
      lost: 1,
      noAnswer: 0,
      ratePct: 67,
    });
    expect(await closeRateBetween(workspaceId, OCT.start, OCT.end)).toEqual({
      won: 2,
      lost: 1,
      noAnswer: 0,
      ratePct: 67,
    });
    // With no end it's "this month so far", exactly as monthCloseRate always counted.
    expect(await monthCloseRate(workspaceId, oct(20), NY)).toEqual(
      await closeRateBetween(workspaceId, OCT.start, null),
    );
    // "So far" has no upper bound (as before), so the Nov 1 decision is in it; the monthly
    // summary's [start, end) leaves it out.
    expect(await monthCloseRate(workspaceId, oct(20), NY)).toEqual({
      won: 3,
      lost: 1,
      noAnswer: 0,
      ratePct: 75,
    });
  });
});

describe("sendMonthlySummaries", () => {
  async function seedOctober() {
    await request(oct(5), "noreply@thumbtack.com", { jobKind: "Panel upgrades" });
    await request(oct(8), "dana@gmail.com", { jobKind: "EV chargers" });
    await thread({ quoteOutcome: "won", quoteOutcomeAt: oct(20) });
  }

  it("sends once per month with its own idempotency key, logs it and marks the month", async () => {
    await seedOctober();
    // 6:30am on Nov 1: before the owner's hour.
    expect(await sendMonthlySummaries(T("2026-11-01T11:30:00Z"), { send: sender })).toMatchObject({
      sent: 0,
    });
    expect(sent).toHaveLength(0);

    expect(await sendMonthlySummaries(NOW, { send: sender })).toEqual({
      sent: 1,
      skipped: 0,
      failed: 0,
      notConfigured: false,
    });
    expect(sent).toHaveLength(1);
    const e = sent[0]!;
    expect(e.to).toBe("owner@shop.com");
    expect(e.idempotencyKey).toBe(`monthly-${workspaceId}-2026-10`);
    expect(e.subject).toBe("Your October in numbers");
    expect(e.text).toContain("2 quote requests.");
    expect(e.text).toContain("Busiest: EV chargers (1), Panel upgrades (1).");
    expect(e.text).toContain("Where they came from: Direct email (1), Thumbtack (1).");
    expect(e.text).toContain("You won 1 of 1 quote decided (100%).");
    expect(await marker()).toBe("2026-10");
    const rows = await monthlyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("squared_away");
    expect(rows[0]!.detail).toEqual({});

    // Later that day, and the catch-up days: nothing more.
    await sendMonthlySummaries(T("2026-11-01T15:00:00Z"), { send: sender });
    await sendMonthlySummaries(T("2026-11-02T13:00:00Z"), { send: sender });
    expect(sent).toHaveLength(1);
    expect(await monthlyRows()).toHaveLength(1);
  });

  it("a missed 1st is caught up on the 2nd at the owner's hour", async () => {
    await seedOctober();
    await sendMonthlySummaries(T("2026-11-02T05:30:00Z"), { send: sender }); // 00:30 local
    expect(sent).toHaveLength(0);
    await sendMonthlySummaries(T("2026-11-02T12:00:00Z"), { send: sender });
    expect(sent.map((e) => e.idempotencyKey)).toEqual([`monthly-${workspaceId}-2026-10`]);
  });

  it("each owner on their own 1st: a Los Angeles owner waits for their hour", async () => {
    await seedOctober();
    const la = await owner("la@shop.com");
    await database
      .insert(businessProfiles)
      .values({ workspaceId: la.workspaceId, timeZone: LA })
      .onConflictDoUpdate({ target: businessProfiles.workspaceId, set: { timeZone: LA } });
    await request(oct(9), "lee@gmail.com", {}, la.mailboxId);

    await sendMonthlySummaries(T("2026-11-01T12:30:00Z"), { send: sender }); // 4:30am PST
    expect(sent.map((e) => e.to)).toEqual(["owner@shop.com"]);
    await sendMonthlySummaries(T("2026-11-01T15:05:00Z"), { send: sender }); // 7:05am PST
    expect(sent.map((e) => e.to)).toEqual(["owner@shop.com", "la@shop.com"]);
    expect(sent[1]!.idempotencyKey).toBe(`monthly-${la.workspaceId}-2026-10`);
  });

  it("an empty month: no email, but the month is marked done (no activity row)", async () => {
    // Only mail outside October.
    await request(sep(10), "dana@gmail.com");
    expect(await sendMonthlySummaries(NOW, { send: sender })).toMatchObject({
      sent: 0,
      skipped: 1,
    });
    expect(sent).toHaveLength(0);
    expect(await marker()).toBe("2026-10");
    expect(await monthlyRows()).toHaveLength(0);
  });

  it("GATE: without email set up, nothing is sent and nothing is marked", async () => {
    await seedOctober();
    const run = await sendMonthlySummaries(NOW, { send: async () => "not_configured" });
    expect(run.notConfigured).toBe(true);
    expect(run.sent).toBe(0);
    expect(await marker()).toBeNull();
    expect(await monthlyRows()).toHaveLength(0);
  });

  it.each([
    ["evaluation_expired", null],
    ["canceled", null],
    ["paused", null],
    ["past_due", null],
    // Stored as evaluating, but the three days ended (A7).
    ["evaluating", T("2026-10-20T00:00:00Z")],
  ] as const)(
    "GATE read-only (%s): no monthly email, no marker, no activity row",
    async (status, evaluationEndsAt) => {
      await seedOctober();
      await database
        .update(workspaces)
        .set({ status, evaluationEndsAt })
        .where(eq(workspaces.id, workspaceId));
      const run = await sendMonthlySummaries(NOW, { send: sender });
      expect(run.sent).toBe(0);
      expect(sent).toHaveLength(0);
      expect(await marker()).toBeNull();
      expect(await monthlyRows()).toHaveLength(0);
    },
  );

  it("GATE: the morning summary switched off means no monthly summary either", async () => {
    await seedOctober();
    await database
      .insert(businessProfiles)
      .values({ workspaceId, digestEnabled: false })
      .onConflictDoUpdate({ target: businessProfiles.workspaceId, set: { digestEnabled: false } });
    await sendMonthlySummaries(NOW, { send: sender });
    await sendMonthlySummaries(T("2026-11-03T13:00:00Z"), { send: sender });
    expect(sent).toHaveLength(0);
    expect(await marker()).toBeNull();
    expect(await monthlyRows()).toHaveLength(0);
  });

  it("one owner's failure doesn't stop the others; logged as metadata only, nothing marked", async () => {
    await seedOctober();
    const second = await owner("second@shop.com");
    await request(oct(9), "lee@gmail.com", {}, second.mailboxId);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const flaky = async (e: OutgoingEmail) => {
      if (e.to === "owner@shop.com") throw new Error("Resend 500 for SECRET@thumbtack.com");
      return sender(e);
    };
    const run = await sendMonthlySummaries(NOW, { send: flaky });
    expect(run).toMatchObject({ sent: 1, failed: 1 });
    expect(sent.map((e) => e.to)).toEqual(["second@shop.com"]);
    expect(await marker()).toBeNull();
    expect(await marker(second.workspaceId)).toBe("2026-10");
    expect(errors).toHaveBeenCalledWith("monthly_summary_failed", {
      workspaceId,
      error: "Error",
    });
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/SECRET|thumbtack|Resend 500/);

    // The next hourly run tries again.
    await sendMonthlySummaries(T("2026-11-01T13:05:00Z"), { send: sender });
    expect(sent.map((e) => e.to)).toEqual(["second@shop.com", "owner@shop.com"]);
  });

  it("one owner's failing morning summary stops neither the other digests nor anyone's monthly one", async () => {
    // The hourly job runs the morning summaries first, then the monthly ones: a morning
    // summary that the email service keeps refusing (say, an address it won't deliver to)
    // must not throw, or the monthly step would never run for anyone.
    await seedOctober();
    const second = await owner("second@shop.com");
    await request(oct(9), "lee@gmail.com", {}, second.mailboxId);
    // Something waiting for each owner today, so both morning summaries are worth sending.
    const waiting = { category: "complaint", needsOwner: true } as const;
    await request(T("2026-10-31T20:00:00Z"), "kim@gmail.com", waiting);
    await request(T("2026-10-31T20:00:00Z"), "kim@gmail.com", waiting, second.mailboxId);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const digestSent: string[] = [];
    const refusing = async (e: OutgoingEmail) => {
      if (e.to === "second@shop.com") throw new Error("Resend 403 for second@shop.com");
      digestSent.push(e.to);
      return "sent" as const;
    };
    const digests = await sendDigests(NOW, { send: refusing });
    expect(digests).toMatchObject({ sent: 1, failed: 1 });
    expect(digestSent).toEqual(["owner@shop.com"]);
    expect(errors).toHaveBeenCalledWith("digest_failed", {
      workspaceId: second.workspaceId,
      error: "Error",
    });
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/Resend 403|second@shop\.com/);

    expect(await sendMonthlySummaries(NOW, { send: sender })).toMatchObject({ sent: 2, failed: 0 });
    expect(sent.map((e) => e.to).sort()).toEqual(["owner@shop.com", "second@shop.com"]);
  });

  describe("Resend answers 'already sent' (409 invalid_idempotent_request: same key, changed body)", () => {
    // An earlier try got the email out but its marker didn't save; the retry's body moved on
    // ("waiting 41 minutes"), so Resend refuses it. The owner already has the email.
    const already = async (e: OutgoingEmail) => {
      sent.push(e);
      return "already_sent" as const;
    };
    const digestMarker = async () =>
      (
        await database
          .select({ d: businessProfiles.digestLastSentOn })
          .from(businessProfiles)
          .where(eq(businessProfiles.workspaceId, workspaceId))
      )[0]?.d ?? null;
    const digestRows = () =>
      database
        .select()
        .from(activityLog)
        .where(eq(activityLog.workspaceId, workspaceId))
        .then((rows) => rows.filter((r) => r.action === "digest_sent"));
    async function seedWithSomethingWaiting() {
      await seedOctober();
      // Something waiting today, so the morning summary is worth sending too.
      await request(T("2026-10-31T20:00:00Z"), "kim@gmail.com", {
        category: "complaint",
        needsOwner: true,
      });
    }

    it("both summaries record it as sent: marked, one Activity row each, no failure, no error alert", async () => {
      await seedWithSomethingWaiting();
      const digests = await sendDigests(NOW, { send: already });
      const monthly = await sendMonthlySummaries(NOW, { send: already });
      expect(sent.map((e) => e.idempotencyKey)).toEqual([
        `digest-${workspaceId}-2026-11-01`,
        `monthly-${workspaceId}-2026-10`,
      ]);
      expect(digests).toMatchObject({ sent: 1, failed: 0 });
      expect(monthly).toMatchObject({ sent: 1, failed: 0 });
      expect(() => reportSummaryFailures(digests, monthly)).not.toThrow();
      expect(await digestMarker()).toBe("2026-11-01");
      expect(await marker()).toBe("2026-10");
      expect(await digestRows()).toHaveLength(1);
      expect(await monthlyRows()).toHaveLength(1);

      // The next hourly run is done for the day and the month: no send, no failure.
      const later = T("2026-11-01T13:05:00Z");
      expect(await sendDigests(later, { send: sender })).toMatchObject({ sent: 0, failed: 0 });
      expect(await sendMonthlySummaries(later, { send: sender })).toMatchObject({
        sent: 0,
        failed: 0,
      });
      expect(sent).toHaveLength(2);
      expect(await digestRows()).toHaveLength(1);
      expect(await monthlyRows()).toHaveLength(1);
    });

    it("a run that overlapped one which already marked the day and month adds no second Activity row", async () => {
      await seedWithSomethingWaiting();
      // While this run's send is in flight, the other run finishes: marker + Activity row.
      const otherRunFinishedFirst = async (e: OutgoingEmail) => {
        sent.push(e);
        const monthly = e.idempotencyKey.startsWith("monthly-");
        await database
          .insert(businessProfiles)
          .values({ workspaceId })
          .onConflictDoNothing({ target: businessProfiles.workspaceId });
        await database
          .update(businessProfiles)
          .set(
            monthly ? { monthlySummaryLastSentFor: "2026-10" } : { digestLastSentOn: "2026-11-01" },
          )
          .where(eq(businessProfiles.workspaceId, workspaceId));
        await database.insert(activityLog).values({
          workspaceId,
          actor: "squared_away",
          action: monthly ? "monthly_summary_sent" : "digest_sent",
          detail: {},
        });
        return "already_sent" as const;
      };
      const digests = await sendDigests(NOW, { send: otherRunFinishedFirst });
      const monthly = await sendMonthlySummaries(NOW, { send: otherRunFinishedFirst });
      expect(digests).toMatchObject({ sent: 0, skipped: 1, failed: 0 });
      expect(monthly).toMatchObject({ sent: 0, skipped: 1, failed: 0 });
      expect(await digestMarker()).toBe("2026-11-01");
      expect(await marker()).toBe("2026-10");
      expect(await digestRows()).toHaveLength(1);
      expect(await monthlyRows()).toHaveLength(1);
    });
  });
});

describe("GUARDRAILS: the monthly email is labels and counts only", () => {
  it("never carries the extracted service text, a sender, a name, a subject or an amount", async () => {
    const t = await request(oct(5), "SECRET@thumbtack.com", {
      subject: "SECRET subject",
      summary: "SECRET summary",
      needsOwnerReason: "SECRET reason",
      extracted: { service_requested: "SECRET-SERVICE 200A panel for Dana at 12 Elm St $4,800" },
      quoteOutcome: "won",
      quoteOutcomeAt: oct(20),
      quoteAmountCents: 480000,
    });
    await database
      .update(messages)
      .set({ fromName: "SECRET Dana" })
      .where(eq(messages.threadId, t));
    // A repeat customer, so that line is there too.
    await msg(await thread({ category: "scheduling" }), sep(3), "SECRET-repeat@gmail.com");
    await request(oct(7), "SECRET-repeat@gmail.com", {
      extracted: { service_requested: "SECRET-SERVICE EV charger at 12 Elm St" },
    });

    await sendMonthlySummaries(NOW, { send: sender });
    expect(sent).toHaveLength(1);
    const e = sent[0]!;
    // Proof it said something: the panel request is counted under our label.
    expect(e.text).toContain("Panel upgrades (1)");
    expect(e.text).toContain("Thumbtack (1)");
    expect(e.text).toContain("1 repeat customer wrote in again.");
    for (const out of [e.subject, e.text, e.html]) {
      expect(out).not.toMatch(/SECRET/i);
      expect(out).not.toContain("@thumbtack");
      expect(out).not.toContain("thumbtack.com");
      expect(out).not.toContain("gmail");
      expect(out).not.toContain("12 Elm");
      expect(out).not.toContain("Dana");
      expect(out).not.toContain("$4,800");
      expect(out).not.toContain("4,800");
      expect(out).not.toContain("4800");
    }
  });

  it("every job-kind and lead-source label is one of our fixed labels, for every trade", async () => {
    const services = [
      "new 200 amp panel",
      "water heater leaking",
      "deck repair",
      "AC not cooling",
      "roof leak",
      "paint the kitchen",
      "paver patio",
      "kitchen remodel",
      "SECRET something else",
      null,
    ];
    const senders = [
      "noreply@thumbtack.com",
      "x@homeadvisor.com",
      "y@localservices.google.com",
      "calendar-notification@google.com",
      "z@yelp.com",
      "dana@gmail.com",
      "pro@houzz.com",
      "n@nextdoor.com",
      "b@bark.com",
      "q@porch.com",
    ];
    for (let i = 0; i < services.length; i++)
      await request(oct(i + 2), senders[i]!, {
        // Half carry a stored label from some trade, half only the service text.
        jobKind: i % 2 ? "Panel upgrades" : null,
        extracted: { service_requested: services[i] },
      });

    const sources = new Set([...LEAD_SOURCES.map((s) => s.label), DIRECT_EMAIL]);
    for (const trade of [...TRADES, null]) {
      const s = await stats(trade);
      const kinds = new Set([...JOB_KINDS[trade ?? "other"].map((k) => k.label), OTHER_JOB_KIND]);
      expect(s.jobKinds.length).toBeGreaterThan(0);
      for (const k of s.jobKinds) expect(kinds.has(k.label), `${trade}: ${k.label}`).toBe(true);
      for (const l of s.leadSources) expect(sources.has(l.label), l.label).toBe(true);

      // And the email echoes only those labels.
      const e = buildMonthlySummary(s, "October", URLS);
      // "Busiest: A (2), B (1)." → ["A", "B"] (our labels have no commas).
      const listed = (prefix: string) => {
        const line = e.text.split("\n").find((l) => l.startsWith(prefix)) ?? "";
        const items = line.slice(prefix.length, -1).split(", ");
        for (const x of items) expect(x).toMatch(/^[^,]+ \(\d+\)$/);
        return items.map((x) => x.replace(/ \(\d+\)$/, ""));
      };
      for (const k of listed("Busiest: ")) expect(kinds.has(k), `${trade}: ${k}`).toBe(true);
      for (const l of listed("Where they came from: ")) expect(sources.has(l), l).toBe(true);
    }
  });

  it("links only to Activity and Settings (no ids, no addresses, no query strings)", async () => {
    await request(oct(5), "SECRET@thumbtack.com", { jobKind: "Panel upgrades" });
    await sendMonthlySummaries(NOW, { send: sender });
    const e = sent[0]!;
    const allowed = new Set([appUrl("/activity"), appUrl("/settings#digest")]);
    const hrefs = [...e.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
    const textUrls = e.text.match(/https?:\/\/\S+/g) ?? [];
    expect(hrefs.length).toBeGreaterThan(0);
    expect(textUrls.length).toBeGreaterThan(0);
    for (const u of [...hrefs, ...textUrls]) {
      expect(allowed.has(u.replace(/&amp;/g, "&")), u).toBe(true);
      expect(u).not.toMatch(/[@?]/);
    }
  });
});
