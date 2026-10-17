import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Check 50 P3: review prompts written side by side each added the same column under their own
 * migration (business_profile.state, messages.auto_reply…). On the shared database the second
 * migration fails on a column that exists; under two names the app gets two lists that disagree.
 * This parses every drizzle/*.sql for CREATE TABLE column lists and ALTER TABLE … ADD COLUMN, and
 * fails when the same table.column is added twice, naming both files.
 */

type Added = { key: string; file: string };

const unquote = (name: string) => name.replace(/"/g, "").replace(/^public\./, "");

/** Every table.column a migration file adds. */
function columnsAdded(file: string, sqlText: string): Added[] {
  const out: Added[] = [];
  const text = sqlText.replace(/^\s*--(?! statement-breakpoint).*$/gm, "");
  for (const m of text.matchAll(
    /CREATE TABLE (?:IF NOT EXISTS )?((?:"?\w+"?\.)?"?\w+"?)\s*\(([\s\S]*?)\n\);/gi,
  )) {
    const table = unquote(m[1]!);
    for (const line of m[2]!.split("\n")) {
      const col = line.match(/^\s*"(\w+)"\s+/);
      if (col) out.push({ key: `${table}.${col[1]}`, file });
    }
  }
  for (const stmt of text.split("--> statement-breakpoint")) {
    const alter = stmt.match(/ALTER TABLE (?:ONLY )?((?:"?\w+"?\.)?"?\w+"?)/i);
    if (!alter) continue;
    const table = unquote(alter[1]!);
    for (const add of stmt.matchAll(/ADD COLUMN (?:IF NOT EXISTS )?"?(\w+)"?/gi)) {
      out.push({ key: `${table}.${add[1]}`, file });
    }
  }
  return out;
}

/** "table.column: first.sql and second.sql" for each column added more than once. */
function duplicates(files: Array<{ file: string; sql: string }>): string[] {
  const seen = new Map<string, string>();
  const dupes: string[] = [];
  for (const { file, sql } of files) {
    for (const a of columnsAdded(file, sql)) {
      const first = seen.get(a.key);
      if (first) dupes.push(`${a.key} is added by both ${first} and ${a.file}`);
      else seen.set(a.key, a.file);
    }
  }
  return dupes;
}

const repo = readdirSync("drizzle")
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((file) => ({ file, sql: readFileSync(join("drizzle", file), "utf8") }));

describe("no column is added by two migrations", () => {
  it("parses the repo's migrations (so an empty parse can't pass)", () => {
    const all = repo.flatMap((f) => columnsAdded(f.file, f.sql)).map((a) => a.key);
    for (const key of [
      "users.email",
      "messages.body_text",
      "business_profile.review_url",
      "business_profile.state",
      "business_profile.crew_addresses",
      "messages.auto_reply",
      "messages.ack_only",
    ]) {
      expect(all, key).toContain(key);
    }
  });

  it("the repo has no column added twice", () => {
    expect(duplicates(repo)).toEqual([]);
  });

  it("the reserved columns are all in one migration", () => {
    const owners = new Set(
      repo
        .flatMap((f) => columnsAdded(f.file, f.sql))
        .filter((a) =>
          [
            "business_profile.state",
            "business_profile.crew_addresses",
            "messages.auto_reply",
            "messages.ack_only",
          ].includes(a.key),
        )
        .map((a) => a.file),
    );
    expect([...owners]).toEqual(["0035_reserved_columns.sql"]);
  });

  it("self-test: two migrations adding the same column fail, naming both files", () => {
    const found = duplicates([
      ...repo,
      {
        file: "0099_team.sql",
        sql: 'ALTER TABLE "business_profile" ADD COLUMN "state" text;--> statement-breakpoint\nALTER TABLE "business_profile" ADD COLUMN "team_addresses" text[];',
      },
      {
        file: "0100_new_table.sql",
        sql: 'CREATE TABLE "growth_things" (\n\t"id" uuid PRIMARY KEY NOT NULL,\n\t"id" text\n);\n',
      },
    ]);
    expect(found).toEqual([
      "business_profile.state is added by both 0035_reserved_columns.sql and 0099_team.sql",
      "growth_things.id is added by both 0100_new_table.sql and 0100_new_table.sql",
    ]);
  });
});
