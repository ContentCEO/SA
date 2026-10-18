import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import {
  activityLog,
  businessProfiles,
  drafts,
  mailboxes,
  messages,
  pushSubscriptions,
  threads,
  workspaces,
} from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { describeActivity } from "@/server/activity";
import { buildDigest, digestCounts } from "@/server/digest";
import {
  leadsAtRisk,
  leadsAtRiskQuery,
  sendLeadAtRiskPushes,
  unalerted,
} from "@/server/leads-at-risk";
import {
  atRiskDigestLine,
  isNotificationUrl,
  notificationUrl,
  queueDeepLink,
} from "@/server/leads-at-risk-rules";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { saveWorkHours, workHoursInput } from "@/server/profile";
import { listQuotes } from "@/server/quotes";
import { savePushSubscription } from "@/server/push-alerts";
import { createTestDb } from "../support/db";

// A29: make one owner's slot claim fail (a database error), to show the others still go out.
const slot = vi.hoisted(() => ({ failFor: null as string | null }));
vi.mock("@/server/push-alerts", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/push-alerts")>();
  return {
    ...real,
    claimPushSlot: async (...args: Parameters<typeof real.claimPushSlot>) => {
      if (args[0] === slot.failFor)
        throw new TypeError("SECRET-dana@customer.example: connection lost");
      return real.claimPushSlot(...args);
    },
  };
});

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const FCM = "https://fcm.googleapis.com/fcm/send/SECRET-ENDPOINT";
const min = (n: number) => n * 60_000;
const hrs = (n: number) => n * 3_600_000;
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

// October 2026 is daylight time: New York is UTC-4, Los Angeles UTC-7.
const TUE_9_NY = new Date("2026-10-13T13:00:00Z");
const TUE_13_01_NY = new Date("2026-10-13T17:01:00Z");
const TUE_12_59_NY = new Date("2026-10-13T16:59:00Z");
const FRI_17_NY = new Date("2026-10-16T21:00:00Z");
const SAT_17_NY = new Date("2026-10-17T21:00:00Z");
const MON_9_NY = new Date("2026-10-19T13:00:00Z");
/** A forward's subject (Gmail keeps the forward in the customer's conversation). */
const FWD = "Fwd: SECRET-SUBJECT";

let database: Database;
let workspaceId: string;
let mailboxId: string;
let n = 0;
const pushed: string[] = [];
const push = async (endpoint: string) => {
  pushed.push(endpoint);
  return "sent" as const;
};

async function setTimeZone(timeZone: string, ws = workspaceId) {
  await database
    .insert(businessProfiles)
    .values({ workspaceId: ws, timeZone })
    .onConflictDoUpdate({ target: businessProfiles.workspaceId, set: { timeZone } });
}

/** The mailbox synced just now (a stale mailbox can't see the owner's replies). */
async function synced(now: Date, box = mailboxId) {
  await database.update(mailboxes).set({ lastSyncedAt: now }).where(eq(mailboxes.id, box));
}

/**
 * An email on the thread. The customer's come from `from`; the owner's go to `from` (the
 * customer) unless `to` says otherwise, lowercased as sync stores them. A forward is told
 * apart by its subject ("Fwd: …").
 */
async function msg(
  threadId: string,
  direction: "in" | "out",
  sentAt: Date,
  from = "SECRET-dana@customer.example",
  box = mailboxId,
  to = direction === "in" ? "owner@shop.com" : from,
  subject = "SECRET-SUBJECT",
) {
  n += 1;
  await database.insert(messages).values({
    threadId,
    mailboxId: box,
    gmailMessageId: `m-${n}`,
    direction,
    fromName: direction === "in" ? "SECRET Dana" : "Owner",
    fromAddress: direction === "in" ? from : "owner@shop.com",
    toAddresses: [to.toLowerCase()],
    subject,
    bodyText: "SECRET-BODY",
    sentAt,
  });
  await database.update(threads).set({ lastMessageAt: sentAt }).where(eq(threads.id, threadId));
}

/** A quote request: the customer wrote at `at` (and nothing since, unless added). */
async function lead(
  at: Date,
  over: Partial<typeof threads.$inferInsert> = {},
  opts: { from?: string; box?: string } = {},
) {
  n += 1;
  const box = opts.box ?? mailboxId;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId: box,
      gmailThreadId: `t-${n}`,
      inInbox: true,
      category: "quote_request",
      priority: "normal",
      subject: "SECRET-SUBJECT",
      summary: "SECRET-SUMMARY",
      classifiedAt: at,
      lastMessageAt: at,
      ...over,
    })
    .returning();
  await msg(t!.id, "in", at, opts.from, box);
  return t!.id;
}

async function draft(threadId: string, over: Partial<typeof drafts.$inferInsert> = {}) {
  n += 1;
  await database.insert(drafts).values({
    threadId,
    mailboxId,
    gmailDraftId: `d-${n}`,
    toAddress: "SECRET-dana@customer.example",
    subject: "Re: SECRET",
    body: "SECRET-DRAFT",
    originalBody: "SECRET-DRAFT",
    reason: "SECRET-DRAFT-REASON",
    promptVersion: "draft.v5",
    ...over,
  });
}

const ids = async (now: Date, tz = NY) =>
  (await leadsAtRisk(workspaceId, now, tz)).map((l) => l.threadId);
const logs = () =>
  database.select().from(activityLog).where(eq(activityLog.action, "lead_at_risk_push_sent"));
const lastPush = async () =>
  (
    await database
      .select()
      .from(businessProfiles)
      .where(eq(businessProfiles.workspaceId, workspaceId))
  )[0]!.pushLastSentAt;
const alertedAt = async (id: string) =>
  (await database.select().from(threads).where(eq(threads.id, id)))[0]!.atRiskAlertedAt;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  pushed.length = 0;
  slot.failFor = null;
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  workspaceId = workspace.id;
  await database
    .update(workspaces)
    .set({ status: "active", setupPaidVia: "stripe" })
    .where(eq(workspaces.id, workspaceId));
  mailboxId = (
    await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    })
  ).id;
  await setTimeZone(NY);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

