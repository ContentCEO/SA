import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import {
  activityLog,
  businessProfiles,
  drafts,
  messages,
  smsDeliveries,
  threads,
  workspaces,
} from "@/db/schema";
import { TwilioError, type OutgoingSms, type SmsSendResult } from "@/lib/sms";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { describeActivity } from "@/server/activity";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { applyTwilioStatus } from "@/server/sms-deliveries";
import { removeAlertPhone, setExtraText, SMS, SmsError } from "@/server/sms-alerts";
import { sendSummaryTexts } from "@/server/sms-summary";
import {
  LAST_TEXT_OF_DAY,
  SUMMARY_TEXT_LAST_HOUR,
  summaryTextBody,
  summaryTextDue,
} from "@/server/sms-summary-rules";
import { createTestDb } from "../support/db";

/**
 * Plan #50: the morning summary by text. Counts and a link, once a local day at the morning
 * email's hour, its own opt-in, never at night, never for read-only accounts, never after STOP,
 * inside the shared caps; nothing sent or marked without Twilio. Twilio is never called: the
 * sender is injected.
 */

// Tuesday 8:30am Eastern (October: UTC-4).
const MORNING = new Date("2026-10-13T12:30:00Z");
const at = (iso: string) => new Date(iso);
const min = (n: number) => n * 60_000;
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const PHONE = "+15085551234";
const BODY_SHAPE =
  /^Squared Away: \d+ (?:reply|replies|follow-ups?|needs? you)(?: ready)?(?:, \d+ (?:reply|replies|follow-ups?|needs? you)(?: ready)?)*\. Open: https:\/\/app\.example\/(?:queue|quotes)(?: That's today's last text; the rest wait in the app\.)?$/;

let database: Database;
let workspaceId: string;
let mailboxId: string;
let texts: OutgoingSms[];
let sids = 0;
let n = 0;
const send = async (s: OutgoingSms): Promise<SmsSendResult> => {
  texts.push(s);
  return { status: "sent", sid: `SM${++sids}` };
};

async function profile(set: Partial<typeof businessProfiles.$inferInsert>, ws = workspaceId) {
  await database
    .insert(businessProfiles)
    .values({ workspaceId: ws, ...set })
    .onConflictDoUpdate({ target: businessProfiles.workspaceId, set });
}
const profileOf = async (ws = workspaceId) =>
  (await database.select().from(businessProfiles).where(eq(businessProfiles.workspaceId, ws)))[0]!;

/** A confirmed number with text alerts on (and, unless told otherwise, the summary on). */
async function textsOnFor(ws = workspaceId, summary = true, phone = PHONE) {
  await profile(
    {
      alertPhone: phone,
      alertPhoneVerifiedAt: plus(MORNING, -min(60 * 24)),
      smsAlertsEnabled: true,
      smsSummaryEnabled: summary,
      timeZone: "America/New_York",
      digestHour: 7,
    },
    ws,
  );
}

/** A thread that needs the owner, full of customer content a careless text could pick up. */
async function needsYou(
  c: { name: string; email: string; subject: string; amount: string },
  box = mailboxId,
) {
  n += 1;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId: box,
      gmailThreadId: `t-${n}`,
      inInbox: true,
      category: "customer_question",
      needsOwner: true,
      needsOwnerReason: `${c.name} says ${c.amount} is too much`,
      subject: c.subject,
      summary: `${c.name} (${c.email}) asks about ${c.subject} for ${c.amount}`,
      classifiedAt: plus(MORNING, -min(120)),
      lastMessageAt: plus(MORNING, -min(120)),
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId: box,
    gmailMessageId: `m-${n}`,
    direction: "in",
    fromName: c.name,
    fromAddress: c.email,
    subject: c.subject,
    bodyText: `Hi, ${c.name} here. ${c.amount}?`,
    sentAt: plus(MORNING, -min(120)),
  });
  return t!.id;
}

