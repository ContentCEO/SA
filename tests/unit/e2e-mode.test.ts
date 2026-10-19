import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  anthropicClientOptions,
  e2eHookSecret,
  e2eMode,
  googleEndpoints,
  isLocalDatabaseUrl,
  isLoopbackHostname,
} from "@/config/e2e";

/**
 * GUARDRAIL (Milestone 11 S1, amendment A1): the local e2e seams are inert everywhere else.
 * Without every condition the Google URLs are the real ones, the Anthropic client gets no
 * options and the test-hooks secret is null.
 */

const REAL_GOOGLE = {
  gmailApi: "https://gmail.googleapis.com/gmail/v1/users/me",
  token: "https://oauth2.googleapis.com/token",
  userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
  revoke: "https://oauth2.googleapis.com/revoke",
};
const SECRET = "s".repeat(32);

/** A complete local e2e environment, as Playwright will start the app. */
const LOCAL = {
  SA_E2E: "1",
  SA_E2E_GOOGLE_BASE_URL: "http://127.0.0.1:3301/google",
  SA_E2E_ANTHROPIC_BASE_URL: "http://127.0.0.1:3301/anthropic",
  SA_E2E_HOOK_SECRET: SECRET,
  DATABASE_URL: "postgres://postgres:pw@localhost:5432/squared_away_launch",
  NODE_ENV: "production",
};
type Env = Record<string, string | undefined>;
const without = (key: keyof typeof LOCAL): Env => ({ ...LOCAL, [key]: undefined });

/** Off e2e mode, every seam must be exactly the production value. */
function expectInert(env: Env) {
  expect(e2eMode(env)).toBe(false);
  expect(googleEndpoints(env)).toEqual(REAL_GOOGLE);
  expect(anthropicClientOptions(env)).toEqual({});
  expect(e2eHookSecret(env)).toBeNull();
}

