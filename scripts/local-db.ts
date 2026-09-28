// A real Postgres 16 for local development — no Docker, no installer, no
// admin password. Data lives in .data/pg (gitignored). Leave it running in
// its own terminal; Ctrl-C stops it.
//
//   pnpm db:local        then, in another terminal:  pnpm db:migrate
//
// Matches CI and docs/SETUP.md: postgres://sa:sa@localhost:5432/squared_away
import { existsSync } from "node:fs";

import EmbeddedPostgres from "embedded-postgres";

const DATA_DIR = ".data/pg";
const DATABASE = "squared_away";

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: "sa",
    password: "sa",
    port: 5432,
    persistent: true,
  });

  const fresh = !existsSync(`${DATA_DIR}/PG_VERSION`);
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase(DATABASE);

  console.log(`Local Postgres ready: postgres://sa:sa@localhost:5432/${DATABASE}`);
  console.log("Press Ctrl-C to stop.");

  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
