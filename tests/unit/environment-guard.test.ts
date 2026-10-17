import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPreviewSafe,
  databaseHosts,
  PREVIEW_USES_PRODUCTION,
  PRODUCTION_DB_HOST_SHA256,
  PRODUCTION_KEY_SHA256S,
  previewGuard,
  setFingerprintsForTests,
  sha256,
} from "@/config/environment-guard";
import { db, setDbForTests } from "@/db";
import { GET as health } from "@/app/api/health/route";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

/**
 * Check 26 P2: a Vercel preview refuses to run against production's database or keys. Only
 * fingerprints (sha256) are compared; the values never appear in a message.
 */

// Invented "production" values for the test.
const PROD_HOST = "ep-prod-pooler.us-east-2.aws.neon.example";
const PROD_URL = `postgres://app:pa55word@${PROD_HOST}:5432/neondb?sslmode=require`;
const PROD_KEY = randomBytes(32).toString("base64");
const PROD_AUTH = "prod-auth-secret-0123456789";
const FP = { dbHosts: [sha256(PROD_HOST)], keys: [sha256(PROD_KEY), sha256(PROD_AUTH)] };
const FRESH_URL = "postgres://app:other@ep-preview.us-east-2.aws.neon.example/neondb";
const FRESH_KEY = randomBytes(32).toString("base64");

const preview = (over: Record<string, string> = {}) => ({
  VERCEL_ENV: "preview",
  DATABASE_URL: FRESH_URL,
  TOKEN_ENCRYPTION_KEY: FRESH_KEY,
  AUTH_SECRET: "preview-auth",
  ...over,
});

afterEach(() => {
  setFingerprintsForTests(null);
  setDbForTests(undefined);
});

describe("preview guard (pure)", () => {
  it("production is never blocked, even with production's values", () => {
    const env = {
      VERCEL_ENV: "production",
      DATABASE_URL: PROD_URL,
      TOKEN_ENCRYPTION_KEY: PROD_KEY,
      AUTH_SECRET: PROD_AUTH,
    };
    expect(previewGuard(env, FP)).toEqual([]);
  });

  it("local and development runs are never blocked", () => {
    for (const VERCEL_ENV of [undefined, "development"]) {
      expect(
        previewGuard({ VERCEL_ENV, DATABASE_URL: PROD_URL, TOKEN_ENCRYPTION_KEY: PROD_KEY }, FP),
      ).toEqual([]);
    }
  });

  it("a preview on production's database host is blocked (any port, case, user or password)", () => {
    expect(previewGuard(preview({ DATABASE_URL: PROD_URL }), FP)).toEqual(["database_host"]);
    expect(
      previewGuard(preview({ DATABASE_URL: `postgresql://x:y@${PROD_HOST.toUpperCase()}/db` }), FP),
    ).toEqual(["database_host"]);
    // A host list tries each in turn, so production anywhere in it counts.
    expect(
      previewGuard(preview({ DATABASE_URL: `postgres://x:y@other.host,${PROD_HOST}/db` }), FP),
    ).toEqual(["database_host"]);
  });

  it("a preview holding production's encryption key or auth secret is blocked", () => {
    expect(previewGuard(preview({ TOKEN_ENCRYPTION_KEY: PROD_KEY }), FP)).toEqual([
      "token_encryption_key",
    ]);
    expect(previewGuard(preview({ AUTH_SECRET: PROD_AUTH }), FP)).toEqual(["auth_secret"]);
  });

  it("a preview with fresh values is allowed", () => {
    expect(previewGuard(preview(), FP)).toEqual([]);
  });

  it("ships with empty fingerprint lists, which block nothing", () => {
    expect(PRODUCTION_DB_HOST_SHA256).toEqual([]);
    expect(PRODUCTION_KEY_SHA256S).toEqual([]);
    const shared = preview({
      DATABASE_URL: PROD_URL,
      TOKEN_ENCRYPTION_KEY: PROD_KEY,
      AUTH_SECRET: PROD_AUTH,
    });
    expect(previewGuard(shared)).toEqual([]);
    expect(() => assertPreviewSafe(shared)).not.toThrow();
  });

  it("the thrown message is plain and holds no part of the URL or key", () => {
    const shared = preview({
      DATABASE_URL: PROD_URL,
      TOKEN_ENCRYPTION_KEY: PROD_KEY,
      AUTH_SECRET: PROD_AUTH,
    });
    let message = "";
    try {
      assertPreviewSafe(shared, FP);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe(PREVIEW_USES_PRODUCTION);
    for (const part of [
      PROD_HOST,
      "ep-prod",
      "pa55word",
      "neondb",
      PROD_KEY,
      PROD_KEY.slice(0, 8),
      PROD_AUTH,
      "prod-auth",
    ]) {
      expect(message).not.toContain(part);
    }
  });

  it("reads the host the way postgres.js does", () => {
    expect(databaseHosts("postgres://u:p@Host.Example:5432/db?x=1")).toEqual(["host.example"]);
    expect(databaseHosts("postgres://u:p@a.example,b.example:6543/db")).toEqual([
      "a.example",
      "b.example",
    ]);
    expect(databaseHosts("postgres://u@[::1]:5432/db")).toEqual(["[::1]"]);
    expect(databaseHosts(undefined)).toEqual([]);
  });
});

describe("where the guard stops a preview", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["VERCEL_ENV", "DATABASE_URL", "TOKEN_ENCRYPTION_KEY", "AUTH_SECRET"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("db() refuses before connecting, and decrypting refuses", () => {
    setFingerprintsForTests(FP);
    Object.assign(process.env, preview({ DATABASE_URL: PROD_URL, TOKEN_ENCRYPTION_KEY: PROD_KEY }));
    setDbForTests(undefined);
    expect(() => db()).toThrow(PREVIEW_USES_PRODUCTION);
    expect(() => encryptSecret("refresh-token")).toThrow(PREVIEW_USES_PRODUCTION);
  });

  it("a fresh preview connects and decrypts normally", () => {
    setFingerprintsForTests(FP);
    Object.assign(process.env, preview());
    expect(decryptSecret(encryptSecret("refresh-token"))).toBe("refresh-token");
  });

  it("/api/health reports preview_uses_production", async () => {
    setFingerprintsForTests(FP);
    Object.assign(process.env, preview({ DATABASE_URL: PROD_URL }));
    const res = health();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      service: "squared-away",
      reason: "preview_uses_production",
    });
    Object.assign(process.env, preview());
    expect(await health().json()).toMatchObject({ ok: true });
  });
});
