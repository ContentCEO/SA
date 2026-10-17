/**
 * Check 30 P2: stop a build when drizzle would silently skip a migration.
 *
 * drizzle-orm's migrator (pg-core/dialect.js `migrate()`) applies a journal entry only when its
 * `when` is later than the newest `created_at` already recorded in
 * `drizzle.__drizzle_migrations`. A migration written on one branch before another branch's
 * migration ran on the shared database is skipped forever, with no error. These checks run
 * before and after `migrate()` (scripts/migrate.ts, scripts/migrate-http.ts) and fail the build
 * with the tags involved. Pure apart from reading the migrations folder; the database is reached
 * through the `query` function the caller passes, so the same code runs on postgres.js, Neon's
 * HTTP driver and PGlite (tests/unit/migrate-guard.test.ts).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type JournalEntry = { idx: number; when: number; tag: string };
export type AppliedRow = { hash: string; created_at: string | number | bigint | null };
export type Query = (text: string) => Promise<Array<Record<string, unknown>>>;

export type LocalMigration = JournalEntry & { hash: string };

export function readJournal(folder: string): JournalEntry[] {
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries;
}

/** Each journal entry with the hash drizzle records for it (sha256 of the .sql file's text). */
export function readLocalMigrations(folder: string): LocalMigration[] {
  return readJournal(folder).map((e) => ({
    ...e,
    hash: createHash("sha256")
      .update(readFileSync(join(folder, `${e.tag}.sql`)).toString())
      .digest("hex"),
  }));
}

/** Duplicate idx or tag numbers, and `when` values that don't strictly increase in idx order. */
export function journalProblems(entries: JournalEntry[]): string[] {
  const problems: string[] = [];
  const seenIdx = new Map<number, string>();
  const seenNumber = new Map<string, string>();
  for (const e of entries) {
    const other = seenIdx.get(e.idx);
    if (other) problems.push(`Migrations ${other} and ${e.tag} share idx ${e.idx}.`);
    seenIdx.set(e.idx, e.tag);
    const number = e.tag.split("_")[0]!;
    const sameNumber = seenNumber.get(number);
    if (sameNumber) problems.push(`Migrations ${sameNumber} and ${e.tag} share number ${number}.`);
    seenNumber.set(number, e.tag);
  }
  const byIdx = [...entries].sort((a, b) => a.idx - b.idx);
  for (let i = 1; i < byIdx.length; i++) {
    const prev = byIdx[i - 1]!;
    const cur = byIdx[i]!;
    if (cur.when <= prev.when) {
      problems.push(
        `Migration ${cur.tag} is stamped no later than ${prev.tag}, which comes before it; renumber and regenerate it.`,
      );
    }
  }
  return problems;
}

/**
 * Journal entries the database hasn't recorded (by drizzle's hash, or by its `created_at`,
 * which drizzle sets to the entry's `when`).
 */
export function missingFromDatabase(
  local: LocalMigration[],
  applied: AppliedRow[],
): LocalMigration[] {
  const hashes = new Set(applied.map((r) => r.hash));
  const stamps = new Set(applied.map((r) => Number(r.created_at)));
  return local.filter((m) => !hashes.has(m.hash) && !stamps.has(m.when));
}

/**
 * The migrations drizzle would skip: not recorded, and stamped no later than the newest one
 * that is. Each message names the skipped tag and the newest applied one.
 */
export function skippedMigrations(local: LocalMigration[], applied: AppliedRow[]): string[] {
  if (applied.length === 0) return [];
  const newest = Math.max(...applied.map((r) => Number(r.created_at)));
  const newestTag =
    local.find((m) => m.when === newest)?.tag ?? `the migration stamped ${String(newest)}`;
  return missingFromDatabase(local, applied)
    .filter((m) => m.when <= newest)
    .map(
      (m) =>
        `Migration ${m.tag} is older than ${newestTag}, which is already applied; renumber and regenerate it.`,
    );
}

/** A branch's journal must be the base journal unchanged, plus new entries at the end. */
export function appendOnlyProblems(base: JournalEntry[], head: JournalEntry[]): string[] {
  const problems: string[] = [];
  base.forEach((b, i) => {
    const h = head[i];
    if (!h) problems.push(`Migration ${b.tag} is missing from this branch's journal.`);
    else if (h.idx !== b.idx || h.tag !== b.tag || h.when !== b.when) {
      problems.push(
        `Journal entry ${i} was ${b.tag} (when ${b.when}) and is now ${h.tag} (when ${h.when}); never edit or renumber a migration that has run.`,
      );
    }
  });
  return problems;
}

export async function appliedMigrations(query: Query): Promise<AppliedRow[]> {
  const exists = await query(
    `select to_regclass('drizzle.__drizzle_migrations') is not null as "exists"`,
  );
  if (!exists[0]?.exists) return [];
  const rows = await query(`select hash, created_at from drizzle.__drizzle_migrations`);
  return rows.map((r) => ({
    hash: String(r.hash),
    created_at: r.created_at as AppliedRow["created_at"],
  }));
}

export class MigrationGuardError extends Error {
  constructor(public problems: string[]) {
    super(problems.join("\n"));
    this.name = "MigrationGuardError";
  }
}

/** Before migrate(): the journal is well-formed and nothing would be skipped. */
export async function checkBeforeMigrate(query: Query, folder: string): Promise<void> {
  const local = readLocalMigrations(folder);
  const problems = [
    ...journalProblems(local),
    ...skippedMigrations(local, await appliedMigrations(query)),
  ];
  if (problems.length) throw new MigrationGuardError(problems);
}

/** After migrate(): every journal entry is recorded. */
export async function checkAfterMigrate(query: Query, folder: string): Promise<void> {
  const missing = missingFromDatabase(readLocalMigrations(folder), await appliedMigrations(query));
  if (missing.length) {
    throw new MigrationGuardError(
      missing.map((m) => `Migration ${m.tag} was not applied; renumber and regenerate it.`),
    );
  }
}
