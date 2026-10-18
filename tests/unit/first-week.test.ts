import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDollars, pricing } from "@/config/pricing";
import type { Database } from "@/db";
import {
  activityLog,
  appSettings,
  businessProfiles,
  drafts,
  invites,
  mailboxes,
  messages,
  threads,
  voiceProfiles,
  workspaces,
} from "@/db/schema";
import type { OutgoingEmail, SendOutcome } from "@/lib/email";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { inviteOwner, markTestUserAdded } from "@/server/admin";
import { notifyPaymentReceived } from "@/server/billing";
import { firstChargeLine } from "@/server/billing-rules";
import { queueMembership, threadsToAutoDraft } from "@/server/drafts";
import {
  claimFoundMoneyDrafts,
  firstLookFor,
  markAnsweredByPhone,
  sendFirstDraftsReady,
  trialCounts,
} from "@/server/first-week";
import {
  answeredByPhone,
  firstLookLines,
  foundMoneyLine,
  inviteEmailCopy,
  isLastDay,
  paymentNoticeCopy,
  showFirstLook,
  trialSoFarLine,
  waitingLine,
  wroteLine,
} from "@/server/first-week-rules";
import { threadsToFollowUp } from "@/server/followups";
import { sendInviteEmail } from "@/server/invite-email";
import { ReadOnlyError, sendingBlockedReason, sendingOffLabel } from "@/server/lifecycle";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { buildChecklist, checklistFor } from "@/server/onboarding";
import { businessProfileInput, saveBusinessProfile } from "@/server/profile";
import { leaveOptionsLine } from "@/server/terms-rules";
import { createTestDb } from "../support/db";
import { FakeWriter } from "../support/fake-writer";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date("2026-10-16T15:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("first-week rules (pure)", () => {
  it("I called them: counts until the customer writes again", () => {
    expect(answeredByPhone(null, ago(DAY))).toBe(false);
    expect(answeredByPhone(ago(HOUR), ago(DAY))).toBe(true);
    expect(answeredByPhone(ago(DAY), ago(HOUR))).toBe(false);
    expect(answeredByPhone(ago(HOUR), null)).toBe(true);
  });

  it("every card says how old the email is", () => {
    expect(wroteLine(ago(9 * DAY), NOW)).toBe("Wrote 9 days ago");
    expect(wroteLine(ago(2 * HOUR), NOW)).toBe("Wrote 2 hours ago");
    expect(wroteLine(null, NOW)).toBeNull();
  });

  it("the last-30-days card: a week after the first read, not once hidden or read-only", () => {
    const base = { firstReadAt: ago(DAY), hiddenAt: null, readOnly: false, now: NOW };
    expect(showFirstLook(base)).toBe(true);
    expect(showFirstLook({ ...base, firstReadAt: ago(8 * DAY) })).toBe(false);
    expect(showFirstLook({ ...base, firstReadAt: null })).toBe(false);
    expect(showFirstLook({ ...base, hiddenAt: ago(HOUR) })).toBe(false);
    expect(showFirstLook({ ...base, readOnly: true })).toBe(false);
    expect(showFirstLook({ ...base, accountCreatedAt: ago(2 * DAY) })).toBe(true);
    // An old account whose Gmail was read again after a reconnect: not a first week.
    expect(showFirstLook({ ...base, accountCreatedAt: ago(60 * DAY) })).toBe(false);
  });

  it("the last-30-days lines are honest about the two windows, counts only", () => {
    const c = {
      read: 312,
      sorted: 140,
      quoteRequests: 9,
      unansweredQuotes: 2,
      invoices: 4,
      complaints: 1,
      junk: 80,
      quietQuotes: 1,
    };
    expect(firstLookLines(c, 14)).toEqual([
      "We read 312 emails from the last 30 days.",
      "From the last two weeks, we sorted 140 conversations: 9 quote requests (2 with no answer or draft yet), 4 invoice or payment emails, 1 complaint, 80 junk.",
    ]);
    expect(firstLookLines({ ...c, sorted: 0 }, 14)[1]).toBe(
      "Nothing from the last two weeks needed sorting.",
    );
    expect(foundMoneyLine(c)).toBe(
      "2 quote requests still have no answer, and 1 quote you sent never got a follow-up. Want drafts? You check each one before anything goes out.",
    );
    expect(foundMoneyLine({ unansweredQuotes: 0, quietQuotes: 0 })).toBeNull();
  });

  it("the last day: inside 24 hours, with what the three days did", () => {
    expect(isLastDay(5 * HOUR)).toBe(true);
    expect(isLastDay(25 * HOUR)).toBe(false);
    expect(isLastDay(0)).toBe(false);
    expect(trialSoFarLine({ sorted: 14, drafted: 6 })).toBe(
      "So far it has sorted 14 emails and written 6 drafts for you.",
    );
    expect(trialSoFarLine({ sorted: 0, drafted: 0 })).toBeNull();
    expect(waitingLine({ drafts: 6, needsYou: 1 })).toBe(
      "Waiting for you: 6 replies drafted and 1 email that needs you.",
    );
    expect(waitingLine({ drafts: 0, needsYou: 0 })).toBeNull();
  });

  it("expired wording says what turns sending on (a plan), not 'until then' or 'after setup'", () => {
    const expired = {
      status: "evaluating" as const,
      evaluationEndsAt: ago(HOUR),
      setupPaidVia: null,
    };
    expect(sendingBlockedReason(expired, NOW)).toBe(
      "Your three days are up. Choose a plan to switch sending on.",
    );
    expect(sendingOffLabel(expired, NOW)).toBe("Sending turns on once you choose a plan");
  });

  it("the first charge comes from the config: plan + setup when due, plus tax", () => {
    const setup = pricing.setupFee.amountCents;
    const solo = pricing.plans.solo.amountCents;
    expect(firstChargeLine("solo", true)).toBe(
      `Your first payment is ${formatDollars(setup + solo)}: ${formatDollars(setup)} for setup and ${formatDollars(solo)} for the first month, plus sales tax where it applies. Then ${formatDollars(solo)} a month.`,
    );
    expect(firstChargeLine("crew", false)).toBe(
      `Your first payment is ${formatDollars(pricing.plans.crew.amountCents)} for the first month, plus sales tax where it applies. Then ${formatDollars(pricing.plans.crew.amountCents)} a month.`,
    );
  });

  it("the terms screen only offers the ways out this person has", () => {
    expect(leaveOptionsLine({ canManageBilling: true, hasGmail: true })).toBe(
      "You can still leave. Cancel your plan, disconnect Gmail or delete your account right here, or just sign out.",
    );
    expect(leaveOptionsLine({ canManageBilling: false, hasGmail: true })).toBe(
      "You can still leave. Disconnect Gmail or delete your account right here, or just sign out.",
    );
    expect(leaveOptionsLine({ canManageBilling: false, hasGmail: false })).toBe(
      "You can still leave. Delete your account right here, or just sign out.",
    );
  });

  it("emails: the invite has the sign-in link and what to have ready; Davi's notice is content-free", () => {
    const invite = inviteEmailCopy({
      signInUrl: "https://app.example/signin",
      operatorFirstName: "Davi",
      phone: "978-201-9763",
    });
    expect(invite.button.url).toBe("https://app.example/signin");
    expect(invite.lines.join(" ")).toContain("about 10 minutes");
    expect(invite.lines.join(" ")).toContain("won't send anything to a customer");
    const notice = paymentNoticeCopy({
      planName: "Solo",
      includesSetup: true,
      adminUrl: "https://app.example/admin",
    });
    expect(notice.lines[0]).toBe(
      "An owner just paid for the Solo plan, with the setup fee. Sending is on for them now.",
    );
    for (const text of [JSON.stringify(invite), JSON.stringify(notice)]) {
      expect(text).not.toMatch(/builder|\bhe\b|\bhis\b|\bhim\b/i);
    }
  });

  it("the checklist: an expired trial gets 'Choose a plan' instead of a step it can't do", () => {
    const f = { mailboxes: 1, profileCompleted: true, draftsChecked: 1, dismissed: false };
    expect(buildChecklist(f).steps[2]).toMatchObject({ key: "drafts", detail: "1 of 3" });
    expect(buildChecklist({ ...f, readOnly: true }).steps[2]).toMatchObject({
      key: "plan",
      label: "Choose a plan to keep going",
      href: "/billing",
      done: false,
    });
    // Already done before it expired: the done step stays.
    expect(buildChecklist({ ...f, draftsChecked: 3, readOnly: true }).allDone).toBe(true);
  });

  it("*-rules files stay pure", () => {
    const src = readFileSync("src/server/first-week-rules.ts", "utf8");
    expect(src).not.toMatch(/import\s+["']server-only["']/);
    expect(src).not.toMatch(/from\s+["']@\/db/);
  });
});

describe("first week, with the database", () => {
  let database: Database;
  let workspaceId: string;
  let userId: string;
  let mailboxId: string;
  let writer: FakeWriter;
  let g = 0;

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    database = await createTestDb();
    const { user, workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    workspaceId = workspace.id;
    userId = user.id;
    mailboxId = (
      await saveConnectedMailbox(workspace, {
        email: "owner@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
    writer = new FakeWriter();
  });
  afterEach(() => vi.unstubAllEnvs());

  async function thread(o: {
    category?: string;
    needsOwner?: boolean;
    inAt?: Date;
    outAt?: Date;
    classifiedAt?: Date;
    /** Check 21 P5: a newer email from the same address elsewhere would answer a quiet quote. */
    from?: string;
  }) {
    const id = `g${++g}`;
    const inAt = o.inAt ?? ago(2 * HOUR);
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: id,
        inInbox: true,
        category: o.category ?? "quote_request",
        needsOwner: o.needsOwner ?? false,
        classifiedAt: o.classifiedAt ?? new Date(inAt.getTime() + 60_000),
        lastMessageAt: o.outAt && o.outAt > inAt ? o.outAt : inAt,
      })
      .returning();
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-in`,
      direction: "in",
      fromAddress: o.from ?? "dana@customer.com",
      bodyText: "Can you quote a water heater swap?",
      sentAt: inAt,
    });
    if (o.outAt) {
      await database.insert(messages).values({
        threadId: t!.id,
        mailboxId,
        gmailMessageId: `${id}-out`,
        direction: "out",
        fromAddress: "owner@shop.com",
        toAddresses: ["dana@customer.com"],
        bodyText: "It's $1,450 installed.",
        sentAt: o.outAt,
      });
    }
    return t!.id;
  }

  async function pendingDraft(threadId: string) {
    const { draftId } = await writer.createDraft({ threadId: "gt", raw: "" });
    const [d] = await database
      .insert(drafts)
      .values({
        threadId,
        mailboxId,
        gmailDraftId: draftId,
        toAddress: "dana@customer.com",
        subject: "Re",
        body: "Thanks for reaching out!",
        originalBody: "Thanks for reaching out!",
        reason: "r",
        promptVersion: "draft.v6",
      })
      .returning();
    return d!;
  }

  it("I called them: the draft goes (from Gmail too), no auto draft, no nudge, off Needs you", async () => {
    const drafted = await thread({});
    const draft = await pendingDraft(drafted);
    const needs = await thread({ needsOwner: true });
    const quiet = await thread({
      inAt: ago(6 * DAY),
      outAt: ago(5 * DAY),
      from: "lee@customer.com",
    });

    // Before: a nudge is due, the needs-you card shows.
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([quiet]);
    expect((await queueMembership(workspaceId, NOW)).needsYou.map((m) => m.threadId)).toEqual([
      needs,
    ]);

    const opts = { writerFor: () => writer, now: () => NOW };
    expect(await markAnsweredByPhone(workspaceId, drafted, opts)).toBe("marked");
    expect(await markAnsweredByPhone(workspaceId, needs, opts)).toBe("marked");
    expect(await markAnsweredByPhone(workspaceId, quiet, opts)).toBe("marked");

    const [d] = await database.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(d!.status).toBe("expired");
    expect(writer.calls).toContain("deleteDraft");
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
    expect(await threadsToAutoDraft(mailboxId)).not.toContain(drafted);
    expect((await queueMembership(workspaceId, NOW)).needsYou).toEqual([]);
    const logs = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "answered_by_phone"));
    expect(logs).toHaveLength(3);
    // Content-free: ids and a yes/no only.
    expect(Object.keys(logs[0]!.detail as object)).toEqual(["draftRemoved"]);

    // The customer writes again: it's back.
    await database.insert(messages).values({
      threadId: needs,
      mailboxId,
      gmailMessageId: "again",
      direction: "in",
      fromAddress: "dana@customer.com",
      sentAt: new Date(NOW.getTime() + HOUR),
    });
    expect(
      (await queueMembership(workspaceId, new Date(NOW.getTime() + 2 * HOUR))).needsYou.map(
        (m) => m.threadId,
      ),
    ).toEqual([needs]);
  });

  it("I called them: someone else's thread is not found; a read-only account is refused", async () => {
    const t = await thread({});
    expect(await markAnsweredByPhone(crypto.randomUUID(), t)).toBe("not_found");
    await database
      .update(workspaces)
      .set({ status: "evaluation_expired" })
      .where(eq(workspaces.id, workspaceId));
    await expect(markAnsweredByPhone(workspaceId, t)).rejects.toBeInstanceOf(ReadOnlyError);
  });

  it("practice copies tick 'Check your first 3 drafts' (each draft once)", async () => {
    const t = await thread({});
    const d = await pendingDraft(t);
    for (let i = 0; i < 2; i++) {
      await database.insert(activityLog).values({
        workspaceId,
        actor: "owner",
        action: "practice_sent",
        threadId: t,
        detail: { draftId: d.id },
      });
    }
    const list = await checklistFor(workspaceId);
    expect(list.steps[2]!.detail).toBe("1 of 3");
    expect((await checklistFor(workspaceId, { readOnly: true })).steps[2]!.key).toBe("plan");
  });

  it("the last 30 days and found money: counts, then drafts offered once", async () => {
    await database
      .update(mailboxes)
      .set({ backfillCompletedAt: ago(2 * HOUR) })
      .where(eq(mailboxes.id, mailboxId));
    const [w] = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    const unanswered = await thread({ inAt: ago(3 * DAY) });
    const quiet = await thread({ inAt: ago(9 * DAY), outAt: ago(8 * DAY) });
    await thread({ category: "noise", inAt: ago(DAY) });
    const drafted = await thread({ inAt: ago(DAY) });
    await pendingDraft(drafted);

    const look = await firstLookFor(w!, NOW);
    expect(look.show).toBe(true);
    expect(look.counts).toMatchObject({
      quoteRequests: 3,
      unansweredQuotes: 1,
      quietQuotes: 1,
      junk: 1,
      sorted: 4,
    });
    expect(look.offerDrafts).toBe(true);

    const found = await claimFoundMoneyDrafts(w!, NOW);
    expect(found).toEqual({ replies: [unanswered], nudges: [quiet] });
    // Offered once.
    expect(await claimFoundMoneyDrafts(w!, NOW)).toBeNull();
    expect((await firstLookFor(w!, NOW)).offerDrafts).toBe(false);

    await database
      .update(businessProfiles)
      .set({ firstLookHiddenAt: NOW })
      .where(eq(businessProfiles.workspaceId, workspaceId));
    await database
      .insert(businessProfiles)
      .values({ workspaceId, firstLookHiddenAt: NOW })
      .onConflictDoNothing();
    expect((await firstLookFor(w!, NOW)).show).toBe(false);
  });

  it("'your first drafts are ready': once, only after reading + voice, only with a draft waiting", async () => {
    const sent: OutgoingEmail[] = [];
    const send = async (e: OutgoingEmail): Promise<SendOutcome> => {
      sent.push(e);
      return "sent";
    };
    await database
      .update(mailboxes)
      .set({ backfillCompletedAt: ago(HOUR) })
      .where(eq(mailboxes.id, mailboxId));
    // Voice still learning: nothing yet.
    await database.insert(voiceProfiles).values({ workspaceId, status: "learning" });
    await pendingDraft(await thread({}));
    expect((await sendFirstDraftsReady(NOW, { send })).sent).toBe(0);

    await database
      .update(voiceProfiles)
      .set({ status: "ready" })
      .where(eq(voiceProfiles.workspaceId, workspaceId));
    // Email not set up: nothing marked, so it can go later.
    const off = async (): Promise<SendOutcome> => "not_configured";
    expect((await sendFirstDraftsReady(NOW, { send: off })).sent).toBe(0);

    expect((await sendFirstDraftsReady(NOW, { send })).sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("owner@shop.com");
    expect(sent[0]!.idempotencyKey).toBe(`first-drafts-${workspaceId}`);
    expect(sent[0]!.text).not.toContain("dana");
    expect(sent[0]!.text).not.toContain("Thanks for reaching out");
    // Once ever.
    expect((await sendFirstDraftsReady(NOW, { send })).sent).toBe(0);
  });

  it("'your first drafts are ready' never goes to accounts read long ago", async () => {
    const send = vi.fn(async (): Promise<SendOutcome> => "sent");
    await database
      .update(mailboxes)
      .set({ backfillCompletedAt: ago(10 * DAY) })
      .where(eq(mailboxes.id, mailboxId));
    await database.insert(voiceProfiles).values({ workspaceId, status: "ready" });
    await pendingDraft(await thread({}));
    expect((await sendFirstDraftsReady(NOW, { send })).sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("trial counts: sorted and drafted since the clock started", async () => {
    await database
      .update(workspaces)
      .set({ status: "evaluating", evaluationStartedAt: ago(2 * DAY) })
      .where(eq(workspaces.id, workspaceId));
    const t = await thread({ inAt: ago(DAY) });
    await thread({ inAt: ago(5 * DAY), classifiedAt: ago(5 * DAY) });
    await pendingDraft(t);
    const [w] = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(await trialCounts(w!)).toEqual({ sorted: 1, drafted: 1 });
  });

  it("the invite email: once per invite, not after sign-in, and never fails the invite", async () => {
    const sent: OutgoingEmail[] = [];
    const send = async (e: OutgoingEmail): Promise<SendOutcome> => {
      sent.push(e);
      return "sent";
    };
    await inviteOwner({ email: "Mike@RuizPlumbing.com" });
    expect(await sendInviteEmail("mike@ruizplumbing.com", { send })).toBe("sent");
    expect(await sendInviteEmail("mike@ruizplumbing.com", { send })).toBe("already_sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("mike@ruizplumbing.com");
    expect(sent[0]!.text).toContain("/signin");
    expect(sent[0]!.idempotencyKey).not.toContain("mike");

    const boom = async (): Promise<SendOutcome> => {
      throw new Error("Resend 500.");
    };
    await inviteOwner({ email: "ann@shop.com" });
    expect(await sendInviteEmail("ann@shop.com", { send: boom })).toBe("failed");
    await database
      .update(invites)
      .set({ acceptedAt: NOW })
      .where(eq(invites.email, "ann@shop.com"));
    expect(await sendInviteEmail("ann@shop.com", { send })).toBe("skipped");

    expect(await markTestUserAdded("ann@shop.com")).toBe(true);
    const [row] = await database.select().from(invites).where(eq(invites.email, "ann@shop.com"));
    expect(row!.testUserAddedAt).not.toBeNull();
  });

  it("Davi hears about each paid checkout once; content-free; never throws", async () => {
    vi.stubEnv("ADMIN_EMAIL", "davi@example.com");
    const sent: OutgoingEmail[] = [];
    const send = async (e: OutgoingEmail): Promise<SendOutcome> => {
      sent.push(e);
      return "sent";
    };
    expect(
      await notifyPaymentReceived("cs_1", { plan: "solo", includesSetup: true }, { send }),
    ).toBe("sent");
    expect(
      await notifyPaymentReceived("cs_1", { plan: "solo", includesSetup: true }, { send }),
    ).toBe("skipped");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("davi@example.com");
    expect(sent[0]!.text).not.toContain("owner@shop.com");
    const boom = async (): Promise<SendOutcome> => {
      throw new Error("Resend 500.");
    };
    expect(
      await notifyPaymentReceived("cs_2", { plan: null, includesSetup: false }, { send: boom }),
    ).toBe("failed");
    const [marker] = await database
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, "payment-notice:cs_2"));
    expect(marker).toBeUndefined();
  });

  it("setup saves the browser's time zone; a bad one is dropped, not an error", async () => {
    const base = {
      businessName: "Ruiz Street Plumbing",
      trade: "plumbing",
      services: "Water heaters",
      serviceArea: "",
      hours: "",
      leadTime: "",
      pricingNotes: "",
      paymentTerms: "",
      policies: "",
      signature: "",
      reviewUrl: "",
      doNotPromise: "",
      vipSenders: "",
      amountThresholdDollars: "2500",
    };
    await saveBusinessProfile(
      workspaceId,
      businessProfileInput.parse({ ...base, timeZone: "America/Denver" }),
    );
    const tz = async () =>
      (
        await database
          .select({ tz: businessProfiles.timeZone })
          .from(businessProfiles)
          .where(eq(businessProfiles.workspaceId, workspaceId))
      )[0]!.tz;
    expect(await tz()).toBe("America/Denver");
    const parsed = businessProfileInput.safeParse({ ...base, timeZone: "Mars/Olympus" });
    expect(parsed.success).toBe(true);
    await saveBusinessProfile(workspaceId, parsed.data!);
    expect(await tz()).toBe("America/Denver");
    void userId;
  });
});
