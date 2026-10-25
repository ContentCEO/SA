import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  compareTermsVersions,
  hasCurrentTerms,
  isTermsVersion,
  termsVersionDate,
} from "@/server/terms-rules";
import { createTestDb } from "../support/db";

/**
 * Check 27 P4: a second legal release on one day is "YYYY-MM-DD.N". It must sort after the plain
 * date and before the next day, in the rules and in the database's byte-order comparison that
 * recordTermsAcceptance uses (collate "C").
 */
describe("same-day terms versions (Check 27 P4)", () => {
  const ordered = ["2026-10-16", "2026-10-16.2", "2026-10-16.3", "2026-10-17"];

  it("the shape: a date, optionally with .N", () => {
    for (const v of ordered) expect(isTermsVersion(v), v).toBe(true);
    for (const v of ["2026-10-16.", "2026-10-16.x", "2026-10-16-2", "2026/10/16", "", null])
      expect(isTermsVersion(v), String(v)).toBe(false);
    expect(termsVersionDate("2026-10-16.2")).toBe("2026-10-16");
    expect(termsVersionDate("2026-10-16")).toBe("2026-10-16");
  });

  it('orders "2026-10-16" < "2026-10-16.2" < "2026-10-17" in the rules', () => {
    for (let i = 1; i < ordered.length; i++) {
      expect(compareTermsVersions(ordered[i - 1]!, ordered[i]!)).toBeLessThan(0);
      expect(compareTermsVersions(ordered[i]!, ordered[i - 1]!)).toBeGreaterThan(0);
    }
    expect(compareTermsVersions("2026-10-16.2", "2026-10-16.2")).toBe(0);
    // Someone on the plain date is asked again by the .2 release; someone on .2 isn't by the date.
    expect(hasCurrentTerms({ termsVersion: "2026-10-16" }, "2026-10-16.2")).toBe(false);
    expect(hasCurrentTerms({ termsVersion: "2026-10-16.2" }, "2026-10-16")).toBe(true);
    expect(hasCurrentTerms({ termsVersion: "2026-10-16.2" }, "2026-10-17")).toBe(false);
  });

  it('and in the database with collate "C" (as recordTermsAcceptance compares)', async () => {
    const database = await createTestDb();
    for (let i = 1; i < ordered.length; i++) {
      const rows = (await database.execute(
        sql`select (${ordered[i - 1]} collate "C") < (${ordered[i]} collate "C") as before`,
      )) as unknown as { rows?: { before: boolean }[] } | { before: boolean }[];
      const row = Array.isArray(rows) ? rows[0] : rows.rows?.[0];
      expect(row?.before, `${ordered[i - 1]} < ${ordered[i]}`).toBe(true);
    }
  });
});
