import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { appSettings } from "@/db/schema";
import {
  emailErrorFields,
  purgeEmailRefusedTallies,
  purgeEmailSentRecords,
  refusedTally,
  ResendError,
  sendEmail,
  SENT_RECORD_KEEP_MS,
  type OutgoingEmail,
} from "@/lib/email";
import { createTestDb } from "../support/db";

const email: OutgoingEmail = {
  to: "owner@shop.com",
  subject: "Good morning",
  html: "<p>hi</p>",
  text: "hi",
  idempotencyKey: "digest-ws-2026-10-13",
};

function answer(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const CHANGED_BODY_409 = {
  statusCode: 409,
  name: "invalid_idempotent_request",
  message: "Same idempotency key used with a different request payload.",
};

let database: Database;

describe("sendEmail (Resend)", () => {
  beforeEach(async () => {
    database = await createTestDb();
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM", "Squared Away <hello@example.com>");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends with the idempotency key and reports sent", async () => {
    const fetchMock = answer(200, { id: "email_1" });
    expect(await sendEmail(email)).toBe("sent");
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe(email.idempotencyKey);
  });

  it("without a key or sender address nothing is sent", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const fetchMock = answer(200, {});
    expect(await sendEmail(email)).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GUARD: a 409 for a changed body means already sent only after our own 2xx for that key", async () => {
    answer(200, { id: "email_1" });
    expect(await sendEmail(email)).toBe("sent");
    expect((await database.select().from(appSettings)).map((r) => r.key)).toEqual([
      `email-sent:${email.idempotencyKey}`,
    ]);
    answer(409, CHANGED_BODY_409);
    expect(await sendEmail({ ...email, text: "hi again" })).toBe("already_sent");
  });

  it("GUARD: a 409 with no 2xx of ours for the key stays an error (a refused first try may hold it)", async () => {
    // Say Resend refused the first try (403: sandbox sender) and kept the key anyway.
    answer(403, { statusCode: 403, name: "validation_error", message: "SECRET" });
    await expect(sendEmail(email)).rejects.toThrow("Resend 403.");
    answer(409, CHANGED_BODY_409);
    await expect(sendEmail({ ...email, text: "hi again" })).rejects.toThrow("Resend 409.");
    // Another key's 2xx proves nothing for this one.
    answer(200, { id: "email_2" });
    await sendEmail({ ...email, idempotencyKey: "digest-other-2026-10-13" });
    answer(409, CHANGED_BODY_409);
    await expect(sendEmail(email)).rejects.toThrow("Resend 409.");
    expect(
      (await database.select().from(appSettings))
        .map((r) => r.key)
        .filter((k) => k.startsWith("email-sent:")),
    ).toEqual(["email-sent:digest-other-2026-10-13"]);
  });

  it("sent records outlive Resend's 24-hour key window, then the daily purge drops them", async () => {
    answer(200, { id: "email_1" });
    await sendEmail(email);
    await database
      .insert(appSettings)
      .values({ key: "cost_alert:ws:2026-10", value: "x", updatedAt: new Date(0) });
    await purgeEmailSentRecords(new Date(Date.now() + SENT_RECORD_KEEP_MS - 60_000));
    expect(await database.select().from(appSettings)).toHaveLength(2);
    await purgeEmailSentRecords(new Date(Date.now() + SENT_RECORD_KEEP_MS + 60_000));
    // Only our sent records go; other app settings stay.
    expect((await database.select().from(appSettings)).map((r) => r.key)).toEqual([
      "cost_alert:ws:2026-10",
    ]);
  });

  it("other 409s stay errors: the first request may still fail, so nothing is marked on a guess", async () => {
    answer(200, { id: "email_1" });
    await sendEmail(email); // even with our 2xx on record
    for (const name of ["concurrent_idempotent_requests", "resource_locked", undefined]) {
      answer(409, { statusCode: 409, name, message: "SECRET-detail" });
      await expect(sendEmail(email)).rejects.toThrow("Resend 409.");
    }
    answer(409, "not json");
    await expect(sendEmail(email)).rejects.toThrow("Resend 409.");
  });

  it("Check 18 P2: a 403 is a ResendError with status 403, counted in the day's tally, and the log carries no address", async () => {
    const logs: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a));
    answer(403, { statusCode: 403, name: "validation_error", message: "SECRET owner@shop.com" });
    const err = await sendEmail(email).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResendError);
    expect((err as ResendError).name).toBe("ResendError");
    expect((err as ResendError).status).toBe(403);
    // What a sender's catch block logs: the name and the number, nothing else.
    expect(emailErrorFields(err)).toEqual({ error: "ResendError", status: 403 });
    expect(emailErrorFields(new TypeError("x"))).toEqual({ error: "TypeError" });
    expect(JSON.stringify([logs, emailErrorFields(err)])).not.toMatch(/owner@|SECRET/);
    await expect(sendEmail(email)).rejects.toThrow("Resend 403.");
    answer(500, "oops");
    await expect(sendEmail(email)).rejects.toThrow("Resend 500.");
    const today = new Date().toISOString().slice(0, 10);
    const rows = await database.select().from(appSettings);
    expect(rows.map((r) => r.key)).toEqual([`email-refused:${today}`]);
    expect(JSON.parse(rows[0]!.value)).toEqual({ "403": 2, "500": 1 });
    expect(await refusedTally(7)).toEqual({ total: 3, byStatus: { "403": 2, "500": 1 } });
    // Older days count within the window and are dropped after two weeks.
    await database
      .insert(appSettings)
      .values({ key: "email-refused:2026-01-01", value: JSON.stringify({ "403": 9 }) });
    expect((await refusedTally(7)).total).toBe(3);
    await purgeEmailRefusedTallies();
    expect((await database.select().from(appSettings)).map((r) => r.key)).toEqual([
      `email-refused:${today}`,
    ]);
    // A 409 "already sent" is not a refusal.
    answer(200, { id: "email_1" });
    await sendEmail({ ...email, idempotencyKey: "k2" });
    answer(409, CHANGED_BODY_409);
    expect(await sendEmail({ ...email, idempotencyKey: "k2", text: "again" })).toBe("already_sent");
    expect((await refusedTally(7)).total).toBe(3);
  });

  it("Check 18 P5: an owner email replies to SUPPORT_EMAIL, else ADMIN_EMAIL, else nobody; a notice to Davi gets none", async () => {
    const body = (fetchMock: ReturnType<typeof answer>) =>
      JSON.parse(
        (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
      ) as Record<string, unknown>;
    vi.stubEnv("SUPPORT_EMAIL", " help@squaredaway.example ");
    vi.stubEnv("ADMIN_EMAIL", "davi@example.com");
    let f = answer(200, { id: "1" });
    await sendEmail(email);
    expect(body(f).reply_to).toBe("help@squaredaway.example");
    vi.stubEnv("SUPPORT_EMAIL", "");
    f = answer(200, { id: "2" });
    await sendEmail({ ...email, idempotencyKey: "k2" });
    expect(body(f).reply_to).toBe("davi@example.com");
    // An explicit address still wins; null means none on purpose (notices to Davi himself).
    f = answer(200, { id: "3" });
    await sendEmail({ ...email, idempotencyKey: "k3", replyTo: "shop@example.com" });
    expect(body(f).reply_to).toBe("shop@example.com");
    f = answer(200, { id: "4" });
    await sendEmail({ ...email, idempotencyKey: "k4", to: "davi@example.com", replyTo: null });
    expect(body(f)).not.toHaveProperty("reply_to");
    vi.stubEnv("ADMIN_EMAIL", "");
    f = answer(200, { id: "5" });
    await sendEmail({ ...email, idempotencyKey: "k5" });
    expect(body(f)).not.toHaveProperty("reply_to");
  });

  it("a refusal's error carries the status only, never Resend's message", async () => {
    answer(422, { statusCode: 422, name: "validation_error", message: "SECRET owner@shop.com" });
    const err = await sendEmail(email).catch((e: unknown) => e);
    expect((err as Error).message).toBe("Resend 422.");
  });
});
