/**
 * Local end-to-end test mode (Milestone 11). The ONLY file that may read the SA_E2E* variables
 * (a unit test walks src/ to keep it that way).
 *
 * In e2e mode the app talks to local fake Google and Anthropic servers instead of the real
 * ones, and /api/test-hooks/run can run the job steps without Inngest. It is on only when ALL
 * of these hold, so it can't switch on anywhere real by mistake:
 *
 * - `SA_E2E` is exactly "1";
 * - this isn't a Vercel deploy (`VERCEL` and `VERCEL_ENV` both absent; previews share the
 *   production database, so they're refused too);
 * - `SA_E2E_GOOGLE_BASE_URL` and `SA_E2E_ANTHROPIC_BASE_URL` are both set, http(s), on this
 *   machine (hostname exactly localhost, 127.0.0.1 or [::1]);
 * - `DATABASE_URL` points at this machine (loopback host or a unix socket), so a checkout whose
 *   .env.local holds the production database can never run in e2e mode.
 *
 * `pnpm start` runs with NODE_ENV=production, so NODE_ENV is deliberately not part of the
 * test: the loopback rules are the real gate there. Off e2e mode every value below is the real
 * one, unchanged. Pure: no `server-only`, no database.
 */

type Env = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True for exactly localhost / 127.0.0.1 / [::1] — never a prefix or substring match. */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

function isLoopbackHttpUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

/** A loopback host, or a unix socket path (starts with "/"). Never a host list ("a,b"). */
const localHost = (host: string) =>
  !host.includes(",") && (host.startsWith("/") || isLoopbackHostname(host));

/**
 * The database is on this machine: a loopback host or a unix socket. Read the way postgres.js
 * (src/db, the e2e global setup and tests/e2e/support.ts) reads it, not only the way the
 * WHATWG URL parser does. They disagree: postgres.js takes the host text from the raw
 * authority after the FIRST "@" (the URL parser: after the LAST), percent-decodes it, and a
 * comma there makes a host list it tries in turn. So `postgres://u:x@remote,y@localhost/db`
 * is "localhost" to the URL parser but "remote" first to postgres.js. Refused here: a comma
 * (raw or encoded), more than one "@" or a "#" in the raw authority, and anything that doesn't
 * parse. Otherwise postgres.js connects to the URL's hostname, else PGHOST, else localhost.
 */
export function isLocalDatabaseUrl(value: string | undefined, env: Env = process.env): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return false;
    // postgres.js's own cut: after "://", up to the first "/" or "?".
    if (value.indexOf("://") !== url.protocol.length - 1) return false;
    const authority = value.slice(url.protocol.length + 2).split(/[?/]/)[0]!;
    if (authority.split("@").length > 2 || authority.includes("#")) return false;
    if (decodeURIComponent(authority.slice(authority.indexOf("@") + 1)).includes(",")) {
      return false;
    }
    // postgres.js ignores ?host= / ?hostaddr=, but other tools (psql, drizzle-kit) read
    // them, so a host there must be local too.
    for (const key of ["host", "hostaddr"]) {
      for (const h of url.searchParams.getAll(key)) if (!localHost(h)) return false;
    }
    // A percent-encoded socket path (postgres://u@%2Fvar%2Frun%2Fpostgresql/db) is local too.
    if (url.hostname) return localHost(decodeURIComponent(url.hostname));
    // No host in the URL: postgres.js connects to PGHOST, else localhost
    // (`url.hostname || env.PGHOST || 'localhost'`), whatever the query string says.
    return localHost(env.PGHOST || "localhost");
  } catch {
    return false;
  }
}

export function e2eMode(env: Env = process.env): boolean {
  return (
    env.SA_E2E === "1" &&
    env.VERCEL === undefined &&
    env.VERCEL_ENV === undefined &&
    isLoopbackHttpUrl(env.SA_E2E_GOOGLE_BASE_URL) &&
    isLoopbackHttpUrl(env.SA_E2E_ANTHROPIC_BASE_URL) &&
    isLocalDatabaseUrl(env.DATABASE_URL, env)
  );
}

export type GoogleEndpoints = {
  gmailApi: string;
  token: string;
  userinfo: string;
  revoke: string;
};

const GOOGLE: GoogleEndpoints = {
  gmailApi: "https://gmail.googleapis.com/gmail/v1/users/me",
  token: "https://oauth2.googleapis.com/token",
  userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
  revoke: "https://oauth2.googleapis.com/revoke",
};

const trimSlash = (s: string) => s.replace(/\/+$/, "");

/**
 * Where the server talks to Google. The browser's consent page is not here on purpose: it
 * can't be redirected, so the CSP form-action never changes.
 */
export function googleEndpoints(env: Env = process.env): GoogleEndpoints {
  if (!e2eMode(env)) return GOOGLE;
  const base = trimSlash(env.SA_E2E_GOOGLE_BASE_URL!);
  return {
    gmailApi: `${base}/gmail/v1/users/me`,
    token: `${base}/token`,
    userinfo: `${base}/userinfo`,
    revoke: `${base}/revoke`,
  };
}

export type AnthropicClientOptions = {
  baseURL?: string;
  apiKey?: string;
  authToken?: null;
  defaultHeaders?: Record<string, null>;
  maxRetries?: number;
};

/** Header names the SDK would add from ANTHROPIC_CUSTOM_HEADERS (its own parse: "Name: value" lines). */
function customHeaderNames(env: Env): string[] {
  const raw = env.ANTHROPIC_CUSTOM_HEADERS;
  if (!raw) return [];
  return raw
    .split("\n")
    .filter((line) => line.includes(":"))
    .map((line) => line.substring(0, line.indexOf(":")).trim())
    .filter(Boolean);
}

/**
 * Extra Anthropic client options: none off e2e mode (the SDK keeps its own env defaults).
 * In e2e mode nothing real reaches the fake: a fake key, `authToken: null` (else the SDK reads
 * ANTHROPIC_AUTH_TOKEN and sends it as a Bearer header too), and every header the SDK would
 * add from ANTHROPIC_CUSTOM_HEADERS is removed (a null header = omit).
 */
export function anthropicClientOptions(env: Env = process.env): AnthropicClientOptions {
  if (!e2eMode(env)) return {};
  const names = customHeaderNames(env);
  return {
    baseURL: trimSlash(env.SA_E2E_ANTHROPIC_BASE_URL!),
    apiKey: "e2e-fake-key",
    authToken: null,
    ...(names.length ? { defaultHeaders: Object.fromEntries(names.map((n) => [n, null])) } : {}),
    maxRetries: 0,
  };
}

/** The test-hooks secret: only in e2e mode and only if it's at least 32 characters. */
export function e2eHookSecret(env: Env = process.env): string | null {
  if (!e2eMode(env)) return null;
  const secret = env.SA_E2E_HOOK_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}
