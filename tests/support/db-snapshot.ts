import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    pgliteSnapshotPath: string;
  }
}

/**
 * Global setup: migrate one PGlite database with every checked-in migration, once per run, and
 * hand its data directory to the workers. createTestDb loads a copy of it instead of migrating
 * again: about half a second instead of four per database, and the unit suite makes several
 * hundred of them (CI's 45-minute job was running out of time). It is the same migrate() call
 * on the same files, so every test still sees exactly what the migrations build.
 */
export default async function setup(project: TestProject) {
  const client = new PGlite();
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  const dump = await client.dumpDataDir("none");
  await client.close();
  const dir = mkdtempSync(join(tmpdir(), "sa-pglite-"));
  const path = join(dir, "migrated.tar");
  writeFileSync(path, Buffer.from(await dump.arrayBuffer()));
  project.provide("pgliteSnapshotPath", path);
  return () => rmSync(dir, { recursive: true, force: true });
}
