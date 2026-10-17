import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyCapWarning, reserveAiCall } from "@/ai/usage";
import type { Database } from "@/db";
import { appSettings, mailboxes, workspaces } from "@/db/schema";
import type { OutgoingEmail } from "@/lib/email";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  alertIfJobsStopped,
  deepHealth,
  LIFECYCLE_LAST_RUN_KEY,
  recordLifecycleRun,
} from "@/server/health-deep";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";

/** Check 1 P4: the deep health check, the cron backstop and the 80% notice. */

const { GET: deep } = await import("@/app/api/health/deep/route");
const { GET: cron } = await import("@/app/api/cron/jobs-check/route");

let database: Database;
let workspaceId: string;
const TOKEN = "t".repeat(48);
const min = (n: number) => new Date(Date.now() - n * 60_000);

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.HEALTH_TOKEN = TOKEN;
  process.env.CRON_SECRET = "c".repeat(48);
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  workspaceId = workspace.id;
});
afterEach(() => {
  delete process.env.HEALTH_TOKEN;
  delete process.env.CRON_SECRET;
  delete process.env.ADMIN_EMAIL;
  vi.restoreAllMocks();
});

const call = (url: string, headers: Record<string, string> = {}) =>
  new NextRequest(new URL(url, "https://app.example"), { headers });

describe("/api/health/deep (Check 1 P4)", () => {
  it("is a 404 without the right token, or when no token is set", async () => {
    expect((await deep(call("/api/health/deep"))).status).toBe(404);
    expect((await deep(call("/api/health/deep?token=wrong"))).status).toBe(404);
    delete process.env.HEALTH_TOKEN;
    expect((await deep(call("/api/health/deep?token="))).status).toBe(404);
    expect((await deep(call(`/api/health/deep?token=${TOKEN}`))).status).toBe(404);
  });

  it("200 when the lifecycle job ran recently, with no ids in the body", async () => {
    await recordLifecycleRun(min(5));
    const mb = await saveConnectedMailbox({ id: workspaceId } as never, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    });
    await database
      .update(mailboxes)
      .set({ lastSyncedAt: min(3) })
      .where(eq(mailboxes.id, mb.id));
    const res = await deep(call("/api/health/deep", { "x-health-token": TOKEN }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ db: "ok", jobs: "ok", minutesSinceJobs: 5, minutesSinceMailCheck: 3 });
    const text = JSON.stringify(body);
    expect(text).not.toContain(workspaceId);
    expect(text).not.toContain(mb.id);
    expect(text).not.toContain("@");
  });

  it("503 when the jobs are over 30 minutes stale (or never ran)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let res = await deep(call(`/api/health/deep?token=${TOKEN}`));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ db: "ok", jobs: "stale", minutesSinceJobs: null });
    await recordLifecycleRun(min(31));
    res = await deep(call(`/api/health/deep?token=${TOKEN}`));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ jobs: "stale", minutesSinceJobs: 31 });
    const [row] = await database
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, LIFECYCLE_LAST_RUN_KEY));
    expect(row).toBeTruthy();
  });
});

describe("the 'jobs look stopped' email (cron backstop)", () => {
  it("the cron route needs Vercel's Bearer secret", async () => {
    expect((await cron(call("/api/cron/jobs-check"))).status).toBe(404);
    expect(
      (await cron(call("/api/cron/jobs-check", { authorization: "Bearer nope" }))).status,
    ).toBe(404);
    await recordLifecycleRun(min(1));
    const ok = await cron(
      call("/api/cron/jobs-check", { authorization: `Bearer ${"c".repeat(48)}` }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ jobs: "ok", alert: "fine" });
  });

  it("emails Davi at most once an hour while the jobs are stale", async () => {
    process.env.ADMIN_EMAIL = "davi@example.com";
    process.env.APP_URL = "https://app.example";
    const sent: OutgoingEmail[] = [];
    const send = async (e: OutgoingEmail) => {
      sent.push(e);
      return "sent" as const;
    };
    const T = new Date("2026-10-17T10:05:00Z");
    await recordLifecycleRun(new Date(T.getTime() - 45 * 60_000));
    const h = await deepHealth(T);
    expect(h.jobs).toBe("stale");
    expect(await alertIfJobsStopped(h, T, { send })).toBe("sent");
    expect(await alertIfJobsStopped(h, new Date("2026-10-17T10:35:00Z"), { send })).toBe("already");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("Background jobs look stopped");
    expect(sent[0]!.text).toContain("45 minutes ago");
    expect(await alertIfJobsStopped(h, new Date("2026-10-17T11:01:00Z"), { send })).toBe("sent");
    expect(sent).toHaveLength(2);
    // Fine jobs never email.
    await recordLifecycleRun(T);
    expect(await alertIfJobsStopped(await deepHealth(T), T, { send })).toBe("fine");
  });
});

describe("80% of the day's AI limit (Check 1 P4)", () => {
  it("emails Davi once per account per day, naming no account", async () => {
    process.env.ADMIN_EMAIL = "davi@example.com";
    process.env.APP_URL = "https://app.example";
    const sent: OutgoingEmail[] = [];
    const send = async (e: OutgoingEmail) => {
      sent.push(e);
      return "sent" as const;
    };
    const T = new Date("2026-10-17T12:00:00Z");
    await notifyCapWarning(workspaceId, "2026-10-17", T, { send });
    await notifyCapWarning(workspaceId, "2026-10-17", T, { send });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("An account used 80% of today's AI limit");
    expect(sent[0]!.text).toContain("https://app.example/admin");
    expect(sent[0]!.text).not.toContain("owner@shop.com");
    expect(sent[0]!.text).not.toContain(workspaceId);
    await notifyCapWarning(workspaceId, "2026-10-18", T, { send });
    expect(sent).toHaveLength(2);
  });

  it("crossing 80% in reserveAiCall tries the notice once (no Resend: not marked, never throws)", async () => {
    process.env.ADMIN_EMAIL = "davi@example.com";
    process.env.AI_DAILY_CALL_CAP = "5";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const T = new Date("2026-10-17T12:00:00Z");
    for (let i = 0; i < 5; i++) await reserveAiCall(workspaceId, T);
    const markers = await database.select().from(appSettings);
    // No RESEND_API_KEY in tests: nothing was sent, so nothing is marked (it tries again).
    expect(markers.filter((m) => m.key.startsWith("admin_notice:"))).toEqual([]);
    const [w] = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(w).toBeTruthy();
  });
});
