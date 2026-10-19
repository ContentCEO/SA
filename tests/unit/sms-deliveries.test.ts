import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import {
  activityLog,
  businessProfiles,
  messages,
  smsDeliveries,
  threads,
  workspaces,
} from "@/db/schema";
import type { OutgoingSms } from "@/lib/sms";
import { twilioSignature, twilioSignatureOk } from "@/lib/twilio-signature";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { describeActivity, listActivity } from "@/server/activity";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { confirmPhone, sendLeadAlerts, startPhoneVerification } from "@/server/sms-alerts";
import { lastSmsDelivery, purgeSmsDeliveries } from "@/server/sms-deliveries";
import { lastTextLine, smsAlertActivityLine } from "@/server/sms-delivery-rules";
import { createTestDb } from "../support/db";

/* Check 19 P6: Twilio's delivery reports, matched by message id, with no body or number. */
const { POST } = await import("@/app/api/twilio/status/route");

const NOW = new Date("2026-10-10T18:00:00Z"); // 2pm Eastern
const TOKEN = "twilio-test-token";
const CALLBACK = "https://app.example/api/twilio/status";
let database: Database;
let workspaceId: string;
let mailboxId: string;
let texts: OutgoingSms[];
let sids = 0;
const send = async (s: OutgoingSms) => {
  texts.push(s);
  return { status: "sent" as const, sid: `SM${++sids}` };
};

const report = (params: Record<string, string>, signature?: string | null) =>
  POST(
    new NextRequest(CALLBACK, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(signature === null
          ? {}
          : { "x-twilio-signature": signature ?? twilioSignature(TOKEN, CALLBACK, params) }),
      },
      body: new URLSearchParams(params).toString(),
    }),
  );

async function verifiedOwnerWithText() {
  await startPhoneVerification(workspaceId, "(508) 555-1234", { send, now: NOW });
  const code = texts.at(-1)!.body.match(/\d{6}/)![0];
  await confirmPhone(workspaceId, code, NOW);
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: "g1",
      inInbox: true,
      category: "quote_request",
      needsOwner: true,
      classifiedAt: new Date(NOW.getTime() + 60_000),
      lastMessageAt: new Date(NOW.getTime() + 60_000),
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: "g1-m",
    direction: "in",
    fromAddress: "dana@customer.com",
    sentAt: new Date(NOW.getTime() + 60_000),
  });
  expect((await sendLeadAlerts(new Date(NOW.getTime() + 120_000), { send })).sent).toBe(1);
  return `SM${sids}`;
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.APP_URL = "https://app.example";
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
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
afterEach(() => {
  delete process.env.TWILIO_AUTH_TOKEN;
});

describe("the signature", () => {
  it("good passes, bad and missing are refused with 403 and change nothing", async () => {
    const sid = await verifiedOwnerWithText();
    const params = { MessageSid: sid, MessageStatus: "delivered" };
    expect(
      twilioSignatureOk(TOKEN, CALLBACK, params, twilioSignature(TOKEN, CALLBACK, params)),
    ).toBe(true);
    expect((await report(params, "bm90IGl0")).status).toBe(403);
    expect((await report(params, null)).status).toBe(403);
    // Signed for another URL, or with another token.
    expect(
      (await report(params, twilioSignature(TOKEN, "https://evil.example/x", params))).status,
    ).toBe(403);
    expect((await report(params, twilioSignature("other", CALLBACK, params))).status).toBe(403);
    expect((await lastSmsDelivery(workspaceId))!.status).toBe("queued");
    // No token configured: nothing is ever accepted.
    delete process.env.TWILIO_AUTH_TOKEN;
    expect((await report(params)).status).toBe(403);
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    expect((await report(params)).status).toBe(204);
    expect((await lastSmsDelivery(workspaceId))!.status).toBe("delivered");
  });
});

