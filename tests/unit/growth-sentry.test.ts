import type { ErrorEvent } from "@sentry/nextjs";
import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { SafeQueryError } from "@/db";
import { waitlist } from "@/db/schema";
import { scrubEvent } from "@/lib/sentry";
import { createTestDb } from "../support/db";

// Kept apart from sentry.test.ts (M7's file, as close as this branch allows) so the two branches merge cleanly.
describe("a failed Growth call write never reaches error alerts with the requester's details", () => {
  it("a failed Growth call write keeps the SQL but none of the values (name, phone, note)", async () => {
    const database = await createTestDb();
    const row = {
      email: "mike@shop.com",
      name: "Mike Secretname",
      phone: "617-555-0142",
      teamSize: "growth-only",
      note: "[Growth call] 2026-10-12 14:05\nHelp with: Reviews\nPhone: 617-555-0142",
    };
    await database.insert(waitlist).values(row);
    // The same email again with no conflict handling: Drizzle wraps the failure with every
    // bound value in its message.
    const err = await database
      .insert(waitlist)
      .values(row)
      .then(
        () => null,
        (e: unknown) => e,
      );
    // Check 26 P5: the database layer already swaps Drizzle's error for one with no values.
    expect(err).toBeInstanceOf(SafeQueryError);
    expect(String((err as Error).message)).not.toContain("617-555-0142");
    expect(String((err as Error).stack)).not.toContain("Secretname");

    // Sentry's scrub still holds on its own, for Drizzle's original error (defence in depth).
    const query = new DrizzleQueryError(
      'insert into "waitlist" ("email", "name", "phone", "team_size", "note") values ($1, $2, $3, $4, $5)',
      [row.email, row.name, row.phone, row.teamSize, row.note],
      new Error("duplicate key value violates unique constraint"),
    );
    expect(query.message).toContain("617-555-0142");
    expect(query.message).toContain("Mike");

    const cause = query.cause as Error;
    const event = {
      type: undefined,
      message: query.message,
      logentry: { message: query.message, params: [row.name] },
      exception: {
        values: [
          { type: cause.name, value: `Wrapped: ${query.message}` },
          { type: "DrizzleQueryError", value: query.message },
        ],
      },
    } as unknown as ErrorEvent;
    const scrubbed = scrubEvent(event);
    const out = JSON.stringify(scrubbed);
    for (const leak of ["Mike", "Secretname", "617-555-0142", "mike@shop.com", "Reviews"]) {
      expect(out).not.toContain(leak);
    }
    expect(scrubbed.message).toMatch(/^Failed query: insert into "waitlist"/);
    expect(scrubbed.exception?.values?.[1]?.value).toMatch(/^Failed query: insert into "waitlist"/);
    expect(scrubbed.exception?.values?.[0]?.value).toContain("params: [dropped]");
  }, 30_000);
});