/** A drafted reply (or follow-up) waiting on the queue. */
async function ready(
  c: { name: string; email: string; subject: string; amount: string },
  kind: "reply" | "followup" = "reply",
) {
  n += 1;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: `t-${n}`,
      inInbox: true,
      category: "customer_question",
      subject: c.subject,
      summary: `${c.name} wants ${c.amount}`,
      classifiedAt: plus(MORNING, -min(90)),
      lastMessageAt: plus(MORNING, -min(90)),
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `m-${n}`,
    direction: "in",
    fromName: c.name,
    fromAddress: c.email,
    subject: c.subject,
    bodyText: c.amount,
    sentAt: plus(MORNING, -min(90)),
  });
  await database.insert(drafts).values({
    threadId: t!.id,
    mailboxId,
    gmailDraftId: `d-${n}`,
    kind,
    toAddress: c.email,
    subject: `Re: ${c.subject}`,
    body: `Hi ${c.name}, that's ${c.amount}.`,
    originalBody: `Hi ${c.name}, that's ${c.amount}.`,
    reason: `${c.name} asked`,
    promptVersion: "draft.v5",
    createdAt: plus(MORNING, -min(60)),
  });
}

const DANA = {
  name: "Dana Ruiz",
  email: "dana.ruiz@customer.example",
  subject: "Deck at 12 Elm St",
  amount: "$4,250",
};
const logs = (action = "sms_summary_sent") =>
  database.select().from(activityLog).where(eq(activityLog.action, action));

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.APP_URL = "https://app.example";
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_MESSAGING_SERVICE_SID;
  delete process.env.TWILIO_FROM_NUMBER;
  database = await createTestDb();
  texts = [];
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

describe("#50 the words (pure)", () => {
  it("counts and a link, nothing else; a quiet morning is no text", () => {
    expect(summaryTextBody({ replies: 3, followups: 0, needsYou: 1 }, "https://x/queue")).toBe(
      "Squared Away: 3 replies ready, 1 needs you. Open: https://x/queue",
    );
    expect(summaryTextBody({ replies: 1, followups: 2, needsYou: 2 }, "u")).toBe(
      "Squared Away: 1 reply ready, 2 follow-ups ready, 2 need you. Open: u",
    );
    expect(
      summaryTextBody({ replies: 0, followups: 1, needsYou: 0 }, "u", { lastToday: true }),
    ).toBe(`Squared Away: 1 follow-up ready. Open: u${LAST_TEXT_OF_DAY}`);
    expect(summaryTextBody({ replies: 0, followups: 0, needsYou: 0 }, "u")).toBeNull();
  });

  it("PROPERTY: any counts give the fixed shape (digits and fixed words only)", () => {
    let seed = 7;
    const rnd = (k: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % k;
    };
    for (let i = 0; i < 500; i++) {
      const pick = () => [0, 1, 2, 9, 37, 120, -3, 2.7, Number.NaN][rnd(9)]!;
      const body = summaryTextBody(
        { replies: pick(), followups: pick(), needsYou: pick() },
        rnd(2) ? "https://app.example/queue" : "https://app.example/quotes",
        { lastToday: rnd(4) === 0 },
      );
      if (body === null) continue;
      expect(body).toMatch(BODY_SHAPE);
      expect(body).not.toMatch(/NaN|-\d|\d\.\d/);
    }
  });

  it("due once a local day, from the morning email's hour until noon", () => {
    const s = { digestHour: 7, lastSentOn: null };
    expect(summaryTextDue(s, { date: "2026-10-13", hour: 6 })).toBe(false);
    expect(summaryTextDue(s, { date: "2026-10-13", hour: 7 })).toBe(true);
    expect(summaryTextDue(s, { date: "2026-10-13", hour: SUMMARY_TEXT_LAST_HOUR - 1 })).toBe(true);
    expect(summaryTextDue(s, { date: "2026-10-13", hour: SUMMARY_TEXT_LAST_HOUR })).toBe(false);
    expect(
      summaryTextDue({ ...s, lastSentOn: "2026-10-13" }, { date: "2026-10-13", hour: 8 }),
    ).toBe(false);
  });
});

