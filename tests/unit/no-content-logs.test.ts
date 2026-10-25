import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scrubEvent, sentryOptions } from "@/lib/sentry";
import { parse, rel, sourceFiles, ts, walk } from "../support/source-ast";

/**
 * Milestone 11 S4.
 *
 * C11 — CLAUDE.md: "Never log tokens, email bodies, or customer personal details." Every
 * console call in src/ is read as code: no identifier in its arguments (variable, property or
 * object key, `${}` included) may name a token, secret, password, email text, phone number,
 * address, code or error message. Event names and other string literals are fixed text and
 * aren't checked. Nor may a whole error be logged (`err`, `{ err }`, `String(e)`, `${e}`):
 * Node prints its message and stack. Log `err.name`, ids and counts instead.
 *
 * C15 — every way to Sentry goes through `sentryOptions` (beforeSend: scrubEvent).
 */

/** Name parts that mean content or a credential (camelCase / snake_case parts, lower case). */
const FORBIDDEN = new Set(
  [
    "token",
    "tokens",
    "secret",
    "secrets",
    "password",
    "passwords",
    "body",
    "bodies",
    "snippet",
    "snippets",
    "subject",
    "subjects",
    "raw",
    "phone",
    "phones",
    "code",
    "codes",
    "message",
    "messages",
    "email",
    "emails",
    "address",
    "addresses",
    "text",
    "texts",
    "stack",
  ].map((w) => w.toLowerCase()),
);

/**
 * Reviewed exceptions: whole identifiers that look like content but are not. An entry nobody
 * uses any more fails the test, so the list can't quietly grow stale.
 */
const ALLOWED_IDENTIFIERS: Record<string, string> = {
  emailErrorFields:
    "Check 18 P2: returns only the error's name and the Resend status (checked below), never an address",
};

function parts(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_$]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
}

/**
 * Names that usually hold a whole error. Logging one (`console.error("x", err)`, `{ err }`,
 * `String(err)`, `${e}`) prints its message and stack, which can echo customer ids, email text
 * or a query's bound values — only `err.name` (or an `instanceof` test) may be used.
 */
const ERROR_NAMES = new Set(["err", "error", "e", "cause", "exception", "ex"]);

/** Catch-clause bindings in the file (`catch (failure)`), which hold errors whatever their name. */
function catchBindings(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  walk(sf, (n) => {
    if (ts.isCatchClause(n) && n.variableDeclaration && ts.isIdentifier(n.variableDeclaration.name))
      out.add(n.variableDeclaration.name.text);
  });
  return out;
}

/** An identifier used as a value (not an object key, a member name or a type). */
function isValue(n: ts.Identifier): boolean {
  const p = n.parent;
  if (ts.isPropertyAssignment(p) && p.name === n) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === n) return false;
  if (ts.isTypeReferenceNode(p) || ts.isQualifiedName(p)) return false;
  return true;
}

/** Fields of an error that are fixed codes, never text: its class name and an HTTP status. */
const SAFE_ERROR_FIELDS = new Set(["name", "status"]);
/** Helpers that turn an error into those fields only (each body is checked below). */
const SAFE_ERROR_HELPERS = new Set(["emailErrorFields"]);

/** `err.name` / `(err as Error).name`, `err.status`, or `err instanceof X`. */
function isSafeErrorUse(n: ts.Identifier): boolean {
  let x: ts.Node = n;
  while (
    ts.isParenthesizedExpression(x.parent) ||
    ts.isAsExpression(x.parent) ||
    ts.isNonNullExpression(x.parent) ||
    ts.isTypeAssertionExpression(x.parent)
  )
    x = x.parent;
  const p = x.parent;
  if (ts.isPropertyAccessExpression(p) && p.expression === x)
    return SAFE_ERROR_FIELDS.has(p.name.text);
  // Check 18 P2: `emailErrorFields(err)` (src/lib/email.ts) returns only the name and the
  // Resend status; the test below checks that is all it reads.
  if (
    ts.isCallExpression(p) &&
    ts.isIdentifier(p.expression) &&
    SAFE_ERROR_HELPERS.has(p.expression.text) &&
    p.arguments.length === 1 &&
    p.arguments[0] === x
  )
    return true;
  return (
    ts.isBinaryExpression(p) &&
    p.left === x &&
    p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
  );
}