describe("#34 which leads are at risk", () => {
  it("4 business hours: Tue 9:00 → at risk at 13:01, not at 12:59", async () => {
    const t = await lead(TUE_9_NY);
    await synced(TUE_13_01_NY);
    expect(await ids(TUE_13_01_NY)).toEqual([t]);
    await synced(TUE_12_59_NY);
    expect(await ids(TUE_12_59_NY)).toEqual([]);
  });

  it("business hours only (Mon–Sat 7–6): Fri 5pm counts 1h Friday, then Saturday morning", async () => {
    const fri = await lead(FRI_17_NY);
    // Fri 17–18 = 60, Sat 7–10 = 180: at risk from Sat 10:00 exactly.
    const sat959 = new Date("2026-10-17T13:59:00Z");
    const sat10 = new Date("2026-10-17T14:00:00Z");
    await synced(sat959);
    expect(await ids(sat959)).toEqual([]);
    await synced(sat10);
    expect(await ids(sat10)).toEqual([fri]);
    // Fri 5pm → Mon 9am = 60 + 660 + 120 = 840 business minutes: at risk.
    await synced(MON_9_NY);
    expect(await ids(MON_9_NY)).toEqual([fri]);
  });

  it("a Mon–Fri shop: a Saturday request isn't at risk until Monday (Check 15 P8)", async () => {
    await saveWorkHours(
      workspaceId,
      workHoursInput.parse({ days: ["1", "2", "3", "4", "5"], startHour: "7", endHour: "18" }),
    );
    const SAT_10_NY = new Date("2026-10-17T14:00:00Z");
    const id = await lead(SAT_10_NY);
    const MON_10_59_NY = new Date("2026-10-19T14:59:00Z");
    const MON_11_01_NY = new Date("2026-10-19T15:01:00Z");
    for (const now of [new Date("2026-10-17T21:00:00Z"), MON_9_NY, MON_10_59_NY]) {
      await synced(now);
      expect(await ids(now)).toEqual([]);
    }
    await synced(MON_11_01_NY);
    expect(await ids(MON_11_01_NY)).toEqual([id]);
    // The default schedule (before the owner edits) counts Saturday: at risk by 2pm Saturday.
    await saveWorkHours(
      workspaceId,
      workHoursInput.parse({ days: ["1", "2", "3", "4", "5", "6"], startHour: "7", endHour: "18" }),
    );
    const SAT_14_01_NY = new Date("2026-10-17T18:01:00Z");
    await synced(SAT_14_01_NY);
    expect(await ids(SAT_14_01_NY)).toEqual([id]);
  });

  it("Sat 5pm → Mon 9am is 60 + 0 (Sunday) + 120 = 180 minutes: not yet", async () => {
    await lead(SAT_17_NY);
    await synced(MON_9_NY);
    expect(await ids(MON_9_NY)).toEqual([]);
    const mon10 = new Date("2026-10-19T14:00:00Z");
    await synced(mon10);
    expect(await ids(mon10)).toHaveLength(1);
  });

  it("leaves out answered, snoozed, decided, archived, other categories and old mail", async () => {
    const now = TUE_13_01_NY;
    const answered = await lead(TUE_9_NY);
    await msg(answered, "out", plus(TUE_9_NY, hrs(1)));
    await lead(TUE_9_NY, { snoozedUntil: plus(now, hrs(2)) });
    for (const outcome of ["won", "lost", "no_answer"])
      await lead(TUE_9_NY, { quoteOutcome: outcome, quoteOutcomeSource: "owner" });
    await lead(TUE_9_NY, { inInbox: false });
    await lead(TUE_9_NY, { category: "customer_question" });
    // Customer wrote 73 calendar hours ago (Saturday): just quiet now, the tracker has it.
    await lead(plus(now, -hrs(73)));
    await synced(now);
    expect(await ids(now)).toEqual([]);

    // A snooze that has run out doesn't hide it.
    const back = await lead(TUE_9_NY, { snoozedUntil: plus(now, -min(5)) });
    expect(await ids(now)).toEqual([back]);
  });

  it("a needs-you quote request and one with a draft waiting are still leads", async () => {
    const big = await lead(TUE_9_NY, { needsOwner: true, needsOwnerReason: "SECRET-REASON" });
    const drafted = await lead(plus(TUE_9_NY, min(1)));
    await draft(drafted);
    await synced(TUE_13_01_NY);
    expect(await ids(TUE_13_01_NY)).toEqual([big, drafted]);
  });

  it("GUARDRAIL: a Gmail draft older sync stored as the owner's mail is no answer, checked or not", async () => {
    // Old sync stored every Gmail draft (ours too) as an 'out' message from the owner. A sent
    // draft is a new message in Gmail, so a row still labelled DRAFT never answers the lead —
    // before the cleanup has looked at it, and in a mailbox the cleanup had to skip.
    const ownerRow = async (threadId: string, labelIds: string[], sentAt: Date) => {
      n += 1;
      await database.insert(messages).values({
        threadId,
        mailboxId,
        gmailMessageId: `m-${n}`,
        direction: "out",
        fromAddress: "owner@shop.com",
        toAddresses: ["secret-dana@customer.example"],
        labelIds,
        sentAt,
      });
      await database.update(threads).set({ lastMessageAt: sentAt }).where(eq(threads.id, threadId));
    };
    const drafted = await lead(TUE_9_NY);
    await draft(drafted);
    await ownerRow(drafted, ["DRAFT"], plus(TUE_9_NY, min(1)));
    // Real sent mail answers it: SENT, or DRAFT and SENT together.
    const sent = await lead(TUE_9_NY);
    await ownerRow(sent, ["SENT"], plus(TUE_9_NY, min(1)));
    const both = await lead(TUE_9_NY);
    await ownerRow(both, ["DRAFT", "SENT"], plus(TUE_9_NY, min(1)));
    await synced(TUE_13_01_NY);

    const leads = await leadsAtRisk(workspaceId, TUE_13_01_NY, NY);
    expect(leads.map((l) => l.threadId)).toEqual([drafted]);
    // Waiting since the customer's email, not since the draft.
    expect(leads[0]!.waitingSince.toISOString()).toBe(TUE_9_NY.toISOString());
  });

  it("waits from the first email after the owner's last one (customer wrote twice)", async () => {
    const now = new Date("2026-10-13T21:00:00Z"); // Tue 5pm
    const t = await lead(plus(TUE_9_NY, -hrs(24))); // Monday 9am
    await msg(t, "out", plus(TUE_9_NY, -hrs(20)));
    await msg(t, "in", TUE_9_NY);
    await msg(t, "in", plus(TUE_9_NY, hrs(3)));
    await synced(now);
    const [l] = await leadsAtRisk(workspaceId, now, NY);
    expect(l!.waitingSince.toISOString()).toBe(TUE_9_NY.toISOString());
  });

  it("a lead forwarded to the crew is still waiting; a forward that includes the customer answers it", async () => {
    const t = await lead(TUE_9_NY);
    // 9:05: the owner forwards it to the estimator; Gmail keeps the forward in the thread.
    await msg(t, "out", plus(TUE_9_NY, min(5)), undefined, mailboxId, "crew@shop.com", FWD);
    await synced(TUE_13_01_NY);
    const [l] = await leadsAtRisk(workspaceId, TUE_13_01_NY, NY);
    expect(l?.threadId).toBe(t);
    expect(l!.waitingSince.toISOString()).toBe(TUE_9_NY.toISOString());

    // A forward with the customer in Cc does answer them.
    n += 1;
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `m-${n}`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["spouse@customer.example"],
      ccAddresses: ["secret-dana@customer.example"],
      subject: FWD,
      sentAt: plus(TUE_9_NY, hrs(1)),
    });
    expect(await ids(TUE_13_01_NY)).toEqual([]);
  });

  it("the crew's reply to a forward is no wait: once the owner has answered the customer, the lead is answered", async () => {
    const t = await lead(TUE_9_NY);
    await msg(t, "out", plus(TUE_9_NY, min(5)), undefined, mailboxId, "crew@shop.com", FWD);
    // 9:30 the estimator replies to the forward, inside the same Gmail thread.
    await msg(
      t,
      "in",
      plus(TUE_9_NY, min(30)),
      "crew@shop.com",
      mailboxId,
      "owner@shop.com",
      `Re: ${FWD}`,
    );
    await synced(TUE_13_01_NY);
    // Still the customer waiting, since 9:00 (not the crew since 9:30).
    const [l] = await leadsAtRisk(workspaceId, TUE_13_01_NY, NY);
    expect(l?.threadId).toBe(t);
    expect(l!.waitingSince.toISOString()).toBe(TUE_9_NY.toISOString());

    // 10:00 the owner replies to the customer: answered at 2:01pm.
    await msg(t, "out", plus(TUE_9_NY, hrs(1)));
    const at1401 = new Date("2026-10-13T18:01:00Z");
    await synced(at1401);
    expect(await ids(at1401)).toEqual([]);

    // The crew writes again on the forward afterwards ("RE: FW:", any case): still answered.
    await msg(
      t,
      "in",
      plus(TUE_9_NY, hrs(2)),
      "crew@shop.com",
      mailboxId,
      "owner@shop.com",
      "RE: FW: x",
    );
    // Hours later (past 4 business hours from the crew's email), still answered.
    const at1601 = new Date("2026-10-13T20:01:00Z");
    await synced(at1601);
    expect(await ids(at1601)).toEqual([]);
  });

  it("the customer's own forward (\"Fwd: photos\") after the owner's answer is a new wait", async () => {
    const t = await lead(TUE_9_NY);
    await msg(t, "out", plus(TUE_9_NY, min(30)));
    await msg(t, "in", plus(TUE_9_NY, hrs(1)), undefined, mailboxId, "owner@shop.com", FWD);
    const at1401 = new Date("2026-10-13T18:01:00Z");
    await synced(at1401);
    const [l] = await leadsAtRisk(workspaceId, at1401, NY);
    expect(l?.threadId).toBe(t);
    expect(l!.waitingSince.toISOString()).toBe(plus(TUE_9_NY, hrs(1)).toISOString());
  });

  it("a Cc'd spouse's '+1' before the owner's reply to the customer leaves nothing waiting", async () => {
    const t = await lead(TUE_9_NY);
    await msg(t, "in", plus(TUE_9_NY, min(10)), "spouse@customer.example");
    await msg(t, "out", plus(TUE_9_NY, hrs(1))); // to the customer only
    await synced(TUE_13_01_NY);
    expect(await ids(TUE_13_01_NY)).toEqual([]);
  });

  it("a contact-form lead answered from Gmail (to the Reply-To address) is answered", async () => {
    // The form's relay sends it with Reply-To set to the customer (not stored); the owner's
    // reply goes to the customer's own address, never back to the relay.
    const t = await lead(TUE_9_NY, {}, { from: "wordpress@secret-site.example" });
    await msg(t, "out", plus(TUE_9_NY, hrs(1)), "secret-dana@customer.example");
    await synced(TUE_13_01_NY);
    expect(await ids(TUE_13_01_NY)).toEqual([]);
  });

  it("a bounce after the owner's reply to the customer leaves no lead waiting", async () => {
    const t = await lead(TUE_9_NY);
    await msg(t, "out", plus(TUE_9_NY, min(30)));
    await msg(t, "in", plus(TUE_9_NY, min(31)), "mailer-daemon@googlemail.com");
    await synced(TUE_13_01_NY);
    expect(await ids(TUE_13_01_NY)).toEqual([]);
  });

  it("a forward doesn't count as the owner having written on a re-sorted quote request (A11)", async () => {
    const t = await lead(plus(TUE_9_NY, -hrs(1)), {
      category: "customer_question",
      quoteRequestedAt: plus(TUE_9_NY, -hrs(1)),
    });
    await msg(t, "out", plus(TUE_9_NY, -min(30)), undefined, mailboxId, "crew@shop.com", FWD);
    await msg(t, "in", TUE_9_NY);
    await synced(TUE_13_01_NY);
    const [l] = await leadsAtRisk(workspaceId, TUE_13_01_NY, NY);
    expect(l?.threadId).toBe(t);
    expect(l!.waitingSince.toISOString()).toBe(plus(TUE_9_NY, -hrs(1)).toISOString());
  });

  it("GUARDRAIL: an unsent Gmail draft to the customer isn't the owner having written on a re-sorted quote request", async () => {
    const t = await lead(TUE_9_NY, { category: "customer_question", quoteRequestedAt: TUE_9_NY });
    n += 1;
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: `m-${n}`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["secret-dana@customer.example"],
      labelIds: ["DRAFT"],
      // Before the customer's latest email, so only the "has the owner written" check sees it.
      sentAt: plus(TUE_9_NY, -min(30)),
    });
    await msg(t, "in", plus(TUE_9_NY, min(1)));
    await synced(TUE_13_01_NY);
    const [l] = await leadsAtRisk(workspaceId, TUE_13_01_NY, NY);
    expect(l?.threadId).toBe(t);
  });

  it("a forwarded lead with no queue card links to Quotes, where it's waiting on you", async () => {
    const t = await lead(TUE_9_NY);
    await msg(t, "out", plus(TUE_9_NY, min(5)), undefined, mailboxId, "crew@shop.com", FWD);
    await msg(
      t,
      "in",
      plus(TUE_9_NY, min(30)),
      "crew@shop.com",
      mailboxId,
      "owner@shop.com",
      `Re: ${FWD}`,
    );
    await synced(TUE_13_01_NY);
    expect(await ids(TUE_13_01_NY)).toEqual([t]);
    const c = await digestCounts(workspaceId, TUE_13_01_NY, NY);
    expect(c.leadsAtRiskOffQueue).toBe(1);
    const { quotes } = await listQuotes(workspaceId, TUE_13_01_NY);
    expect(quotes.find((q) => q.threadId === t)?.stage).toBe("waiting_on_you");
  });

  it("on Quotes, the crew's reply to a forward after the owner's quote isn't the customer writing", async () => {
    const t = await lead(TUE_9_NY);
    await msg(t, "out", plus(TUE_9_NY, hrs(1))); // the quote, to the customer
    await msg(t, "out", plus(TUE_9_NY, hrs(1.5)), undefined, mailboxId, "crew@shop.com", FWD);
    await msg(
      t,
      "in",
      plus(TUE_9_NY, hrs(2)),
      "crew@shop.com",
      mailboxId,
      "owner@shop.com",
      `Re: ${FWD}`,
    );
    const { quotes } = await listQuotes(workspaceId, TUE_13_01_NY);
    expect(quotes.find((q) => q.threadId === t)?.stage).toBe("talking");
  });

  /** Any email on the thread, with explicit To / Cc and subject (addresses as sync stores them). */
  async function mail(
    threadId: string,
    m: {
      direction: "in" | "out";
      at: Date;
      from?: string;
      to: string[];
      cc?: string[];
      subject: string;
    },
  ) {
    n += 1;
    await database.insert(messages).values({
      threadId,
      mailboxId,
      gmailMessageId: `m-${n}`,
      direction: m.direction,
      fromAddress: m.from ?? "owner@shop.com",
      toAddresses: m.to,
      ccAddresses: m.cc ?? [],
      subject: m.subject,
      sentAt: m.at,
    });
  }
  /** A lead that arrived as someone else's forward (a friend, an office, a property manager). */
  async function forwardedLead(from: string, cc: string[], subject = "Fwd: SECRET-SUBJECT") {
    n += 1;
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: `t-${n}`,
        inInbox: true,
        category: "quote_request",
        priority: "normal",
        subject,
        classifiedAt: TUE_9_NY,
        lastMessageAt: TUE_9_NY,
      })
      .returning();
    await mail(t!.id, { direction: "in", at: TUE_9_NY, from, to: ["owner@shop.com"], cc, subject });
    return t!.id;
  }
  const at1401 = new Date("2026-10-13T18:01:00Z");

  it("a friend's referral with the customer in Cc: the customer's 'Re: Fwd:' after the owner's reply-all is a wait", async () => {
    const t = await forwardedLead("friend@pal.example", ["cust@home.example"]);
    // 9:30 the owner replies to all (the friend, the customer in Cc).
    await mail(t, {
      direction: "out",
      at: plus(TUE_9_NY, min(30)),
      to: ["friend@pal.example"],
      cc: ["cust@home.example"],
      subject: "Re: Fwd: SECRET-SUBJECT",
    });
    // 10:00 the customer asks for a price, in the same thread.
    await mail(t, {
      direction: "in",
      at: plus(TUE_9_NY, hrs(1)),
      from: "cust@home.example",
      to: ["owner@shop.com"],
      cc: ["friend@pal.example"],
      subject: "Re: Fwd: SECRET-SUBJECT",
    });
    await synced(at1401);
    const [l] = await leadsAtRisk(workspaceId, at1401, NY);
    expect(l?.threadId).toBe(t);
    expect(l!.waitingSince.toISOString()).toBe(plus(TUE_9_NY, hrs(1)).toISOString());
    const { quotes } = await listQuotes(workspaceId, at1401);
    expect(quotes.find((q) => q.threadId === t)?.stage).toBe("waiting_on_you");
  });

  it("a property manager's forward with the tenant in Cc: the owner's reply to the tenant answers it", async () => {
    const t = await forwardedLead("office@pm.example", ["tenant@home.example"]);
    await mail(t, {
      direction: "out",
      at: plus(TUE_9_NY, min(30)),
      to: ["tenant@home.example"],
      subject: "Re: Fwd: SECRET-SUBJECT",
    });
    await synced(TUE_13_01_NY);
    expect(await ids(TUE_13_01_NY)).toEqual([]);
  });

  it("an office's forward with the customer only in the text: the owner's 'Re: Fwd:' to the customer answers it", async () => {
    // The customer was never on a header; the lead itself arrived as a forward.
    const t = await forwardedLead("office@pm.example", []);
    await mail(t, {
      direction: "out",
      at: plus(TUE_9_NY, min(30)),
      to: ["tenant@home.example"],
      subject: "Re: Fwd: SECRET-SUBJECT",
    });
    await synced(TUE_13_01_NY);
    expect(await ids(TUE_13_01_NY)).toEqual([]);
  });

  it("someone the customer Cc'd is on the customer's side: a forward to them answers the lead", async () => {
    const t = await lead(TUE_9_NY);
    await database
      .update(messages)
      .set({ ccAddresses: ["spouse@customer.example"] })
      .where(eq(messages.threadId, t));
    await mail(t, {
      direction: "out",
      at: plus(TUE_9_NY, min(30)),
      to: ["spouse@customer.example"],
      subject: FWD,
    });
    await synced(TUE_13_01_NY);
    expect(await ids(TUE_13_01_NY)).toEqual([]);
  });

  it("a 'Re:' sent only to the crew on the owner's own domain answers nobody (nor does their reply)", async () => {
    const t = await lead(TUE_9_NY);
    // 9:05 the owner hits Reply, changes To to the estimator: "Can you price this?"
    await mail(t, {
      direction: "out",
      at: plus(TUE_9_NY, min(5)),
      to: ["crew@shop.com"],
      subject: "Re: SECRET-SUBJECT",
    });
    await mail(t, {
      direction: "in",
      at: plus(TUE_9_NY, min(30)),
      from: "crew@shop.com",
      to: ["owner@shop.com"],
      subject: "Re: SECRET-SUBJECT",
    });
    // 9:40 the owner answers the estimator again: still the crew.
    await mail(t, {
      direction: "out",
      at: plus(TUE_9_NY, min(40)),
      to: ["crew@shop.com"],
      subject: "Re: SECRET-SUBJECT",
    });
    await synced(TUE_13_01_NY);
    const [l] = await leadsAtRisk(workspaceId, TUE_13_01_NY, NY);
    expect(l?.threadId).toBe(t);
    expect(l!.waitingSince.toISOString()).toBe(TUE_9_NY.toISOString());
  });

  it("the estimator introduced to the customer ('Dana, meet Mike'): Mike's reply-all isn't the customer writing", async () => {
    const t = await lead(TUE_9_NY);
    await mail(t, {
      direction: "out",
      at: plus(TUE_9_NY, min(30)),
      to: ["secret-dana@customer.example"],
      cc: ["crew@shop.com"],
      subject: "Re: SECRET-SUBJECT",
    });
    await mail(t, {
      direction: "in",
      at: plus(TUE_9_NY, hrs(1)),
      from: "crew@shop.com",
      to: ["owner@shop.com"],
      cc: ["secret-dana@customer.example"],
      subject: "Re: SECRET-SUBJECT",
    });
    await synced(at1401);
    expect(await ids(at1401)).toEqual([]);
  });

  it("on a webmail mailbox, a 'Re:' to another webmail address answers the lead (a contact-form customer)", async () => {
    // owner@gmail.com and the customer's dana@gmail.com share a domain with strangers.
    await database
      .update(mailboxes)
      .set({ email: "owner@gmail.com" })
      .where(eq(mailboxes.id, mailboxId));
    const t = await lead(TUE_9_NY, {}, { from: "wordpress@secret-site.example" });
    await mail(t, {
      direction: "out",
      at: plus(TUE_9_NY, hrs(1)),
      from: "owner@gmail.com",
      to: ["dana@gmail.com"],
      subject: "Re: SECRET-SUBJECT",
    });
    await synced(TUE_13_01_NY);
    expect(await ids(TUE_13_01_NY)).toEqual([]);
  });

  it("emergencies first, then whoever has waited longest", async () => {
    const older = await lead(plus(TUE_9_NY, -min(2)));
    const newer = await lead(TUE_9_NY);
    const urgent = await lead(plus(TUE_9_NY, min(1)), { priority: "high" });
    await synced(TUE_13_01_NY);
    expect(await ids(TUE_13_01_NY)).toEqual([urgent, older, newer]);
  });

  describe("A12: answered in the app counts as answered, before the next sync", () => {
    it("a reply sent from the app since the wait began", async () => {
      const t = await lead(TUE_9_NY);
      await draft(t, { status: "sent", decidedAt: plus(TUE_9_NY, hrs(1)) });
      await synced(TUE_13_01_NY);
      expect(await ids(TUE_13_01_NY)).toEqual([]);
    });

    it("but a reply sent before this wait (an older one) doesn't answer it", async () => {
      const t = await lead(plus(TUE_9_NY, -hrs(24)));
      await draft(t, { status: "edited_and_sent", decidedAt: plus(TUE_9_NY, -hrs(23)) });
      await msg(t, "out", plus(TUE_9_NY, -hrs(23)));
      await msg(t, "in", TUE_9_NY);
      await synced(TUE_13_01_NY);
      expect(await ids(TUE_13_01_NY)).toEqual([t]);
    });

    it("a draft thrown away is NOT an answer: the owner meant to write their own and forgot", async () => {
      const discarded = await lead(TUE_9_NY);
      await draft(discarded, { status: "discarded", decidedAt: plus(TUE_9_NY, hrs(1)) });
      // Deleted in Gmail (reconcile closes it as discarded): still waiting.
      const deleted = await lead(TUE_9_NY);
      await draft(deleted, {
        status: "discarded",
        closedNote: "You deleted this draft in Gmail.",
        decidedAt: plus(TUE_9_NY, hrs(2)),
      });
      // One the customer's new email outdated (expired) isn't an answer either.
      const expired = await lead(TUE_9_NY);
      await draft(expired, { status: "expired", decidedAt: plus(TUE_9_NY, hrs(1)) });
      await synced(TUE_13_01_NY);
      expect((await ids(TUE_13_01_NY)).sort()).toEqual([discarded, deleted, expired].sort());
      // …and they're still pushed about.
      await savePushSubscription(workspaceId, FCM);
      expect(await sendLeadAtRiskPushes(TUE_13_01_NY, { push })).toEqual({ sent: 1 });
      expect((await logs()).map((r) => r.detail)).toEqual([{ leads: 3, phones: 1 }]);
    });

    it("a send in its undo window, or being delivered", async () => {
      const queued = await lead(TUE_9_NY);
      await draft(queued, { sendAfter: plus(TUE_13_01_NY, 5_000) });
      const claimed = await lead(TUE_9_NY);
      await draft(claimed, { sendClaimedAt: plus(TUE_13_01_NY, -5_000) });
      await synced(TUE_13_01_NY);
      expect(await ids(TUE_13_01_NY)).toEqual([]);
    });

    it("a mailbox we can't see clearly (lost access, paused, or not synced for 30 min) → none, and no digest line", async () => {
      await lead(TUE_9_NY);
      await synced(plus(TUE_13_01_NY, -min(31)));
      expect(await ids(TUE_13_01_NY)).toEqual([]);
      expect((await digestCounts(workspaceId, TUE_13_01_NY, NY)).leadsAtRisk).toBe(0);
      await synced(plus(TUE_13_01_NY, -min(29)));
      expect(await ids(TUE_13_01_NY)).toHaveLength(1);
      for (const status of ["reconnect_needed", "paused"] as const) {
        await database.update(mailboxes).set({ status }).where(eq(mailboxes.id, mailboxId));
        expect(await ids(TUE_13_01_NY)).toEqual([]);
        expect((await digestCounts(workspaceId, TUE_13_01_NY, NY)).leadsAtRisk).toBe(0);
      }
      await savePushSubscription(workspaceId, FCM);
      expect(await sendLeadAtRiskPushes(TUE_13_01_NY, { push })).toEqual({ sent: 0 });
      expect(pushed).toEqual([]);
    });
  });

  describe("A11: a quote request the classifier re-sorted later", () => {
    it("the customer's 'any update?' sorted as a question is still a waiting lead", async () => {
      const t = await lead(plus(TUE_9_NY, -hrs(1)), {
        category: "customer_question",
        quoteRequestedAt: plus(TUE_9_NY, -hrs(1)),
      });
      await msg(t, "in", TUE_9_NY);
      // An older thread with no sticky mark but an outcome since cleared still counts too.
      const reopened = await lead(TUE_9_NY, {
        category: "scheduling",
        quoteOutcomeSource: "owner",
      });
      await synced(TUE_13_01_NY);
      expect((await ids(TUE_13_01_NY)).sort()).toEqual([t, reopened].sort());
      const [l] = await leadsAtRisk(workspaceId, TUE_13_01_NY, NY);
      // The wait began with the first email, not the nudge.
      expect(l!.waitingSince.toISOString()).toBe(plus(TUE_9_NY, -hrs(1)).toISOString());
    });

    it("but not once the owner has written and the thread is now something else, nor noise", async () => {
      // The owner quoted; the customer's "Thanks, I'll let you know" was sorted as a question.
      const thanks = await lead(plus(TUE_9_NY, -hrs(2)), {
        category: "customer_question",
        quoteRequestedAt: plus(TUE_9_NY, -hrs(2)),
      });
      await msg(thanks, "out", plus(TUE_9_NY, -hrs(1)));
      await msg(thanks, "in", TUE_9_NY);
      // An out-of-office reply re-sorted as noise.
      await lead(TUE_9_NY, { category: "noise", quoteRequestedAt: TUE_9_NY });
      await synced(TUE_13_01_NY);
      expect(await ids(TUE_13_01_NY)).toEqual([]);
    });
  });

  it("A13: a lead platform's no-reply notice is answered on the platform, never waiting here", async () => {
    await lead(TUE_9_NY, {}, { from: "noreply@thumbtack.com" });
    await lead(TUE_9_NY, {}, { from: "No-Reply@angi.com" });
    const direct = await lead(TUE_9_NY, {}, { from: "pat@gmail.com" });
    await synced(TUE_13_01_NY);
    expect(await ids(TUE_13_01_NY)).toEqual([direct]);
  });

  it("other workspaces' leads never count", async () => {
    const other = await ensureUserAndWorkspace({ email: "other@shop.com" });
    const box = (
      await saveConnectedMailbox(other.workspace, {
        email: "other@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
    await lead(TUE_9_NY, {}, { box });
    await synced(TUE_13_01_NY, box);
    await synced(TUE_13_01_NY);
    expect(await ids(TUE_13_01_NY)).toEqual([]);
  });

  it("selects no content, and binds no Date into raw SQL (A10)", async () => {
    const { params } = leadsAtRiskQuery(workspaceId, TUE_13_01_NY).toSQL();
    for (const p of params) expect(p).not.toBeInstanceOf(Date);
    await lead(TUE_9_NY);
    await synced(TUE_13_01_NY);
    const rows = await leadsAtRiskQuery(workspaceId, TUE_13_01_NY);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "alertedAt",
      "priority",
      "threadId",
      "waitingSince",
    ]);
    const leads = await leadsAtRisk(workspaceId, TUE_13_01_NY, NY);
    expect(JSON.stringify(leads)).not.toMatch(/SECRET|@/);
  });

  it("once per waiting episode", () => {
    const waitingSince = TUE_9_NY;
    expect(unalerted({ waitingSince, alertedAt: null })).toBe(true);
    expect(unalerted({ waitingSince, alertedAt: plus(TUE_9_NY, hrs(4)) })).toBe(false);
    expect(unalerted({ waitingSince, alertedAt: plus(TUE_9_NY, -hrs(20)) })).toBe(true);
  });
});