describe("what Twilio reports", () => {
  it("rows hold the id, kind and status only — never the body or the number", async () => {
    await verifiedOwnerWithText();
    const rows = await database.select().from(smsDeliveries);
    expect(rows.map((r) => r.kind)).toEqual(["code", "alert"]);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        "createdAt",
        "errorCode",
        "id",
        "kind",
        "messageSid",
        "status",
        "updatedAt",
        "workspaceId",
      ].sort(),
    );
    expect(JSON.stringify(rows)).not.toMatch(/508|555|1234|Squared Away|quote|code is/i);
    // Texts ask Twilio to report back to our signed callback.
  });

  it("delivered → Settings and Activity say it arrived; a late 'sent' doesn't undo it", async () => {
    const sid = await verifiedOwnerWithText();
    // Before Twilio says anything, Activity doesn't claim it arrived.
    expect((await listActivity(workspaceId)).map((e) => e.text)).toContain(
      "Sent a text to your phone about new emails that need you",
    );
    expect((await report({ MessageSid: sid, MessageStatus: "delivered" })).status).toBe(204);
    expect((await report({ MessageSid: sid, MessageStatus: "sent" })).status).toBe(204);
    const last = await lastSmsDelivery(workspaceId);
    expect(last!.status).toBe("delivered");
    expect(
      lastTextLine({
        stoppedReason: null,
        last: { ...last!, updatedAt: new Date("2026-10-10T13:42:00Z") },
        timeZone: "America/New_York",
        now: NOW,
      }),
    ).toBe("Last text delivered at 9:42am.");
    expect((await listActivity(workspaceId)).map((e) => e.text)).toContain(
      "Texted you about new emails that need you",
    );
  });

  it("21610 (STOP) turns texts off by itself and the screen says so", async () => {
    const sid = await verifiedOwnerWithText();
    await report({ MessageSid: sid, MessageStatus: "undelivered", ErrorCode: "21610" });
    const [p] = await database.select().from(businessProfiles);
    expect(p!.smsAlertsEnabled).toBe(false);
    expect(p!.smsStoppedReason).toBe("opted_out");
    const line = lastTextLine({
      stoppedReason: p!.smsStoppedReason,
      last: await lastSmsDelivery(workspaceId),
      timeZone: "America/New_York",
      now: NOW,
    });
    expect(line).toBe(
      "You replied STOP, so texts are off. Text START to the number, then turn them on here.",
    );
    const changed = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "sms_alerts_changed"));
    expect(changed.at(-1)!.detail).toEqual({ enabled: false, reason: "opted_out" });
    expect(describeActivity("sms_alerts_changed", changed.at(-1)!.detail, null)).toBe(
      "Turned off text alerts because you replied STOP",
    );
    expect((await listActivity(workspaceId)).map((e) => e.text)).toContain(
      "Tried to text you about new emails that need you, but it didn't arrive",
    );
    // Nothing more goes to that number until the owner turns texts on again.
    expect((await sendLeadAlerts(new Date(NOW.getTime() + 60 * 60_000), { send })).sent).toBe(0);
  });

  it("30006 → 'can't get texts'; 30034 → the carrier line (texts stay on)", async () => {
    const sid = await verifiedOwnerWithText();
    await report({ MessageSid: sid, MessageStatus: "undelivered", ErrorCode: "30034" });
    let [p] = await database.select().from(businessProfiles);
    expect(p!.smsAlertsEnabled).toBe(true);
    const at = (last: Awaited<ReturnType<typeof lastSmsDelivery>>) =>
      lastTextLine({ stoppedReason: p!.smsStoppedReason, last, timeZone: "UTC", now: NOW });
    expect(at(await lastSmsDelivery(workspaceId))).toBe(
      "Your last text didn't arrive. Carriers haven't approved our texting number yet.",
    );
    await report({ MessageSid: sid, MessageStatus: "failed", ErrorCode: "30006" });
    [p] = await database.select().from(businessProfiles);
    expect(p!.smsAlertsEnabled).toBe(false);
    expect(at(await lastSmsDelivery(workspaceId))).toBe(
      "That number can't get texts. Use a mobile number.",
    );
  });

  it("a report for a text we never sent changes nothing", async () => {
    expect((await report({ MessageSid: "SMnope", MessageStatus: "delivered" })).status).toBe(204);
    expect(await database.select().from(smsDeliveries)).toEqual([]);
  });

  it("reports are purged after 30 days", async () => {
    await verifiedOwnerWithText();
    await purgeSmsDeliveries(new Date(NOW.getTime() + 29 * 24 * 60 * 60_000));
    expect(await database.select().from(smsDeliveries)).toHaveLength(2);
    await purgeSmsDeliveries(new Date(NOW.getTime() + 31 * 24 * 60 * 60_000));
    expect(await database.select().from(smsDeliveries)).toEqual([]);
  });

  it("Activity's wording follows the report", () => {
    expect(smsAlertActivityLine(null)).toBe(
      "Sent a text to your phone about new emails that need you",
    );
    expect(smsAlertActivityLine("delivered")).toBe("Texted you about new emails that need you");
    expect(smsAlertActivityLine("undelivered")).toContain("didn't arrive");
  });
});
