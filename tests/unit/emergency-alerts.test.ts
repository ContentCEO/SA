import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
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
import type { OutgoingSms } from "@/lib/sms";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { describeActivity } from "@/server/activity";
import {
  dayStart,
  EMERGENCY_ALERTS,
  emergencyActivityLine,
  emergencyAlertText,
  emergencyAllowed,
  emergencySmsBody,
  emergencySummaryApplies,
  inNight,
  nightStart,
} from "@/server/emergency-alert-rules";
import {
  emergencyCandidates,
  emergencySummary,
  sendEmergencyAlerts,
  setEmergencyAlerts,
} from "@/server/emergency-alerts";
import { isNotificationUrl, queueDeepLink } from "@/server/leads-at-risk-rules";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { savePushSubscription, sendPushAlerts } from "@/server/push-alerts";
import { freshLeads, sendLeadAlerts } from "@/server/sms-alerts";
import { createTestDb } from "../support/db";

const NY = "America/New_York";
const FCM = "https://fcm.googleapis.com/fcm/send/SECRET-ENDPOINT";
const min = (n: number) => n * 60_000;
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

// October 2026 is daylight time: New York is UTC-4.
const TWO_AM_NY = new Date("2026-10-14T06:00:00Z");
const TEN_PM_NY = new Date("2026-10-14T02:00:00Z"); // Tue 13 Oct, 10pm
const NOON_NY = new Date("2026-10-14T16:00:00Z");

let database: Database;
let workspaceId: string;
let mailboxId: string;
let n = 0;
let pushed: string[];
let texts: OutgoingSms[];
const push = async (endpoint: string) => {
  pushed.push(endpoint);
  return "sent" as const;
};
const sms = async (t: OutgoingSms) => {
  texts.push(t);
  return "sent" as const;
};

/**
 * A thread whose newest customer email came in at `at` and was sorted a minute later. SECRET
 * content everywhere a careless alert could pick it up.
 */
async function emergency(
  at: Date,
  over: Partial<typeof threads.$inferInsert> = {},
  opts: { from?: string; extracted?: Record<string, unknown>; replyTo?: string } = {},
) {
  n += 1;
  const sortedAt = plus(at, min(1));
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: `t-${n}`,
      inInbox: true,
      category: "customer_question",
      priority: "high",
      needsOwner: true,
      needsOwnerReason: "SECRET-REASON",
      subject: "SECRET-SUBJECT",
      summary: "SECRET-SUMMARY water everywhere",
      extracted: {
        urgency: "emergency",
        address: "SECRET 12 Elm St",
        owner_rule_hits: ["emergency"],
        ...opts.extracted,
      },
      classifiedAt: sortedAt,
      lastMessageAt: at,
      ...over,
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `m-${n}`,
    direction: "in",
    fromName: "SECRET Dana",
    fromAddress: opts.from ?? "secret-dana@customer.example",
    toAddresses: ["owner@shop.com"],
    subject: "SECRET-SUBJECT",
    bodyText: "SECRET-BODY the basement is flooding",
    sentAt: at,
    classifiedAt: sortedAt,
    ...(opts.replyTo ? { replyToHeader: { address: opts.replyTo } } : {}),
  });
  return t!;
}

async function profile(set: Partial<typeof businessProfiles.$inferInsert>) {
  await database
    .insert(businessProfiles)
    .values({ workspaceId, ...set })
    .onConflictDoUpdate({ target: businessProfiles.workspaceId, set });
}

const alertsRows = () =>
  database
    .select()
    .from(activityLog)
    .where(
      and(eq(activityLog.workspaceId, workspaceId), eq(activityLog.action, "emergency_alert_sent")),
    );
const alertedAt = async (id: string) =>
  (await database.select().from(threads).where(eq(threads.id, id)))[0]!.emergencyAlertedAt;

const run = (now: Date) => sendEmergencyAlerts(now, { push, send: sms });

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
  await database.update(workspaces).set({ status: "active" }).where(eq(workspaces.id, workspaceId));
  await profile({ timeZone: NY });
  await savePushSubscription(workspaceId, FCM);
  pushed = [];
  texts = [];
});

