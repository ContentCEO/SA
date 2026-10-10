import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { activityLog, messages, pushSubscriptions, threads, workspaces } from "@/db/schema";
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
    expect(pushSummaryText({ replies: 2, needsYou: 1 })).toBe(
      "1 email needs you · 2 replies ready to send",
    );
    expect(pushSummaryText({ replies: 0, needsYou: 0 })).toBe("Your queue is up to date.");
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

    it("refuses an endpoint that isn't a push service", async () => {
      expect(await savePushSubscription(workspaceId, "https://internal.example.com/hook")).toBe(
        false,
      );
    });
  });
});
