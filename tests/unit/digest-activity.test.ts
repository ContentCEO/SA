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
import { buildDigest, digestDue, localParts, sendDigests } from "@/server/digest";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { digestSettingsInput, saveDigestSettings } from "@/server/profile";
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
  const counts = {
    repliesReady: 3,
    nudgesReady: 1,
    needsYou: [{ category: "complaint" }, { category: "customer_question" }],
    sentYesterday: 2,
    sortedYesterday: 14,
  };

  it("says what's waiting in counts and categories", () => {
    const d = buildDigest(counts, "https://app/queue", "https://app/settings");
    expect(d.subject).toBe("6 things waiting on you");
    expect(d.text).toContain("2 emails need you: a complaint, a question.");
    expect(d.text).toContain("3 replies drafted and waiting for your okay.");
    expect(d.text).toContain("1 follow-up ready");
    expect(d.text).toContain("Yesterday: 14 emails sorted, 2 replies sent.");
    expect(d.html).toContain('href="https://app/queue"');
    expect(d.text).toContain("Nothing is sent without your okay.");
    expect(d.worthSending).toBe(true);
  });

  it("a quiet day isn't worth an email", () => {
    const d = buildDigest(
      { repliesReady: 0, nudgesReady: 0, needsYou: [], sentYesterday: 0, sortedYesterday: 0 },
      "q",
      "s",
    );
    expect(d.worthSending).toBe(false);
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
    expect(sent[0]!.text).toContain("1 email needs you: a complaint.");
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

  it("an unknown time zone falls back to Eastern instead of failing", () => {
    expect(digestSettingsInput.parse({ hour: "7", timeZone: "Mars/Base" }).timeZone).toBe(
      "America/New_York",
    );
    expect(digestSettingsInput.safeParse({ hour: "3", timeZone: "UTC" }).success).toBe(false);
  });

  it("read-only accounts get no digest", async () => {
    await database
      .update(workspaces)
      .set({ status: "evaluation_expired" })
      .where(eq(workspaces.id, workspaceId));
    await sendDigests(NOW, { send: sender });
    expect(sent).toHaveLength(0);
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
