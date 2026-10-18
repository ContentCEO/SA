/**
 * Check 26 P2: a preview must never run against production's database or keys.
 *
 * Previews and production share DATABASE_URL, TOKEN_ENCRYPTION_KEY and AUTH_SECRET until Davi
 * finishes docs/LAUNCH.md step 2 (an empty `sa-preview` database and fresh keys for previews).
 * Until then a preview of any pushed branch can read customer data, decrypt Gmail refresh tokens
 * and sign an admin session. This guard compares sha256 fingerprints of the preview's values with
 * production's and refuses to connect or decrypt when one matches. Only fingerprints are stored
 * here, never a host, password or key.
 *
 * The lists ship EMPTY: with no fingerprints the guard blocks nothing (a test proves it). Davi (or
 * the integrator, with his okay) fills them with `pnpm fingerprint` run against production's
 * values (docs/LAUNCH.md step 2). Once previews have their own database and keys, the lists keep
 * them from ever being pointed back at production.
 *
 * Pure: no `server-only`, no database. Used by db() (src/db), loadKey() (src/lib/crypto.ts) and
 * /api/health.
 */
import { createHash } from "node:crypto";

type Env = Record<string, string | undefined>;

export type Fingerprints = {
  /** sha256 (hex) of production's database host name, lower case. */
  dbHosts: readonly string[];
  /** sha256 (hex) of production's TOKEN_ENCRYPTION_KEY and AUTH_SECRET, exactly as set. */
  keys: readonly string[];
};

/** Production's database host fingerprint(s). Empty until Davi supplies them. */
export const PRODUCTION_DB_HOST_SHA256: readonly string[] = [];
/** Production's TOKEN_ENCRYPTION_KEY and AUTH_SECRET fingerprints. Empty until Davi supplies them. */
export const PRODUCTION_KEY_SHA256S: readonly string[] = [];

export const PREVIEW_USES_PRODUCTION =
  "This preview is pointed at production. See docs/LAUNCH.md step 2.";

let override: Fingerprints | null = null;
/** Tests only: pretend production's fingerprints are these. */
export function setFingerprintsForTests(fp: Fingerprints | null) {
  override = fp;
}
const current = (): Fingerprints =>
  override ?? { dbHosts: PRODUCTION_DB_HOST_SHA256, keys: PRODUCTION_KEY_SHA256S };

export const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * The host(s) postgres.js would connect to, lower case: the raw authority after the FIRST "@",
 * up to the first "/" or "?", split on commas (a host list), each without its port. Read the way
 * src/config/e2e.ts reads it, because the WHATWG URL parser disagrees with postgres.js.
 */
export function databaseHosts(url: string | undefined): string[] {
  if (!url) return [];
  const start = url.indexOf("://");
  if (start < 0) return [];
  const authority = url.slice(start + 3).split(/[?/]/)[0]!;
  const hostPart = authority.slice(authority.indexOf("@") + 1);
  let decoded = hostPart;
  try {
    decoded = decodeURIComponent(hostPart);
  } catch {
    // Keep the raw text: a bad escape still names a host.
  }
  return decoded
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .map((h) => (h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.replace(/:\d*$/, "")))
    .filter(Boolean);
}

export type GuardProblem = "database_host" | "token_encryption_key" | "auth_secret";

/**
 * On a Vercel preview, which values are production's. Never blocks production, development or
 * local runs. Returns names only, never values.
 */
export function previewGuard(env: Env = process.env, fp: Fingerprints = current()): GuardProblem[] {
  if (env.VERCEL_ENV !== "preview") return [];
  const problems: GuardProblem[] = [];
  const hosts = new Set(fp.dbHosts);
  const keys = new Set(fp.keys);
  if (databaseHosts(env.DATABASE_URL).some((h) => hosts.has(sha256(h)))) {
    problems.push("database_host");
  }
  if (env.TOKEN_ENCRYPTION_KEY && keys.has(sha256(env.TOKEN_ENCRYPTION_KEY))) {
    problems.push("token_encryption_key");
  }
  if (env.AUTH_SECRET && keys.has(sha256(env.AUTH_SECRET))) problems.push("auth_secret");
  return problems;
}

/** Throws the plain message (no values) when this is a preview pointed at production. */
export function assertPreviewSafe(env: Env = process.env, fp: Fingerprints = current()): void {
  if (previewGuard(env, fp).length > 0) throw new Error(PREVIEW_USES_PRODUCTION);
}
