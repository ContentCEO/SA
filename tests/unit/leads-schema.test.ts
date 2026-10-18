import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Leads package: one additive migration (previews and production share a database, so old
 * code must keep working): new columns only, each nullable or with a default, no backfill.
 */
describe("migration 0032 leads", () => {
  it("only adds nullable or defaulted columns", () => {
    const sql = readFileSync("drizzle/0032_leads.sql", "utf8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(4);
    for (const s of statements) {
      expect(s).toMatch(/^ALTER TABLE "(threads|business_profile)" ADD COLUMN /);
      if (/NOT NULL/.test(s)) expect(s).toMatch(/DEFAULT/);
      expect(s).not.toMatch(/UPDATE|DROP|RENAME/);
    }
  });
});
