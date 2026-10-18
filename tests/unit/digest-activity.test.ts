import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { draftTag } from "@/config/categories";
import type { Database } from "@/db";
import { activityLog, businessProfiles, drafts, messages, threads, workspaces } from "@/db/schema";
import type { OutgoingEmail } from "@/lib/email";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  describeActivity,
  listActivity,
  localMonthName,
  localMonthStart,
  monthCloseRate,
  monthSummary,
} from "@/server/activity";
import { buildDigest, digestCounts, digestDue, localParts, sendDigests } from "@/server/digest";
import { queueThreadUrl } from "@/server/digest-rules";
import { listQueue, queueCounts } from "@/server/drafts";
import { lastInSql, lastOutSql, waitingSinceSql } from "@/server/thread-sql";
import { appUrl } from "@/lib/app-url";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { digestSettingsInput, saveDigestSettings, setOwnerTimeZone } from "@/server/profile";
import { createTestDb } from "../support/db";

// 11:30 UTC = 7:30am in New York (EDT), 4:30am in Los Angeles.
const NOW = new Date("2026-10-06T11:30:00Z");

describe("digest timing", () => {
  it("works in the owner's time zone", () => {
    expect(localParts(NOW, "America/New_York")).toEqual({ date: "2026-10-06", hour: 7 });
    expect(localParts(NOW, "America/Los_Angeles")).toEqual({ date: "2026-10-06", hour: 4 });
    expect(localParts(NOW, "Not/AZone")).toEqual({ date: "2026-10-06", hour: 7 });
  });

  it("is due once a day, at or after the owner's hour", () => {
    const s = {
      digestEnabled: true,
      digestHour: 7,
      timeZone: "America/New_York",
      digestLastSentOn: null,
    };
    expect(digestDue(s, NOW).due).toBe(true);
    expect(digestDue({ ...s, digestHour: 8 }, NOW).due).toBe(false);
    expect(digestDue({ ...s, digestLastSentOn: "2026-10-06" }, NOW).due).toBe(false);
    expect(digestDue({ ...s, digestLastSentOn: "2026-10-05" }, NOW).due).toBe(true);
    expect(digestDue({ ...s, timeZone: "America/Los_Angeles" }, NOW).due).toBe(false);
    expect(digestDue({ ...s, digestEnabled: false }, NOW).due).toBe(false);
  });
});

describe("digest content", () => {
  const T1 = "11111111-1111-4111-8111-111111111111";
  const T2 = "22222222-2222-4222-8222-222222222222";
  const links = {
    queueUrl: "https://app/queue",
    quotesUrl: "https://app/quotes",
    settingsUrl: "https://app/settings",
    threadUrl: (id: string) => queueThreadUrl("https://app/queue", id),
  };
  const at = { now: NOW, timeZone: "America/New_York" };
  const counts = {
    repliesReady: 3,
    nudgesReady: 1,
    needsYou: [
      {
        threadId: T1,
        category: "complaint",
        priority: "normal" as const,
        waitingSince: new Date("2026-10-05T20:00:00Z"),
      },
      {
        threadId: T2,
        category: "customer_question",
        priority: "normal" as const,
        waitingSince: new Date(NOW.getTime() - 40 * 60_000),
      },
    ],
    sentYesterday: 2,
    sortedYesterday: 14,
    leadsAtRisk: 0,
    leadsAtRiskOffQueue: 0,
  };
  const quiet = {
    repliesReady: 0,
    nudgesReady: 0,
    needsYou: [],
    sentYesterday: 0,
    sortedYesterday: 0,
    leadsAtRisk: 0,
    leadsAtRiskOffQueue: 0,
  };

  it("opens with what needs you, each a link to its card, then what's ready (plan #31)", () => {
    const d = buildDigest(counts, links, at);
    expect(d.subject).toBe("6 things waiting on you");
    expect(d.text).toContain(
      [
        "Good morning.",
        "",
        "Needs you:",
        `• A complaint — waiting since yesterday: https://app/queue#t-${T1}`,
        `• A customer question — waiting 40 minutes: https://app/queue#t-${T2}`,
        "",
        "3 replies drafted and waiting for your okay.",
      ].join("\n"),
    );
    expect(d.text).toContain("1 follow-up ready");
    expect(d.text).toContain("Yesterday: 14 emails sorted, 2 replies sent.");
    expect(d.text).not.toContain("more in your queue");
    expect(d.html).toContain(`href="https://app/queue#t-${T1}"`);
    expect(d.html).toContain("A complaint — waiting since yesterday</a>");
    expect(d.html).toContain('href="https://app/queue"');
    expect(d.text).toContain("Nothing is sent without your okay.");
    // The needs-you header comes before the rest of the summary.
    expect(d.html.indexOf("Needs you")).toBeLessThan(d.html.indexOf("3 replies drafted"));
    expect(d.worthSending).toBe(true);
  });

  it("five waiting: three lines and '+ 2 more in your queue', and the subject counts all five", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      threadId: `00000000-0000-4000-8000-00000000000${i}`,
      category: "quote_request",
      priority: (i === 4 ? "high" : "normal") as "high" | "normal",
      waitingSince: new Date(NOW.getTime() - (i + 1) * 3600_000),
    }));
    const d = buildDigest({ ...quiet, needsYou: five }, links, at);
    expect(d.subject).toBe("5 things waiting on you");
    const bullets = d.text.split("\n").filter((l) => l.startsWith("• "));
    expect(bullets).toEqual([
      "• A quote request — waiting 5 hours: https://app/queue#t-00000000-0000-4000-8000-000000000004",
      "• A quote request — waiting 4 hours: https://app/queue#t-00000000-0000-4000-8000-000000000003",
      "• A quote request — waiting 3 hours: https://app/queue#t-00000000-0000-4000-8000-000000000002",
    ]);
    expect(d.text).toContain("+ 2 more in your queue");
    expect(d.html).toContain("+ 2 more in your queue</a>");
  });

  it("nothing needs you: one line, and a day with nothing else isn't worth an email", () => {
    const d = buildDigest(quiet, links, at);
    expect(d.text).toContain("No emails need a decision from you today.");
    expect(d.html).toContain("No emails need a decision from you today.");
    expect(d.text).not.toContain("Open your queue");
    expect(d.worthSending).toBe(false);
    // Something ready but nobody waiting: worth it, and the header still says so plainly.
    const ready = buildDigest({ ...quiet, repliesReady: 1 }, links, at);
    expect(ready.worthSending).toBe(true);
    expect(ready.text).toContain("No emails need a decision from you today.");
    expect(ready.text).toContain("Open your queue: https://app/queue");
  });

  it("Monday's 'Last week' lines go below the rest, and alone make the email worth sending (plan #32)", () => {
    const lastWeek = ["Last week: 2 replies sent, 1 follow-up sent, 1 quote out."];
    const d = buildDigest(quiet, links, { ...at, lastWeek });
    expect(d.worthSending).toBe(true);
    expect(d.text).toContain(lastWeek[0]);
    expect(d.html).toContain(lastWeek[0]);
    expect(d.text.indexOf("No emails need a decision from you today.")).toBeLessThan(
      d.text.indexOf("Last week:"),
    );
  });
});

