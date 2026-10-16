import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SMOKE_SPECS } from "../e2e/smoke-specs";

/**
 * GUARDRAIL (Milestone 11 review, test-seams #0/#1): the Playwright harness can never touch a
 * database on another machine, and the e2e app is reachable from this machine only.
 *
 * - A smoke run (PLAYWRIGHT_BASE_URL) opens no database connection at all: the global setup
 *   returns before `postgres()`, and only specs that touch no database run.
 * - tests/e2e/support.ts (every seeding spec) refuses, at import, a DATABASE_URL that isn't on
 *   this machine — smoke run or not.
 * - The e2e app server is bound to loopback (`--hostname localhost`).
 *
 * `postgres` is replaced by a spy: any call means a client (and so a connection) was made.
 */

const pg = vi.hoisted(() => {
  const queries: string[] = [];
  const client = Object.assign(
    (strings: TemplateStringsArray) => {
      queries.push(strings.join("?"));
      return Promise.resolve([]);
    },
    { end: async () => {}, options: {} },
  );
  return {
    queries,
    client,
    postgres: vi.fn<(url?: string, options?: unknown) => typeof client>(() => client),
  };
});
vi.mock("postgres", () => ({ default: pg.postgres }));
const migrate = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("drizzle-orm/postgres-js/migrator", () => ({ migrate }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: vi.fn(() => ({})) }));
// playwright.config.ts loads .env.local: keep this machine's real values out of the test.
vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));

const NEON = "postgresql://u:p@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb";
const FINDING = "postgres://u:x@ep-cool.us-east-2.aws.neon.tech,y@localhost/neondb";
const LOCAL_DB = "postgres://postgres@localhost:5432/squared_away_launch";
const DEPLOYED = "https://sa-dac3.vercel.app";

function env(vars: Record<string, string | undefined>) {
  vi.stubEnv("PGHOST", "");
  vi.stubEnv("PLAYWRIGHT_BASE_URL", undefined);
  // Written by playwright.config.ts; stubbed so they're put back afterwards.
  vi.stubEnv("E2E_FAKES_URL", undefined);
  vi.stubEnv("SA_E2E_HOOK_SECRET", undefined);
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
}

async function globalSetup() {
  vi.resetModules();
  return (await import("../e2e/global-setup")).default();
}

beforeEach(() => {
  pg.postgres.mockClear();
  pg.queries.length = 0;
  migrate.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("global setup", () => {
  it("a smoke run opens no database connection, even with a Neon DATABASE_URL", async () => {
    for (const url of [NEON, FINDING, LOCAL_DB, undefined]) {
      env({ PLAYWRIGHT_BASE_URL: DEPLOYED, DATABASE_URL: url });
      await expect(globalSetup()).resolves.toBeUndefined();
    }
    expect(pg.postgres).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
    expect(pg.queries).toEqual([]);
  });

  it("a local run refuses a database on another machine before any client exists", async () => {
    for (const url of [NEON, FINDING, "postgres://u@localhost/db?host=ep-x.neon.tech"]) {
      env({ DATABASE_URL: url });
      await expect(globalSetup(), url).rejects.toThrow(/only run against a Postgres on this/);
    }
    env({ DATABASE_URL: "postgres:///db", PGHOST: "ep-x.neon.tech" });
    await expect(globalSetup()).rejects.toThrow(/on this machine/);
    env({ DATABASE_URL: undefined });
    await expect(globalSetup()).rejects.toThrow(/need DATABASE_URL/);
    expect(pg.postgres).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });

  it("a local run with a local database migrates and clears rate_limits (positive control)", async () => {
    env({ DATABASE_URL: LOCAL_DB });
    await globalSetup();
    expect(pg.postgres).toHaveBeenCalledWith(LOCAL_DB, expect.anything());
    expect(migrate).toHaveBeenCalledOnce();
    expect(pg.queries).toEqual(["delete from rate_limits"]);
  });
});

describe("tests/e2e/support.ts", () => {
  async function importSupport() {
    vi.resetModules();
    return import("../e2e/support");
  }

  it("throws at import for a database that isn't on this machine, smoke run or not", async () => {
    for (const smoke of [undefined, DEPLOYED]) {
      for (const url of [NEON, FINDING, undefined]) {
        env({ PLAYWRIGHT_BASE_URL: smoke, DATABASE_URL: url });
        await expect(importSupport(), `${smoke} ${url}`).rejects.toThrow(
          /only talks to a Postgres on this machine/,
        );
      }
    }
    expect(pg.postgres).not.toHaveBeenCalled();
  });

  it("loads for a local database (positive control)", async () => {
    env({ DATABASE_URL: LOCAL_DB });
    const support = await importSupport();
    expect(typeof support.seedOwner).toBe("function");
    expect(pg.postgres).toHaveBeenCalledWith(LOCAL_DB, { max: 2 });
  });
});

describe("playwright.config.ts", () => {
  async function loadConfig() {
    vi.resetModules();
    return (await import("../../playwright.config")).default;
  }

  it("a smoke run runs only SMOKE_SPECS and starts no servers", async () => {
    env({ PLAYWRIGHT_BASE_URL: DEPLOYED });
    const config = await loadConfig();
    expect(config.testMatch).toEqual(SMOKE_SPECS.map((name) => `**/${name}`));
    expect(config.webServer).toBeUndefined();
  });

  it("a local run binds the app server to loopback, on the origin Playwright drives", async () => {
    env({ PORT: "3300", APP_URL: "http://localhost:3300", E2E_FAKES_PORT: undefined });
    const config = await loadConfig();
    expect(config.testMatch).toBeUndefined();
    const servers = config.webServer as { command: string; url: string }[];
    const app = servers.find((s) => s.command.startsWith("pnpm start"));
    expect(app?.command).toBe("pnpm start --port 3300 --hostname localhost");
    expect(app?.url).toBe("http://localhost:3300/api/health");
    expect(config.use?.baseURL).toBe("http://localhost:3300");
  });

  it("every smoke spec touches no database", () => {
    expect(SMOKE_SPECS.length).toBeGreaterThan(0);
    for (const name of SMOKE_SPECS) {
      const path = join(__dirname, "../e2e", name);
      expect(existsSync(path), name).toBe(true);
      const src = readFileSync(path, "utf8");
      const imports = [...src.matchAll(/from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']/g)].map(
        (m) => m[1] ?? m[2],
      );
      expect(imports, name).toEqual(["@playwright/test"]);
    }
  });
});