function badIdentifiers(call: ts.CallExpression): string[] {
  const bad: string[] = [];
  const errors = new Set([...ERROR_NAMES, ...catchBindings(call.getSourceFile())]);
  for (const arg of call.arguments) {
    walk(arg, (n) => {
      if (!ts.isIdentifier(n)) return;
      const name = n.text;
      if (name in ALLOWED_IDENTIFIERS) return;
      if (parts(name).some((p) => FORBIDDEN.has(p))) bad.push(name);
      else if (errors.has(name) && isValue(n) && !isSafeErrorUse(n)) bad.push(name);
    });
  }
  return bad;
}

function consoleCalls(sf: ts.SourceFile): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  walk(sf, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "console"
    ) {
      out.push(n);
    }
  });
  return out;
}

const scan = (code: string) =>
  consoleCalls(ts.createSourceFile("x.ts", code, ts.ScriptTarget.Latest, true)).flatMap(
    badIdentifiers,
  );

describe("C11: logs carry no content or credentials", () => {
  const FILES = sourceFiles();
  const calls = FILES.flatMap((f) => {
    const sf = parse(f);
    return consoleCalls(sf).map((c) => ({
      at: `${rel(f)}:${sf.getLineAndCharacterOfPosition(c.getStart()).line + 1}`,
      call: c,
    }));
  });

  it("finds the console calls (the scan isn't silently empty)", () => {
    expect(calls.length).toBeGreaterThanOrEqual(25);
  });

  it("no console call names a token, secret, body, subject, phone, code or message", () => {
    const hits = calls
      .map(({ at, call }) => ({ at, bad: badIdentifiers(call) }))
      .filter((h) => h.bad.length)
      .map((h) => `${h.at}: ${h.bad.join(", ")}`);
    expect(hits).toEqual([]);
  });

  it("every allow-listed identifier is still used in a console call", () => {
    const used = new Set<string>();
    for (const { call } of calls)
      for (const arg of call.arguments) walk(arg, (n) => ts.isIdentifier(n) && used.add(n.text));
    for (const name of Object.keys(ALLOWED_IDENTIFIERS)) expect(used.has(name), name).toBe(true);
  });

  it("the scanner catches what it's meant to (self-test)", () => {
    expect(scan('console.error("x", { refreshToken })')).toEqual(["refreshToken"]);
    expect(scan("console.log(m.bodyText)")).toEqual(["bodyText"]);
    expect(scan('console.info("x", { message: err.message })')).toEqual([
      "message",
      "err",
      "message",
    ]);
    expect(scan("console.warn(`sent to ${phone}`)")).toEqual(["phone"]);
    expect(scan('console.error("x", { subject: t.subject, to: d.toAddress })')).toEqual([
      "subject",
      "subject",
      "toAddress",
    ]);
    expect(scan('console.info("x", { code })')).toEqual(["code"]);
    expect(scan('console.debug("x", accessToken.slice(0, 4))')).toEqual(["accessToken"]);
    // A whole error prints its message and stack.
    expect(scan('console.error("x", err)')).toEqual(["err"]);
    expect(scan('console.error("x", { err })')).toEqual(["err"]);
    expect(scan('console.error("x", { error: err })')).toEqual(["err"]);
    expect(scan('console.error("x", { cause: e })')).toEqual(["e"]);
    expect(scan('console.error("x", String(error))')).toEqual(["error"]);
    expect(scan("console.warn(`failed: ${e}`)")).toEqual(["e"]);
    expect(scan('console.error("x", { at: err.stack })')).toEqual(["err", "stack"]);
    expect(scan('console.error("x", { at: err.cause })')).toEqual(["err"]);
    expect(scan('console.error("x", { s: err.status, n: (err as Error).name })')).toEqual([]);
    expect(scan('try {} catch (failure) { console.error("x", failure); }')).toEqual(["failure"]);
    expect(scan('console.error("x", { error: err.name })')).toEqual([]);
    expect(
      scan('console.error("x", { error: err instanceof Error ? err.name : "unknown" })'),
    ).toEqual([]);
    // Content-free shapes pass: event names, err.name, ids, counts.
    expect(
      scan(
        'console.error("sent_message_record_failed", { mailboxId: m.id, error: err instanceof Error ? err.name : "unknown", count: n })',
      ),
    ).toEqual([]);
  });
});

