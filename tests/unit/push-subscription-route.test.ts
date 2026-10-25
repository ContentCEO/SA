import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { savePushSubscription } from "@/server/push-alerts";
import { recordTermsAcceptance } from "@/server/terms";
import { createTestDb } from "../support/db";

/* Check 19 P5: a renewed push subscription replaces the old address on the server. */
const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/auth", () => ({
  auth: async () => (session.userId ? { user: { id: session.userId, sv: 0 } } : null),
}));

const { POST } = await import("@/app/api/push/subscription/route");

const OLD = "https://fcm.googleapis.com/fcm/send/old-one";
const NEW = "https://fcm.googleapis.com/fcm/send/new-one";

let database: Database;
let workspaceId: string;

const post = (body: unknown, origin: string | null = "https://sa.example") =>
  POST(
    new NextRequest("https://sa.example/api/push/subscription", {
      method: "POST",
      headers: {
        host: "sa.example",
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
const endpoints = async () =>
  (await database.select().from(pushSubscriptions)).map((r) => r.endpoint).sort();

describe("POST /api/push/subscription (Check 19 P5)", () => {
  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    database = await createTestDb();
    const { user, workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    await recordTermsAcceptance(user.id);
    session.userId = user.id;
    workspaceId = workspace.id;
    await savePushSubscription(workspaceId, OLD);
  });

  it("swaps the old address for the new one", async () => {
    const res = await post({ oldEndpoint: OLD, newEndpoint: NEW });
    expect(res.status).toBe(200);
    expect(await endpoints()).toEqual([NEW]);
  });

  it("signed out → 401, and nothing changes", async () => {
    session.userId = null;
    expect((await post({ oldEndpoint: OLD, newEndpoint: NEW })).status).toBe(401);
    expect(await endpoints()).toEqual([OLD]);
  });

  it("refuses an address that isn't a push service, either side", async () => {
    for (const body of [
      { oldEndpoint: OLD, newEndpoint: "https://internal.example.com/hook" },
      { oldEndpoint: "http://169.254.169.254/x", newEndpoint: NEW },
      { oldEndpoint: OLD },
      "nonsense",
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await endpoints()).toEqual([OLD]);
  });

  it("refuses a cross-site request", async () => {
    expect(
      (await post({ oldEndpoint: OLD, newEndpoint: NEW }, "https://evil.example")).status,
    ).toBe(403);
    expect((await post({ oldEndpoint: OLD, newEndpoint: NEW }, null)).status).toBe(403);
    expect(await endpoints()).toEqual([OLD]);
  });

  it("another owner's row is never deleted through it", async () => {
    const { workspace: other } = await ensureUserAndWorkspace({ email: "other@shop2.com" });
    const theirs = "https://fcm.googleapis.com/fcm/send/theirs";
    await savePushSubscription(other.id, theirs);
    await post({ oldEndpoint: theirs, newEndpoint: NEW });
    expect(await endpoints()).toEqual([NEW, OLD, theirs].sort());
  });

  it("Settings re-saves this phone's address on every visit, and reads 'off' when refused", () => {
    const src = readFileSync("src/components/app/push-toggle.tsx", "utf8");
    const effect = src.slice(src.indexOf("useEffect("), src.indexOf("const turnOn"));
    expect(effect).toContain("savePushAction(sub.endpoint)");
    expect(effect).toMatch(/saved === false\)[\s\S]*unsubscribe\(\)[\s\S]*return "off"/);
  });
});
