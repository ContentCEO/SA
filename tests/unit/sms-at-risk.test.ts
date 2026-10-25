import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEAD_AT_RISK_PUSHES_PER_DAY } from "@/config/business-hours";
import type { Database } from "@/db";
import {
  activityLog,
  businessProfiles,
  mailboxes,
  messages,
  threads,
  workspaces,
} from "@/db/schema";
import { TwilioError, type OutgoingSms, type SmsSendResult } from "@/lib/sms";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { describeActivity } from "@/server/activity";
import { sendLeadAtRiskPushes } from "@/server/leads-at-risk";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { savePushSubscription } from "@/server/push-alerts";
import { sendLeadAlerts, SMS } from "@/server/sms-alerts";
import { atRiskTextBody, LAST_TEXT_OF_DAY } from "@/server/sms-summary-rules";
import { createTestDb } from "../support/db";

/**
 * Plan #50: leads at risk by text. Rides on the plan #34 push: same moment, same episode marks
 * (a lead is never alerted twice), the same daily allowance of at-risk alerts, plus the texts'
 * quiet hours, 10-minute slot and ten a day. Twilio is never called: the sender is injected.
 */

const min = (n: number) => n * 60_000;
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
// October 2026 is daylight time: New York is UTC-4.
const TUE_9 = new Date("2026-10-13T13:00:00Z");
const TUE_13_01 = new Date("2026-10-13T17:01:00Z");
const SUN_13 = new Date("2026-10-18T17:00:00Z");
const PHONE = "+15085551234";
const FCM = "https://fcm.googleapis.com/fcm/send/SECRET-ENDPOINT";
const SHAPE =
  /^Squared Away: \d+ quote (?:request has|requests have) waited over 4 hours\. Open: https:\/\/app\.example\/(?:quotes|queue\?t=[0-9a-f-]{36}#t-[0-9a-f-]{36})(?: That's today's last text; the rest wait in the app\.)?$/;

let database: Database;
let workspaceId: string;
let mailboxId: string;
let texts: OutgoingSms[];
let pushed: string[];
let sids = 0;
let n = 0;
const send = async (s: OutgoingSms): Promise<SmsSendResult> => {
  texts.push(s);
  return { status: "sent", sid: `SM${++sids}` };
};
const push = async (endpoint: string) => {
  pushed.push(endpoint);
  return "sent" as const;
};

async function profile(set: Partial<typeof businessProfiles.$inferInsert>) {
  await database
    .insert(businessProfiles)
    .values({ workspaceId, ...set })
    .onConflictDoUpdate({ target: businessProfiles.workspaceId, set });
}
const profileOf = async () =>
  (
    await database
      .select()
      .from(businessProfiles)
      .where(eq(businessProfiles.workspaceId, workspaceId))
  )[0]!;
const logs = () =>
  database.select().from(activityLog).where(eq(activityLog.action, "lead_at_risk_push_sent"));
const alertedAt = async (id: string) =>
  (await database.select().from(threads).where(eq(threads.id, id)))[0]!.atRiskAlertedAt;

async function textsOnFor(atRisk = true) {
  await profile({
    alertPhone: PHONE,
    alertPhoneVerifiedAt: plus(TUE_9, -min(60 * 24)),
    smsAlertsEnabled: true,
    smsAtRiskEnabled: atRisk,
    timeZone: "America/New_York",
  });
}

/** A quote request the customer sent at `at`, full of content a careless text could pick up. */
async function lead(at: Date, who = { name: "Dana Ruiz", email: "dana@customer.example" }) {
  n += 1;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: `t-${n}`,
      inInbox: true,
      category: "quote_request",
      priority: "normal",
      subject: `Deck at 12 Elm St for ${who.name}`,
      summary: `${who.name} wants a $4,250 deck`,
      classifiedAt: at,
      lastMessageAt: at,
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `m-${n}`,
    direction: "in",
    fromName: who.name,
    fromAddress: who.email,
    toAddresses: ["owner@shop.com"],
    subject: `Deck at 12 Elm St for ${who.name}`,
    bodyText: "$4,250?",
    sentAt: at,
  });
  return t!.id;
}
const synced = (now: Date) =>
  database.update(mailboxes).set({ lastSyncedAt: now }).where(eq(mailboxes.id, mailboxId));

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.APP_URL = "https://app.example";
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  database = await createTestDb();
  texts = [];
  pushed = [];
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
});