describe("C15: every Sentry path is scrubbed", () => {
  const SENTRY_FILES: Record<string, string> = {
    "src/instrumentation.ts": "server init (sentryOptions) + captureRequestError",
    "src/instrumentation-client.ts": "browser init (sentryOptions), loaded only with a DSN",
    "src/jobs/client.ts": "Inngest ReportFinalFailures: captureException + flush",
    "src/jobs/functions.ts":
      "workspace-lifecycle runChecks (Check 25 P4): captureException per failed check, tags = job + check name only",
    "src/lib/sentry.ts": "sentryOptions / scrubEvent (type import only)",
  };
  /** Sentry calls that go through the client set up by init — so through beforeSend. */
  const ALLOWED_MEMBERS = new Set(["init", "captureException", "captureRequestError", "flush"]);
  /** Options an init call may not set itself: they would bypass or weaken sentryOptions. */
  const NO_OVERRIDE = new Set([
    "beforeSend",
    "beforeSendTransaction",
    "beforeBreadcrumb",
    "sendDefaultPii",
    "tracesSampleRate",
    "replaysSessionSampleRate",
    "replaysOnErrorSampleRate",
    "dsn",
  ]);

  const FILES = sourceFiles();
  const importsSentry = (text: string) => /["']@sentry\//.test(text);

  it("only the reviewed files load Sentry, and there are no separate sentry.*.config files", () => {
    const found = FILES.filter((f) => importsSentry(readFileSync(f, "utf8"))).map(rel);
    expect(found.sort()).toEqual(Object.keys(SENTRY_FILES).sort());
    for (const cfg of [
      "sentry.server.config.ts",
      "sentry.client.config.ts",
      "sentry.edge.config.ts",
    ])
      expect(existsSync(cfg), cfg).toBe(false);
  });

  it("sentryOptions scrubs every event, sends no PII and no traces", () => {
    expect(sentryOptions.beforeSend).toBe(scrubEvent);
    expect(sentryOptions.sendDefaultPii).toBe(false);
    expect(sentryOptions.tracesSampleRate).toBe(0);
  });

  it("every init uses sentryOptions without overriding it; only capture/flush calls besides", () => {
    let inits = 0;
    let captures = 0;
    for (const file of Object.keys(SENTRY_FILES)) {
      const sf = parse(file);
      walk(sf, (n) => {
        if (
          !ts.isPropertyAccessExpression(n) ||
          !ts.isIdentifier(n.expression) ||
          n.expression.text !== "Sentry"
        )
          return;
        const member = n.name.text;
        expect(ALLOWED_MEMBERS.has(member), `${file}: Sentry.${member}`).toBe(true);
        if (member.startsWith("capture")) captures++;
        if (member !== "init") return;
        inits++;
        const call = n.parent;
        expect(ts.isCallExpression(call), file).toBe(true);
        const [arg] = (call as ts.CallExpression).arguments;
        if (arg && ts.isIdentifier(arg)) {
          expect(arg.text, file).toBe("sentryOptions");
          return;
        }
        expect(arg && ts.isObjectLiteralExpression(arg), file).toBe(true);
        const props = (arg as ts.ObjectLiteralExpression).properties;
        const first = props[0];
        expect(
          first && ts.isSpreadAssignment(first) && first.expression.getText(),
          `${file}: init spreads sentryOptions first`,
        ).toBe("sentryOptions");
        for (const p of props.slice(1)) {
          const key = p.name && ts.isIdentifier(p.name) ? p.name.text : p.getText();
          expect(NO_OVERRIDE.has(key), `${file}: init overrides ${key}`).toBe(false);
          expect(ts.isSpreadAssignment(p), `${file}: a second spread`).toBe(false);
        }
      });
    }
    expect(inits).toBe(2); // server and browser
    expect(captures).toBeGreaterThanOrEqual(2);
  });

  it("captureException adds tags only — no extra, context or user data", () => {
    const sf = parse("src/jobs/client.ts");
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || n.expression.getText() !== "Sentry.captureException") return;
      const opts = n.arguments[1];
      if (!opts) return;
      expect(ts.isObjectLiteralExpression(opts)).toBe(true);
      const keys = (opts as ts.ObjectLiteralExpression).properties.map((p) => p.name?.getText());
      expect(keys).toEqual(["tags"]);
    });
  });

  it("Check 18 P2: emailErrorFields reads only the error's name and its Resend status", () => {
    const src = readFileSync("src/lib/email.ts", "utf8");
    const body = src.slice(src.indexOf("export function emailErrorFields"));
    const fn = body.slice(0, body.indexOf("\n}\n") + 3);
    expect(fn).toContain("return { error: err.name, status: err.status }");
    expect(fn).not.toMatch(/\.message|\.stack|\.cause|String\(err|JSON/);
    expect(
      [...fn.matchAll(/err\.(\w+)/g)].map((m) => m[1]).every((f) => f === "name" || f === "status"),
    ).toBe(true);
  });
});
