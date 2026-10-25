import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { activityLog, businessProfiles, messages, threads, workspaces } from "@/db/schema";
import { sendSms, TwilioError, TWILIO_OPTED_OUT_CODE, type OutgoingSms } from "@/lib/sms";
import { SCREEN_MESSAGES } from "@/app/(app)/settings/messages";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import {
  confirmPhone,
  sendLeadAlerts,
  SMS,
  SmsError,
  startPhoneVerification,
} from "@/server/sms-alerts";
import { hourWord, STOPPED_LINES, textsConsentCopy } from "@/server/sms-delivery-rules";
import { createTestDb } from "../support/db";

/**
 * Check 27 P6: carriers' consent rules, and hearing STOP on the send path. Twilio's 21610 on a
 * send switches that owner's texts off (with the reason the screen shows) and the loop goes on
 * to the next owner; any other refusal for one owner never stops the others.
 */

const NOW = new Date("2026-10-10T18:00:00Z"); // 2pm Eastern
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);

let database: Database;
let texts: OutgoingSms[];
let sids = 0;
const okSend = async (s: OutgoingSms) => {
  texts.push(s);
  return { status: "sent" as const, sid: `SM${++sids}` };
};

type Owner = { workspaceId: string; mailboxId: string; phone: string };
let g = 0;

async function owner(email: string, phone: string): Promise<Owner> {
  const { workspace } = await ensureUserAndWorkspace({ email });
  await database
    .update(workspaces)
    .set({ status: "active" })
    .where(eq(workspaces.id, workspace.id));
  const mailbox = await saveConnectedMailbox(workspace, {
    email,
    refreshToken: "rt",
    grantedScopes: [],
  });
  const e164 = await startPhoneVerification(workspace.id, phone, { send: okSend, now: NOW });
  const code = texts.at(-1)!.body.match(/\d{6}/)![0];
  await confirmPhone(workspace.id, code, NOW);
  return { workspaceId: workspace.id, mailboxId: mailbox.id, phone: e164 };
}

async function lead(o: Owner, classifiedAt: Date) {
  const id = `g${++g}`;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId: o.mailboxId,
      gmailThreadId: id,
      inInbox: true,
      category: "quote_request",
      needsOwner: false,
      classifiedAt,
      lastMessageAt: classifiedAt,
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId: o.mailboxId,
    gmailMessageId: `${id}-m`,
    direction: "in",
    fromAddress: "dana@customer.com",
    sentAt: classifiedAt,
  });
}

