import { randomBytes } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { appSettings, rateLimits } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  emailAddressOf,
  emailHealth,
  EMAIL_NOT_SET_UP,
  EMAIL_TEST_SENDER,
  refusedLine,
  testEmailErrorText,
} from "@/server/email-health-rules";
import { recordTermsAcceptance } from "@/server/terms";
import { createTestDb } from "../support/db";

/** Check 18 P2: /admin shows whether the app's emails can reach owners, with a test button. */

const session = vi.hoisted(() => ({ user: null as { id: string; email: string } | null }));
vi.mock("@/auth", () => ({
  auth: async () => (session.user ? { user: { ...session.user, sv: 0 } } : null),
}));
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
const { sendTestEmailAction } = await import("@/app/(app)/admin/actions");
const { EmailHealthBox } = await import("@/app/(app)/admin/email-health");
const { emailHealthBox, sendAdminTestEmail } = await import("@/server/email-health");

describe("the Email box picks its sentence from the env (pure)", () => {
  it("missing key or sender: not set up", () => {
    expect(emailHealth({})).toEqual({ state: "not_set_up", line: EMAIL_NOT_SET_UP });
    expect(emailHealth({ RESEND_API_KEY: "re_x" }).state).toBe("not_set_up");
    expect(emailHealth({ EMAIL_FROM: "Squared Away <hello@shop.example>" }).state).toBe(
      "not_set_up",
    );
    expect(emailHealth({ RESEND_API_KEY: " ", EMAIL_FROM: "hello@shop.example" }).state).toBe(
      "not_set_up",
    );
  });

  it("a resend.dev sender is the test sender (inverted on the page)", () => {
    const h = emailHealth({
      RESEND_API_KEY: "re_x",
      EMAIL_FROM: "Squared Away <onboarding@resend.dev>",
    });
    expect(h).toEqual({ state: "test_sender", line: EMAIL_TEST_SENDER });
    expect(h.line).toContain("Verify your domain in Resend");
    expect(emailHealth({ RESEND_API_KEY: "re_x", EMAIL_FROM: "x@sub.resend.dev" }).state).toBe(
      "test_sender",
    );
  });

  it("a real sender names the address it sends from", () => {
    expect(
      emailHealth({
        RESEND_API_KEY: "re_x",
        EMAIL_FROM: "Squared Away <Hello@SquaredAway.example>",
      }),
    ).toEqual({ state: "real", line: "Sending from hello@squaredaway.example." });
    expect(emailAddressOf("hello@shop.example")).toBe("hello@shop.example");
    expect(emailAddressOf("not an address")).toBeNull();
    // A look-alike isn't the test sender.
    expect(emailHealth({ RESEND_API_KEY: "re_x", EMAIL_FROM: "x@resend.dev.example" }).state).toBe(
      "real",
    );
  });

  it("the refusal line counts and names the most common status", () => {
    expect(refusedLine({ total: 0, byStatus: {} })).toBe("Refused in the last 7 days: 0.");
    expect(refusedLine({ total: 4, byStatus: { "403": 3, "500": 1 } })).toBe(
      "Refused in the last 7 days: 4 (most often: 403).",
    );
    // A tie goes to the lower status, so the line is stable.
    expect(refusedLine({ total: 2, byStatus: { "500": 1, "403": 1 } })).toContain("403");
  });

  it("the test button's result words come from fixed codes only", () => {
    expect(testEmailErrorText("email_test_refused", "403")).toBe("Test email: refused 403.");
    expect(testEmailErrorText("email_test_refused", "<script>")).toBe("Test email: refused.");
    expect(testEmailErrorText("email_test_limit", undefined)).toContain("five this hour");
    expect(testEmailErrorText("anything", "403")).toBeUndefined();
  });

  it("the rendered box shows the sentence, the count and a 44px button, never an owner address", () => {
    const html = renderToStaticMarkup(
      createElement(EmailHealthBox, {
        health: emailHealth({ RESEND_API_KEY: "re_x", EMAIL_FROM: "onboarding@resend.dev" }),
        refused: refusedLine({ total: 3, byStatus: { "403": 3 } }),
        sendTestAction: async () => {},
      }),
    );
    expect(html).toContain("sa-inverted");
    expect(html).toContain("Test sender: emails only reach the Resend account");
    expect(html).toContain("Verify your domain in Resend (launch notes step 6).");
    expect(html).toContain("Refused in the last 7 days: 3 (most often: 403).");
    expect(html).toContain("Send me a test email");
    // No owner address anywhere (the test sender box names no address at all).
    expect(html).not.toMatch(/\S+@\S+\.\S+/);
    const plain = renderToStaticMarkup(
      createElement(EmailHealthBox, {
        health: emailHealth({ RESEND_API_KEY: "re_x", EMAIL_FROM: "hello@squaredaway.example" }),
        refused: refusedLine({ total: 0, byStatus: {} }),
        sendTestAction: async () => {},
      }),
    );
    expect(plain).not.toContain("sa-inverted");
    expect(plain).toContain("Sending from hello@squaredaway.example.");
  });
});

