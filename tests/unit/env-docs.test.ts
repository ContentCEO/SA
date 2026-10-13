import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FEATURE_ENV } from "@/config/features";
import { rel, ROOT, sourceFiles, SRC } from "../support/source-ast";

/**
 * Plan M11 S6: every environment variable the code reads is documented, so a new developer (or
 * Davi setting up Vercel) can follow docs/SETUP.md and .env.example alone. A new
 * `process.env.X` without a row in SETUP.md's table fails here.
 */

const NAME = "[A-Z_][A-Z0-9_]*";

/** Set by Vercel or Next.js themselves: documented in SETUP.md, never in .env.example. */
const SET_BY_PLATFORM = new Set([
  "NODE_ENV",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_BRANCH_URL",
  "VERCEL_GIT_COMMIT_SHA",
]);

/**
 * Read by postgres.js / the Anthropic SDK, not configured by us. src/config/e2e.ts only checks
 * them so e2e mode can't point at something real. Documented in SETUP.md, not in .env.example.
 */
const READ_BY_LIBRARIES = new Set(["PGHOST", "ANTHROPIC_CUSTOM_HEADERS"]);

const files = [...sourceFiles(SRC), ...sourceFiles(join(ROOT, "scripts"))];

/** Every variable name the code reads, with one file that reads it. */
function envNamesInCode(): Map<string, string> {
  const found = new Map<string, string>();
  const add = (name: string, file: string) => {
    if (!found.has(name)) found.set(name, rel(file));
  };
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(new RegExp(`process\\.env\\.(${NAME})`, "g"))) add(m[1]!, file);
    for (const m of src.matchAll(
      new RegExp(`process\\.env\\[\\s*["'\`](${NAME})["'\`]\\s*\\]`, "g"),
    ))
      add(m[1]!, file);
    // Pure helpers take the environment as a parameter defaulting to process.env
    // (`env: Env = process.env`) and read `env.X` / `env["X"]`.
    if (/=\s*process\.env\b/.test(src)) {
      for (const m of src.matchAll(new RegExp(`\\benv\\.(${NAME})\\b`, "g"))) add(m[1]!, file);
      for (const m of src.matchAll(new RegExp(`\\benv\\[\\s*["'\`](${NAME})["'\`]\\s*\\]`, "g")))
        add(m[1]!, file);
    }
  }
  // Feature switches are read through FEATURE_ENV (`env[FEATURE_ENV[name]]`).
  for (const name of Object.values(FEATURE_ENV)) add(name, "src/config/features.ts");
  return found;
}

const setup = readFileSync("docs/SETUP.md", "utf8");
const example = readFileSync(".env.example", "utf8");

/** SETUP.md's "Environment variables" section (the table). */
function envSection(): string {
  const start = setup.search(/^## \d+\. Environment variables$/m);
  expect(start, "SETUP.md has an 'Environment variables' section").toBeGreaterThanOrEqual(0);
  const rest = setup.slice(start);
  const end = rest.slice(3).search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end + 3);
}

/** The variable names in the first column of the table. */
function tableNames(section: string): Set<string> {
  const names = new Set<string>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const first = line.split("|")[1] ?? "";
    for (const m of first.matchAll(new RegExp(`\`(${NAME})\``, "g"))) names.add(m[1]!);
  }
  return names;
}

/** `NAME=` at the start of a line, commented out or not. */
const exampleNames = new Set(
  [...example.matchAll(new RegExp(`^#?\\s*(${NAME})=`, "gm"))].map((m) => m[1]!),
);