describe("activity wording", () => {
  it("is plain, uses only the customer's first name, and hides internal entries", () => {
    const who = { name: "Dana Ruiz", category: "quote_request" };
    expect(describeActivity("draft_created", {}, who)).toBe(
      "Drafted a reply to Dana · Quote request",
    );
    expect(describeActivity("reply_sent", { editedByOwner: true, kind: "reply" }, who)).toBe(
      "You sent a reply to Dana, after editing it",
    );
    expect(describeActivity("followup_drafted", { nudgeNumber: 2 }, who)).toBe(
      "Drafted a follow-up to Dana (the last one) · Quote request",
    );
    expect(describeActivity("workspace_status_changed", { to: "setup_paid" }, null)).toBe(
      "Setup paid — sending switched on",
    );
    expect(describeActivity("payment_received", { includesSetup: true }, null)).toMatch(
      /sending switched on/,
    );
    expect(describeActivity("subscription_changed", { to: "past_due" }, null)).toMatch(
      /didn't go through/,
    );
    expect(describeActivity("something_internal", {}, null)).toBeNull();
  });

  it("names deposit details, review requests and closing questions (plan #26 #28 #29)", () => {
    const who = { name: "Dana Ruiz", category: "quote_request" };
    expect(describeActivity("draft_created", { purpose: "deposit" }, who)).toBe(
      "Drafted deposit details for Dana · Quote request",
    );
    // An acceptance re-sorted as scheduling is still a quote (A5).
    expect(
      describeActivity("draft_created", { purpose: "deposit" }, { ...who, category: "scheduling" }),
    ).toBe("Drafted deposit details for Dana · Quote request");
    expect(draftTag({ category: "scheduling", kind: "reply", purpose: "deposit" })).toBe(
      "Deposit details · Quote request",
    );
    expect(draftTag({ category: "quote_request", kind: "followup", purpose: null })).toBe(
      "Follow-up · Quote request",
    );
    expect(draftTag({ category: "scheduling", kind: "reply", purpose: "review_request" })).toBe(
      "Review request",
    );
    expect(describeActivity("draft_created", { purpose: "review_request" }, who)).toBe(
      "Drafted a review request to Dana",
    );
    expect(describeActivity("closing_question", { purpose: "closing_question" }, who)).toBe(
      "Drafted a question to Dana asking if they went another way",
    );
    // No name on file: still plain.
    expect(describeActivity("draft_created", { purpose: "deposit" }, null)).toBe(
      "Drafted deposit details",
    );
    expect(describeActivity("closing_question", {}, null)).toBe(
      "Drafted a question asking if they went another way",
    );
  });

  it("says who marked a quote, and that our guesses can be changed (plan #30)", () => {
    const who = { name: "Dana Ruiz", category: "scheduling" };
    expect(describeActivity("quote_marked", { outcome: "won" }, who)).toBe(
      "You marked a quote from Dana as won",
    );
    expect(describeActivity("quote_marked", { outcome: "lost" }, who)).toBe(
      "You marked a quote from Dana as lost",
    );
    expect(describeActivity("quote_marked", { outcome: "no_answer" }, who)).toBe(
      "You marked a quote from Dana as no answer",
    );
    expect(describeActivity("quote_marked", { outcome: null }, who)).toBe(
      "You reopened a quote from Dana",
    );
    expect(describeActivity("quote_marked", { outcome: "won" }, null)).toBe(
      "You marked a quote as won",
    );
    expect(
      describeActivity("quote_outcome_guessed", { outcome: "won", why: "accepted" }, who),
    ).toBe("Marked a quote from Dana as won — they said go ahead. Change it on Quotes");
    expect(
      describeActivity("quote_outcome_guessed", { outcome: "no_answer", why: "two_nudges" }, who),
    ).toBe(
      "Marked a quote from Dana as no answer after two nudges and a quiet week. Change it on Quotes",
    );
    expect(
      describeActivity("quote_outcome_guessed", { outcome: "no_answer", why: "three_weeks" }, who),
    ).toBe("Marked a quote from Dana as no answer after three quiet weeks. Change it on Quotes");
    // We never guess lost; an odd row is hidden rather than worded wrong.
    expect(describeActivity("quote_outcome_guessed", { outcome: "lost" }, who)).toBeNull();
  });
});

