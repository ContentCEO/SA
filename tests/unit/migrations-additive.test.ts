import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Check 31 P2: previews and production share one database, and every preview build runs its
 * branch's migrations on it (package.json "vercel-build") before anyone reviews them. So every
 * migration must be additive: the code that's live keeps working against the new schema. This
 * reads every drizzle/*.sql and refuses drops, renames, NOT NULL tightening, type changes,
 * truncates and deletes, a new NOT NULL column without a default, and any enum change other than
 * ADD VALUE. (That every .sql file has a journal entry, with idx 0..N and no gap, is checked in
 * tests/unit/migrations-order.test.ts; not repeated here.)
 *
 * CI's "old-code-new-schema" job also runs main's unit tests against this branch's migrations.
 */

/**
 * Statements already in the repo that the rule would flag, by file, each with the reason it was
 * safe. Empty on 2026-10-17 (all 35 migrations passed); one row since 2026-10-19. Don't loosen the patterns; add a row here
 * on purpose, with the reason, if a reviewed statement ever needs one.
 */
const REVIEWED: Record<string, string> = {
  "0076_drop_reply_address_index.sql":
    "drops only the index messages_mailbox_reply_address_idx (shipped in 0070): dropping an index " +
    "never breaks old code; held back until main carries notesForThreads' tie-break (PR #14)",
};

const REFUSED = /\bDROP\b|\bRENAME\b|SET NOT NULL|ALTER COLUMN .* TYPE|TRUNCATE|^\s*DELETE\b/im;

/** Statements of one migration file, with comment lines dropped. */
function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

/** Why a statement isn't additive, or null when it is. */
function refusal(statement: string): string | null {
  const m = statement.match(REFUSED);
  if (m) return `not additive (${m[0].trim()})`;
  for (const clause of statement.split(/\bADD COLUMN\b/i).slice(1)) {
    if (/\bNOT NULL\b/i.test(clause) && !/\bDEFAULT\b/i.test(clause)) {
      return "adds a NOT NULL column without a DEFAULT (old code's inserts would fail)";
    }
  }
  if (/\bALTER TYPE\b/i.test(statement) && !/\bADD VALUE\b/i.test(statement)) {
    return "changes an enum other than with ADD VALUE";
  }
  return null;
}

function problems(file: string, sqlText: string): string[] {
  return statements(sqlText)
    .map((s) => [s, refusal(s)] as const)
    .filter(([, why]) => why)
    .map(([s, why]) => `${file}: ${why}: ${s.slice(0, 120)}`);
}

const files = readdirSync("drizzle")
  .filter((f) => f.endsWith(".sql"))
  .sort();

describe("migrations are additive (old code keeps working on the shared database)", () => {
  it("finds the migrations", () => {
    expect(files.length).toBeGreaterThanOrEqual(35);
  });

  it.each(files)("%s", (file) => {
    const found = problems(file, readFileSync(join("drizzle", file), "utf8"));
    if (REVIEWED[file]) return;
    expect(found).toEqual([]);
  });

  it("every REVIEWED entry names a real file and still needs its exemption", () => {
    for (const file of Object.keys(REVIEWED)) {
      expect(files, file).toContain(file);
      expect(problems(file, readFileSync(join("drizzle", file), "utf8")), file).not.toEqual([]);
    }
  });

  it("self-test: refuses a DROP and a NOT NULL column without a default, allows a plain ADD COLUMN", () => {
    const fixture = [
      'ALTER TABLE "threads" DROP COLUMN "x";',
      'ALTER TABLE "threads" ADD COLUMN "y" integer NOT NULL;',
      'ALTER TABLE "threads" ADD COLUMN "z" text;',
    ].join("--> statement-breakpoint\n");
    const found = problems("fixture.sql", fixture);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('DROP COLUMN "x"');
    expect(found[1]).toContain('"y" integer NOT NULL');
  });

  it("self-test: the other shapes", () => {
    for (const bad of [
      'ALTER TABLE "a" RENAME COLUMN "b" TO "c";',
      'ALTER TABLE "a" ALTER COLUMN "b" SET NOT NULL;',
      'ALTER TABLE "a" ALTER COLUMN "b" SET DATA TYPE integer;',
      'TRUNCATE "a";',
      'DELETE FROM "a" WHERE true;',
      `ALTER TYPE "public"."plan" RENAME VALUE 'solo' TO 'one';`,
      'ALTER TABLE "a" ADD COLUMN "b" text DEFAULT \'\' NOT NULL, ADD COLUMN "c" int NOT NULL;',
    ]) {
      expect(refusal(bad), bad).not.toBeNull();
    }
    for (const ok of [
      `ALTER TYPE "public"."trade" ADD VALUE 'roofing';`,
      'ALTER TABLE "a" ADD COLUMN "b" boolean DEFAULT false NOT NULL;',
      'CREATE TABLE "x" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL);',
      'UPDATE "a" SET "b" = 1 WHERE "b" IS NULL;',
    ]) {
      expect(refusal(ok), ok).toBeNull();
    }
    // Comment lines are ignored.
    expect(statements("-- DROP everything\nSELECT 1;")).toEqual(["SELECT 1;"]);
  });
});