const profileOf = async (workspaceId: string) =>
  (
    await database
      .select()
      .from(businessProfiles)
      .where(eq(businessProfiles.workspaceId, workspaceId))
  )[0]!;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.APP_URL = "https://app.example";
  database = await createTestDb();
  texts = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("STOP on the send path", () => {
  it("21610 for one owner turns their texts off, hands the slot back, and the next owner is texted", async () => {
    const a = await owner("a@shop.com", "(508) 555-0001");
    const b = await owner("b@shop.com", "(508) 555-0002");
    await lead(a, later(1));
    await lead(b, later(1));
    texts = [];
    const send = async (s: OutgoingSms) => (s.to === a.phone ? "opted_out" : okSend(s));
    const r = await sendLeadAlerts(later(2), { send: vi.fn(send) });
    expect(r).toEqual({ sent: 1, notConfigured: false });
    expect(texts.map((t) => t.to)).toEqual([b.phone]);

    const pa = await profileOf(a.workspaceId);
    expect(pa.smsAlertsEnabled).toBe(false);
    expect(pa.smsStoppedReason).toBe("opted_out");
    // The slot went back: nothing says a text went out.
    expect(pa.smsLastSentAt).toBeNull();
    expect(pa.smsAlertCursor).toEqual(NOW);
    const changed = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "sms_alerts_changed"));
    expect(changed.filter((c) => c.workspaceId === a.workspaceId).at(-1)!.detail).toEqual({
      enabled: false,
      reason: "opted_out",
    });
    // Nothing more to that number until the owner turns texts on again.
    await lead(a, later(20));
    expect((await sendLeadAlerts(later(21), { send: okSend })).sent).toBe(0);
    expect((await profileOf(b.workspaceId)).smsAlertsEnabled).toBe(true);
  });

  it("a sender that throws for one owner doesn't stop the next, and that owner's slot is handed back", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await owner("a@shop.com", "(508) 555-0001");
    const b = await owner("b@shop.com", "(508) 555-0002");
    await lead(a, later(1));
    await lead(b, later(1));
    texts = [];
    const send = async (s: OutgoingSms) => {
      if (s.to === a.phone) throw new TwilioError(500);
      return okSend(s);
    };
    expect((await sendLeadAlerts(later(2), { send })).sent).toBe(1);
    expect(texts.map((t) => t.to)).toEqual([b.phone]);
    const pa = await profileOf(a.workspaceId);
    expect(pa.smsAlertsEnabled).toBe(true);
    expect(pa.smsLastSentAt).toBeNull();
    // Logged with the status and the error's name, never the number or the words.
    expect(errors).toHaveBeenCalledWith("sms_alert_failed", {
      workspaceId: a.workspaceId,
      status: 500,
      error: "TwilioError",
    });
    expect(JSON.stringify(errors.mock.calls)).not.toContain("555");
    // The next run texts owner A.
    expect((await sendLeadAlerts(later(3), { send: okSend })).sent).toBe(1);
    expect(texts.at(-1)!.to).toBe(a.phone);
  });

  it("not_configured for the first owner still stops the run and hands the slot back (unchanged)", async () => {
    const a = await owner("a@shop.com", "(508) 555-0001");
    await lead(a, later(1));
    const r = await sendLeadAlerts(later(2), { send: async () => "not_configured" });
    expect(r).toEqual({ sent: 0, notConfigured: true });
    expect((await profileOf(a.workspaceId)).smsLastSentAt).toBeNull();
  });

  it("the code sender: 21610 → a plain refusal, no code held, the reason for the screen", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "a@shop.com" });
    const err = await startPhoneVerification(workspace.id, "(508) 555-0001", {
      send: async () => "opted_out",
      now: NOW,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsError);
    expect((err as SmsError).code).toBe("opted_out");
    expect((err as SmsError).message).toBe(
      "That number replied STOP to our texts. Text START to the number, then try again.",
    );
    const p = await profileOf(workspace.id);
    expect(p.smsCodeHash).toBeNull();
    expect(p.alertPhone).toBeNull();
    expect(p.smsStoppedReason).toBe("opted_out");
    expect(SCREEN_MESSAGES["/settings/texts"].error.sms_opted_out).toBe(
      "That number replied STOP to our texts. Text START to the number, then try again.",
    );
  });

  it("sendSms reads Twilio's error code: 21610 → opted_out; anything else still throws the status", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC1";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG1";
    try {
      expect(TWILIO_OPTED_OUT_CODE).toBe(21610);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({ code: 21610, message: "Attempt to send to unsubscribed recipient" }),
              {
                status: 400,
              },
            ),
        ),
      );
      expect(await sendSms({ to: "+15085551234", body: "x" })).toBe("opted_out");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ code: 21211 }), { status: 400 })),
      );
      await expect(sendSms({ to: "+15085551234", body: "x" })).rejects.toMatchObject({
        name: "TwilioError",
        status: 400,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("not json", { status: 503 })),
      );
      await expect(sendSms({ to: "+15085551234", body: "x" })).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_MESSAGING_SERVICE_SID;
    }
  });
});

describe("the opt-in screen's words (carrier consent)", () => {
  it("come from the SMS limits in code", () => {
    const c = textsConsentCopy(SMS, "Eastern time");
    expect(SMS.dailyCap).toBe(10);
    expect(c.intro).toBe(
      "Squared Away texts you when a new quote request or an email that needs you comes in: just the count and a link, never a customer's name or words. Up to 10 texts a day, none between 9pm and 7am Eastern time (except emergencies, if you leave that on below). Msg & data rates may apply. Reply HELP for help, STOP to stop.",
    );
    expect(
      textsConsentCopy({ dailyCap: 3, quietStartHour: 22, quietEndHour: 6 }, "Pacific time").intro,
    ).toContain("Up to 3 texts a day, none between 10pm and 6am Pacific time");
    expect(hourWord(0)).toBe("12am");
    expect(hourWord(12)).toBe("12pm");
    expect(c.consent).toBe("By tapping Text me a code you agree to these texts and to our");
    expect(c.button).toBe("Text me a code");
  });

  it("the screen shows them, with 44px links to /terms and /privacy and no typed numbers", () => {
    const page = readFileSync("src/app/(app)/settings/texts/page.tsx", "utf8");
    expect(page).toContain("textsConsentCopy(SMS, zoneTimeName(profile?.timeZone))");
    expect(page).toContain("{copy.intro}");
    expect(page).toContain("{copy.consent}");
    expect(page).toMatch(/href="\/terms"\s+className="inline-flex min-h-tap/);
    expect(page).toMatch(/href="\/privacy"\s+className="inline-flex min-h-tap/);
    expect(page).not.toMatch(/9pm|7am|10 texts|every 10 minutes|Reply STOP any time/);
    // The rules file carries the carrier words once.
    const rules = readFileSync("src/server/sms-delivery-rules.ts", "utf8");
    for (const words of ["Msg & data rates may apply", "Reply HELP for help, STOP to stop"])
      expect(rules).toContain(words);
  });

  it("the STOP line tells the owner the way back", () => {
    expect(STOPPED_LINES.opted_out).toBe(
      "You replied STOP, so texts are off. Text START to the number, then turn them on here.",
    );
  });
});