describe("in the database", () => {
  let database: Database;
  let workspaceId: string;
  let mailboxId: string;
  let sent: OutgoingEmail[];
  const sender = async (e: OutgoingEmail) => {
    sent.push(e);
    return "sent" as const;
  };

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
    sent = [];
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: "g1",
        inInbox: true,
        subject: "SECRET-SUBJECT",
        category: "complaint",
        needsOwner: true,
        needsOwnerReason: "SECRET-REASON",
        summary: "SECRET-SUMMARY",
        classifiedAt: new Date(NOW.getTime() - 3600_000),
      })
      .returning();
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: "g1-m1",
      direction: "in",
      fromName: "SECRET-NAME Person",
      fromAddress: "secret@customer.com",
      bodyText: "SECRET-BODY",
      sentAt: new Date(NOW.getTime() - 7200_000),
    });
    await database.insert(activityLog).values({
      workspaceId,
      actor: "owner",
      action: "marked_needs_owner",
      threadId: t!.id,
    });
  });

  it("sends the owner one digest a day — counts only, retry-safe", async () => {
    expect(await sendDigests(NOW, { send: sender })).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("owner@shop.com");
    expect(sent[0]!.idempotencyKey).toBe(`digest-${workspaceId}-2026-10-06`);
    const [t] = await database.select().from(threads);
    expect(sent[0]!.text).toContain(
      `• A complaint — waiting 2 hours: ${appUrl("/queue")}#t-${t!.id}`,
    );
    expect(`${sent[0]!.subject}${sent[0]!.text}${sent[0]!.html}`).not.toMatch(/SECRET|secret@/);

    // Later the same morning: nothing more.
    expect(await sendDigests(new Date(NOW.getTime() + 3600_000), { send: sender })).toMatchObject({
      sent: 0,
    });
    expect(sent).toHaveLength(1);
  });

  it("waits for the owner's hour and respects off", async () => {
    await saveDigestSettings(
      workspaceId,
      digestSettingsInput.parse({ enabled: "on", hour: "9", timeZone: "America/New_York" }),
    );
    await sendDigests(NOW, { send: sender });
    expect(sent).toHaveLength(0);
    await saveDigestSettings(
      workspaceId,
      digestSettingsInput.parse({ hour: "7", timeZone: "America/New_York" }),
    );
    await sendDigests(NOW, { send: sender });
    expect(sent).toHaveLength(0);
  });

  it("an unknown time zone is refused (Check 15 P7: the saved one stays)", () => {
    expect(digestSettingsInput.safeParse({ hour: "7", timeZone: "Mars/Base" }).success).toBe(false);
    expect(digestSettingsInput.safeParse({ hour: "3", timeZone: "UTC" }).success).toBe(false);
  });

  it.each([
    ["evaluation_expired", null],
    ["canceled", null],
    ["paused", null],
    ["past_due", null],
    // Stored as evaluating, but the three days ended (A7): no cron has to move it first.
    ["evaluating", new Date("2026-10-05T00:00:00Z")],
  ] as const)(
    "GATE read-only (%s): no digest, no marker, no activity row",
    async (status, evaluationEndsAt) => {
      // The seeded complaint is waiting on the owner, so the digest would be worth sending.
      await database
        .update(workspaces)
        .set({ status, evaluationEndsAt })
        .where(eq(workspaces.id, workspaceId));
      const run = await sendDigests(NOW, { send: sender });
      expect(run).toMatchObject({ sent: 0, skipped: 0, failed: 0 });
      expect(sent).toHaveLength(0);
      const [p] = await database
        .select()
        .from(businessProfiles)
        .where(eq(businessProfiles.workspaceId, workspaceId));
      expect(p?.digestLastSentOn ?? null).toBeNull();
      const rows = await database
        .select()
        .from(activityLog)
        .where(eq(activityLog.workspaceId, workspaceId));
      expect(rows.filter((r) => r.action === "digest_sent")).toHaveLength(0);
    },
  );

  it("the same account still evaluating (end date ahead) does get it: the gate is the end date", async () => {
    await database
      .update(workspaces)
      .set({ status: "evaluating", evaluationEndsAt: new Date("2026-10-08T00:00:00Z") })
      .where(eq(workspaces.id, workspaceId));
    expect(await sendDigests(NOW, { send: sender })).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);
  });

  it("without email set up, nothing is sent and the day isn't marked done", async () => {
    const run = await sendDigests(NOW, { send: async () => "not_configured" });
    expect(run.notConfigured).toBe(true);
    const [p] = await database
      .select()
      .from(businessProfiles)
      .where(eq(businessProfiles.workspaceId, workspaceId));
    expect(p?.digestLastSentOn ?? null).toBeNull();
  });

  it("activity shows the owner's own log in plain words", async () => {
    const entries = await listActivity(workspaceId);
    expect(entries.map((e) => e.text)).toContain(
      "You marked a conversation with SECRET-NAME as needing you",
    );
    expect(entries.map((e) => e.text)).toContain("You connected Gmail");
  });

  it("time saved is counted only from replies actually sent", async () => {
    const [t] = await database.select().from(threads);
    const base = {
      threadId: t!.id,
      mailboxId,
      toAddress: "x@y.com",
      subject: "Re",
      body: "b",
      originalBody: "b",
      reason: "r",
      promptVersion: "draft.v1",
      createdAt: NOW,
    };
    await database.insert(drafts).values([
      { ...base, gmailDraftId: "a", status: "sent", decidedAt: NOW },
      { ...base, gmailDraftId: "b", status: "edited_and_sent", decidedAt: NOW },
      { ...base, gmailDraftId: "c", status: "sent", kind: "followup", decidedAt: NOW },
      { ...base, gmailDraftId: "d", status: "discarded", decidedAt: NOW },
    ]);
    expect(await monthSummary(workspaceId, NOW)).toEqual({
      sorted: 1,
      drafted: 4,
      sent: 3,
      sentAfterEditing: 1,
      nudgesSent: 1,
      minutesSaved: 9,
    });
  });

  it("sent replies count in the month they were sent, not the month they were drafted (A18)", async () => {
    const [t] = await database.select().from(threads);
    const base = {
      threadId: t!.id,
      mailboxId,
      toAddress: "x@y.com",
      subject: "Re",
      body: "b",
      originalBody: "b",
      reason: "r",
      promptVersion: "draft.v1",
    };
    const sept30 = new Date("2026-09-30T18:00:00Z");
    await database.insert(drafts).values([
      // Drafted Sep 30, sent Oct 1: October's reply (and October's time saved)…
      {
        ...base,
        gmailDraftId: "a",
        status: "sent",
        createdAt: sept30,
        decidedAt: new Date("2026-10-01T13:00:00Z"),
      },
      // …a follow-up drafted and sent in September is not…
      {
        ...base,
        gmailDraftId: "b",
        status: "sent",
        kind: "followup",
        createdAt: sept30,
        decidedAt: new Date("2026-09-30T19:00:00Z"),
      },
      // …and one drafted this month but not sent counts as drafted only.
      { ...base, gmailDraftId: "c", status: "discarded", createdAt: NOW, decidedAt: NOW },
    ]);
    expect(await monthSummary(workspaceId, NOW)).toEqual({
      sorted: 1,
      drafted: 1,
      sent: 1,
      sentAfterEditing: 0,
      nudgesSent: 0,
      minutesSaved: 3,
    });
  });

  it("close rate counts only quotes decided this month (owner's zone, Eastern by default), whoever decided them", async () => {
    const empty = await monthCloseRate(workspaceId, NOW);
    expect(empty).toEqual({ won: 0, lost: 0, noAnswer: 0, ratePct: null });

    // No profile yet: Eastern, so October began at 04:00 UTC on Oct 1.
    const start = localMonthStart(NOW, "America/New_York");
    expect(start.toISOString()).toBe("2026-10-01T04:00:00.000Z");
    const quote = async (gid: string, outcome: string, at: Date, source = "owner") =>
      database.insert(threads).values({
        mailboxId,
        gmailThreadId: gid,
        category: "quote_request",
        quoteOutcome: outcome,
        quoteOutcomeSource: source as "owner" | "auto",
        quoteOutcomeAt: at,
      });
    await quote("w1", "won", start);
    await quote("w2", "won", NOW, "auto");
    await quote("l1", "lost", NOW);
    await quote("n1", "no_answer", NOW, "auto");
    await quote("old", "won", new Date(start.getTime() - 1)); // last month
    // A reopened quote (no outcome) doesn't count.
    await database.insert(threads).values({
      mailboxId,
      gmailThreadId: "re",
      category: "quote_request",
      quoteOutcomeSource: "owner",
    });
    // Another workspace's quotes never count.
    const { workspace: other } = await ensureUserAndWorkspace({ email: "other@shop.com" });
    const otherBox = await saveConnectedMailbox(other, {
      email: "other@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    });
    await database.insert(threads).values({
      mailboxId: otherBox.id,
      gmailThreadId: "x1",
      category: "quote_request",
      quoteOutcome: "lost",
      quoteOutcomeSource: "owner",
      quoteOutcomeAt: NOW,
    });

    expect(await monthCloseRate(workspaceId, NOW)).toEqual({
      won: 2,
      lost: 1,
      noAnswer: 1,
      ratePct: 50,
    });
  });

  it("a Pacific owner at 6pm on Oct 31 is still in October: the evening's decisions count there", async () => {
    await database
      .insert(businessProfiles)
      .values({ workspaceId, timeZone: "America/Los_Angeles" })
      .onConflictDoUpdate({
        target: businessProfiles.workspaceId,
        set: { timeZone: "America/Los_Angeles" },
      });
    // 6pm PDT on Oct 31 is 01:00 UTC on Nov 1.
    const evening = new Date("2026-11-01T01:00:00Z");
    const quote = async (gid: string, outcome: string, at: Date) =>
      database.insert(threads).values({
        mailboxId,
        gmailThreadId: gid,
        category: "quote_request",
        quoteOutcome: outcome,
        quoteOutcomeSource: "owner",
        quoteOutcomeAt: at,
      });
    // Three marked Won that evening (00:30–00:55 UTC Nov 1)…
    for (const [i, m] of [30, 45, 55].entries())
      await quote(`w${i}`, "won", new Date(`2026-11-01T00:${m}:00Z`));
    // …one Lost on Oct 2 local (and 1 minute before October began locally: September).
    await quote("l1", "lost", new Date("2026-10-02T17:00:00Z"));
    await quote("sep", "lost", new Date("2026-10-01T06:59:00Z"));

    expect(await monthCloseRate(workspaceId, evening)).toEqual({
      won: 3,
      lost: 1,
      noAnswer: 0,
      ratePct: 75,
    });
    expect(localMonthStart(evening, "America/Los_Angeles").toISOString()).toBe(
      "2026-10-01T07:00:00.000Z",
    );
    expect(localMonthName(evening, "America/Los_Angeles")).toBe("October");
    // An hour after local midnight it's November there too, and the evening is last month.
    const nov = new Date("2026-11-01T08:00:00Z");
    expect(localMonthName(nov, "America/Los_Angeles")).toBe("November");
    expect(await monthCloseRate(workspaceId, nov)).toEqual({
      won: 0,
      lost: 0,
      noAnswer: 0,
      ratePct: null,
    });
    // The month's counts follow the same zone: a reply sent that evening is October's.
    const [t] = await database.select().from(threads).where(eq(threads.gmailThreadId, "w0"));
    await database.insert(drafts).values({
      threadId: t!.id,
      mailboxId,
      gmailDraftId: "pac",
      toAddress: "x@y.com",
      subject: "Re",
      body: "b",
      originalBody: "b",
      reason: "r",
      promptVersion: "draft.v1",
      status: "sent",
      createdAt: new Date("2026-11-01T00:40:00Z"),
      decidedAt: new Date("2026-11-01T00:41:00Z"),
    });
    expect((await monthSummary(workspaceId, evening)).sent).toBe(1);
    expect((await monthSummary(workspaceId, nov)).sent).toBe(0);
    // A broken zone falls back to Eastern rather than failing the screen.
    expect(localMonthStart(NOW, "Not/AZone").toISOString()).toBe("2026-10-01T04:00:00.000Z");
  });
});

