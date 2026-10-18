import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import {
  activityLog,
  businessProfiles,
  messages,
  pushSubscriptions,
  threads,
  workspaces,
} from "@/db/schema";
import { sendPush, vapidAuthorization } from "@/lib/web-push";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import {
  isPushEndpoint,
  pushSummaryText,
  savePushSubscription,
  sendPushAlerts,
} from "@/server/push-alerts";
import { createTestDb } from "../support/db";

const NOON_NY = new Date("2026-10-10T16:00:00Z");
const FCM = "https://fcm.googleapis.com/fcm/send/abc123";

function vapidKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const pub = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from(jwk.y!, "base64url"),
  ]).toString("base64url");
  return { pub, priv: privateKey.export({ format: "jwk" }).d!, publicKey };
}

describe("#36 phone notifications", () => {
  afterEach(() => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    vi.unstubAllGlobals();
  });

  it("signs a VAPID token the push service can verify, for that service only", () => {
    const k = vapidKeys();
    process.env.VAPID_PUBLIC_KEY = k.pub;
    process.env.VAPID_PRIVATE_KEY = k.priv;
    const header = vapidAuthorization(FCM, NOON_NY);
    const [, jwt, key] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
    expect(key).toBe(k.pub);
    const [h, c, s] = jwt!.split(".");
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.exp).toBeGreaterThan(NOON_NY.getTime() / 1000);
    expect(
      verify(
        "sha256",
        Buffer.from(`${h}.${c}`),
        { key: k.publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(s!, "base64url"),
      ),
    ).toBe(true);
  });

  it("the push itself is empty — nothing about any email goes to the push service", async () => {
    expect(await sendPush(FCM)).toBe("not_configured");
    const k = vapidKeys();
    process.env.VAPID_PUBLIC_KEY = k.pub;
    process.env.VAPID_PRIVATE_KEY = k.priv;
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendPush(FCM)).toBe("sent");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["Content-Length"]).toBe("0");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 410 }));
    expect(await sendPush(FCM)).toBe("gone");
  });

  it("only real push services are accepted as endpoints", () => {
    for (const ok of [
      FCM,
      "https://web.push.apple.com/QGx1",
      "https://updates.push.services.mozilla.com/wpush/v2/x",
      "https://wns2-par02p.notify.windows.com/w/?token=x",
    ])
      expect(isPushEndpoint(ok), ok).toBe(true);
    for (const bad of [
      "http://fcm.googleapis.com/x",
      "https://localhost/x",
      "https://169.254.169.254/latest",
      "https://evil.example.com/fcm.googleapis.com",
      "https://fcm.googleapis.com.evil.test/x",
      "not a url",
      42,
    ])
      expect(isPushEndpoint(bad), String(bad)).toBe(false);
  });

  it("what the phone shows: counts only", () => {
    expect(pushSummaryText({ replies: 2, needsYou: 1, canSend: true })).toBe(
      "1 email needs you · 2 replies ready to send",
    );
    // During the trial (or unpaid) nothing can be sent to a customer: "ready to check".
    expect(pushSummaryText({ replies: 2, needsYou: 1 })).toBe(
      "1 email needs you · 2 replies ready to check",
    );
    expect(pushSummaryText({ replies: 1, needsYou: 0, canSend: false })).toBe(
      "1 reply ready to check",
    );
    expect(pushSummaryText({ replies: 0, needsYou: 0 })).toBe("Your queue is up to date.");
  });

  it("Check 19 P7: quote requests from before midnight are 'waiting on you'", () => {
    expect(pushSummaryText({ replies: 0, needsYou: 0, newQuotes: 45, waiting: true })).toBe(
      "45 quote requests are waiting on you",
    );
    expect(pushSummaryText({ replies: 0, needsYou: 0, newQuotes: 1 })).toBe("1 new quote request");
  });

  it("leads at risk come first, as a count (plan #34)", () => {
    expect(pushSummaryText({ replies: 1, needsYou: 0, atRisk: 2, canSend: true })).toBe(
      "2 quote requests have waited over 4 hours · 1 reply ready to send",
    );
    expect(pushSummaryText({ replies: 0, needsYou: 1, atRisk: 1 })).toBe(
      "1 quote request has waited over 4 hours · 1 email needs you",
    );
    expect(pushSummaryText({ replies: 0, needsYou: 0, atRisk: 0 })).toBe(
      "Your queue is up to date.",
    );
  });

  describe("sending", () => {
    let database: Database;
    let workspaceId: string;
    let mailboxId: string;
    let n = 0;
    const pushed: string[] = [];
    const push = async (endpoint: string) => {
      pushed.push(endpoint);
      return endpoint.includes("gone") ? ("gone" as const) : ("sent" as const);
    };

    beforeEach(async () => {
      process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
      pushed.length = 0;
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
      await savePushSubscription(workspaceId, FCM);
    });

    async function lead(at: Date) {
      const [t] = await database
        .insert(threads)
        .values({
          mailboxId,
          gmailThreadId: `t${++n}`,
          inInbox: true,
          category: "quote_request",
          classifiedAt: at,
          lastMessageAt: at,
        })
        .returning();
      await database.insert(messages).values({
        threadId: t!.id,
        mailboxId,
        gmailMessageId: `m${n}`,
        direction: "in",
        fromName: "Dana Lee",
        fromAddress: "dana@x.com",
        sentAt: at,
      });
    }

    it("one buzz per batch, 10 minutes apart; the log holds counts only", async () => {
      await lead(new Date(NOON_NY.getTime() - 60_000));
      expect(await sendPushAlerts(NOON_NY, { push })).toEqual({ sent: 1 });
      expect(pushed).toEqual([FCM]);
      await lead(new Date(NOON_NY.getTime() + 60_000));
      expect(await sendPushAlerts(new Date(NOON_NY.getTime() + 120_000), { push })).toEqual({
        sent: 0,
      });
      expect(await sendPushAlerts(new Date(NOON_NY.getTime() + 11 * 60_000), { push })).toEqual({
        sent: 1,
      });
      // Nothing new since: no buzz.
      expect(await sendPushAlerts(new Date(NOON_NY.getTime() + 30 * 60_000), { push })).toEqual({
        sent: 0,
      });
      const logs = await database
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "push_alert_sent"));
      expect(logs).toHaveLength(2);
      expect(JSON.stringify(logs.map((l) => l.detail))).not.toMatch(/Dana|dana|fcm/);
    });

    it("quiet at night, never for read-only accounts, and dead phones are forgotten", async () => {
      await lead(new Date(NOON_NY.getTime() - 60_000));
      const elevenPm = new Date("2026-10-11T03:00:00Z");
      expect(await sendPushAlerts(elevenPm, { push })).toEqual({ sent: 0 });

      await database
        .update(workspaces)
        .set({ status: "canceled" })
        .where(eq(workspaces.id, workspaceId));
      expect(await sendPushAlerts(NOON_NY, { push })).toEqual({ sent: 0 });
      expect(pushed).toEqual([]);

      await database
        .update(workspaces)
        .set({ status: "active" })
        .where(eq(workspaces.id, workspaceId));
      await savePushSubscription(workspaceId, "https://fcm.googleapis.com/fcm/send/gone");
      await sendPushAlerts(NOON_NY, { push });
      const left = await database.select().from(pushSubscriptions);
      expect(left.map((s) => s.endpoint)).toEqual([FCM]);
    });

    it("Check 19 P2: no phone took it → no Activity row, cursor and slot handed back", async () => {
      await lead(new Date(NOON_NY.getTime() - 60_000));
      const failed = async () => "failed" as const;
      expect(await sendPushAlerts(NOON_NY, { push: failed })).toEqual({ sent: 0 });
      expect(
        await database.select().from(activityLog).where(eq(activityLog.action, "push_alert_sent")),
      ).toHaveLength(0);
      const [p] = await database.select().from(businessProfiles);
      expect(p?.pushAlertCursor ?? null).toBeNull();
      expect(p?.pushLastSentAt ?? null).toBeNull();
      // A run 11 minutes later with a working phone buzzes about the same lead.
      expect(await sendPushAlerts(new Date(NOON_NY.getTime() + 11 * 60_000), { push })).toEqual({
        sent: 1,
      });
      const [row] = await database
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "push_alert_sent"));
      expect(row!.detail).toMatchObject({ quotes: 1, phones: 1 });
    });

    it("Check 19 P2: one owner's push throwing doesn't stop the next owner's", async () => {
      await lead(new Date(NOON_NY.getTime() - 60_000));
      const { workspace: second } = await ensureUserAndWorkspace({ email: "second@shop2.com" });
      await database
        .update(workspaces)
        .set({ status: "active", setupPaidVia: "stripe" })
        .where(eq(workspaces.id, second.id));
      const box = await saveConnectedMailbox(second, {
        email: "second@shop2.com",
        refreshToken: "rt",
        grantedScopes: [],
      });
      const theirs = "https://fcm.googleapis.com/fcm/send/second";
      await savePushSubscription(second.id, theirs);
      const [t] = await database
        .insert(threads)
        .values({
          mailboxId: box.id,
          gmailThreadId: "second-t",
          inInbox: true,
          category: "quote_request",
          classifiedAt: new Date(NOON_NY.getTime() - 60_000),
          lastMessageAt: new Date(NOON_NY.getTime() - 60_000),
        })
        .returning();
      await database.insert(messages).values({
        threadId: t!.id,
        mailboxId: box.id,
        gmailMessageId: "second-m",
        direction: "in",
        fromAddress: "lee@x.com",
        sentAt: new Date(NOON_NY.getTime() - 60_000),
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const flaky = async (endpoint: string) => {
        if (endpoint === FCM) throw new TypeError("boom");
        pushed.push(endpoint);
        return "sent" as const;
      };
      expect(await sendPushAlerts(NOON_NY, { push: flaky })).toEqual({ sent: 1 });
      expect(pushed).toEqual([theirs]);
      expect(JSON.stringify(errors.mock.calls)).not.toMatch(/boom|fcm/);
      errors.mockRestore();
    });

    it("Check 19 P5: a refusing phone is counted, reset by a delivered push, and forgotten after 7 days", async () => {
      const row = async () =>
        (
          await database.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, FCM))
        )[0];
      const failed = async () => "failed" as const;
      const day = 24 * 60 * 60_000;
      let t = NOON_NY.getTime();
      for (let i = 0; i < 3; i++) {
        await lead(new Date(t - 60_000));
        await sendPushAlerts(new Date(t), { push: failed });
        t += 11 * 60_000;
      }
      expect(await row()).toMatchObject({ failCount: 3, firstFailedAt: NOON_NY });
      // A delivered push clears the run.
      await lead(new Date(t - 60_000));
      expect(await sendPushAlerts(new Date(t), { push })).toEqual({ sent: 1 });
      expect(await row()).toMatchObject({ failCount: 0, firstFailedAt: null });

      // Failing every day for a week: the row goes.
      const start = t + day;
      for (let d = 0; d <= 7; d++) {
        const at = new Date(start + d * day);
        await lead(new Date(at.getTime() - 60_000));
        await sendPushAlerts(at, { push: failed });
        if (d < 7) expect(await row(), `day ${d}`).toMatchObject({ failCount: d + 1 });
      }
      expect(await row()).toBeUndefined();
    });

    it("Check 19 P5: a push service answering 403 is a failure, not a dead phone", async () => {
      const k = vapidKeys();
      process.env.VAPID_PUBLIC_KEY = k.pub;
      process.env.VAPID_PRIVATE_KEY = k.priv;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 403 })),
      );
      expect(await sendPush(FCM)).toBe("failed");
    });

    it("Check 19 P8: the push may wait only until the owner's 9pm", async () => {
      const k = vapidKeys();
      process.env.VAPID_PUBLIC_KEY = k.pub;
      process.env.VAPID_PRIVATE_KEY = k.priv;
      const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
      vi.stubGlobal("fetch", fetchMock);
      const ttl = (i: number) =>
        (fetchMock.mock.calls[i] as unknown as [string, RequestInit])[1].headers as Record<
          string,
          string
        >;
      await lead(new Date(NOON_NY.getTime() - 60_000));
      expect(await sendPushAlerts(NOON_NY)).toEqual({ sent: 1 });
      expect(ttl(0).TTL).toBe("14400");
      const fiveToNine = new Date("2026-10-11T00:55:00Z"); // 8:55pm Eastern
      await lead(new Date(fiveToNine.getTime() - 60_000));
      expect(await sendPushAlerts(fiveToNine)).toEqual({ sent: 1 });
      expect(ttl(1).TTL).toBe("300");
    });

    it("Check 19 P7: ten buzzes a local day, counted from the owner's midnight", async () => {
      const step = 11 * 60_000;
      let t = NOON_NY.getTime();
      for (let i = 0; i < 12; i++, t += step) {
        await lead(new Date(t - 60_000));
        await sendPushAlerts(new Date(t), { push });
      }
      expect(pushed).toHaveLength(10);
      // 7:05am Eastern the next day: under 24 hours since the first, but a new day.
      const morning = new Date("2026-10-11T11:05:00Z");
      expect(await sendPushAlerts(morning, { push })).toEqual({ sent: 1 });
    });

    it("refuses an endpoint that isn't a push service", async () => {
      expect(await savePushSubscription(workspaceId, "https://internal.example.com/hook")).toBe(
        false,
      );
    });

    it("GUARDRAIL (M11 C6): a stored row outside the allow-list is never fetched", async () => {
      // A row that skipped savePushSubscription (a bug, a hand edit): the server must still
      // never fetch an internal address with it.
      const internal = "http://169.254.169.254/x";
      await database.insert(pushSubscriptions).values({ workspaceId, endpoint: internal });
      const k = vapidKeys();
      process.env.VAPID_PUBLIC_KEY = k.pub;
      process.env.VAPID_PRIVATE_KEY = k.priv;
      const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
      vi.stubGlobal("fetch", fetchMock);

      expect(await sendPush(internal)).toBe("gone");
      expect(await sendPush("https://fcm.googleapis.com.evil.example/x")).toBe("gone");
      expect(fetchMock).not.toHaveBeenCalled();

      // The real sender through the alert job: the push service gets its ping, the internal
      // address gets nothing and the row is forgotten.
      await lead(new Date(NOON_NY.getTime() - 60_000));
      expect(await sendPushAlerts(NOON_NY)).toEqual({ sent: 1 });
      const fetched = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
      expect(fetched).toEqual([FCM]);
      expect(fetched.some((u) => u.includes("169.254"))).toBe(false);
      const left = await database.select().from(pushSubscriptions);
      expect(left.map((s) => s.endpoint)).toEqual([FCM]);
    });
  });
});