afterEach(() => {
  delete process.env.APP_URL;
});

describe("#50 leads at risk by text", () => {
  it("the words: counts and a link only", () => {
    expect(atRiskTextBody(2, "https://app.example/quotes")).toBe(
      "Squared Away: 2 quote requests have waited over 4 hours. Open: https://app.example/quotes",
    );
    expect(atRiskTextBody(1, "u", { lastToday: true })).toBe(
      `Squared Away: 1 quote request has waited over 4 hours. Open: u${LAST_TEXT_OF_DAY}`,
    );
  });

  it("off by default: text alerts on, the waiting-quote switch off → no text, no marks", async () => {
    await textsOnFor(false);
    const t = await lead(TUE_9);
    await synced(TUE_13_01);
    expect(await sendLeadAtRiskPushes(TUE_13_01, { send })).toEqual({ sent: 0 });
    expect(texts).toEqual([]);
    expect(await alertedAt(t)).toBeNull();
  });

  it("text only (no phone subscribed): one counts-only text, the leads marked, one Activity line", async () => {
    await textsOnFor();
    const a = await lead(TUE_9);
    const b = await lead(plus(TUE_9, min(1)), { name: "Priya Shah", email: "priya@x.example" });
    await synced(TUE_13_01);
    expect(await sendLeadAtRiskPushes(TUE_13_01, { send })).toEqual({ sent: 1 });
    expect(texts).toHaveLength(1);
    expect(texts[0]!.to).toBe(PHONE);
    // No draft on the queue for either: they wait on the quote list.
    expect(texts[0]!.body).toBe(
      "Squared Away: 2 quote requests have waited over 4 hours. Open: https://app.example/quotes",
    );
    expect(texts[0]!.body).toMatch(SHAPE);
    expect(texts[0]!.body).not.toMatch(/Dana|Priya|@|Elm|4,250/);
    expect((await alertedAt(a))?.toISOString()).toBe(TUE_13_01.toISOString());
    expect((await alertedAt(b))?.toISOString()).toBe(TUE_13_01.toISOString());
    const [log, ...rest] = await logs();
    expect(rest).toHaveLength(0);
    expect(Object.keys(log!.detail as object).sort()).toEqual([
      "deliveryId",
      "leads",
      "phones",
      "texted",
    ]);
    expect(log!.detail).toMatchObject({ leads: 2, phones: 0, texted: true });
    expect(JSON.stringify(log!.detail)).not.toMatch(/Dana|@|\+1508/);
    expect(describeActivity(log!.action, log!.detail as Record<string, unknown>, null)).toBe(
      "Let you know 2 quote requests were waiting",
    );
    expect((await profileOf()).smsLastSentAt?.toISOString()).toBe(TUE_13_01.toISOString());
  });

  it("with a phone too: push and text together, ONE episode — never alerted twice", async () => {
    await textsOnFor();
    await savePushSubscription(workspaceId, FCM);
    await lead(TUE_9);
    await synced(TUE_13_01);
    expect(await sendLeadAtRiskPushes(TUE_13_01, { push, send })).toEqual({ sent: 1 });
    expect(pushed).toEqual([FCM]);
    expect(texts).toHaveLength(1);
    expect(await logs()).toHaveLength(1);
    // Later runs, past both slots: the same wait is never alerted again by either.
    for (const m of [15, 30, 60]) {
      await synced(plus(TUE_13_01, min(m)));
      expect((await sendLeadAtRiskPushes(plus(TUE_13_01, min(m)), { push, send })).sent).toBe(0);
    }
    expect(pushed).toHaveLength(1);
    expect(texts).toHaveLength(1);
  });

  it("a new wait after the owner answered re-arms it (once per episode)", async () => {
    await textsOnFor();
    const t = await lead(TUE_9);
    await synced(TUE_13_01);
    await sendLeadAtRiskPushes(TUE_13_01, { send });
    // The owner answered, then the customer wrote again on Wednesday morning.
    const wed = new Date("2026-10-14T12:00:00Z");
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: "m-out",
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["dana@customer.example"],
      sentAt: plus(TUE_13_01, min(20)),
    });
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: "m-in-2",
      direction: "in",
      fromAddress: "dana@customer.example",
      toAddresses: ["owner@shop.com"],
      sentAt: wed,
    });
    await database.update(threads).set({ lastMessageAt: wed }).where(eq(threads.id, t));
    const later = new Date("2026-10-14T17:30:00Z");
    await synced(later);
    expect((await sendLeadAtRiskPushes(later, { send })).sent).toBe(1);
    expect(texts).toHaveLength(2);
  });

  it("GATE: never outside business hours or in quiet hours", async () => {
    await textsOnFor();
    await lead(plus(SUN_13, -min(60 * 30)));
    await synced(SUN_13);
    expect((await sendLeadAtRiskPushes(SUN_13, { send })).sent).toBe(0); // Sunday
    // Business hours that run late can't beat quiet hours (9pm–7am).
    await profile({ workDays: [1, 2, 3, 4, 5, 6, 7], workStartHour: 0, workEndHour: 24 });
    const tue22 = new Date("2026-10-14T02:00:00Z"); // Tue 10pm Eastern
    await lead(plus(tue22, -min(60 * 6)));
    await synced(tue22);
    expect((await sendLeadAtRiskPushes(tue22, { send })).sent).toBe(0);
    expect(texts).toEqual([]);
  });

  it("GATE: read-only accounts get no text and no marks", async () => {
    await textsOnFor();
    const t = await lead(TUE_9);
    await synced(TUE_13_01);
    for (const c of [
      { status: "evaluation_expired" },
      { status: "past_due" },
      { status: "canceled" },
      { status: "paused" },
    ] as const) {
      await database.update(workspaces).set(c).where(eq(workspaces.id, workspaceId));
      expect((await sendLeadAtRiskPushes(TUE_13_01, { send })).sent).toBe(0);
    }
    expect(texts).toEqual([]);
    expect(await alertedAt(t)).toBeNull();
    expect(await logs()).toHaveLength(0);
  });

  it("GATE: STOP on the send turns every text off; marks back when nothing else reached them", async () => {
    await textsOnFor();
    await profile({ smsSummaryEnabled: true });
    const t = await lead(TUE_9);
    await synced(TUE_13_01);
    expect((await sendLeadAtRiskPushes(TUE_13_01, { send: async () => "opted_out" })).sent).toBe(0);
    const p = await profileOf();
    expect([p.smsAlertsEnabled, p.smsSummaryEnabled, p.smsAtRiskEnabled]).toEqual([
      false,
      false,
      false,
    ]);
    expect(p.smsStoppedReason).toBe("opted_out");
    expect(p.smsLastSentAt).toBeNull();
    expect(await alertedAt(t)).toBeNull();
    expect(await logs()).toHaveLength(0);
    // Never texted again.
    await synced(plus(TUE_13_01, min(20)));
    await sendLeadAtRiskPushes(plus(TUE_13_01, min(20)), { send });
    expect(texts).toEqual([]);
  });

  it("a refused text: the slot goes back; with a push delivered the episode still counts", async () => {
    await textsOnFor();
    await savePushSubscription(workspaceId, FCM);
    const t = await lead(TUE_9);
    await synced(TUE_13_01);
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    try {
      const r = await sendLeadAtRiskPushes(TUE_13_01, {
        push,
        send: async () => {
          throw new TwilioError(503);
        },
      });
      expect(r.sent).toBe(1);
    } finally {
      console.error = orig;
    }
    expect(JSON.stringify(errors)).toContain("lead_at_risk_text_failed");
    expect(JSON.stringify(errors)).not.toMatch(/Dana|@|\+1508|Twilio 503/);
    expect((await profileOf()).smsLastSentAt).toBeNull();
    expect(await alertedAt(t)).not.toBeNull();
    const [log] = await logs();
    expect(log!.detail).toEqual({ leads: 1, phones: 1 });
  });

  it("a refused text with no phone: marks back, no Activity, slot back (the next run tries again)", async () => {
    await textsOnFor();
    const t = await lead(TUE_9);
    await synced(TUE_13_01);
    const orig = console.error;
    console.error = () => {};
    try {
      await sendLeadAtRiskPushes(TUE_13_01, {
        send: async () => {
          throw new TwilioError(500);
        },
      });
    } finally {
      console.error = orig;
    }
    expect(await alertedAt(t)).toBeNull();
    expect(await logs()).toHaveLength(0);
    expect((await profileOf()).smsLastSentAt).toBeNull();
    expect((await sendLeadAtRiskPushes(plus(TUE_13_01, min(1)), { send })).sent).toBe(1);
  });

  it("GATE: Twilio not set up → no text, no marks, nothing logged", async () => {
    await textsOnFor();
    const t = await lead(TUE_9);
    await synced(TUE_13_01);
    expect(await sendLeadAtRiskPushes(TUE_13_01)).toEqual({ sent: 0, notConfigured: true });
    expect(
      (await sendLeadAtRiskPushes(TUE_13_01, { send: async () => "not_configured" })).sent,
    ).toBe(0);
    expect(await alertedAt(t)).toBeNull();
    expect(await logs()).toHaveLength(0);
    expect((await profileOf()).smsLastSentAt).toBeNull();
  });

  it("CAP: shares the 10-minute text slot and the ten a day (the push still goes)", async () => {
    await textsOnFor();
    await savePushSubscription(workspaceId, FCM);
    await lead(TUE_9);
    await synced(TUE_13_01);
    // A new-lead text 5 minutes ago: no text now, the push alone.
    await profile({ smsLastSentAt: plus(TUE_13_01, -min(5)) });
    expect((await sendLeadAtRiskPushes(TUE_13_01, { push, send })).sent).toBe(1);
    expect(pushed).toHaveLength(1);
    expect(texts).toEqual([]);
    expect((await logs())[0]!.detail).toEqual({ leads: 1, phones: 1 });

    // Ten texts today: the next episode goes by push only.
    await database.delete(activityLog);
    await profile({ smsLastSentAt: null });
    for (let i = 0; i < SMS.dailyCap; i++)
      await database.insert(activityLog).values({
        workspaceId,
        actor: "squared_away",
        action: "sms_summary_sent",
        detail: {},
        createdAt: plus(TUE_9, min(i)),
      });
    await lead(plus(TUE_9, min(2)));
    await database.update(businessProfiles).set({ pushLastSentAt: null });
    expect((await sendLeadAtRiskPushes(plus(TUE_13_01, min(2)), { push, send })).sent).toBe(1);
    expect(texts).toEqual([]);
  });

  it("CAP: the tenth text says it's the last; at-risk texts count toward the new-lead texts' ten", async () => {
    await textsOnFor();
    for (let i = 0; i < SMS.dailyCap - 1; i++)
      await database.insert(activityLog).values({
        workspaceId,
        actor: "squared_away",
        action: "sms_alert_sent",
        detail: {},
        createdAt: plus(TUE_9, min(i)),
      });
    await lead(TUE_9);
    await synced(TUE_13_01);
    await sendLeadAtRiskPushes(TUE_13_01, { send });
    expect(texts[0]!.body.endsWith(LAST_TEXT_OF_DAY)).toBe(true);
    // Now ten: a new-lead text is refused by the shared cap.
    await lead(plus(TUE_13_01, min(20)));
    expect((await sendLeadAlerts(plus(TUE_13_01, min(30)), { send })).sent).toBe(0);
    expect(texts).toHaveLength(1);
  });

  it(`CAP: at most ${LEAD_AT_RISK_PUSHES_PER_DAY} at-risk alerts a local day, push or text`, async () => {
    await textsOnFor();
    for (let i = 0; i < LEAD_AT_RISK_PUSHES_PER_DAY + 2; i++) {
      await lead(plus(TUE_9, min(i)));
      const now = plus(TUE_13_01, min(i * 11));
      await synced(now);
      await sendLeadAtRiskPushes(now, { send });
    }
    expect(texts).toHaveLength(LEAD_AT_RISK_PUSHES_PER_DAY);
    expect(await logs()).toHaveLength(LEAD_AT_RISK_PUSHES_PER_DAY);
    for (const t of texts) expect(t.body).toMatch(SHAPE);
  });

  it("two runs at once alert once", async () => {
    await textsOnFor();
    await lead(TUE_9);
    await synced(TUE_13_01);
    const runs = await Promise.all([
      sendLeadAtRiskPushes(TUE_13_01, { send }),
      sendLeadAtRiskPushes(TUE_13_01, { send }),
    ]);
    expect(runs.reduce((s, r) => s + r.sent, 0)).toBe(1);
    expect(texts).toHaveLength(1);
  });
});
