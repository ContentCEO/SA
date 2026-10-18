import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { businessProfiles, drafts, messages, threads, workspaces } from "@/db/schema";
import { sendSms, TwilioError, type OutgoingSms } from "@/lib/sms";
import { SCREEN_MESSAGES } from "@/app/(app)/settings/messages";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import {
  confirmPhone,
  inQuietHours,
  leadAlertBody,
  normalizeUsPhone,
  sendLeadAlerts,
  setSmsAlerts,
  SMS,
  SmsError,
  startPhoneVerification,
  textsStep,
} from "@/server/sms-alerts";
import { createTestDb } from "../support/db";

// 2pm Eastern.
const NOW = new Date("2026-10-10T18:00:00Z");
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);

let database: Database;
let workspaceId: string;
let mailboxId: string;
let texts: OutgoingSms[];
let sids = 0;
const send = async (s: OutgoingSms) => {
  texts.push(s);
  return { status: "sent" as const, sid: `SM${++sids}` };
};
let g = 0;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.APP_URL = "https://app.example";
  database = await createTestDb();
  texts = [];
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  workspaceId = workspace.id;
  await database.update(workspaces).set({ status: "active" }).where(eq(workspaces.id, workspaceId));
  mailboxId = (
    await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    })
  ).id;
});

async function verify(at = NOW) {
  await startPhoneVerification(workspaceId, "(508) 555-1234", { send, now: at });
  const code = texts.at(-1)!.body.match(/\d{6}/)![0];
  await confirmPhone(workspaceId, code, at);
  texts = [];
}

async function lead(o: {
  category?: string;
  needsOwner?: boolean;
  classifiedAt: Date;
  last?: "in" | "out";
}) {
  const id = `g${++g}`;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: id,
      inInbox: true,
      category: o.category ?? "quote_request",
      needsOwner: o.needsOwner ?? false,
      summary: "Dana Ruiz wants a quote for 12 Elm St.",
      classifiedAt: o.classifiedAt,
      lastMessageAt: o.classifiedAt,
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `${id}-m`,
    direction: o.last ?? "in",
    fromAddress: "dana@customer.com",
    fromName: "Dana Ruiz",
    sentAt: o.classifiedAt,
  });
  return t!;
}

describe("phone numbers and wording", () => {
  it("accepts US numbers in the usual shapes", () => {
    expect(normalizeUsPhone("(508) 555-1234")).toBe("+15085551234");
    expect(normalizeUsPhone("+1 508.555.1234")).toBe("+15085551234");
    expect(normalizeUsPhone("555-1234")).toBeNull();
    expect(normalizeUsPhone("+44 20 7946 0958")).toBeNull();
    // Check 19 P4: toll-free and N11 codes never take texts.
    for (const n of [
      "800-555-1234",
      "888 555 1234",
      "1-833-555-1234",
      "211-555-1234",
      "911-555-1234",
    ])
      expect(normalizeUsPhone(n), n).toBeNull();
    expect(normalizeUsPhone("(508) 555-1234")).toBe("+15085551234");
  });
  it("texts carry counts and a link, nothing else", () => {
    expect(leadAlertBody({ quotes: 1, needsYou: 0 }, "https://x/queue")).toBe(
      "Squared Away: 1 new quote request needs you. Open: https://x/queue",
    );
    expect(leadAlertBody({ quotes: 1, needsYou: 2 }, "u")).toContain(
      "3 new emails (1 quote request)",
    );
  });
  it("is quiet from 9pm to 7am local time", () => {
    expect(inQuietHours(new Date("2026-10-10T02:00:00Z"), "America/New_York")).toBe(true); // 10pm
    expect(inQuietHours(new Date("2026-10-10T10:30:00Z"), "America/New_York")).toBe(true); // 6:30am
    expect(inQuietHours(NOW, "America/New_York")).toBe(false);
  });
});

describe("confirming the number", () => {
  it("only a correct, unexpired code turns alerts on", async () => {
    await startPhoneVerification(workspaceId, "508-555-1234", { send, now: NOW });
    expect(texts[0]!.to).toBe("+15085551234");
    expect(texts[0]!.body).toContain("STOP");
    const code = texts[0]!.body.match(/\d{6}/)![0];
    const wrong = code === "000000" ? "111111" : "000000";
    await expect(confirmPhone(workspaceId, wrong, NOW)).rejects.toBeInstanceOf(SmsError);
    await expect(confirmPhone(workspaceId, code, later(11))).rejects.toBeInstanceOf(SmsError);
    await confirmPhone(workspaceId, code, later(1));
    const [p] = await database.select().from(businessProfiles);
    expect(p!.smsAlertsEnabled).toBe(true);
    expect(p!.smsCodeHash).toBeNull();
  });
  it("Check 19 P4: a refused text → a plain error, no code stored, the phone form again", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const refuse = async () => {
      throw new TwilioError(400);
    };
    const err = await startPhoneVerification(workspaceId, "(508) 555-1234", {
      send: refuse,
      now: NOW,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsError);
    expect((err as SmsError).code).toBe("send_failed");
    expect((err as SmsError).message).toBe(
      "We couldn't text that number. Check it's a mobile number and try again.",
    );
    const [p] = await database.select().from(businessProfiles);
    expect(p!.smsCodeHash).toBeNull();
    expect(p!.smsCodeExpiresAt).toBeNull();
    expect(p!.alertPhone).toBeNull();
    expect(textsStep(p!, NOW)).toBe("phone");
    // The log carries Twilio's status, never the number.
    expect(errors).toHaveBeenCalledWith("sms_code_failed", { workspaceId, status: 400 });
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/508|555/);
    errors.mockRestore();
    // A code that really went shows the code box.
    await startPhoneVerification(workspaceId, "(508) 555-1234", { send, now: NOW });
    const [q] = await database.select().from(businessProfiles);
    expect(textsStep(q!, NOW)).toBe("code");
    expect(SCREEN_MESSAGES["/settings/texts"]!.error!.sms_send_failed).toBe(
      "We couldn't text that number. Check it's a mobile number and try again.",
    );
  });

  it("can't be switched on without a confirmed number", async () => {
    await expect(setSmsAlerts(workspaceId, true)).rejects.toBeInstanceOf(SmsError);
  });
  it("stops after five codes an hour", async () => {
    for (let i = 0; i < 5; i++) await startPhoneVerification(workspaceId, "5085551234", { send });
    await expect(startPhoneVerification(workspaceId, "5085551234", { send })).rejects.toMatchObject(
      {
        code: "busy",
      },
    );
  });
});

