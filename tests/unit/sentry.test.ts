import { randomUUID } from "node:crypto";
import type { ErrorEvent } from "@sentry/nextjs";
import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { priceHistory } from "@/db/schema";
import { scrubEvent, sentryOptions } from "@/lib/sentry";
import { createTestDb } from "../support/db";

describe("error alerts never carry customer details", () => {
  it("is off without a DSN", () => {
    expect(sentryOptions.enabled).toBe(false);
    expect(sentryOptions.sendDefaultPii).toBe(false);
    expect(sentryOptions.tracesSampleRate).toBe(0);
  });

  it("drops request data, cookies, headers and query; masks emails; keeps only a user id", () => {
    const event = {
      type: undefined,
      message: "Draft for dana@example.com failed",
      request: {
        url: "https://app.example/queue?sent=abc&email=dana@example.com",
        data: "body=Hi Dana, the quote is $4,200",
        cookies: { "authjs.session-token": "secret" },
        headers: { cookie: "secret", authorization: "Bearer x" },
        query_string: "email=dana@example.com",
      },
      user: { id: "u1", email: "owner@shop.com", ip_address: "203.0.113.9" },
      exception: { values: [{ type: "Error", value: "No mailbox for owner@shop.com" }] },
      breadcrumbs: [
        { category: "console", message: "something" },
        { category: "fetch", message: "to x@y.com", data: { url: "https://gmail?q=x" } },
      ],
      extra: { body: "email text" },
    } as unknown as ErrorEvent;

    const out = JSON.stringify(scrubEvent(event));
    for (const leak of ["dana@example.com", "owner@shop.com", "secret", "4,200", "203.0.113.9"]) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain("[email]");
    expect(out).toContain('"id":"u1"');
    expect(out).toContain("https://app.example/queue");
    expect(out).not.toContain('"category":"console"');
  });

  it("keeps no element text from taps: amounts and names in aria-labels never leave (A9)", () => {
    const event = {
      type: undefined,
      breadcrumbs: [
        {
          category: "ui.click",
          message: 'li > button[aria-label="Use $1,800 for the price"]',
          data: { label: "Zelda Secretname" },
        },
        {
          category: "ui.input",
          message: 'article[aria-label="Invoice for Zelda Secretname"] > input',
        },
        { category: "navigation", message: "/money", data: { from: "/quotes" } },
      ],
    } as unknown as ErrorEvent;
    const scrubbed = scrubEvent(event);
    const out = JSON.stringify(scrubbed);
    for (const leak of ["$1,800", "1,800", "Zelda", "Secretname"]) {
      expect(out).not.toContain(leak);
    }
    // The tap itself is still there, for the timeline.
    expect(scrubbed.breadcrumbs?.map((b) => b.category)).toEqual([
      "ui.click",
      "ui.input",
      "navigation",
    ]);
    expect(out).toContain("/money");
  });

  it("a failed price-memory write keeps the SQL but none of the values (job, price, ids)", async () => {
    const database = await createTestDb();
    const service = "Zelda Secretname kitchen remodel at 12 Elm St";
    const workspaceId = randomUUID();
    const threadId = randomUUID();
    // No such workspace or thread: the insert fails the way a dropped connection or a
    // timeout would, wrapped by Drizzle with every bound value in its message.
    const err = await database
      .insert(priceHistory)
      .values({
        workspaceId,
        threadId,
        service,
        amountCents: 1_823_457,
        quotedAt: new Date("2026-03-01T15:00:00Z"),
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(DrizzleQueryError);
    const query = err as DrizzleQueryError;
    // The leak is real before scrubbing.
    expect(query.message).toContain(service);
    expect(query.message).toContain("1823457");

    const cause = query.cause as Error;
    const event = {
      type: undefined,
      message: query.message,
      logentry: { message: query.message, params: [service] },
      exception: {
        values: [
          { type: cause.name, value: `Wrapped: ${query.message}` },
          { type: "DrizzleQueryError", value: query.message },
        ],
      },
    } as unknown as ErrorEvent;
    const scrubbed = scrubEvent(event);
    const out = JSON.stringify(scrubbed);
    for (const leak of [
      "Zelda",
      "Secretname",
      "Elm St",
      "1823457",
      workspaceId,
      threadId,
      "2026-03-01",
    ]) {
      expect(out).not.toContain(leak);
    }
    // What failed is still there for whoever reads the alert.
    expect(scrubbed.exception?.values?.[1]?.value).toMatch(
      /^Failed query: insert into "price_history"/,
    );
    expect(scrubbed.message).toMatch(/^Failed query: insert into "price_history"/);
    expect(scrubbed.exception?.values?.[0]?.value).toContain("params: [dropped]");
    // Builds a whole in-memory database (migrations included) inside the test, like
    // growth-sentry.test.ts: the 5 s default isn't enough on a busy machine.
  }, 30_000);
});