describe("e2eMode — every condition is required", () => {
  it("is on for the full local setup, even under `pnpm start` (NODE_ENV=production)", () => {
    expect(e2eMode(LOCAL)).toBe(true);
    expect(googleEndpoints(LOCAL)).toEqual({
      gmailApi: "http://127.0.0.1:3301/google/gmail/v1/users/me",
      token: "http://127.0.0.1:3301/google/token",
      userinfo: "http://127.0.0.1:3301/google/userinfo",
      revoke: "http://127.0.0.1:3301/google/revoke",
    });
    expect(anthropicClientOptions(LOCAL)).toEqual({
      baseURL: "http://127.0.0.1:3301/anthropic",
      apiKey: "e2e-fake-key",
      authToken: null,
      maxRetries: 0,
    });
    expect(e2eHookSecret(LOCAL)).toBe(SECRET);
    // localhost and [::1] count; a trailing slash doesn't double up.
    const v6 = {
      ...LOCAL,
      SA_E2E_GOOGLE_BASE_URL: "http://[::1]:3301/",
      SA_E2E_ANTHROPIC_BASE_URL: "https://localhost:3301",
      DATABASE_URL: "postgresql://u@[::1]/db",
    };
    expect(e2eMode(v6)).toBe(true);
    expect(googleEndpoints(v6).token).toBe("http://[::1]:3301/token");
  });

  it("is off with nothing set (every normal run)", () => expectInert({}));
  it("is off on the real process env of the unit tests", () => {
    expect(e2eMode()).toBe(false);
    expect(googleEndpoints()).toEqual(REAL_GOOGLE);
    expect(anthropicClientOptions()).toEqual({});
    expect(e2eHookSecret()).toBeNull();
  });

  it("only SA_E2E='1' switches it on", () => {
    expectInert(without("SA_E2E"));
    for (const v of ["true", "yes", "on", "01", " 1", ""]) expectInert({ ...LOCAL, SA_E2E: v });
  });

  it("is off on every Vercel deploy, production or preview, even if SA_E2E=1 is set by mistake", () => {
    expectInert({ ...LOCAL, VERCEL_ENV: "production" });
    expectInert({ ...LOCAL, VERCEL_ENV: "preview" });
    expectInert({ ...LOCAL, VERCEL_ENV: "development" });
    expectInert({ ...LOCAL, VERCEL: "1" });
    expectInert({ ...LOCAL, VERCEL: "" });
  });

  it("needs BOTH fake base URLs (either missing → off, nothing half-redirected)", () => {
    expectInert(without("SA_E2E_GOOGLE_BASE_URL"));
    expectInert(without("SA_E2E_ANTHROPIC_BASE_URL"));
    expectInert({ ...LOCAL, SA_E2E_GOOGLE_BASE_URL: undefined, SA_E2E_ANTHROPIC_BASE_URL: "" });
  });

  it("refuses any base URL that isn't http(s) on exactly localhost / 127.0.0.1 / [::1]", () => {
    for (const bad of [
      "https://evil.example",
      "http://localhost.evil.com",
      "http://localhost@evil.com/x",
      "http://127.0.0.1.nip.io",
      "http://127.0.0.2:3301",
      "http://0.0.0.0:3301",
      "http://evil.com/http://127.0.0.1",
      "file:///tmp",
      "ftp://127.0.0.1",
      "127.0.0.1:3301",
      "not a url",
    ]) {
      expectInert({ ...LOCAL, SA_E2E_GOOGLE_BASE_URL: bad });
      expectInert({ ...LOCAL, SA_E2E_ANTHROPIC_BASE_URL: bad });
    }
  });

  it("refuses a database that isn't on this machine (a checkout pointed at Neon stays real)", () => {
    expectInert(without("DATABASE_URL"));
    for (const bad of [
      "postgresql://u:p@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
      "postgres://u@localhost.evil.com/db",
      "postgres://u@127.0.0.1.nip.io/db",
      "postgres://u@localhost,ep-x.neon.tech/db",
      "postgres://u@localhost/db?host=ep-x.neon.tech",
      "postgres://u@%2Ftmp%2Cep-x.neon.tech/db",
      "postgres:///db?host=/tmp,ep-x.neon.tech",
      "mysql://u@localhost/db",
      "garbage",
    ]) {
      expectInert({ ...LOCAL, DATABASE_URL: bad });
    }
    // No host in the URL: the driver falls back to PGHOST, which must be local too —
    // postgres.js ignores ?host=, so a local one there doesn't excuse a remote PGHOST.
    expectInert({ ...LOCAL, DATABASE_URL: "postgres:///db", PGHOST: "ep-x.neon.tech" });
    expectInert({ ...LOCAL, DATABASE_URL: "postgres:///db?host=/tmp", PGHOST: "ep-x.neon.tech" });
    expectInert({ ...LOCAL, DATABASE_URL: "postgres://u@%65vil.com/db" });
  });

  it("accepts a loopback or unix-socket database", () => {
    for (const ok of [
      "postgres://u@127.0.0.1:5432/db",
      "postgres://u@localhost/db",
      "postgres:///db?host=/var/run/postgresql",
      "postgres://u@%2Fvar%2Frun%2Fpostgresql/db",
      "postgres:///db",
    ]) {
      expect(e2eMode({ ...LOCAL, DATABASE_URL: ok })).toBe(true);
    }
    expect(e2eMode({ ...LOCAL, DATABASE_URL: "postgres:///db", PGHOST: "/tmp" })).toBe(true);
  });

  // Finding (M11 review, test-seams #2): the URL parser and postgres.js read the host
  // differently. Each of these is "localhost" (or local) to `new URL()`, but postgres.js
  // would try a remote host — or the URL is an "@" trick we refuse outright.
  const ADVERSARIAL = [
    // postgres.js cuts at the FIRST "@": hosts ["ep-cool…neon.tech", "y@localhost"].
    "postgres://u:x@ep-cool.us-east-2.aws.neon.tech,y@localhost/neondb",
    "postgresql://u:x@ep-cool.us-east-2.aws.neon.tech,y@localhost:5432/neondb?sslmode=require",
    // "#" ends the URL parser's host, not postgres.js's: hosts ["localhost#", "evil.com"].
    "postgres://u@localhost#,evil.com/db",
    "postgres://u@localhost#@evil.com/db",
    // A percent-encoded comma is a host list to postgres.js.
    "postgres://u@localhost%2Cep-x.neon.tech/db",
    "postgres://u@ep-x.neon.tech%2Clocalhost/db",
    // More than one "@" in the authority: refused whatever the driver would do.
    "postgres://u:p@evil.com@localhost/db",
    "postgres://u@evil.com:5432@localhost/db",
    // Not loopback, or not where postgres.js would look.
    "postgres://u@[2001:db8::1]/db",
    "postgres://u@[::ffff:7f00:1]/db",
    "postgres://u@localhost/db?hostaddr=10.0.0.5",
    "postgres://u@localhost/db?host=localhost&host=ep-x.neon.tech",
    " postgres://u@localhost/db",
    "postgres:/db",
  ];

  it("reads the host the way postgres.js does: comma lists, '@' and '#' tricks are refused", () => {
    for (const bad of ADVERSARIAL) {
      expect(e2eMode({ ...LOCAL, DATABASE_URL: bad }), bad).toBe(false);
      expect(isLocalDatabaseUrl(bad, {}), bad).toBe(false);
    }
    // A PGHOST host list is refused too (postgres.js splits it on ",").
    expect(isLocalDatabaseUrl("postgres:///db", { PGHOST: "localhost,ep-x.neon.tech" })).toBe(
      false,
    );
    // Still local: a comma or "@" that is only in the (encoded) password or user name.
    for (const ok of [
      "postgres://u:x%40ep-x.neon.tech,y@localhost/db",
      "postgres://ep-x.neon.tech,u@localhost/db",
      "postgres://u:p%40ss@127.0.0.1:5432/db",
    ]) {
      expect(isLocalDatabaseUrl(ok, {}), ok).toBe(true);
    }
  });

  it("whatever it accepts, the real postgres.js connects only to this machine", async () => {
    const { default: postgres } = await import("postgres");
    // What postgres.js may be left holding for a local URL: a loopback host, a socket path, or
    // a name no resolver answers ("[" is its own split of "[::1]"; "%2F…" an encoded path).
    const harmless = (h: string) =>
      ["localhost", "127.0.0.1", "::1", "["].includes(h) || h.startsWith("/") || /^%2F/i.test(h);
    vi.stubEnv("PGHOST", "");
    try {
      const corpus = [
        ...ADVERSARIAL,
        "postgres://u@127.0.0.1:5432/db",
        "postgres://u@localhost/db",
        "postgresql://u@[::1]/db",
        "postgres:///db?host=/var/run/postgresql",
        "postgres://u@%2Fvar%2Frun%2Fpostgresql/db",
        "postgres:///db",
        "postgres://u:x%40ep-x.neon.tech,y@localhost/db",
        "postgres://ep-x.neon.tech,u@localhost/db",
        "postgresql://u:p@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb",
      ];
      let accepted = 0;
      for (const url of corpus) {
        if (!isLocalDatabaseUrl(url, { PGHOST: "" })) continue;
        accepted++;
        const hosts = postgres(url).options.host;
        expect(hosts.every(harmless), `${url} → ${hosts.join(" | ")}`).toBe(true);
      }
      expect(accepted).toBeGreaterThanOrEqual(8);
      // And the finding's URL really is remote to postgres.js while `new URL()` says localhost:
      // the case this check exists for.
      const finding = ADVERSARIAL[0]!;
      expect(new URL(finding).hostname).toBe("localhost");
      expect(postgres(finding).options.host[0]).toBe("ep-cool.us-east-2.aws.neon.tech");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("no real Anthropic credential or custom header reaches the fake", () => {
    // authToken: null stops the SDK reading ANTHROPIC_AUTH_TOKEN (a Bearer header); every
    // header ANTHROPIC_CUSTOM_HEADERS would add is removed.
    const opts = anthropicClientOptions({
      ...LOCAL,
      ANTHROPIC_API_KEY: "sk-ant-real",
      ANTHROPIC_AUTH_TOKEN: "real-token",
      ANTHROPIC_CUSTOM_HEADERS: "X-Org-Token: abc\nnot a header\n Proxy-Auth : x:y\n: nameless",
    });
    expect(opts).toEqual({
      baseURL: "http://127.0.0.1:3301/anthropic",
      apiKey: "e2e-fake-key",
      authToken: null,
      defaultHeaders: { "X-Org-Token": null, "Proxy-Auth": null },
      maxRetries: 0,
    });
  });

  it("the SDK built from those options sends only the fake key", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const seen: Headers[] = [];
    const prev = { ...process.env };
    process.env.ANTHROPIC_AUTH_TOKEN = "real-token";
    process.env.ANTHROPIC_CUSTOM_HEADERS = "X-Org-Token: abc";
    try {
      const client = new Anthropic({
        ...anthropicClientOptions({ ...LOCAL, ANTHROPIC_CUSTOM_HEADERS: "X-Org-Token: abc" }),
        fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
          seen.push(new Headers(init?.headers));
          return new Response(JSON.stringify({ data: [], has_more: false }), {
            headers: { "content-type": "application/json" },
          });
        },
      });
      await client.models.list();
    } finally {
      process.env.ANTHROPIC_AUTH_TOKEN = prev.ANTHROPIC_AUTH_TOKEN;
      process.env.ANTHROPIC_CUSTOM_HEADERS = prev.ANTHROPIC_CUSTOM_HEADERS;
      if (prev.ANTHROPIC_AUTH_TOKEN === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      if (prev.ANTHROPIC_CUSTOM_HEADERS === undefined) delete process.env.ANTHROPIC_CUSTOM_HEADERS;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.get("x-api-key")).toBe("e2e-fake-key");
    expect(seen[0]!.get("authorization")).toBeNull();
    expect(seen[0]!.get("x-org-token")).toBeNull();
  });

  it("the hook secret also needs ≥32 characters", () => {
    expect(e2eHookSecret({ ...LOCAL, SA_E2E_HOOK_SECRET: "s".repeat(31) })).toBeNull();
    expect(e2eHookSecret({ ...LOCAL, SA_E2E_HOOK_SECRET: "" })).toBeNull();
    expect(e2eHookSecret(without("SA_E2E_HOOK_SECRET"))).toBeNull();
    // A good secret alone switches nothing on.
    expect(e2eHookSecret({ SA_E2E: "1", SA_E2E_HOOK_SECRET: SECRET })).toBeNull();
  });

  it("the real Google URLs stay when only a base URL is set, or in production", () => {
    expectInert({ SA_E2E_GOOGLE_BASE_URL: "http://127.0.0.1:3301" });
    expectInert({ ...LOCAL, SA_E2E: undefined, VERCEL_ENV: "production" });
  });

  it("isLoopbackHostname is an exact match", () => {
    for (const h of ["localhost", "127.0.0.1", "[::1]"]) expect(isLoopbackHostname(h)).toBe(true);
    for (const h of ["localhost.evil.com", "127.0.0.1.nip.io", "::1x", "", "LOCALHOST "])
      expect(isLoopbackHostname(h)).toBe(false);
  });
});

describe("boundary: who may read the e2e switch", () => {
  const root = join(__dirname, "../..");
  const src = join(root, "src");
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|js|mjs)$/.test(name) ? [p] : [];
    });
  }
  const files = walk(src).map((p) => ({ path: relative(root, p), text: readFileSync(p, "utf8") }));

  it("the literal SA_E2E appears only in src/config/e2e.ts", () => {
    expect(files.filter((f) => f.text.includes("SA_E2E")).map((f) => f.path)).toEqual([
      "src/config/e2e.ts",
    ]);
  });

  it("only the five seams import @/config/e2e", () => {
    const importers = files
      .filter((f) => /from\s+["']@\/config\/e2e["']|import\(\s*["']@\/config\/e2e["']/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(importers).toEqual(
      [
        "src/ai/client.ts",
        "src/app/api/test-hooks/run/route.ts",
        "src/mailbox/gmail/api.ts",
        "src/mailbox/gmail/connector.ts",
        // Check 47 P3 CI fix: no real DNS lookup for the waitlist's mail host in e2e mode.
        "src/server/mail-host.ts",
      ].sort(),
    );
    // Nothing reaches it by a relative path either.
    expect(
      files.filter(
        (f) => f.path !== "src/config/e2e.ts" && /["'][./]+[^"']*\/e2e["']/.test(f.text),
      ),
    ).toEqual([]);
  });

  it("the consent page stays Google's own (not overridable, so the CSP never changes)", () => {
    const connector = files.find((f) => f.path === "src/mailbox/gmail/connector.ts")!.text;
    expect(connector).toContain('"https://accounts.google.com/o/oauth2/v2/auth"');
    const e2e = files.find((f) => f.path === "src/config/e2e.ts")!.text;
    expect(e2e).not.toContain("accounts.google.com");
  });

  it("the one Anthropic client takes its options from the seam ({} off e2e mode)", () => {
    const creations = files.flatMap((f) =>
      [...f.text.matchAll(/new Anthropic\(([\s\S]*?)\);/g)].map(
        (m) => `${f.path}: ${m[1]!.replace(/\s+/g, " ").trim()}`,
      ),
    );
    // Check 48 P4: our time limit and retry count first, then the seam spread last, so e2e mode
    // (fake base URL, no retries) always wins.
    expect(creations).toEqual([
      "src/ai/client.ts: { maxRetries: aiMaxRetries, timeout: aiTimeouts.jobMs, ...anthropicClientOptions(), }",
    ]);
  });
});
