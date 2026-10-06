import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";
import { scrubEvent, sentryOptions } from "@/lib/sentry";

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
});