describe("digest: needs-you header, queue agreement and Monday's last week (plan #31 #32)", () => {
  let database: Database;
  let workspaceId: string;
  let mailboxId: string;
  let sent: OutgoingEmail[];
  let n = 0;
  const sender = async (e: OutgoingEmail) => {
    sent.push(e);
    return "sent" as const;
  };
  const hoursAgo = (h: number, from = NOW) => new Date(from.getTime() - h * 3600_000);

  /** A thread with SECRET content everywhere a careless summary could pick it up. */
  async function thread(
    over: Partial<typeof threads.$inferInsert> = {},
    mail: { dir: "in" | "out"; at: Date; from?: string }[] = [{ dir: "in", at: hoursAgo(2) }],
  ) {
    n += 1;
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: `g-${n}`,
        inInbox: true,
        subject: `SECRET-SUBJECT-${n}`,
        summary: "SECRET-SUMMARY (model-written)",
        category: "customer_question",
        lastMessageAt: mail.at(-1)?.at ?? null,
        ...over,
      })
      .returning();
    for (const [i, m] of mail.entries())
      await database.insert(messages).values({
        threadId: t!.id,
        mailboxId,
        gmailMessageId: `g-${n}-m${i}`,
        direction: m.dir,
        fromName: m.dir === "in" ? "SECRET Customer" : "Owner",
        fromAddress: m.dir === "in" ? (m.from ?? "SECRET@example.com") : "owner@shop.com",
        bodyText: "SECRET-BODY",
        sentAt: m.at,
      });
    return t!;
  }
  const needsYou = (
    over: Partial<typeof threads.$inferInsert> = {},
    mail?: Parameters<typeof thread>[1],
  ) =>
    thread({ needsOwner: true, needsOwnerReason: "SECRET-REASON from the model", ...over }, mail);
  async function draft(threadId: string, over: Partial<typeof drafts.$inferInsert> = {}) {
    n += 1;
    const [d] = await database
      .insert(drafts)
      .values({
        threadId,
        mailboxId,
        gmailDraftId: `d-${n}`,
        toAddress: "SECRET@example.com",
        subject: "Re: SECRET",
        body: "SECRET-DRAFT-BODY",
        originalBody: "SECRET-DRAFT-BODY",
        reason: "SECRET-DRAFT-REASON",
        promptVersion: "draft.v5",
        createdAt: hoursAgo(1),
        ...over,
      })
      .returning();
    return d!;
  }
  const runDigest = async (now = NOW) => {
    sent = [];
    const run = await sendDigests(now, { send: sender });
    return { run, email: sent[0] };
  };

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
    // Out of the three days, so the fixed test clock never meets the real evaluation end.
    await database
      .update(workspaces)
      .set({ status: "active" })
      .where(eq(workspaces.id, workspaceId));
    sent = [];
  });

  it("GUARDRAIL: the needs-you header is content-free and links only to the queue by thread id (A4)", async () => {
    const complaint = await needsYou({ category: "complaint", priority: "high" });
    const invoice = await needsYou({ category: "invoice_payment" }, [
      { dir: "in", at: hoursAgo(30), from: "SECRET.Billing@example.com" },
    ]);
    const quote = await thread({ category: "quote_request" });
    await draft(quote.id);
    // Replies package: the month's money is in it too — totals only, from threads that are
    // full of SECRET names, subjects and invoice numbers.
    await thread({
      category: "quote_request",
      quoteOutcome: "won",
      quoteOutcomeSource: "owner",
      quoteOutcomeAt: hoursAgo(48),
      quoteAmountCents: 420_000,
    });
    await thread({
      category: "invoice_payment",
      invoicePaidAt: hoursAgo(24),
      invoicePaidSource: "owner",
      extracted: {
        invoice: { invoice_number: "SECRET-INV-9", amount: 1200, due_date: null, status: "paid" },
      },
    });
    await thread({
      category: "invoice_payment",
      extracted: {
        invoice: { invoice_number: "SECRET-INV-10", amount: 500, due_date: null, status: "unpaid" },
      },
    });

    const { email } = await runDigest();
    expect(email).toBeDefined();
    const all = `${email!.subject}\n${email!.text}\n${email!.html}`;
    expect(all).not.toMatch(/SECRET/i);
    expect(all).not.toContain("@example.com");
    expect(email!.text).toContain(
      "This month so far: $4,200 in quotes you won · $1,200 in invoices paid.",
    );
    expect(email!.text).toContain("Still owed to you: $500 on Money owed.");
    expect(email!.text).toContain(
      `• A complaint — waiting 2 hours: ${appUrl("/queue")}#t-${complaint.id}`,
    );
    expect(email!.text).toContain(
      `• An invoice or payment email — waiting since yesterday: ${appUrl("/queue")}#t-${invoice.id}`,
    );

    // Every link, in both versions, is on the allow-list — nothing else, ever.
    const allowed = new Set([
      appUrl("/queue"),
      appUrl("/quotes"),
      appUrl("/settings/morning-email"),
      ...[complaint, invoice, quote].map((t) => `${appUrl("/queue")}#t-${t.id}`),
    ]);
    const hrefs = [...email!.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
    const textUrls = email!.text.match(/https?:\/\/\S+/g) ?? [];
    expect(hrefs.length).toBeGreaterThanOrEqual(4);
    expect(textUrls.length).toBeGreaterThanOrEqual(3);
    for (const u of [...hrefs, ...textUrls]) {
      expect(allowed.has(u), u).toBe(true);
      expect(u).not.toMatch(/[@?]/);
    }
  });

  it("leaves out snoozed items exactly like the queue, and brings them back when the snooze ends", async () => {
    const snoozed = await needsYou({ snoozedUntil: hoursAgo(-3) });
    const snoozedDrafted = await thread({ snoozedUntil: hoursAgo(-3) });
    await draft(snoozedDrafted.id);
    const back = await needsYou({ snoozedUntil: hoursAgo(1) });
    const backDrafted = await thread({ snoozedUntil: hoursAgo(1) });
    await draft(backDrafted.id, { kind: "followup" });

    const c = await digestCounts(workspaceId, NOW);
    expect(c.needsYou.map((i) => i.threadId)).toEqual([back.id]);
    expect(c.needsYou.map((i) => i.threadId)).not.toContain(snoozed.id);
    expect(c.repliesReady).toBe(0);
    expect(c.nudgesReady).toBe(1);

    // Once the snooze has passed, it's counted again.
    const later = hoursAgo(-4);
    const after = await digestCounts(workspaceId, later);
    expect(after.needsYou.map((i) => i.threadId).sort()).toEqual([back.id, snoozed.id].sort());
    expect(after.repliesReady).toBe(1);
  });

  it("a reply in its undo window isn't 'waiting for your okay' (it's already okayed)", async () => {
    const t = await thread();
    await draft(t.id, { sendAfter: hoursAgo(-0.01) });
    expect((await digestCounts(workspaceId, NOW)).repliesReady).toBe(0);
    expect((await listQueue(workspaceId, NOW)).drafts).toHaveLength(0);
  });

  it("the summary, the queue screen and the queue counts agree on the same mail", async () => {
    await needsYou({ category: "complaint" });
    await needsYou({ category: "quote_request", priority: "high" });
    await needsYou({ snoozedUntil: hoursAgo(-2) }); // snoozed: nowhere
    await needsYou({ inInbox: false }); // archived: nowhere
    const drafted = await needsYou(); // has a draft: under drafts, not needs-you
    await draft(drafted.id);
    await draft((await thread()).id);
    await draft((await thread()).id, { kind: "followup" });
    await draft((await thread()).id, { sendAfter: hoursAgo(-0.01) }); // undo window: nowhere
    await draft((await thread()).id, { status: "discarded" }); // decided: nowhere

    const c = await digestCounts(workspaceId, NOW);
    const q = await listQueue(workspaceId, NOW);
    const counts = await queueCounts(workspaceId, NOW);
    expect(c.needsYou.map((i) => i.threadId)).toEqual(q.needsYou.map((i) => i.threadId));
    expect(c.needsYou).toHaveLength(2);
    expect(counts.needsYou).toBe(2);
    expect(c.repliesReady).toBe(q.drafts.filter((d) => d.kind === "reply").length);
    expect(c.nudgesReady).toBe(q.drafts.filter((d) => d.kind === "followup").length);
    expect([c.repliesReady, c.nudgesReady]).toEqual([2, 1]);
    expect([counts.replies, counts.nudges, counts.drafts]).toEqual([2, 1, 3]);
    // The emergency is "high" in the summary, as it's an emergency on the queue.
    expect(c.needsYou.find((i) => i.category === "quote_request")?.priority).toBe("high");
  });

  it("no 50-row cap on the totals: 55 waiting are 55 (A19)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 55; i++)
      ids.push((await needsYou({}, [{ dir: "in", at: hoursAgo(1 + i / 10) }])).id);
    expect((await queueCounts(workspaceId, NOW)).needsYou).toBe(55);
    expect((await digestCounts(workspaceId, NOW)).needsYou).toHaveLength(55);
    const { email } = await runDigest();
    expect(email!.subject).toBe("55 things waiting on you");
    expect(email!.text).toContain("+ 52 more in your queue");
    const bullets = email!.text.split("\n").filter((l) => l.startsWith("• "));
    expect(bullets).toHaveLength(3);

    // The summary links the three that have waited longest — the oldest, past the screen's
    // newest 50 — and the screen still renders each of them, so every link lands on its card.
    const linked = bullets.map((l) => l.match(/#t-([0-9a-f-]{36})$/)![1]!);
    expect(linked.sort()).toEqual(ids.slice(52).sort());
    const shown = (await listQueue(workspaceId, NOW)).needsYou.map((i) => i.threadId);
    expect(shown).toHaveLength(53); // the newest 50, plus the three linked
    expect(shown.slice(0, 50)).toEqual(ids.slice(0, 50));
    for (const id of linked) expect(shown).toContain(id);
  });

  it("a high-priority email past the newest 50 is linked, and still on the screen", async () => {
    for (let i = 0; i < 52; i++) await needsYou({}, [{ dir: "in", at: hoursAgo(1 + i / 10) }]);
    const urgent = await needsYou({ priority: "high" }, [{ dir: "in", at: hoursAgo(20) }]);
    const { email } = await runDigest();
    expect(email!.text.split("\n").find((l) => l.startsWith("• "))).toContain(`#t-${urgent.id}`);
    const shown = (await listQueue(workspaceId, NOW)).needsYou.map((i) => i.threadId);
    expect(shown).toContain(urgent.id);
  });

  it("waiting since = the customer's first email after the owner last wrote; owner wrote last → no time (A14)", async () => {
    const twice = await needsYou({}, [
      { dir: "in", at: new Date("2026-10-01T14:00:00Z") },
      { dir: "out", at: new Date("2026-10-02T14:00:00Z") },
      { dir: "in", at: new Date("2026-10-03T14:00:00Z") }, // waiting since here
      { dir: "in", at: new Date("2026-10-06T10:30:00Z") }, // not "waiting 1 hour"
    ]);
    const ownerLast = await needsYou({ category: "complaint" }, [
      { dir: "in", at: hoursAgo(5) },
      { dir: "out", at: hoursAgo(1) },
    ]);
    const c = await digestCounts(workspaceId, NOW);
    const since = new Map(c.needsYou.map((i) => [i.threadId, i.waitingSince]));
    expect(since.get(twice.id)?.toISOString()).toBe("2026-10-03T14:00:00.000Z");
    expect(since.get(ownerLast.id)).toBeNull();

    const { email } = await runDigest();
    const bullets = email!.text.split("\n").filter((l) => l.startsWith("• "));
    expect(bullets).toEqual([
      `• A customer question — waiting 3 days: ${appUrl("/queue")}#t-${twice.id}`,
      `• A complaint: ${appUrl("/queue")}#t-${ownerLast.id}`,
    ]);
  });

  it("the thread-time subqueries name the outer thread even in a one-table select", () => {
    const { sql: text } = database
      .select({ id: threads.id, a: lastInSql(), b: lastOutSql(), c: waitingSinceSql() })
      .from(threads)
      .toSQL();
    // A bare "id" inside `from messages m` would be the message's own id.
    expect(text).not.toMatch(/thread_id = "id"/);
    // Every thread match is on the outer thread, except the side-conversation check's, which
    // match a message's own thread (`sx_….thread_id = <alias>.thread_id`).
    const all = text.match(/thread_id = /g) ?? [];
    const own = text.match(/\.thread_id = [a-z_]+\.thread_id/g) ?? [];
    expect(all.length - own.length).toBeGreaterThanOrEqual(4);
    expect(text.match(/thread_id = "threads"\."id"/g)).toHaveLength(all.length - own.length);
  });

  it("a quiet day says 'No emails need a decision from you today.' only to itself: skipped, and the day is marked", async () => {
    const run = await sendDigests(NOW, { send: sender });
    expect(run).toMatchObject({ sent: 0, skipped: 1 });
    expect(sent).toHaveLength(0);
    const [p] = await database
      .select()
      .from(businessProfiles)
      .where(eq(businessProfiles.workspaceId, workspaceId));
    expect(p?.digestLastSentOn).toBe("2026-10-06");
  });

  describe("Monday: last week (plan #32)", () => {
    const MONDAY = new Date("2026-10-12T11:30:00Z"); // 7:30am Monday in New York
    async function lastWeekWork() {
      const t = await thread({ category: "scheduling" }, [
        { dir: "in", at: new Date("2026-10-07T13:00:00Z") },
      ]);
      await draft(t.id, { status: "sent", decidedAt: new Date("2026-10-07T15:00:00Z") });
      await draft(t.id, {
        status: "sent",
        kind: "followup",
        decidedAt: new Date("2026-10-09T15:00:00Z"),
      });
      // Something waiting, so every morning here is worth an email anyway.
      await needsYou({ category: "complaint" }, [{ dir: "in", at: hoursAgo(2, MONDAY) }]);
    }
    // Check 44 P5: the zone is saved apart from the morning email settings, as the owner's pick.
    const setTz = async (timeZone: string, hour: string) => {
      await saveDigestSettings(
        workspaceId,
        digestSettingsInput.parse({ enabled: "on", hour, timeZone }),
      );
      await setOwnerTimeZone(workspaceId, timeZone);
    };

    it("the owner's Monday gets last week's counts below the rest — counts only", async () => {
      await lastWeekWork();
      const { email } = await runDigest(MONDAY);
      expect(email!.text).toContain("Last week: 1 reply sent, 1 follow-up sent, 0 quotes out.");
      // No quote requests came in last week: said as that, never "none answered".
      expect(email!.text).toContain("No quote requests came in last week.");
      expect(email!.text).not.toContain("answered last week");
      expect(email!.text).toContain("Time saved: about 6 minutes");
      expect(email!.html).toContain("Last week: 1 reply sent, 1 follow-up sent, 0 quotes out.");
      expect(email!.text.indexOf("Needs you:")).toBeLessThan(email!.text.indexOf("Last week:"));
      // GUARDRAIL: names, subjects, addresses and text never come along.
      expect(`${email!.subject}${email!.text}${email!.html}`).not.toMatch(/SECRET|@example\.com/i);
    });

    it("Tuesday doesn't", async () => {
      await lastWeekWork();
      const { email } = await runDigest(new Date("2026-10-13T11:30:00Z"));
      expect(email!.text).not.toContain("Last week");
    });

    it("by the owner's own Monday: Los Angeles at 5am, and Tokyo while UTC is still Sunday (A20)", async () => {
      await lastWeekWork();
      await setTz("America/Los_Angeles", "5");
      // 12:00 UTC Monday = 5am PDT Monday.
      const la = await runDigest(new Date("2026-10-12T12:00:00Z"));
      expect(la.email!.text).toContain("Last week: 1 reply sent");

      await database.update(businessProfiles).set({ digestLastSentOn: null });
      await setTz("Asia/Tokyo", "7");
      // 23:30 UTC Sunday = 8:30am Monday in Tokyo (and Sunday evening in New York).
      const tokyo = await runDigest(new Date("2026-10-11T23:30:00Z"));
      expect(tokyo.email!.text).toContain("Last week: 1 reply sent");
    });

    it("an empty last week adds no section", async () => {
      await needsYou({ category: "complaint" }, [{ dir: "in", at: hoursAgo(2, MONDAY) }]);
      const { email } = await runDigest(MONDAY);
      expect(email).toBeDefined();
      expect(email!.text).not.toContain("Last week");
      expect(email!.html).not.toContain("Last week");
    });
  });
});
