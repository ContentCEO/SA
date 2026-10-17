/**
 * Check 26 P2: print the fingerprints the preview guard (src/config/environment-guard.ts) compares,
 * WITHOUT printing any value: sha256 of DATABASE_URL's host, of TOKEN_ENCRYPTION_KEY and of
 * AUTH_SECRET, read from the current environment (or from an env file given as the argument).
 *
 *   pnpm fingerprint                      # the environment this runs in
 *   pnpm fingerprint .env.production.local   # e.g. after `vercel env pull` for Production
 *
 * Paste the printed hashes into PRODUCTION_DB_HOST_SHA256 / PRODUCTION_KEY_SHA256S. A hash can't
 * be turned back into the value. Delete any pulled env file afterwards.
 */
import { databaseHosts, sha256 } from "../src/config/environment-guard";

const file = process.argv[2];
if (file) process.loadEnvFile(file);

const line = (name: string, values: string[]) =>
  console.log(values.length ? `${name}: ${values.map(sha256).join(", ")}` : `${name}: (not set)`);

line("DATABASE_URL host", databaseHosts(process.env.DATABASE_URL));
line(
  "TOKEN_ENCRYPTION_KEY",
  process.env.TOKEN_ENCRYPTION_KEY ? [process.env.TOKEN_ENCRYPTION_KEY] : [],
);
line("AUTH_SECRET", process.env.AUTH_SECRET ? [process.env.AUTH_SECRET] : []);