describe("the test email (database)", () => {
  let database: Database;
  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.ADMIN_EMAIL = "davi@example.com";
    database = await createTestDb();
  });
  afterEach(() => {
    session.user = null;
    delete process.env.ADMIN_EMAIL;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("goes to ADMIN_EMAIL with a per-minute key and reports the result word", async () => {
    const sent: { to: string; idempotencyKey: string }[] = [];
    const now = new Date("2026-10-18T14:07:33Z");
    const r = await sendAdminTestEmail(now, {
      send: async (e) => {
        sent.push({ to: e.to, idempotencyKey: e.idempotencyKey });
        return "sent";
      },
    });
    expect(r).toEqual({ result: "sent" });
    expect(sent).toEqual([
      { to: "davi@example.com", idempotencyKey: "admin-test-2026-10-18T14:07" },
    ]);
    expect(await sendAdminTestEmail(now, { send: async () => "not_configured" })).toEqual({
      result: "not_set_up",
    });
    delete process.env.ADMIN_EMAIL;
    expect(await sendAdminTestEmail(now, { send: async () => "sent" })).toEqual({
      result: "not_set_up",
    });
  });

  it("a Resend 403 comes back as refused 403 and lands in the day's tally", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM", "Squared Away <onboarding@resend.dev>");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ statusCode: 403, name: "validation_error", message: "x" }),
            {
              status: 403,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    );
    const now = new Date("2026-10-18T14:07:33Z");
    expect(await sendAdminTestEmail(now)).toEqual({ result: "refused", status: 403 });
    const box = await emailHealthBox(now);
    expect(box.health.state).toBe("test_sender");
    expect(box.refused).toBe("Refused in the last 7 days: 1 (most often: 403).");
  });

  it("the action refuses anyone but Davi (404) and sends nothing", async () => {
    const { user } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    await recordTermsAcceptance(user.id);
    session.user = { id: user.id, email: "owner@shop.com" };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const err = await sendTestEmailAction().catch((e: unknown) => e);
    expect(String((err as { digest?: string }).digest)).toContain("404");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await database.select().from(rateLimits)).toEqual([]);
  });

  it("Davi's tap is rate-limited to five an hour and lands on the Email box", async () => {
    const { user } = await ensureUserAndWorkspace({ email: "davi@example.com" });
    await recordTermsAcceptance(user.id);
    session.user = { id: user.id, email: "davi@example.com" };
    // No Resend env: "not set up", and nothing is fetched.
    vi.stubEnv("RESEND_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const where = async () => {
      const e = await sendTestEmailAction().catch((x: unknown) => x);
      return e instanceof Redirected ? e.url : String(e);
    };
    for (let i = 0; i < 5; i++)
      expect(await where()).toBe("/admin?done=email_test_not_set_up#email");
    expect(await where()).toBe("/admin?error=email_test_limit#email");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await database.select().from(appSettings)).toEqual([]);
  });
});