describe("emergency alert rules (pure)", () => {
  it("night is 9pm to 7am in the owner's zone; the night began at 9pm (today or yesterday)", () => {
    expect(inNight(TWO_AM_NY, NY)).toBe(true);
    expect(inNight(TEN_PM_NY, NY)).toBe(true);
    expect(inNight(NOON_NY, NY)).toBe(false);
    expect(inNight(new Date("2026-10-14T11:00:00Z"), NY)).toBe(false); // 7am sharp
    expect(nightStart(TWO_AM_NY, NY)!.toISOString()).toBe("2026-10-14T01:00:00.000Z");
    expect(nightStart(TEN_PM_NY, NY)!.toISOString()).toBe("2026-10-14T01:00:00.000Z");
    expect(nightStart(NOON_NY, NY)).toBeNull();
    expect(dayStart(TWO_AM_NY, NY).toISOString()).toBe("2026-10-14T04:00:00.000Z");
    // The night the clocks go back (Nov 1, 2026: 2am EDT → 1am EST) still starts at 9pm EDT.
    expect(nightStart(new Date("2026-11-01T07:30:00Z"), NY)!.toISOString()).toBe(
      "2026-11-01T01:00:00.000Z",
    );
  });

  it("caps: 3 a night, 6 a day", () => {
    expect(EMERGENCY_ALERTS).toMatchObject({ nightCap: 3, dayCap: 6 });
    expect(emergencyAllowed({ sentToday: 2, sentTonight: 2, night: true })).toBe(true);
    expect(emergencyAllowed({ sentToday: 3, sentTonight: 3, night: true })).toBe(false);
    expect(emergencyAllowed({ sentToday: 5, sentTonight: 0, night: false })).toBe(true);
    expect(emergencyAllowed({ sentToday: 6, sentTonight: 0, night: false })).toBe(false);
    // The night's count doesn't hold back a daytime alert.
    expect(emergencyAllowed({ sentToday: 3, sentTonight: 3, night: false })).toBe(true);
  });

  it("the words are content-free", () => {
    expect(emergencyAlertText(1)).toBe("An emergency email just came in. Open Squared Away.");
    expect(emergencyAlertText(2)).toBe("2 emergency emails just came in. Open Squared Away.");
    expect(emergencySmsBody(1, "https://app/queue")).toBe(
      "Squared Away: An emergency email just came in. Open: https://app/queue",
    );
    expect(emergencyActivityLine(1)).toBe("Let you know right away about an emergency email");
    expect(emergencyActivityLine(3)).toBe("Let you know right away about 3 emergency emails");
    expect(emergencyActivityLine("SECRET")).toBe(
      "Let you know right away about an emergency email",
    );
  });

  it("the phone says 'emergency' only while that alert is the newest push, for half an hour", () => {
    const at = TWO_AM_NY;
    expect(
      emergencySummaryApplies({ newestEmergencyAlertAt: at, lastPushAt: at, now: plus(at, 5000) }),
    ).toBe(true);
    expect(
      emergencySummaryApplies({
        newestEmergencyAlertAt: at,
        lastPushAt: plus(at, min(11)),
        now: plus(at, min(12)),
      }),
    ).toBe(false);
    expect(
      emergencySummaryApplies({
        newestEmergencyAlertAt: at,
        lastPushAt: null,
        now: plus(at, min(31)),
      }),
    ).toBe(false);
    expect(
      emergencySummaryApplies({ newestEmergencyAlertAt: null, lastPushAt: null, now: at }),
    ).toBe(false);
  });
});

