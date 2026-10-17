import { randomBytes } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { appSettings } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  HAND_CHECKS,
  isHandKey,
  launchChecks,
  launchSummary,
  stripeKeyKind,
} from "@/server/launch-ready";
import { loadLaunchFacts, tickLaunchItem } from "@/server/launch-ticks";
import { recordTermsAcceptance } from "@/server/terms";
import { createTestDb } from "../support/db";

/** Check 50 P6: "Ready for paying owners" on /admin. */

const session = vi.hoisted(() => ({ user: null as { id: string; email: string } | null }));
vi.mock("@/auth", () => ({ auth: async () => (session.user ? { user: session.user } : null) }));
class Redirected extends Error {
  constructor(readonly url: string) {
    super("redirect");
  }
}
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Redirected(url);
  },
}));
const { tickLaunchAction } = await import("@/app/(app)/admin/actions");
const { LaunchReady } = await import("@/app/(app)/admin/launch-ready");

const SECRETS = {
  APP_URL: "https://sa-dac3.vercel.app",
  EMAIL_FROM: "Squared Away <onboarding@resend.dev>",
  SUPPORT_EMAIL: "help-SECRET@shop.example",
  STRIPE_SECRET_KEY: "sk_test_SECRETVALUE123",
  STRIPE_WEBHOOK_SECRET: "whsec_SECRETVALUE",
  INNGEST_SIGNING_KEY: "signkey-prod-SECRETVALUE",
  VERCEL_ENV: "production",
};
const none = { webhookSecretStored: false, ticks: {} };
const state = (rows: ReturnType<typeof launchChecks>, key: string) =>
  rows.find((r) => r.key === key)!;

describe("launchChecks (pure)", () => {
  it("a vercel.app address and resend.dev sender are not yet; a test key shows 'test'", () => {
    const rows = launchChecks(SECRETS, none);
    expect(state(rows, "app_url").state).toBe("not yet");
    expect(state(rows, "email_from").state).toBe("not yet");
    expect(state(rows, "stripe_live")).toMatchObject({ state: "not yet", detail: "test key" });
    expect(state(rows, "support_email").state).toBe("done");
    expect(state(rows, "stripe_webhook").state).toBe("done");
    expect(state(rows, "inngest").state).toBe("done");
    expect(state(rows, "production").state).toBe("done");
    for (const c of HAND_CHECKS)
      expect(state(rows, c.key)).toMatchObject({ state: "check by hand", hand: true });
  });

  it("own domain, own sender and a live key are done; missing ones are not yet", () => {
    const rows = launchChecks(
      {
        APP_URL: "https://app.squaredaway.example",
        EMAIL_FROM: "hello@squaredaway.example",
        STRIPE_SECRET_KEY: "sk_live_x",
      },
      { webhookSecretStored: true, ticks: { vercel_pro: new Date("2026-10-17T15:00:00Z") } },
    );
    expect(state(rows, "app_url").state).toBe("done");
    expect(state(rows, "email_from").state).toBe("done");
    expect(state(rows, "stripe_live")).toMatchObject({ state: "done", detail: "live key" });
    expect(state(rows, "stripe_webhook").state).toBe("done"); // stored by Connect Stripe
    expect(state(rows, "support_email").state).toBe("not yet");
    expect(state(rows, "inngest").state).toBe("not yet");
    expect(state(rows, "production").state).toBe("not yet");
    expect(state(rows, "vercel_pro")).toMatchObject({ state: "done", detail: "ticked Oct 17" });
    expect(stripeKeyKind(undefined)).toBe("missing");
    expect(stripeKeyKind("rk_live_x")).toBe("live");
    expect(launchSummary(rows)).toEqual({ done: 5, total: rows.length });
    expect(isHandKey("vercel_pro")).toBe(true);
    expect(isHandKey("app_url")).toBe(false);
  });

  it("the rendered box shows no setting's value", () => {
    const html = renderToStaticMarkup(
      createElement(LaunchReady, {
        rows: launchChecks(SECRETS, none),
        tickAction: async () => {},
      }),
    );
    expect(html).toContain("Ready for paying owners");
    expect(html).toMatch(/\d+ of \d+ done/);
    expect(html).toContain("Check by hand");
    // (VERCEL_ENV's "production" is an ordinary word on the page, not a secret.)
    for (const [k, v] of Object.entries(SECRETS))
      if (k !== "VERCEL_ENV") expect(html, k).not.toContain(v);
    expect(html).not.toMatch(/SECRETVALUE|help-SECRET|sa-dac3|resend\.dev|sk_test/);
  });
});

describe("ticking a hand row", () => {
  let database: Database;
  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.ADMIN_EMAIL = "davi@example.com";
    database = await createTestDb();
  });
  afterEach(() => {
    session.user = null;
    delete process.env.ADMIN_EMAIL;
    vi.restoreAllMocks();
  });
  const form = (key: string) => {
    const f = new FormData();
    f.set("key", key);
    return f;
  };

  it("refuses anyone but Davi (404) and writes nothing", async () => {
    const { user } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    await recordTermsAcceptance(user.id);
    session.user = { id: user.id, email: "owner@shop.com" };
    const err = await tickLaunchAction(form("vercel_pro")).catch((e: unknown) => e);
    expect(String((err as { digest?: string }).digest)).toContain("404");
    expect(await database.select().from(appSettings)).toEqual([]);
  });

  it("Davi's Done stores only the date, logs only the key, and refuses unknown keys", async () => {
    const { user } = await ensureUserAndWorkspace({ email: "davi@example.com" });
    await recordTermsAcceptance(user.id);
    session.user = { id: user.id, email: "davi@example.com" };
    const logs: unknown[][] = [];
    vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => void logs.push(a));
    const where = await tickLaunchAction(form("main_protected")).catch((e: unknown) => e);
    expect((where as Redirected).url).toBe("/admin?done=launch_ticked#launch");
    expect(logs).toEqual([["launch_ticked", { key: "main_protected" }]]);
    const facts = await loadLaunchFacts();
    expect(Object.keys(facts.ticks)).toEqual(["main_protected"]);
    const bad = await tickLaunchAction(form("app_url")).catch((e: unknown) => e);
    expect((bad as Redirected).url).toBe("/admin?error=unknown");
    const rows = await database.select().from(appSettings);
    expect(rows.map((r) => r.key)).toEqual(["launch_tick:main_protected"]);
    await tickLaunchItem("sales_tax");
    expect(Object.keys((await loadLaunchFacts()).ticks).sort()).toEqual([
      "main_protected",
      "sales_tax",
    ]);
  });
});