describe("environment variables are documented", () => {
  const inCode = envNamesInCode();
  const table = tableNames(envSection());

  it("the scan finds the variables we know the code reads (it can't silently find nothing)", () => {
    for (const name of [
      "DATABASE_URL",
      "AUTH_SECRET",
      "TOKEN_ENCRYPTION_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "TWILIO_FROM_NUMBER",
      "VAPID_SUBJECT",
      "SUPPORT_EMAIL",
      "APP_URL",
      "VERCEL_BRANCH_URL",
      "SA_E2E",
      "SA_E2E_GOOGLE_BASE_URL",
      "SA_E2E_ANTHROPIC_BASE_URL",
      "SA_E2E_HOOK_SECRET",
      "FEATURE_CLOSING_QUESTION",
      "FEATURE_REFERRALS",
      "AI_DAILY_CALL_CAP",
      "RETENTION_BODY_DAYS",
    ]) {
      expect(inCode.has(name), name).toBe(true);
    }
  });

  it("every variable the code reads has a row in SETUP.md's table", () => {
    const missing = [...inCode].filter(([name]) => !table.has(name));
    expect(missing.map(([name, file]) => `${name} (read in ${file})`)).toEqual([]);
  });

  it("every variable the code reads is in .env.example, unless Vercel, Next or a library sets it", () => {
    const missing = [...inCode.keys()].filter(
      (name) =>
        !SET_BY_PLATFORM.has(name) && !READ_BY_LIBRARIES.has(name) && !exampleNames.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("the platform- and library-set names stay out of .env.example", () => {
    for (const name of [...SET_BY_PLATFORM, ...READ_BY_LIBRARIES]) {
      expect(exampleNames.has(name), name).toBe(false);
    }
  });

  it("everything in .env.example is in SETUP.md's table too", () => {
    expect([...exampleNames].filter((name) => !table.has(name))).toEqual([]);
  });

  it("the plan's list is all covered (SETUP.md table and .env.example)", () => {
    for (const name of [
      "ADMIN_EMAIL",
      "AI_DAILY_CALL_CAP",
      "ANTHROPIC_API_KEY",
      "APP_URL",
      "AUTH_SECRET",
      "AUTH_TRUST_HOST",
      "AUTH_GOOGLE_ID",
      "AUTH_GOOGLE_SECRET",
      "DATABASE_URL",
      "EMAIL_FROM",
      "FEATURE_CLOSING_QUESTION",
      "FEATURE_REFERRALS",
      "GMAIL_PUBSUB_TOPIC",
      "GMAIL_PUSH_VERIFICATION_TOKEN",
      "INNGEST_EVENT_KEY",
      "INNGEST_SIGNING_KEY",
      "NEXT_PUBLIC_SENTRY_DSN",
      "RESEND_API_KEY",
      "RETENTION_BODY_DAYS",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "SUPPORT_EMAIL",
      "TOKEN_ENCRYPTION_KEY",
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_MESSAGING_SERVICE_SID",
      "TWILIO_FROM_NUMBER",
      "VAPID_PUBLIC_KEY",
      "VAPID_PRIVATE_KEY",
      "VAPID_SUBJECT",
    ]) {
      expect(table.has(name), `${name} in SETUP.md`).toBe(true);
      expect(exampleNames.has(name), `${name} in .env.example`).toBe(true);
    }
  });

  it("the e2e variables are only commented out in .env.example, and SETUP.md says never on Vercel", () => {
    for (const name of [
      "SA_E2E",
      "SA_E2E_GOOGLE_BASE_URL",
      "SA_E2E_ANTHROPIC_BASE_URL",
      "SA_E2E_HOOK_SECRET",
    ]) {
      expect(example, name).toMatch(new RegExp(`^# ${name}=`, "m"));
      expect(example, name).not.toMatch(new RegExp(`^${name}=`, "m"));
    }
    expect(example).toContain("set by playwright.config.ts; never set on Vercel");
    expect(setup).toMatch(/## \d+\. End-to-end tests with fake Google and Anthropic/);
    expect(setup).toContain("**never** set them on Vercel");
  });

  it("SETUP.md has the sections the launch needs", () => {
    expect(setup).toMatch(/^## \d+\. New developer in under 30 minutes$/m);
    expect(setup).toMatch(/^### \d+[a-z]\. Phone notifications \(VAPID/m);
    expect(setup).toMatch(/^### \d+[a-z]\. SUPPORT_EMAIL$/m);
    // Sign-in lives at /signin; the homepage is the public site.
    expect(setup).toContain("http://localhost:3000/signin");
    // The 30-minute path, in order.
    const path = setup.slice(setup.search(/^## \d+\. New developer/m));
    let at = 0;
    for (const step of [
      "pnpm install",
      "create database",
      "cp .env.example .env.local",
      "pnpm db:migrate",
      "pnpm invite",
      "`pnpm dev`",
      "`pnpm test`",
      "pnpm build",
      "pnpm test:e2e",
    ]) {
      const i = path.indexOf(step, at);
      expect(i, `"${step}" after the step before it`).toBeGreaterThanOrEqual(0);
      at = i + step.length;
    }
  });
});