describe("emergency alerts (B5 part 2)", () => {
  it("GUARDRAIL: quiet hours are bypassed for emergencies only", async () => {
    const now = TWO_AM_NY;
    await profile({
      smsAlertsEnabled: true,
      alertPhone: "+15085551234",
      alertPhoneVerifiedAt: plus(now, -min(600)),
      smsAlertCursor: plus(now, -min(600)),
    });
    // An ordinary needs-you email at 1:50am: nothing at night, by push or by text.
    await emergency(plus(now, -min(10)), { extracted: { urgency: "normal" } });
    expect((await sendPushAlerts(now, { push })).sent).toBe(0);
    expect((await sendLeadAlerts(now, { send: sms })).sent).toBe(0);
    expect((await run(now)).sent).toBe(0);
    expect(pushed).toEqual([]);
    expect(texts).toEqual([]);

    // An emergency at 1:55am: straight to the phone and as a text, content-free.
    const t = await emergency(plus(now, -min(5)));
    expect((await run(now)).sent).toBe(1);
    expect(pushed).toEqual([FCM]);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.to).toBe("+15085551234");
    expect(texts[0]!.body).toMatch(/^Squared Away: An emergency email just came in\. Open: /);
    expect(texts[0]!.body).toContain(`/queue?t=${t.id}#t-${t.id}`);
    expect(texts[0]!.body).not.toMatch(/SECRET|dana|Elm|flood/i);
    expect(await alertedAt(t.id)).toEqual(now);
    const [row] = await alertsRows();
    expect(row!.detail).toEqual({ emergencies: 1, phones: 1, text: true });
    expect(JSON.stringify(row!.detail)).not.toMatch(/SECRET|dana/i);
    expect(describeActivity(row!.action, row!.detail, null)).toBe(
      "Let you know right away about an emergency email",
    );
    // The slots are taken: the ordinary alerts wait their 10 minutes after it.
    const [p] = await database
      .select()
      .from(businessProfiles)
      .where(eq(businessProfiles.workspaceId, workspaceId));
    expect(p!.pushLastSentAt).toEqual(now);
    expect(p!.smsLastSentAt).toEqual(now);
  });

  it("GUARDRAIL: once per thread — a second run, or a later email on it, never alerts again", async () => {
    const now = TWO_AM_NY;
    const t = await emergency(plus(now, -min(5)));
    expect((await run(now)).sent).toBe(1);
    expect((await run(plus(now, min(1)))).sent).toBe(0);
    // The customer writes again ("hello?? water everywhere"), sorted as an emergency again.
    await database.insert(messages).values({
      threadId: t.id,
      mailboxId,
      gmailMessageId: `m-again`,
      direction: "in",
      fromAddress: "secret-dana@customer.example",
      toAddresses: ["owner@shop.com"],
      bodyText: "SECRET hello??",
      sentAt: plus(now, min(20)),
      classifiedAt: plus(now, min(21)),
    });
    await database
      .update(threads)
      .set({ classifiedAt: plus(now, min(21)), lastMessageAt: plus(now, min(20)) })
      .where(eq(threads.id, t.id));
    expect((await run(plus(now, min(25)))).sent).toBe(0);
    expect(pushed).toHaveLength(1);
    expect(await alertsRows()).toHaveLength(1);
  });

  it("GUARDRAIL: at most 3 between 9pm and 7am", async () => {
    // Four emergencies, each in its own run 20 minutes apart from 10pm.
    let now = TEN_PM_NY;
    for (let i = 0; i < 4; i++) {
      await emergency(plus(now, -min(2)));
      await run(now);
      now = plus(now, min(20));
    }
    expect(pushed).toHaveLength(3);
    expect(await alertsRows()).toHaveLength(3);
    // The fourth stays unmarked, so the ordinary 7am alert still counts it.
    const all = await database.select().from(threads);
    expect(all.filter((t) => t.emergencyAlertedAt === null)).toHaveLength(1);
  });

  it("GUARDRAIL: at most 6 in a day", async () => {
    let now = new Date("2026-10-14T12:00:00Z"); // 8am
    for (let i = 0; i < 7; i++) {
      await emergency(plus(now, -min(2)));
      await run(now);
      now = plus(now, min(30));
    }
    expect(pushed).toHaveLength(6);
    expect(await alertsRows()).toHaveLength(6);
  });

  it("the night cap counts from 9pm across midnight", async () => {
    // 2 at 11pm, then 2 more after midnight: only one more fits tonight.
    let now = new Date("2026-10-14T03:00:00Z"); // 11pm Tue
    for (let i = 0; i < 2; i++) {
      await emergency(plus(now, -min(2)));
      await run(now);
      now = plus(now, min(20));
    }
    now = new Date("2026-10-14T05:00:00Z"); // 1am Wed
    for (let i = 0; i < 2; i++) {
      await emergency(plus(now, -min(2)));
      await run(now);
      now = plus(now, min(20));
    }
    expect(pushed).toHaveLength(3);
  });

  it("GUARDRAIL: the owner's switch off → no emergency alert (emergencies wait like any email)", async () => {
    await setEmergencyAlerts(workspaceId, false);
    await emergency(plus(TWO_AM_NY, -min(5)));
    expect((await run(TWO_AM_NY)).sent).toBe(0);
    expect(pushed).toEqual([]);
    const [changed] = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "emergency_alerts_changed"));
    expect(changed!.detail).toEqual({ enabled: false });
    expect(describeActivity(changed!.action, changed!.detail, null)).toBe(
      "You turned off emergency alerts at night",
    );
    // On again: it goes out.
    await setEmergencyAlerts(workspaceId, true);
    expect((await run(TWO_AM_NY)).sent).toBe(1);
  });

  it("GUARDRAIL: never for a read-only account", async () => {
    await database
      .update(workspaces)
      .set({ status: "evaluation_expired" })
      .where(eq(workspaces.id, workspaceId));
    await emergency(plus(TWO_AM_NY, -min(5)));
    expect((await run(TWO_AM_NY)).sent).toBe(0);
    await database
      .update(workspaces)
      .set({ status: "paused" })
      .where(eq(workspaces.id, workspaceId));
    expect((await run(TWO_AM_NY)).sent).toBe(0);
    expect(pushed).toEqual([]);
  });

  it("GUARDRAIL: never for a mailbox that isn't active, injection, a no-reply sender or a non-lead", async () => {
    const now = TWO_AM_NY;
    await emergency(plus(now, -min(5)), {}, { extracted: { injection: true } });
    await emergency(plus(now, -min(5)), {}, { from: "noreply@alarms.example" });
    // A website form robot with the customer in Reply-To is a person: it would alert, but
    // a robot whose Reply-To is also a robot is not.
    await emergency(
      plus(now, -min(5)),
      {},
      {
        from: "no-reply@forms.example",
        replyTo: "donotreply@forms.example",
      },
    );
    await emergency(plus(now, -min(5)), { category: "supplier_vendor" });
    await emergency(plus(now, -min(5)), { category: "noise" });
    await emergency(plus(now, -min(5)), { inInbox: false });
    await emergency(plus(now, -min(5)), { needsOwner: false });
    expect(await emergencyCandidates(workspaceId, now)).toEqual([]);
    expect((await run(now)).sent).toBe(0);

    const ok = await emergency(plus(now, -min(5)));
    await database
      .update(mailboxes)
      .set({ status: "reconnect_needed" })
      .where(eq(mailboxes.id, mailboxId));
    expect((await run(now)).sent).toBe(0);
    await database.update(mailboxes).set({ status: "active" }).where(eq(mailboxes.id, mailboxId));
    expect((await emergencyCandidates(workspaceId, now)).map((c) => c.threadId)).toEqual([ok.id]);
    expect(pushed).toEqual([]);
  });

  it("a gas smell counts (the gas rule marks it an emergency); a form lead with a real Reply-To counts", async () => {
    const now = TWO_AM_NY;
    const gas = await emergency(plus(now, -min(5)), {}, { extracted: { gas_smell: true } });
    const form = await emergency(
      plus(now, -min(6)),
      {},
      {
        from: "no-reply@forms.example",
        replyTo: "secret-dana@customer.example",
      },
    );
    const ids = (await emergencyCandidates(workspaceId, now)).map((c) => c.threadId);
    expect(ids).toEqual([gas.id, form.id]);
    expect((await run(now)).sent).toBe(1);
    const [row] = await alertsRows();
    expect(row!.detail).toMatchObject({ emergencies: 2 });
  });

  it("only fresh, already-sorted, unanswered emergencies", async () => {
    const now = TWO_AM_NY;
    // Written 2 hours ago (an outage, a backfill): the ordinary alerts handle it.
    await emergency(plus(now, -min(120)), { classifiedAt: plus(now, -min(1)) });
    // An older emergency thread whose newest email isn't sorted yet.
    const pending = await emergency(plus(now, -min(30)));
    await database.insert(messages).values({
      threadId: pending.id,
      mailboxId,
      gmailMessageId: "m-unsorted",
      direction: "in",
      fromAddress: "secret-dana@customer.example",
      toAddresses: ["owner@shop.com"],
      sentAt: plus(now, -min(2)),
    });
    // The owner already answered by phone, or by email, or a reply is in its undo window.
    const called = await emergency(plus(now, -min(10)), { handledOfflineAt: plus(now, -min(3)) });
    void called;
    const answered = await emergency(plus(now, -min(10)));
    await database.insert(messages).values({
      threadId: answered.id,
      mailboxId,
      gmailMessageId: "m-answer",
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["secret-dana@customer.example"],
      sentAt: plus(now, -min(4)),
    });
    const sending = await emergency(plus(now, -min(10)));
    await database.insert(drafts).values({
      threadId: sending.id,
      mailboxId,
      toAddress: "secret-dana@customer.example",
      subject: "Re",
      reason: "r",
      sendAfter: plus(now, min(1)),
    });
    // Snoozed by the owner (they've seen it).
    await emergency(plus(now, -min(10)), { snoozedUntil: plus(now, min(60)) });
    expect(await emergencyCandidates(workspaceId, now)).toEqual([]);
  });

  it("nothing reached a phone → the marks and the Activity row are taken back", async () => {
    const t = await emergency(plus(TWO_AM_NY, -min(5)));
    const r = await sendEmergencyAlerts(TWO_AM_NY, {
      push: async () => "not_configured",
      send: async () => "not_configured",
    });
    expect(r.sent).toBe(0);
    expect(await alertedAt(t.id)).toBeNull();
    expect(await alertsRows()).toEqual([]);
    // Next run, with a working phone: it goes out.
    expect((await run(plus(TWO_AM_NY, min(1)))).sent).toBe(1);
  });

  it("no phone and no texts set up → nothing claimed; a phone alone is enough", async () => {
    await database.delete(pushSubscriptions);
    const t = await emergency(plus(TWO_AM_NY, -min(5)));
    expect((await run(TWO_AM_NY)).sent).toBe(0);
    expect(await alertedAt(t.id)).toBeNull();
    await savePushSubscription(workspaceId, FCM);
    expect((await run(TWO_AM_NY)).sent).toBe(1);
    expect(texts).toEqual([]);
    expect(await alertedAt(t.id)).toEqual(TWO_AM_NY);
  });

  it("the ordinary new-lead alert leaves an alerted emergency out, until a later email is sorted", async () => {
    const now = NOON_NY;
    const t = await emergency(plus(now, -min(5)));
    await run(now);
    expect(await freshLeads(workspaceId, plus(now, -min(60)), plus(now, min(15)))).toEqual([]);
    // The push slot is the emergency's: the ordinary push waits 10 minutes.
    await emergency(plus(now, min(2)), { extracted: { urgency: "normal" } });
    expect((await sendPushAlerts(plus(now, min(5)), { push })).sent).toBe(0);
    expect((await sendPushAlerts(plus(now, min(11)), { push })).sent).toBe(1);
    // A later email on the emergency thread, sorted: it's an ordinary lead again.
    await database
      .update(threads)
      .set({ classifiedAt: plus(now, min(30)) })
      .where(eq(threads.id, t.id));
    expect(
      (await freshLeads(workspaceId, plus(now, min(20)), plus(now, min(31)))).map(
        (f) => f.classifiedAt,
      ),
    ).toHaveLength(1);
  });

  it("the phone's notification after an emergency push: the words and that card's link", async () => {
    const t = await emergency(plus(TWO_AM_NY, -min(5)));
    await run(TWO_AM_NY);
    const s = await emergencySummary(workspaceId, plus(TWO_AM_NY, 3000));
    expect(s).toEqual({ threadIds: [t.id] });
    const url = queueDeepLink(t.id);
    expect(url).toBe(`/queue?t=${t.id}#t-${t.id}`);
    expect(isNotificationUrl(url)).toBe(true);
    // The service worker's own allow-list takes the same link.
    expect(readFileSync("public/sw.js", "utf8")).toContain("CARD_URL.exec(u)");
    // A later ordinary push takes over the words.
    await profile({ pushLastSentAt: plus(TWO_AM_NY, min(11)) });
    expect(await emergencySummary(workspaceId, plus(TWO_AM_NY, min(12)))).toBeNull();
  });

  it("runs from the classify job (first) and the 15-minute backstop", () => {
    const src = readFileSync("src/jobs/functions.ts", "utf8");
    const after = src.slice(src.indexOf("async function alertsForMailbox"));
    expect(after.indexOf("sendEmergencyAlerts(")).toBeLessThan(after.indexOf("sendPushAlerts("));
    expect(src).toContain('step.run("emergency-alerts", () => sendEmergencyAlerts())');
  });
});
