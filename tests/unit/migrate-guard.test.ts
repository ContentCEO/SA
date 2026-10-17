import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendOnlyProblems,
  checkAfterMigrate,
  checkBeforeMigrate,
  journalProblems,
  MigrationGuardError,
  readJournal,
  type JournalEntry,
  type Query,
} from "../../scripts/migrate-guard";

/**
 * Check 30 P2: scripts/migrate.ts refuses to run when drizzle would silently skip a migration
 * (a journal entry stamped older than the newest one already applied), and when the journal is
 * malformed. Runs against PGlite with the real migrations.
 */

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of drizzle/ in a temporary folder, so a test can add a fake migration. */
function copyMigrations(): string {
  const dir = mkdtempSync(join(tmpdir(), "sa-migrate-guard-"));
  temps.push(dir);
  cpSync("drizzle", dir, { recursive: true });
  return dir;
}

function writeJournal(folder: string, entries: JournalEntry[]) {
  const path = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as { entries: unknown[] };
  journal.entries = entries.map((e) => ({ version: "7", breakpoints: true, ...e }));
  writeFileSync(path, JSON.stringify(journal, null, 2));
}

async function migratedDb(folder = "./drizzle") {
  const client = new PGlite();
  await migrate(drizzle(client), { migrationsFolder: folder });
  const query: Query = async (text) => (await client.query<Record<string, unknown>>(text)).rows;
  return { client, query };
}

async function guardMessage(run: Promise<void>): Promise<string> {
  try {
    await run;
  } catch (err) {
    expect(err).toBeInstanceOf(MigrationGuardError);
    return (err as Error).message;
  }
  throw new Error("expected the guard to refuse");
}

describe("migration guard (scripts/migrate.ts)", () => {
  it("passes on a fresh database and after a normal run", async () => {
    const client = new PGlite();
    const query: Query = async (text) => (await client.query<Record<string, unknown>>(text)).rows;
    await checkBeforeMigrate(query, "./drizzle"); // no migrations table yet
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
    await checkAfterMigrate(query, "./drizzle");
    await checkBeforeMigrate(query, "./drizzle"); // nothing pending: still fine
  });

  it("passes when a new migration is stamped after the newest applied one", async () => {
    const { query } = await migratedDb();
    const folder = copyMigrations();
    const entries = readJournal(folder);
    const last = entries.at(-1)!;
    const tag = `${String(entries.length).padStart(4, "0")}_newer`;
    writeFileSync(join(folder, `${tag}.sql`), `ALTER TABLE "users" ADD COLUMN "guard_ok" text;`);
    writeJournal(folder, [...entries, { idx: entries.length, when: last.when + 1000, tag }]);
    await checkBeforeMigrate(query, folder);
  });

  it("refuses an extra migration stamped before the newest applied one, naming both tags", async () => {
    const { client, query } = await migratedDb();
    const folder = copyMigrations();
    const entries = readJournal(folder);
    const last = entries.at(-1)!;
    const tag = `${String(entries.length).padStart(4, "0")}_older_stamp`;
    writeFileSync(join(folder, `${tag}.sql`), `ALTER TABLE "users" ADD COLUMN "guard_x" text;`);
    // Stamped an hour before the newest applied migration but listed after it: the case drizzle
    // skips. (Listed in idx order it would also break "strictly increasing", so check that the
    // skip itself is named.)
    writeJournal(folder, [...entries, { idx: entries.length, when: last.when - 3_600_000, tag }]);
    const message = await guardMessage(checkBeforeMigrate(query, folder));
    expect(message).toContain(
      `Migration ${tag} is older than ${last.tag}, which is already applied; renumber and regenerate it.`,
    );

    // Proof that drizzle really skips it without an error, and that the after-check catches it.
    await migrate(drizzle(client), { migrationsFolder: folder });
    const cols = await client.query(
      `select 1 from information_schema.columns where table_name = 'users' and column_name = 'guard_x'`,
    );
    expect(cols.rows).toHaveLength(0);
    expect(await guardMessage(checkAfterMigrate(query, folder))).toContain(
      `Migration ${tag} was not applied`,
    );
  });

  it("refuses a journal whose `when` values are out of order", async () => {
    const folder = copyMigrations();
    const entries = readJournal(folder);
    const swapped = entries.map((e) => ({ ...e }));
    const a = swapped[5]!;
    const b = swapped[6]!;
    [a.when, b.when] = [b.when, a.when];
    writeJournal(folder, swapped);
    const client = new PGlite();
    const query: Query = async (text) => (await client.query<Record<string, unknown>>(text)).rows;
    const message = await guardMessage(checkBeforeMigrate(query, folder));
    expect(message).toContain(b.tag);
  });

  it("refuses duplicate idx values and duplicate tag numbers", () => {
    const problems = journalProblems([
      { idx: 0, when: 1, tag: "0000_a" },
      { idx: 1, when: 2, tag: "0001_b" },
      { idx: 1, when: 3, tag: "0001_c" },
    ]);
    expect(problems.join("\n")).toContain("share idx 1");
    expect(problems.join("\n")).toContain("share number 0001");
  });
});

describe("journal is append-only against main (the CI step)", () => {
  const base: JournalEntry[] = [
    { idx: 0, when: 10, tag: "0000_a" },
    { idx: 1, when: 20, tag: "0001_b" },
  ];

  it("allows new entries at the end", () => {
    expect(appendOnlyProblems(base, [...base, { idx: 2, when: 30, tag: "0002_c" }])).toEqual([]);
  });

  it("refuses an edited, renumbered or removed entry", () => {
    expect(appendOnlyProblems(base, [base[0]!, { idx: 1, when: 21, tag: "0001_b" }])).toHaveLength(
      1,
    );
    expect(appendOnlyProblems(base, [base[0]!, { idx: 1, when: 20, tag: "0001_x" }])).toHaveLength(
      1,
    );
    expect(appendOnlyProblems(base, [base[0]!])).toEqual([
      "Migration 0001_b is missing from this branch's journal.",
    ]);
  });
});