describe("#34 the push", () => {
  beforeEach(async () => {
    await savePushSubscription(workspaceId, FCM);
  });

  it("one push for two leads; both marked; the log holds counts only", async () => {
    const a = await lead(TUE_9_NY);
    const b = await lead(plus(TUE_9_NY, min(1)));
    await synced(TUE_13_01_NY);
    expect(await sendLeadAtRiskPushes(TUE_13_01_NY, { push })).toEqual({ sent: 1 });
    expect(pushed).toEqual([FCM]);
    expect((await alertedAt(a))?.toISOString()).toBe(TUE_13_01_NY.toISOString());
    expect((await alertedAt(b))?.toISOString()).toBe(TUE_13_01_NY.toISOString());
    const [log] = await logs();
    expect(log!.detail).toEqual({ leads: 2, phones: 1 });
    expect(log!.actor).toBe("squared_away");
    expect(log!.createdAt.toISOString()).toBe(TUE_13_01_NY.toISOString());
    expect(describeActivity(log!.action, log!.detail as Record<string, unknown>, null)).toBe(
      "Let you know 2 quote requests were waiting",
    );
  });

  it("GUARDRAIL: the log is counts only — no name, subject, address or phone endpoint", async () => {
    await lead(TUE_9_NY, { needsOwner: true, needsOwnerReason: "SECRET-REASON" });
    await synced(TUE_13_01_NY);
    await sendLeadAtRiskPushes(TUE_13_01_NY, { push });
    const [log] = await logs();
    expect(Object.keys(log!.detail as object).sort()).toEqual(["leads", "phones"]);
    expect(JSON.stringify(log!.detail)).not.toMatch(/SECRET|Dana|@|fcm|http/i);
  });

  it("each lead once per wait; after the owner answers and the customer writes again, again", async () => {
    const t = await lead(TUE_9_NY);
    await synced(TUE_13_01_NY);
    expect(await sendLeadAtRiskPushes(TUE_13_01_NY, { push })).toEqual({ sent: 1 });
    const later = plus(TUE_13_01_NY, min(30));
    await synced(later);
    expect(await sendLeadAtRiskPushes(later, { push })).toEqual({ sent: 0 });

    // The owner answers Tuesday afternoon; the customer writes back Wednesday at 8am.
    await msg(t, "out", plus(TUE_13_01_NY, hrs(1)));
    const wed8 = new Date("2026-10-14T12:00:00Z");
    await msg(t, "in", wed8);
    const wed1201 = new Date("2026-10-14T16:01:00Z");
    await synced(wed1201);
    expect(await sendLeadAtRiskPushes(wed1201, { push })).toEqual({ sent: 1 });
    expect((await alertedAt(t))?.toISOString()).toBe(wed1201.toISOString());
    expect(pushed).toHaveLength(2);
  });

  it("at most 3 a LOCAL day (from local midnight, not UTC and not the last 24 hours) — New York", async () => {
    // Tue 5:00, 5:11, 5:22pm New York; the 4th at 5:33pm is skipped.
    const runs = [0, 11, 22, 33].map((m) => plus(new Date("2026-10-13T21:00:00Z"), min(m)));
    const results = [];
    for (const now of runs) {
      await lead(TUE_9_NY);
      await synced(now);
      results.push((await sendLeadAtRiskPushes(now, { push })).sent);
    }
    expect(results).toEqual([1, 1, 1, 0]);
    // Wednesday 7:00am New York: a new local day, though within 24 hours of the last.
    const wed7 = new Date("2026-10-14T11:00:00Z");
    await synced(wed7);
    expect(await sendLeadAtRiskPushes(wed7, { push })).toEqual({ sent: 1 });
    expect(await logs()).toHaveLength(4);
  });

  it("at most 3 a LOCAL day — Los Angeles, where Tuesday runs past midnight UTC", async () => {
    await setTimeZone(LA);
    const tue9LA = new Date("2026-10-13T16:00:00Z");
    // Tue 4:00, 4:11, 4:22pm Los Angeles (23:xx UTC); then 5:00pm LA = 00:00 UTC Wednesday.
    const runs = [0, 11, 22].map((m) => plus(new Date("2026-10-13T23:00:00Z"), min(m)));
    for (const now of runs) {
      await lead(tue9LA);
      await synced(now);
      expect((await sendLeadAtRiskPushes(now, { push })).sent).toBe(1);
    }
    const fivePmLA = new Date("2026-10-14T00:00:00Z");
    await lead(tue9LA);
    await synced(fivePmLA);
    expect(await sendLeadAtRiskPushes(fivePmLA, { push })).toEqual({ sent: 0 });
    // Wednesday 7am Los Angeles: a new day there.
    const wed7LA = new Date("2026-10-14T14:00:00Z");
    await synced(wed7LA);
    expect(await sendLeadAtRiskPushes(wed7LA, { push })).toEqual({ sent: 1 });
  });

  it("the 3 a day are each owner's own: two owners each get 3, and one at the cap never stops another", async () => {
    const other = await ensureUserAndWorkspace({ email: "other@shop.com" });
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, other.workspace.id));
    await setTimeZone(NY, other.workspace.id);
    const box = (
      await saveConnectedMailbox(other.workspace, {
        email: "other@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
    const OTHER = "https://fcm.googleapis.com/fcm/send/other";
    await savePushSubscription(other.workspace.id, OTHER);

    // Tue 5:00, 5:11, 5:22, 5:33pm New York: a new lead for each owner every run.
    const runs = [0, 11, 22, 33].map((m) => plus(new Date("2026-10-13T21:00:00Z"), min(m)));
    const results = [];
    for (const now of runs) {
      await lead(TUE_9_NY);
      await lead(TUE_9_NY, {}, { box });
      await synced(now);
      await synced(now, box);
      results.push((await sendLeadAtRiskPushes(now, { push })).sent);
    }
    expect(results).toEqual([2, 2, 2, 0]);
    const rows = await logs();
    expect(rows.filter((r) => r.workspaceId === workspaceId)).toHaveLength(3);
    expect(rows.filter((r) => r.workspaceId === other.workspace.id)).toHaveLength(3);
  });

  it("another owner's 3 pushes today don't use up this owner's allowance", async () => {
    const other = await ensureUserAndWorkspace({ email: "other@shop.com" });
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, other.workspace.id));
    await setTimeZone(NY, other.workspace.id);
    const box = (
      await saveConnectedMailbox(other.workspace, {
        email: "other@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
    const OTHER = "https://fcm.googleapis.com/fcm/send/other";
    await savePushSubscription(other.workspace.id, OTHER);
    // The other owner already had their 3 today (Tue 10am, 11am, noon New York).
    for (const h of [14, 15, 16])
      await database.insert(activityLog).values({
        workspaceId: other.workspace.id,
        actor: "squared_away",
        action: "lead_at_risk_push_sent",
        detail: { leads: 1, phones: 1 },
        createdAt: new Date(`2026-10-13T${h}:00:00Z`),
      });
    await lead(TUE_9_NY);
    await lead(TUE_9_NY, {}, { box });
    await synced(TUE_13_01_NY);
    await synced(TUE_13_01_NY, box);

    expect(await sendLeadAtRiskPushes(TUE_13_01_NY, { push })).toEqual({ sent: 1 });
    expect(pushed).toEqual([FCM]);
  });

  it("only inside business hours, and never in quiet hours whatever the business hours say", async () => {
    await lead(new Date("2026-10-17T13:00:00Z")); // Saturday 9am
    const sunNoon = new Date("2026-10-18T16:00:00Z");
    await synced(sunNoon);
    expect(await sendLeadAtRiskPushes(sunNoon, { push })).toEqual({ sent: 0 });
    const tue630pm = new Date("2026-10-13T22:30:00Z");
    await lead(TUE_9_NY);
    await synced(tue630pm);
    expect(await sendLeadAtRiskPushes(tue630pm, { push })).toEqual({ sent: 0 });
    expect(pushed).toEqual([]);

    // Open all hours, every day: 11pm is still quiet hours.
    const always = { days: [1, 2, 3, 4, 5, 6, 7], startHour: 0, endHour: 24 };
    const tue11pm = new Date("2026-10-14T03:00:00Z");
    await synced(tue11pm);
    expect(await sendLeadAtRiskPushes(tue11pm, { push, hours: always })).toEqual({ sent: 0 });
    // …while Sunday noon is fine under those hours (the hours really are the ones passed).
    await synced(sunNoon);
    expect(await sendLeadAtRiskPushes(sunNoon, { push, hours: always })).toEqual({ sent: 1 });
  });

  it("shares the 10-minute slot with new-lead pushes; two runs at once push once", async () => {
    await lead(TUE_9_NY);
    await synced(TUE_13_01_NY);
    await database
      .update(businessProfiles)
      .set({ pushLastSentAt: plus(TUE_13_01_NY, -min(5)) })
      .where(eq(businessProfiles.workspaceId, workspaceId));
    expect(await sendLeadAtRiskPushes(TUE_13_01_NY, { push })).toEqual({ sent: 0 });
    expect(await alertedAt((await ids(TUE_13_01_NY))[0]!)).toBeNull();

    const later = plus(TUE_13_01_NY, min(6));
    await synced(later);
    const both = await Promise.all([
      sendLeadAtRiskPushes(later, { push }),
      sendLeadAtRiskPushes(later, { push }),
    ]);
    expect(both.map((r) => r.sent).sort()).toEqual([0, 1]);
    expect(pushed).toEqual([FCM]);
    expect(await logs()).toHaveLength(1);
    // And the slot is now taken for new-lead pushes too.
    const [p] = await database
      .select()
      .from(businessProfiles)
      .where(eq(businessProfiles.workspaceId, workspaceId));
    expect(p!.pushLastSentAt?.toISOString()).toBe(later.toISOString());
  });

  it("GATE: read-only accounts get no push, no marker and no log", async () => {
    const t = await lead(TUE_9_NY);
    await synced(TUE_13_01_NY);
    const cases: Partial<typeof workspaces.$inferInsert>[] = [
      { status: "evaluation_expired" },
      { status: "evaluating", evaluationEndsAt: plus(TUE_13_01_NY, -hrs(1)) },
      { status: "past_due" },
      { status: "canceled" },
      { status: "paused" },
    ];
    for (const c of cases) {
      await database.update(workspaces).set(c).where(eq(workspaces.id, workspaceId));
      expect(await sendLeadAtRiskPushes(TUE_13_01_NY, { push }), JSON.stringify(c)).toEqual({
        sent: 0,
      });
    }
    expect(pushed).toEqual([]);
    expect(await alertedAt(t)).toBeNull();
    expect(await logs()).toHaveLength(0);
    // An evaluation still running is allowed (the gate is effectiveStatus, not a list of names).
    await database
      .update(workspaces)
      .set({ status: "evaluating", evaluationEndsAt: plus(TUE_13_01_NY, hrs(24)) })
      .where(eq(workspaces.id, workspaceId));
    expect(await sendLeadAtRiskPushes(TUE_13_01_NY, { push })).toEqual({ sent: 1 });
  });

  it("GATE: phone notifications not set up → nothing, and says so", async () => {
    await lead(TUE_9_NY);
    await synced(TUE_13_01_NY);
    expect(await sendLeadAtRiskPushes(TUE_13_01_NY)).toEqual({ sent: 0, notConfigured: true });
    expect(await logs()).toHaveLength(0);
  });

  it("no phone subscribed → no push, but the morning summary still has the line", async () => {
    await database.delete(pushSubscriptions);
    await lead(TUE_9_NY);
    await lead(plus(TUE_9_NY, -min(2)));
    await synced(TUE_13_01_NY);
    expect(await sendLeadAtRiskPushes(TUE_13_01_NY, { push })).toEqual({ sent: 0 });
    const c = await digestCounts(workspaceId, TUE_13_01_NY, NY);
    expect(c.leadsAtRisk).toBe(2);
    const d = buildDigest(c, links, { now: TUE_13_01_NY, timeZone: NY });
    expect(d.text).toContain("2 quote requests have waited more than 4 hours.");
    expect(d.html).toContain("2 quote requests have waited more than 4 hours.");
  });

  it("one owner's failure doesn't stop the others, and the error log names no content (A3, A29)", async () => {
    const other = await ensureUserAndWorkspace({ email: "other@shop.com" });
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, other.workspace.id));
    const box = (
      await saveConnectedMailbox(other.workspace, {
        email: "other@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
    const OTHER = "https://fcm.googleapis.com/fcm/send/other";
    await savePushSubscription(other.workspace.id, OTHER);
    const mine = await lead(TUE_9_NY);
    await lead(TUE_9_NY, {}, { box });
    await synced(TUE_13_01_NY);
    await synced(TUE_13_01_NY, box);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const flaky = async (endpoint: string) => {
      if (endpoint === FCM) throw new TypeError("SECRET-dana@customer.example broke");
      pushed.push(endpoint);
      return "sent" as const;
    };
    expect(await sendLeadAtRiskPushes(TUE_13_01_NY, { push: flaky })).toEqual({ sent: 1 });
    expect(pushed).toEqual([OTHER]);
    expect(errors).toHaveBeenCalledWith("lead_at_risk_push_failed", {
      workspaceId,
      error: "TypeError",
    });
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/SECRET|@/);
    // The owner whose phone failed wasn't told: no mark kept, no Activity line.
    expect(await alertedAt(mine)).toBeNull();
    const rows = await logs();
    expect(rows.map((r) => r.workspaceId)).toEqual([other.workspace.id]);
  });

  it("a database error for one owner doesn't stop the others; the log names no content (A29)", async () => {
    const other = await ensureUserAndWorkspace({ email: "other@shop.com" });
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, other.workspace.id));
    const box = (
      await saveConnectedMailbox(other.workspace, {
        email: "other@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
    const OTHER = "https://fcm.googleapis.com/fcm/send/other";
    await savePushSubscription(other.workspace.id, OTHER);
    const mine = await lead(TUE_9_NY);
    await lead(TUE_9_NY, {}, { box });
    await synced(TUE_13_01_NY);
    await synced(TUE_13_01_NY, box);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    slot.failFor = workspaceId;
    expect(await sendLeadAtRiskPushes(TUE_13_01_NY, { push })).toEqual({ sent: 1 });
    expect(pushed).toEqual([OTHER]);
    expect(errors).toHaveBeenCalledWith("lead_at_risk_push_failed", {
      workspaceId,
      error: "TypeError",
    });
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/SECRET|@/);
    expect(await alertedAt(mine)).toBeNull();
    expect((await logs()).map((r) => r.workspaceId)).toEqual([other.workspace.id]);
  });

  it("nothing reached a phone (gone or failed): marks taken back, no Activity line, not counted in the day's 3", async () => {
    const SECOND = "https://fcm.googleapis.com/fcm/send/second";
    await savePushSubscription(workspaceId, SECOND);
    const t = await lead(TUE_9_NY);
    await synced(TUE_13_01_NY);
    const attempts: string[] = [];
    const broken = async (endpoint: string) => {
      attempts.push(endpoint);
      return endpoint === FCM ? ("gone" as const) : ("failed" as const);
    };
    // A new-lead push went out 20 minutes earlier: that time is put back, not this run's.
    const before = plus(TUE_13_01_NY, -min(20));
    await database
      .update(businessProfiles)
      .set({ pushLastSentAt: before })
      .where(eq(businessProfiles.workspaceId, workspaceId));
    expect(await sendLeadAtRiskPushes(TUE_13_01_NY, { push: broken })).toEqual({ sent: 0 });
    expect(attempts.sort()).toEqual([FCM, SECOND].sort());
    expect(await alertedAt(t)).toBeNull();
    expect(await logs()).toHaveLength(0);
    // The shared slot is handed back: a phone that never buzzed doesn't hold up a new-lead push.
    expect((await lastPush())?.toISOString()).toBe(before.toISOString());
    // The gone phone is forgotten; the one that failed stays.
    const subs = await database.select().from(pushSubscriptions);
    expect(subs.map((r) => r.endpoint)).toEqual([SECOND]);

    // A lead that was alerted in an earlier wait gets that earlier mark back, not null.
    const earlier = plus(TUE_9_NY, -hrs(30));
    await database.update(threads).set({ atRiskAlertedAt: earlier }).where(eq(threads.id, t));
    const later = plus(TUE_13_01_NY, min(15));
    await synced(later);
    expect(await sendLeadAtRiskPushes(later, { push: broken })).toEqual({ sent: 0 });
    expect((await alertedAt(t))?.toISOString()).toBe(earlier.toISOString());

    // Once the phone answers, the lead is pushed about after all.
    const fixed = plus(TUE_13_01_NY, min(30));
    await synced(fixed);
    expect(await sendLeadAtRiskPushes(fixed, { push })).toEqual({ sent: 1 });
    expect(pushed).toEqual([SECOND]);
    expect((await alertedAt(t))?.toISOString()).toBe(fixed.toISOString());
    expect((await logs()).map((r) => r.detail)).toEqual([{ leads: 1, phones: 1 }]);
  });
});

describe("#34 in the morning summary and on the phone (counts only)", () => {
  it("the digest line: plural, singular, none", () => {
    expect(atRiskDigestLine(2)).toBe("2 quote requests have waited more than 4 hours.");
    expect(atRiskDigestLine(1)).toBe("1 quote request has waited more than 4 hours.");
    expect(atRiskDigestLine(0)).toBeNull();
    const quiet = {
      repliesReady: 0,
      nudgesReady: 0,
      needsYou: [],
      sentYesterday: 0,
      sortedYesterday: 0,
      leadsAtRiskOffQueue: 0,
    };
    const zero = buildDigest({ ...quiet, leadsAtRisk: 0 }, links, {
      now: TUE_13_01_NY,
      timeZone: NY,
    });
    expect(zero.text).not.toMatch(/waited more than/);
    expect(zero.worthSending).toBe(false);
    const one = buildDigest({ ...quiet, leadsAtRisk: 1 }, links, {
      now: TUE_13_01_NY,
      timeZone: NY,
    });
    expect(one.text).toContain("1 quote request has waited more than 4 hours.");
    expect(one.worthSending).toBe(true);
  });

  it("the digest line appears with a phone subscribed too", async () => {
    await savePushSubscription(workspaceId, FCM);
    await lead(TUE_9_NY);
    await synced(TUE_13_01_NY);
    const c = await digestCounts(workspaceId, TUE_13_01_NY, NY);
    const d = buildDigest(c, links, { now: TUE_13_01_NY, timeZone: NY });
    expect(d.text).toContain("1 quote request has waited more than 4 hours.");
    expect(`${d.text}${d.html}`).not.toMatch(/SECRET/);
  });

  it("a lead with no card on the queue (no draft, not needs-you) is still waiting: never 'Nothing waiting' or 'all clear', and it links to the quote list", async () => {
    // The drafted reply was never made (model failure, AI cap…): nothing on the queue at all.
    await lead(TUE_9_NY);
    await synced(TUE_13_01_NY);
    const c = await digestCounts(workspaceId, TUE_13_01_NY, NY);
    expect(c.leadsAtRisk).toBe(1);
    expect(c.leadsAtRiskOffQueue).toBe(1);
    expect(c.needsYou).toHaveLength(0);
    expect(c.repliesReady + c.nudgesReady).toBe(0);
    const d = buildDigest(c, links, { now: TUE_13_01_NY, timeZone: NY });
    expect(d.subject).toBe("1 thing waiting on you");
    expect(d.subject).not.toMatch(/nothing waiting/i);
    expect(d.html).toContain("1 thing waiting.");
    expect(d.html).not.toContain("all clear.");
    expect(`${d.text}${d.html}`).not.toContain("No emails need a decision from you today.");
    expect(d.text).toContain("1 quote request has waited more than 4 hours.");
    expect(d.text).toContain(
      "• 1 quote request waiting with no reply drafted — see your quotes: https://app/quotes",
    );
    expect(d.html).toContain('href="https://app/quotes"');
    // The queue has nothing for it, so no "Open your queue" button pointing at an empty queue.
    expect(d.text).not.toContain("Open your queue");
    expect(d.html).not.toContain("Open your queue");
    expect(d.worthSending).toBe(true);
    expect(`${d.text}${d.html}`).not.toMatch(/SECRET/);
  });

  it("a lead whose draft is on the queue is counted once (as the reply waiting), with no quote-list line", async () => {
    const t = await lead(TUE_9_NY);
    await draft(t);
    await synced(TUE_13_01_NY);
    const c = await digestCounts(workspaceId, TUE_13_01_NY, NY);
    expect(c.leadsAtRisk).toBe(1);
    expect(c.leadsAtRiskOffQueue).toBe(0);
    const d = buildDigest(c, links, { now: TUE_13_01_NY, timeZone: NY });
    expect(d.subject).toBe("1 thing waiting on you");
    expect(d.text).not.toContain("https://app/quotes");
    expect(d.text).toContain("Open your queue: https://app/queue");
  });

  it("where a tap goes: an at-risk card on the queue, else the quote tracker, else needs-you, else the queue", () => {
    const A = "11111111-1111-4111-8111-111111111111";
    const B = "22222222-2222-4222-8222-222222222222";
    const C = "33333333-3333-4333-8333-333333333333";
    expect(notificationUrl({ atRisk: [A, B], needsYou: [C], onQueue: new Set([B, C]) })).toBe(
      `/queue?t=${B}#t-${B}`,
    );
    expect(notificationUrl({ atRisk: [A], needsYou: [C], onQueue: new Set([C]) })).toBe("/quotes");
    expect(notificationUrl({ atRisk: [], needsYou: [A, C], onQueue: new Set([C]) })).toBe(
      `/queue?t=${C}#t-${C}`,
    );
    expect(notificationUrl({ atRisk: [], needsYou: [], onQueue: new Set() })).toBe("/queue");
    expect(queueDeepLink("not-a-uuid")).toBe("/queue");
  });

  it("the allow-list of notification links", () => {
    const A = "11111111-1111-4111-8111-111111111111";
    for (const ok of ["/queue", "/quotes", `/queue?t=${A}#t-${A}`])
      expect(isNotificationUrl(ok), ok).toBe(true);
    for (const bad of [
      "https://evil.example/queue",
      "//evil.example",
      "/queue#t-" + A,
      `/queue?t=${A}#t-22222222-2222-4222-8222-222222222222`,
      `/queue?t=${A}&x=dana@x.com#t-${A}`,
      "/settings",
      "javascript:alert(1)",
      null,
      42,
    ])
      expect(isNotificationUrl(bad), String(bad)).toBe(false);
  });
});

const links = {
  queueUrl: "https://app/queue",
  quotesUrl: "https://app/quotes",
  settingsUrl: "https://app/settings/morning-email",
  threadUrl: (id: string) => `https://app/queue#t-${id}`,
};
