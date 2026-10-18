import { DrizzleQueryError, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { SafeQueryError } from "@/db";
import { users } from "@/db/schema";
import { toSafeQueryError } from "@/db/safe-errors";
import { scrubJobError } from "@/jobs/client";
import { createTestDb } from "../support/db";

/**
 * Check 26 P5: a failed query never carries the row's values — not in its message, its stack or
 * any field — whether it reaches Vercel's logs (an unhandled action) or Inngest's run history.
 */

const SECRET = "SECRET-DRAFT-TEXT";

/** Everything a logger or serializer could print from an error. */
function everything(err: unknown): string {
  const e = err as Error & Record<string, unknown>;
  const fields = Object.fromEntries(Object.entries(e));
  return [String(e.message), String(e.stack), JSON.stringify(fields), String(e.cause ?? "")].join(
    "\n",
  );
}

describe("GUARDRAIL: SafeQueryError", () => {
  it("a unique-constraint failure on PGlite keeps the SQL's first line and 23505, never the values", async () => {
    const database = await createTestDb();
    await database.insert(users).values({ email: "owner@shop.com", name: SECRET });
    const err = await database
      .insert(users)
      .values({ email: "owner@shop.com", name: SECRET })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(SafeQueryError);
    const e = err as SafeQueryError;
    expect(e.name).toBe("SafeQueryError");
    expect(e.code).toBe("23505");
    expect(e.message).toMatch(/^Failed query: insert into "users" .*\(code 23505\)$/);
    expect(e.message).toContain("$1");
    expect(e.cause).toBeUndefined();
    const all = everything(e);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("owner@shop.com");
    expect(all).not.toContain("params");
  });

  it("works inside a transaction too, and the transaction still rolls back", async () => {
    const database = await createTestDb();
    await database.insert(users).values({ email: "a@shop.com" });
    const err = await database
      .transaction(async (tx) => {
        await tx.update(users).set({ name: "first" }).where(eq(users.email, "a@shop.com"));
        await tx.insert(users).values({ email: "a@shop.com", name: SECRET });
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(SafeQueryError);
    expect(everything(err)).not.toContain(SECRET);
    const [row] = await database.select().from(users);
    expect(row!.name).toBeNull();
  });

  it("anything that isn't a query error is passed through untouched", () => {
    const other = new Error("not a query");
    expect(toSafeQueryError(other)).toBe(other);
    const q = new DrizzleQueryError("select 1\nfrom x", [SECRET], new Error(SECRET));
    const safe = toSafeQueryError(q) as SafeQueryError;
    expect(safe.message).toBe("Failed query: select 1");
    expect(everything(safe)).not.toContain(SECRET);
  });
});

describe("GUARDRAIL: Inngest's copy of a failed run's error is scrubbed", () => {
  it("drops everything from 'params:' on, in the message, the stack and the cause", () => {
    const cause = new Error(`Failed query: update "drafts" set "body" = $1\nparams: ${SECRET}`);
    const err = new Error(`Failed query: insert into "leads" values ($1)\nparams: ${SECRET}`, {
      cause,
    });
    Object.assign(err, { params: [SECRET] });
    const out = scrubJobError(err) as Error;
    expect(out).toBe(err); // the same object: NonRetriableError / RetryAfterError keep working
    expect(out.message).toBe('Failed query: insert into "leads" values ($1)');
    expect(everything(out)).not.toContain(SECRET);
    expect(String(out.stack)).not.toContain(SECRET);
    expect((out.cause as Error).message).not.toContain(SECRET);
  });

  it("leaves an ordinary error's message alone (but masks an email address)", () => {
    const err = new Error("Gmail API 404 for owner@shop.com");
    expect((scrubJobError(err) as Error).message).toBe("Gmail API 404 for [email]");
  });
});