describe("lead alerts", () => {
  it("nothing without opting in", async () => {
    await lead({ classifiedAt: later(1) });
    expect((await sendLeadAlerts(later(2), { send })).sent).toBe(0);
  });

  it("one content-free text per batch, then throttled", async () => {
    await verify();
    await lead({ classifiedAt: later(1) });
    await lead({ classifiedAt: later(1), needsOwner: true, category: "complaint" });
    await lead({ classifiedAt: later(1), category: "scheduling" }); // not alert-worthy
    await lead({ classifiedAt: later(1), last: "out" }); // owner already replied
    expect((await sendLeadAlerts(later(2), { send })).sent).toBe(1);
    // Check 19 P1: the quote request has no reply drafted, so it isn't on the queue: Quotes.
    expect(texts[0]!.body).toBe(
      "Squared Away: 2 new emails (1 quote request) need you. Open: https://app.example/quotes",
    );
    expect(texts[0]!.body).not.toMatch(/Dana|Elm/);

    await lead({ classifiedAt: later(3) });
    expect((await sendLeadAlerts(later(4), { send })).sent).toBe(0); // within 10 minutes
    expect((await sendLeadAlerts(later(13), { send })).sent).toBe(1);
    expect(texts[1]!.body).toContain("1 new quote request needs you");
    expect((await sendLeadAlerts(later(30), { send })).sent).toBe(0); // nothing new
  });

  it("Check 19 P1: a quote request whose reply is drafted links to the queue", async () => {
    await verify();
    const t = await lead({ classifiedAt: later(1) });
    await database.insert(drafts).values({
      threadId: t.id,
      mailboxId,
      gmailDraftId: "d-1",
      toAddress: "dana@customer.com",
      subject: "Re: quote",
      body: "Hi Dana",
      originalBody: "Hi Dana",
      reason: "r",
      promptVersion: "draft.v8",
    });
    expect((await sendLeadAlerts(later(2), { send })).sent).toBe(1);
    expect(texts[0]!.body).toBe(
      "Squared Away: 1 new quote request needs you. Open: https://app.example/queue",
    );
  });

  it("holds texts overnight and sends them in the morning", async () => {
    const night = new Date("2026-10-10T02:00:00Z"); // 10pm Eastern
    await verify(night);
    await lead({ classifiedAt: new Date(night.getTime() + 60_000) });
    expect((await sendLeadAlerts(new Date(night.getTime() + 120_000), { send })).sent).toBe(0);
    expect((await sendLeadAlerts(new Date("2026-10-10T11:05:00Z"), { send })).sent).toBe(1);
  });

  it("caps at ten a day and skips read-only accounts", async () => {
    await verify();
    for (let i = 0; i < SMS.dailyCap + 2; i++) {
      await lead({ classifiedAt: later(1 + i * 11) });
      await sendLeadAlerts(later(2 + i * 11), { send });
    }
    expect(texts).toHaveLength(SMS.dailyCap);

    texts = [];
    await database
      .update(workspaces)
      .set({ status: "canceled" })
      .where(eq(workspaces.id, workspaceId));
    await lead({ classifiedAt: later(500) });
    expect((await sendLeadAlerts(later(600), { send })).sent).toBe(0);
  });

  it("loses nothing while texting isn't set up", async () => {
    await verify();
    await lead({ classifiedAt: later(1) });
    const r = await sendLeadAlerts(later(2), { send: async () => "not_configured" });
    expect(r.notConfigured).toBe(true);
    expect((await sendLeadAlerts(later(3), { send })).sent).toBe(1);
  });
});

describe("Check 19 P6: texts ask Twilio to report delivery", () => {
  it("the form carries our signed StatusCallback, and the message id comes back", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC1";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG1";
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ sid: "SMabc" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await sendSms({ to: "+15085551234", body: "x" })).toEqual({
        status: "sent",
        sid: "SMabc",
      });
      const form = new URLSearchParams(
        String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
      );
      expect(form.get("StatusCallback")).toBe("https://app.example/api/twilio/status");
    } finally {
      vi.unstubAllGlobals();
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_MESSAGING_SERVICE_SID;
    }
  });
});
