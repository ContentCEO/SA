import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { createTestDb } from "../support/db";

/**
 * Check 30 P1: every foreign key needs an index that starts with its columns. Without one,
 * deleting the parent row (Delete my account, Disconnect) makes Postgres read the whole child
 * table once per deleted row — measured at 114 seconds for one account before drafts got its
 * thread / reply-to indexes. Runs on the real migrations (PGlite).
 */

/** Foreign keys that are fine without an index, each with the reason. "table.column". */
const ALLOWED: Record<string, string> = {
  "invites.referred_by_workspace_id":
    "tiny table (one row per invite); only read when a referrer deletes their account",
  "workspaces.referred_by_workspace_id":
    "one row per shop; a few dozen rows read when a referrer deletes their account",
  "referral_credits.referred_workspace_id":
    "a few rows per referral; ON DELETE SET NULL on a table that stays small",
  "referral_credits.beneficiary_workspace_id":
    "a few rows per referral; ON DELETE SET NULL on a table that stays small",
};

type Fk = { table: string; columns: string[] };

async function unindexedForeignKeys(database: Database): Promise<string[]> {
  const fks = (await database.execute(sql`
    select c.conrelid::regclass::text as "table",
           array(select a.attname::text from unnest(c.conkey) with ordinality k(attnum, ord)
                 join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
                 order by k.ord) as columns
    from pg_constraint c
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace
  `)) as unknown as { rows: Fk[] };
  // Every index's leading key columns (an expression key is 0 and never matches a column).
  // Partial indexes don't count: they don't serve a lookup for every value.
  const idx = (await database.execute(sql`
    select i.indrelid::regclass::text as "table",
           array(select coalesce(a.attname::text, '') from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
                 left join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                 order by k.ord) as columns
    from pg_index i
    join pg_class t on t.oid = i.indrelid
    where t.relnamespace = 'public'::regnamespace and i.indpred is null
  `)) as unknown as { rows: Fk[] };
  const strip = (t: string) => t.replace(/^"|"$/g, "");
  return fks.rows
    .filter(
      (fk) =>
        !idx.rows.some(
          (i) =>
            strip(i.table) === strip(fk.table) &&
            fk.columns.every((col, n) => i.columns[n] === col),
        ),
    )
    .map((fk) => `${strip(fk.table)}.${fk.columns.join(",")}`)
    .sort();
}

describe("foreign keys have indexes", () => {
  let database: Database;
  beforeAll(async () => {
    database = await createTestDb();
  });

  it("every foreign key leads some index, or is allowed with a reason", async () => {
    const missing = await unindexedForeignKeys(database);
    expect(missing.filter((m) => !(m in ALLOWED))).toEqual([]);
  });

  it("every allow-list row is still needed", async () => {
    const missing = await unindexedForeignKeys(database);
    for (const key of Object.keys(ALLOWED)) expect(missing, key).toContain(key);
  });

  it("fails when either new drafts index is removed", async () => {
    for (const name of ["drafts_thread_created_idx", "drafts_reply_to_message_idx"]) {
      await database.execute(sql`begin`);
      try {
        await database.execute(sql.raw(`drop index ${name}`));
        const missing = await unindexedForeignKeys(database);
        expect(missing.some((m) => m.startsWith("drafts."))).toBe(true);
      } finally {
        await database.execute(sql`rollback`);
      }
    }
    expect((await unindexedForeignKeys(database)).filter((m) => !(m in ALLOWED))).toEqual([]);
  });

  it("a drafts-by-thread count uses the index", async () => {
    await database.execute(sql`set enable_seqscan = off`);
    try {
      const plan = (await database.execute(
        sql`explain select count(*) from drafts where thread_id = '00000000-0000-0000-0000-000000000000'`,
      )) as unknown as { rows: { "QUERY PLAN": string }[] };
      const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(text).toMatch(/Index.* (using|on) drafts_thread_created_idx/);
    } finally {
      await database.execute(sql`set enable_seqscan = on`);
    }
  });
});