describe("#50 the morning summary by text", () => {
  it("off by default: a confirmed number with text alerts on gets no summary text", async () => {
    await textsOnFor(workspaceId, false);
    await needsYou(DANA);
    expect((await sendSummaryTexts(MORNING, { send })).sent).toBe(0);
    expect(texts).toEqual([]);
    expect((await profileOf()).smsSummaryLastSentOn).toBeNull();
  });

  it("one text a local day with counts and a link; marked after Twilio took it; Activity counts only", async () => {
    await textsOnFor();
    await ready(DANA);
    await needsYou({ ...DANA, name: "Priya Shah", email: "priya@x.example" });
    await needsYou({ ...DANA, name: "Mo Ali", email: "mo@y.example" });
    expect(await sendSummaryTexts(MORNING, { send })).toEqual({
      sent: 1,
      quiet: 0,
      failed: 0,
      notConfigured: false,
    });
    expect(texts).toHaveLength(1);
    expect(texts[0]!.to).toBe(PHONE);
    expect(texts[0]!.body).toBe(
      "Squared Away: 1 reply ready, 2 need you. Open: https://app.example/queue",
    );
    expect(texts[0]!.validitySec).toBeGreaterThan(0);
    expect((await profileOf()).smsSummaryLastSentOn).toBe("2026-10-13");
    const [log] = await logs();
    expect(Object.keys(log!.detail as object).sort()).toEqual([
      "deliveryId",
      "followups",
      "needsYou",
      "replies",
    ]);
    expect(JSON.stringify(log!.detail)).not.toMatch(/Dana|Priya|@|Elm|4,250|\+1508/);
    expect(describeActivity(log!.action, log!.detail as Record<string, unknown>, null)).toBe(
      "Sent this morning's summary to your phone by text",
    );
    expect(await database.select().from(smsDeliveries)).toHaveLength(1);

    // Later runs that day: nothing (once a day, even past the 10-minute gap).
    for (const m of [15, 75, 135])
      expect((await sendSummaryTexts(plus(MORNING, min(m)), { send })).sent).toBe(0);
    // The next morning: again.
    expect((await sendSummaryTexts(plus(MORNING, min(24 * 60)), { send })).sent).toBe(1);
    expect(texts).toHaveLength(2);
  });

  it("waits for the owner's hour, never after noon, and never in quiet hours (a 5am hour waits for 7am)", async () => {
    await textsOnFor();
    await profile({ digestHour: 9 });
    await needsYou(DANA);
    expect((await sendSummaryTexts(MORNING, { send })).sent).toBe(0); // 8:30 < 9
    expect((await sendSummaryTexts(at("2026-10-13T16:05:00Z"), { send })).sent).toBe(0); // 12:05pm
    expect(texts).toEqual([]);

    await profile({ digestHour: 5 });
    expect((await sendSummaryTexts(at("2026-10-14T09:30:00Z"), { send })).sent).toBe(0); // 5:30am
    expect((await sendSummaryTexts(at("2026-10-14T10:55:00Z"), { send })).sent).toBe(0); // 6:55am
    expect((await profileOf()).smsSummaryLastSentOn).not.toBe("2026-10-14");
    expect((await sendSummaryTexts(at("2026-10-14T11:03:00Z"), { send })).sent).toBe(1); // 7:03am
  });

  it("follows the owner's time zone", async () => {
    await textsOnFor();
    await profile({ timeZone: "America/Los_Angeles" });
    await needsYou(DANA);
    // 8:30am Eastern is 5:30am in Los Angeles: not yet.
    expect((await sendSummaryTexts(MORNING, { send })).sent).toBe(0);
    // 7:10am in Los Angeles.
    expect((await sendSummaryTexts(at("2026-10-13T14:10:00Z"), { send })).sent).toBe(1);
  });

  it("its own switch: goes out with the morning email turned off", async () => {
    await textsOnFor();
    await profile({ digestEnabled: false });
    await needsYou(DANA);
    expect((await sendSummaryTexts(MORNING, { send })).sent).toBe(1);
  });

  it("a quiet morning: no text, and the day is done (no afternoon text when mail comes in)", async () => {
    await textsOnFor();
    expect(await sendSummaryTexts(MORNING, { send })).toMatchObject({ sent: 0, quiet: 1 });
    expect((await profileOf()).smsSummaryLastSentOn).toBe("2026-10-13");
    await needsYou(DANA);
    expect((await sendSummaryTexts(plus(MORNING, min(60)), { send })).sent).toBe(0);
    expect(texts).toEqual([]);
    expect(await logs()).toHaveLength(0);
  });

  it("GATE: read-only accounts get no text and no marker", async () => {
    await textsOnFor();
    await needsYou(DANA);
    const cases: Partial<typeof workspaces.$inferInsert>[] = [
      { status: "evaluation_expired" },
      { status: "evaluating", evaluationEndsAt: plus(MORNING, -min(60)) },
      { status: "past_due" },
      { status: "canceled" },
      { status: "paused" },
    ];
    for (const c of cases) {
      await database.update(workspaces).set(c).where(eq(workspaces.id, workspaceId));
      expect((await sendSummaryTexts(MORNING, { send })).sent, JSON.stringify(c)).toBe(0);
    }
    expect(texts).toEqual([]);
    expect((await profileOf()).smsSummaryLastSentOn).toBeNull();
    expect(await logs()).toHaveLength(0);
  });

  it("GATE: text alerts off, no confirmed number, or a STOP on file → no text", async () => {
    await textsOnFor();
    await needsYou(DANA);
    await profile({ smsAlertsEnabled: false });
    expect((await sendSummaryTexts(MORNING, { send })).sent).toBe(0);
    await profile({ smsAlertsEnabled: true, alertPhoneVerifiedAt: null });
    expect((await sendSummaryTexts(MORNING, { send })).sent).toBe(0);
    await profile({ alertPhoneVerifiedAt: MORNING, smsStoppedReason: "opted_out" });
    expect((await sendSummaryTexts(MORNING, { send })).sent).toBe(0);
    expect(texts).toEqual([]);
  });

  it("GATE: STOP on the send turns every text off; nothing marked; never texted again", async () => {
    await textsOnFor();
    await profile({ smsAtRiskEnabled: true });
    await needsYou(DANA);
    const r = await sendSummaryTexts(MORNING, { send: async () => "opted_out" });
    expect(r.sent).toBe(0);
    const p = await profileOf();
    expect([p.smsAlertsEnabled, p.smsSummaryEnabled, p.smsAtRiskEnabled]).toEqual([
      false,
      false,
      false,
    ]);
    expect(p.smsStoppedReason).toBe("opted_out");
    expect(p.smsSummaryLastSentOn).toBeNull();
    expect(p.smsLastSentAt).toBeNull(); // the slot went back
    expect((await sendSummaryTexts(plus(MORNING, min(30)), { send })).sent).toBe(0);
    expect(texts).toEqual([]);
  });

  it("GATE: a STOP in a delivery report turns the summary and waiting-quote texts off too", async () => {
    await textsOnFor();
    await profile({ smsAtRiskEnabled: true });
    await needsYou(DANA);
    await sendSummaryTexts(MORNING, { send });
    await applyTwilioStatus("SM" + sids, "undelivered", 21610, plus(MORNING, min(1)));
    const p = await profileOf();
    expect([p.smsAlertsEnabled, p.smsSummaryEnabled, p.smsAtRiskEnabled]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("'Remove my number' turns every text off", async () => {
    await textsOnFor();
    await profile({ smsAtRiskEnabled: true });
    await removeAlertPhone(workspaceId);
    const p = await profileOf();
    expect([p.smsAlertsEnabled, p.smsSummaryEnabled, p.smsAtRiskEnabled]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("CAP: shares the ten a day and the 10-minute gap; the tenth says it's the last", async () => {
    await textsOnFor();
    await needsYou(DANA);
    const dayStart = at("2026-10-13T04:30:00Z"); // 12:30am Eastern
    // Ten new-lead texts already today → no summary.
    for (let i = 0; i < SMS.dailyCap; i++)
      await database.insert(activityLog).values({
        workspaceId,
        actor: "squared_away",
        action: "sms_alert_sent",
        detail: { quotes: 1, needsYou: 0 },
        createdAt: plus(dayStart, min(i)),
      });
    expect((await sendSummaryTexts(MORNING, { send })).sent).toBe(0);
    expect((await profileOf()).smsSummaryLastSentOn).toBeNull();

    // Nine → the summary goes and is the tenth.
    const [one] = await logs("sms_alert_sent");
    await database.delete(activityLog).where(eq(activityLog.id, one!.id));
    // ...but not within 10 minutes of the last text.
    await profile({ smsLastSentAt: plus(MORNING, -min(5)) });
    expect((await sendSummaryTexts(MORNING, { send })).sent).toBe(0);
    await profile({ smsLastSentAt: plus(MORNING, -min(11)) });
    expect((await sendSummaryTexts(MORNING, { send })).sent).toBe(1);
    expect(texts[0]!.body.endsWith(LAST_TEXT_OF_DAY)).toBe(true);
    expect((await profileOf()).smsLastSentAt?.toISOString()).toBe(MORNING.toISOString());
  });

  it("two runs at once text once", async () => {
    await textsOnFor();
    await needsYou(DANA);
    const runs = await Promise.all([
      sendSummaryTexts(MORNING, { send }),
      sendSummaryTexts(MORNING, { send }),
    ]);
    expect(runs.reduce((s, r) => s + r.sent, 0)).toBe(1);
    expect(texts).toHaveLength(1);
    expect(await logs()).toHaveLength(1);
  });

  it("GATE: Twilio not set up → nothing sent, nothing marked, and it says so", async () => {
    await textsOnFor();
    await needsYou(DANA);
    expect(await sendSummaryTexts(MORNING)).toMatchObject({ sent: 0, notConfigured: true });
    expect(await sendSummaryTexts(MORNING, { send: async () => "not_configured" })).toMatchObject({
      sent: 0,
      notConfigured: true,
    });
    const p = await profileOf();
    expect(p.smsSummaryLastSentOn).toBeNull();
    expect(p.smsLastSentAt).toBeNull();
    expect(await logs()).toHaveLength(0);
    // Once it is: the same morning's text goes.
    expect((await sendSummaryTexts(plus(MORNING, min(1)), { send })).sent).toBe(1);
  });

  it("a refused text: slot back, day unmarked, error log names no content, the next owner still gets theirs", async () => {
    await textsOnFor();
    await needsYou(DANA);
    const { workspace: other } = await ensureUserAndWorkspace({ email: "two@shop.com" });
    await database.update(workspaces).set({ status: "active" }).where(eq(workspaces.id, other.id));
    const box2 = (
      await saveConnectedMailbox(other, {
        email: "two@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
    await textsOnFor(other.id, true, "+16175550000");
    await needsYou(DANA, box2);
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    try {
      const r = await sendSummaryTexts(MORNING, {
        send: async (s) => {
          if (s.to === PHONE) throw new TwilioError(500);
          return send(s);
        },
      });
      expect(r).toMatchObject({ sent: 1, failed: 1 });
    } finally {
      console.error = orig;
    }
    expect(JSON.stringify(errors)).toContain("sms_summary_failed");
    expect(JSON.stringify(errors)).not.toMatch(/Dana|@|\+1508|\+1617|Elm|Twilio 500/);
    const failed = await profileOf();
    expect(failed.smsSummaryLastSentOn).toBeNull();
    expect(failed.smsLastSentAt).toBeNull();
    expect((await profileOf(other.id)).smsSummaryLastSentOn).toBe("2026-10-13");
    expect(texts.map((t) => t.to)).toEqual(["+16175550000"]);
  });

  it("GUARDRAIL PROPERTY: no customer name, email, subject or amount can reach a text", async () => {
    await textsOnFor();
    const people = [
      {
        name: "Dana Ruiz",
        email: "dana.ruiz@customer.example",
        subject: "Deck at 12 Elm St",
        amount: "$4,250",
      },
      {
        name: "Priya O'Neil",
        email: "priya+jobs@mail.example",
        subject: "Leaky faucet, 7 Oak Ave",
        amount: "$180.50",
      },
      {
        name: "José Núñez",
        email: "jose@núñez.example",
        subject: "Panel upgrade 200A",
        amount: "1,999 dollars",
      },
      { name: "Kim 9 Lee", email: "kim9@x.example", subject: "Re: Invoice #4471", amount: "$12k" },
      {
        name: "Bob https://evil.example",
        email: "bob@evil.example",
        subject: "Pay now https://evil.example/pay",
        amount: "$1",
      },
    ];
    let seed = 11;
    const rnd = (k: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % k;
    };
    let day = 0;
    for (let round = 0; round < 6; round++) {
      await database.delete(drafts);
      await database.delete(messages);
      await database.delete(threads);
      const k = 1 + rnd(4);
      for (let i = 0; i < k; i++) {
        const who = people[rnd(people.length)]!;
        const what = rnd(3);
        if (what === 0) await needsYou(who);
        else await ready(who, what === 1 ? "reply" : "followup");
      }
      const now = plus(MORNING, min(24 * 60 * day++));
      // The fixtures are dated from MORNING; keep them fresh on later days.
      await database.update(threads).set({ lastMessageAt: plus(now, -min(60)) });
      texts = [];
      await sendSummaryTexts(now, { send });
      expect(texts.length, `round ${round}`).toBe(1);
      const body = texts[0]!.body;
      expect(body).toMatch(BODY_SHAPE);
      for (const p of people)
        for (const v of Object.values(p)) {
          expect(body).not.toContain(v);
          for (const word of v.split(/[\s,]+/).filter((w) => w.length > 3 && !/^\d+$/.test(w)))
            expect(body.toLowerCase()).not.toContain(word.toLowerCase());
        }
    }
  });
});

describe("#50 the switches", () => {
  it("need a confirmed number and text alerts on; each logs one Activity line", async () => {
    await expect(setExtraText(workspaceId, "summary", true)).rejects.toBeInstanceOf(SmsError);
    await textsOnFor(workspaceId, false);
    await profile({ smsAlertsEnabled: false });
    await expect(setExtraText(workspaceId, "at_risk", true)).rejects.toBeInstanceOf(SmsError);
    await profile({ smsAlertsEnabled: true });
    await setExtraText(workspaceId, "summary", true);
    await setExtraText(workspaceId, "at_risk", true);
    let p = await profileOf();
    expect([p.smsSummaryEnabled, p.smsAtRiskEnabled]).toEqual([true, true]);
    await setExtraText(workspaceId, "summary", false);
    p = await profileOf();
    expect([p.smsSummaryEnabled, p.smsAtRiskEnabled]).toEqual([false, true]);
    const lines = (await logs("sms_alerts_changed")).map((l) =>
      describeActivity(l.action, l.detail as Record<string, unknown>, null),
    );
    expect(lines).toEqual([
      "You turned on the morning summary by text",
      "You turned on texts about waiting quote requests",
      "You turned off the morning summary by text",
    ]);
    // Turning off never needs a number.
    await removeAlertPhone(workspaceId);
    await setExtraText(workspaceId, "at_risk", false);
  });
});
