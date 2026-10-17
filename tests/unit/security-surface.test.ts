import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  awaitsIn,
  bindFiles,
  calleeName,
  exportedFunctions,
  type FnLike,
  isFnLike,
  localFunctions,
  otherExports,
  parse,
  parseText,
  rel,
  ROOT,
  sourceFiles,
  SRC,
  startsWithUseServer,
  ts,
  walk,
} from "../support/source-ast";

/**
 * Milestone 11 S4, checks C1–C4: the app's attack surface, read from the source. A new server
 * action, admin page or route handler that skips its guard fails here before it ships.
 */

/**
 * requireSignedIn (signed in, terms not needed) is the guard of the terms screen's own action
 * only (SIGNED_IN_ONLY below): everywhere else it would skip the "I agree" check.
 */
const GUARDS = new Set(["requireOwner", "requireAdmin", "requireSignedIn"]);
type GuardName = "requireOwner" | "requireAdmin" | "requireSignedIn";
const ALL = sourceFiles();
const APP = join(SRC, "app");
const ADMIN = join(APP, "(app)", "admin");

/** The guard `fn` awaits first (directly or via a local helper), or null. */
function guardOf(
  fn: FnLike,
  locals: Map<string, FnLike>,
  seen = new Set<string>(),
): GuardName | null {
  const first = awaitsIn(fn)[0];
  const name = first ? calleeName(first) : null;
  if (!name) return null;
  if (GUARDS.has(name)) return name as GuardName;
  const helper = locals.get(name);
  if (!helper || seen.has(name)) return null;
  return guardOf(helper, locals, new Set([...seen, name]));
}
const guardedFirst = (fn: FnLike, locals: Map<string, FnLike>) => guardOf(fn, locals) !== null;

/** The extensions Next serves a route, page or loading file from (its default pageExtensions). */
const NEXT_FILE = (name: string) => new RegExp(`/${name}\\.(tsx|ts|jsx|js)$`);
/** JavaScript files: none belong in src/app, which is TypeScript only. */
const JS_FILE = /\.(js|jsx|mjs|cjs)$/;

/** "use server" files among `files`, and each exported action with the guard it awaits first. */
function scanActions(files: string[], appDir: string = APP) {
  const adminDir = join(appDir, "(app)", "admin");
  const root = dirname(dirname(appDir));
  const id = (f: string) => relative(root, f).split(sep).join("/");
  const actionFiles = files.filter((f) => startsWithUseServer(parse(f).statements));
  const exportedActions = actionFiles.flatMap((f) => {
    const sf = parse(f);
    const locals = localFunctions(sf);
    return exportedFunctions(sf).map(({ name, fn }) => ({
      id: `${id(f)}#${name}`,
      admin: f.startsWith(adminDir + "/"),
      guard: guardOf(fn, locals),
      guarded: guardedFirst(fn, locals),
    }));
  });
  return { actionFiles, exportedActions };
}

/** Route handler files under `appDir`, in any extension Next would serve. */
const routeFilesIn = (files: string[], appDir: string = APP) =>
  files.filter((f) => f.startsWith(appDir + "/") && NEXT_FILE("route").test(f));

/** JavaScript files under `appDir` (the scan reads them, but they have no place there). */
const jsFilesIn = (files: string[], appDir: string = APP) =>
  files.filter((f) => f.startsWith(appDir + "/") && JS_FILE.test(f));

describe("C1: every server action checks who's asking before anything else", () => {
  /** Public on purpose: the forms anyone may use, each with its own hashed-IP limit. */
  const PUBLIC_ACTIONS: Record<string, string> = {
    "src/app/waitlist-actions.ts#joinWaitlistAction":
      "public waitlist form (honeypot + hashed-IP limit); joining never allows sign-in",
    "src/app/growth-actions.ts#requestGrowthCallAction":
      "public Book a free call form (honeypot + the same hashed-IP limit)",
    "src/app/signin/actions.ts#signInWithGoogleAction":
      "the Sign in with Google button: nobody is signed in yet; refuses without the 'I agree' " +
      "box, then starts Auth.js sign-in (invite-only, name and email only)",
  };
  /**
   * Signed in, but the current terms not needed yet: only the terms screen's own actions (Davi,
   * 2026-10-15). Any other action guarded this way would skip the terms.
   */
  const SIGNED_IN_ONLY: Record<string, string> = {
    "src/app/welcome/terms/actions.ts#agreeToTermsAction":
      "records the 'I agree' box; it is how someone who hasn't agreed yet agrees",
    "src/app/welcome/terms/actions.ts#deleteAccountFromTermsAction":
      "Delete my account for someone who won't agree to new terms (the terms and privacy " +
      "policy they agreed to promise it any time); the same deleteAccount as Settings', behind " +
      "the same confirmation; only removes things",
    "src/app/welcome/terms/actions.ts#disconnectMailboxFromTermsAction":
      "Disconnect Gmail for someone who won't agree to new terms; the same disconnectMailbox " +
      "as Settings' (scoped to their own workspace), behind the same confirmation",
    "src/app/welcome/terms/actions.ts#openPortalFromTermsAction":
      "Stripe's billing page, so someone who won't agree to new terms can cancel (the terms " +
      "promise it any time); the same createPortal and billing limit as Plan & billing",
  };
  /**
   * Inline "use server" blocks, by file and the exact calls they await. Any change to one of
   * them (a new call, a new block) fails until it is reviewed here.
   */
  const INLINE_ACTIONS: Record<string, string> = {
    "src/app/(app)/settings/account/page.tsx#cookies,signOut":
      "Sign out: deletes this phone's offline cookie and signs out; must work even for a " +
      "deleted account, so it can't require one",
    "src/app/welcome/terms/page.tsx#cookies,signOut":
      "Sign out on the terms screen: the same as Settings' (someone who doesn't agree can " +
      "always leave), so it can't require the terms",
  };

  const { actionFiles, exportedActions } = scanActions(ALL);

  it("finds the action files (the scan isn't silently empty)", () => {
    expect(actionFiles.length).toBeGreaterThanOrEqual(14);
    expect(exportedActions.length).toBeGreaterThanOrEqual(45);
    for (const f of actionFiles) expect(rel(f)).toMatch(/^src\/app\//);
  });

  it("requireOwner() or requireAdmin() is the first awaited call of every exported action", () => {
    const unguarded = exportedActions
      .filter((a) => !a.guarded && !(a.id in PUBLIC_ACTIONS))
      .map((a) => a.id);
    expect(unguarded).toEqual([]);
    // The allow-list stays honest: each public action exists and really is unguarded.
    for (const id of Object.keys(PUBLIC_ACTIONS)) {
      expect(exportedActions.find((a) => a.id === id)?.guarded, id).toBe(false);
    }
  });

  it("admin actions use requireAdmin (an owner's guard there would let any owner in); nothing else does", () => {
    const wrong = exportedActions
      .filter(
        (a) =>
          a.guarded &&
          a.guard !==
            (a.admin
              ? "requireAdmin"
              : a.id in SIGNED_IN_ONLY
                ? "requireSignedIn"
                : "requireOwner"),
      )
      .map((a) => `${a.id} → ${a.guard}`);
    expect(wrong).toEqual([]);
    // The terms screen's action really is there, guarded by requireSignedIn.
    for (const id of Object.keys(SIGNED_IN_ONLY))
      expect(exportedActions.find((a) => a.id === id)?.guard, id).toBe("requireSignedIn");
    // …and no page or action anywhere else uses it.
    const users = ALL.filter((f) => /\brequireSignedIn\(/.test(readFileSync(f, "utf8"))).map(rel);
    expect(users.sort()).toEqual(
      [
        "src/server/session.ts",
        "src/app/welcome/terms/actions.ts",
        "src/app/welcome/terms/page.tsx",
      ].sort(),
    );
    // Self-check: the admin action file is really scanned, and every action in it is Davi's.
    const admin = exportedActions.filter((a) => a.id.startsWith("src/app/(app)/admin/actions.ts#"));
    expect(admin.length).toBeGreaterThanOrEqual(5);
    for (const a of admin) expect(a.guard, a.id).toBe("requireAdmin");
  });

  it("a 'use server' file exports nothing but plain functions (any other shape would skip the scan)", () => {
    const odd = actionFiles.flatMap((f) => otherExports(parse(f)).map((e) => `${rel(f)}: ${e}`));
    expect(odd).toEqual([]);
  });

  it("the export check catches the shapes it's meant to (self-test)", () => {
    const sf = (code: string) => ts.createSourceFile("x.ts", code, ts.ScriptTarget.Latest, true);
    for (const bad of [
      "async function f() {}\nexport { f };",
      'export { f } from "./x";',
      'export * from "./x";',
      "export default async function f() {}",
      "export default f;",
      "export const f = wrap(async () => {});",
    ])
      expect(otherExports(sf(bad)).length, bad).toBeGreaterThan(0);
    for (const ok of [
      "export async function f() {}",
      "export const f = async () => {};",
      "export type T = { a: 1 };",
      'export type { T } from "./x";',
      "const helper = 1;",
    ])
      expect(otherExports(sf(ok)), ok).toEqual([]);
  });

  it("inline 'use server' blocks are exactly the reviewed ones", () => {
    const found: string[] = [];
    for (const f of ALL) {
      walk(parse(f), (n) => {
        if (!isFnLike(n) || !n.body || !ts.isBlock(n.body)) return;
        if (!startsWithUseServer(n.body.statements)) return;
        if (guardedFirst(n, new Map())) return;
        found.push(`${rel(f)}#${awaitsIn(n).map(calleeName).join(",")}`);
      });
    }
    expect(found.sort()).toEqual(Object.keys(INLINE_ACTIONS).sort());
  });
});

describe("C2: admin pages 404 for everyone else, and nothing streams a 200 first", () => {
  it("every admin page calls requireAdmin() first", () => {
    const pages = ALL.filter((f) => f.startsWith(ADMIN) && NEXT_FILE("page").test(f));
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const p of pages) {
      const sf = parse(p);
      const page = sf.statements.find(
        (s): s is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(s) &&
          (ts.getModifiers(s) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword),
      );
      expect(page, rel(p)).toBeDefined();
      expect(calleeName(awaitsIn(page!)[0]!), rel(p)).toBe("requireAdmin");
    }
  });

  it("no loading.tsx in or above the screens that must 404 (streaming turns notFound into 200)", () => {
    const mustNotFound = [
      ADMIN,
      join(APP, "(app)", "customers", "[key]"),
      join(APP, "(app)", "record", "[draftId]"),
      // Squared Away Growth: anyone who isn't an active or paused client gets a 404.
      join(APP, "my-growth"),
    ];
    const loadings = ALL.filter((f) => NEXT_FILE("loading").test(f));
    for (const dir of mustNotFound) {
      expect(existsSync(join(dir, "page.tsx")), rel(dir)).toBe(true);
      // Inside it…
      expect(loadings.filter((l) => l.startsWith(dir + "/")).map(rel), rel(dir)).toEqual([]);
      // …and in any folder above it, which would wrap it too.
      for (let up = dirname(dir); up.startsWith(APP); up = dirname(up)) {
        for (const ext of ["tsx", "ts", "jsx", "js"])
          expect(existsSync(join(up, `loading.${ext}`)), rel(up)).toBe(false);
      }
    }
  });
});

describe("C3: every route handler is in the table with the guard it uses", () => {
  type Guard =
    | "session" // auth() first, then the owner's workspace; 401 otherwise
    | "session+state" // auth() first, then the OAuth state cookie compared in constant time
    | "token" // Pub/Sub push: shared token compared in constant time, before anything else
    | "stripe-signature" // Stripe's signature over the raw body
    | "inngest-signature" // the Inngest SDK's signing key check
    | "e2e-hook" // local e2e only: 404 unless e2e mode + ≥32-char secret (the e2e app is bound to loopback in playwright.config.ts)
    | "authjs" // Auth.js's own handlers
    | "signed-link" // a link we emailed: HMAC over the id with AUTH_SECRET, constant-time, first
    | "public"; // static, reads nothing private
  const ROUTES: Record<string, Guard> = {
    "src/app/api/badge/route.ts": "session",
    "src/app/api/push/summary/route.ts": "session",
    "src/app/api/drafts/[id]/send/route.ts": "session",
    "src/app/api/gmail/callback/route.ts": "session+state",
    "src/app/api/gmail/push/route.ts": "token",
    "src/app/api/stripe/webhook/route.ts": "stripe-signature",
    "src/app/api/inngest/route.ts": "inngest-signature",
    "src/app/api/test-hooks/run/route.ts": "e2e-hook",
    "src/app/api/auth/[...nextauth]/route.ts": "authjs",
    "src/app/api/health/route.ts": "public",
    "src/app/api/emails/stop/route.ts": "signed-link",
    "src/app/app-icon/[size]/route.tsx": "public",
  };
  const routeFiles = routeFilesIn(ALL).map(rel);

  it("no route without a row, no row without a route", () => {
    expect(routeFiles.sort()).toEqual(Object.keys(ROUTES).sort());
  });

  it("src/app is the only router: no Pages Router (src/pages/api is live), no root app/ or pages/", () => {
    // Next serves src/pages next to src/app, and a root app/ or pages/ would replace src/
    // entirely; none of them is in the table above, so none may exist.
    for (const dir of [join(SRC, "pages"), join(ROOT, "app"), join(ROOT, "pages")])
      expect(existsSync(dir), rel(dir)).toBe(false);
  });

  const handlers = (file: string) =>
    exportedFunctions(parse(join(ROOT, file))).filter((h) =>
      ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(h.name),
    );
  const firstStatement = (fn: FnLike) =>
    fn.body && ts.isBlock(fn.body) ? (fn.body.statements[0]?.getText() ?? "") : "";

  for (const [file, guard] of Object.entries(ROUTES)) {
    it(`${file}: ${guard}`, () => {
      const src = readFileSync(join(ROOT, file), "utf8");
      switch (guard) {
        case "session":
        case "session+state": {
          const hs = handlers(file);
          expect(hs.length).toBeGreaterThan(0);
          for (const h of hs) expect(calleeName(awaitsIn(h.fn)[0]!), h.name).toBe("auth");
          // The "I agree" boxes (Davi, 2026-10-15): not agreed to the current terms → 403,
          // before any work (the poll / send limits, Google's code exchange).
          const terms = src.search(
            /if \(!\(await termsAccepted\(session!?\.user\.id\)\)\) return termsRequiredResponse\(\);/,
          );
          expect(terms, "the terms check").toBeGreaterThan(-1);
          for (const work of ["hitLimit(", "exchangeCode("]) {
            const at = src.indexOf(work);
            if (at > -1) expect(terms, work).toBeLessThan(at);
          }
          if (guard === "session") {
            expect(src).toContain("getWorkspaceForUser(session.user.id)");
            expect(src).toMatch(/status: 401/);
          } else {
            expect(src).toMatch(/statesMatch\(expected, params\.get\("state"\)\)/);
            expect(readFileSync("src/mailbox/gmail/oauth-state.ts", "utf8")).toContain(
              "timingSafeEqual",
            );
          }
          break;
        }
        case "token": {
          const [post] = handlers(file);
          expect(firstStatement(post!.fn)).toMatch(/^if \(!tokenOk\(/);
          expect(src).toContain("timingSafeEqual");
          break;
        }
        case "stripe-signature":
          expect(src).toMatch(
            /handleStripeWebhook\(body, req\.headers\.get\("stripe-signature"\)\)/,
          );
          expect(readFileSync("src/server/billing.ts", "utf8")).toMatch(
            /webhooks\.constructEventAsync\(rawBody, signature, secret\)/,
          );
          break;
        case "inngest-signature":
          expect(src).toMatch(/import \{ serve \} from "inngest\/next"/);
          expect(src).toMatch(/export const \{ GET, POST, PUT \} = serve\(/);
          break;
        case "e2e-hook": {
          const [post] = handlers(file);
          expect(firstStatement(post!.fn)).toBe("const secret = e2eHookSecret();");
          expect(src).toContain('secretMatches(secret, request.headers.get("x-e2e-hook-secret"))');
          break;
        }
        case "signed-link": {
          // Trial emails' "Stop these emails" (2026-10-16): the signature is checked first, and
          // the only thing the route can do is switch trial emails off.
          const hs = handlers(file);
          expect(hs.map((h) => h.name).sort()).toEqual(["GET", "POST"]);
          for (const h of hs)
            expect(firstStatement(h.fn), h.name).toBe(
              "const link = verifiedStopLink(request.nextUrl.searchParams);",
            );
          expect(readFileSync("src/server/trial-email-links.ts", "utf8")).toContain(
            "timingSafeEqual",
          );
          expect(src.match(/await [a-zA-Z.]+\(/g)).toEqual([
            "await stopTrialEmails(",
            "await stopTrialEmails(",
          ]);
          break;
        }
        case "authjs":
          expect(src.trim()).toBe(
            'import { handlers } from "@/auth";\n\nexport const { GET, POST } = handlers;',
          );
          break;
        case "public":
          // Nothing private within reach: no database, session or server logic.
          expect(src).not.toMatch(/from "@\/(db|auth|server\/[^"]+)"/);
          break;
      }
    });
  }
});

describe("C1–C3 read JavaScript too (M11 review finding 3)", () => {
  it("src/app is TypeScript only: no .js / .jsx / .mjs / .cjs file", () => {
    expect(jsFilesIn(ALL).map(rel)).toEqual([]);
  });

  it("an unguarded JS route or action is caught (self-test on fixture files)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sa-surface-"));
    try {
      const app = join(dir, "src", "app");
      const put = (path: string, code: string) => {
        mkdirSync(dirname(join(app, path)), { recursive: true });
        writeFileSync(join(app, path), code);
      };
      put(
        "api/leak/route.js",
        'import { db } from "@/db";\nexport async function GET() {\n  return Response.json(await db().execute("select * from mailboxes"));\n}\n',
      );
      put(
        "probe/actions.js",
        '"use server";\nimport { disconnectMailbox } from "@/server/mailboxes";\nexport async function evil(fd) {\n  await disconnectMailbox(fd.get("ws"), fd.get("id"));\n}\n',
      );
      put(
        "probe/more-actions.mjs",
        '"use server";\nexport const wipe = async (fd) => {\n  await deleteEverything(fd.get("ws"));\n};\n',
      );
      put(
        "probe/page.jsx",
        'export default function Page() {\n  async function go() {\n    "use server";\n    await leak();\n  }\n  return <form action={go} />;\n}\n',
      );
      put(
        "probe/guarded-actions.js",
        '"use server";\nimport { requireOwner } from "@/server/session";\nexport async function fine() {\n  await requireOwner();\n}\n',
      );
      const files = sourceFiles(join(dir, "src"));

      // C1: the JS actions are read, and the unguarded ones are reported.
      const { exportedActions } = scanActions(files, app);
      expect(exportedActions.filter((a) => !a.guarded).map((a) => a.id)).toEqual([
        "src/app/probe/actions.js#evil",
        "src/app/probe/more-actions.mjs#wipe",
      ]);
      expect(exportedActions.find((a) => a.id.endsWith("#fine"))?.guard).toBe("requireOwner");
      // C1: an inline "use server" block in a .jsx page is read too.
      const inline = files.flatMap((f) => {
        const found: string[] = [];
        walk(parse(f), (n) => {
          if (isFnLike(n) && n.body && ts.isBlock(n.body) && startsWithUseServer(n.body.statements))
            found.push(awaitsIn(n).map(calleeName).join(","));
        });
        return found;
      });
      expect(inline).toEqual(["leak"]);
      // C3: a route.js is a route, so it needs a row in the table.
      expect(routeFilesIn(files, app).map((f) => relative(dir, f).split(sep).join("/"))).toEqual([
        "src/app/api/leak/route.js",
      ]);
      // And src/app's TypeScript-only rule names every one of them.
      expect(jsFilesIn(files, app)).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * C4 by the sinks (M11 review finding 4): every redirect target in src must be visibly one of
 * our own paths. Reading a list of parameter names (below) can't see `redirect(fd.get("back"))`.
 */
const NAV_SINKS = new Set(["redirect", "permanentRedirect"]);
/** A target that may be followed by anything: "/x…", never "//", "/\\" or "/" + whitespace. */
const SAFE_PREFIX = /^\/[^/\\\s]/;
const safeWhole = (text: string) => text === "/" || SAFE_PREFIX.test(text);
const oneLine = (n: ts.Node) => n.getText().replace(/\s+/g, " ");
/** The browser's own location object: `location`, `window.location`, `document.location`… */
const LOCATION_OBJECT = /^(?:(?:window|document|globalThis|self)\.)?location$/;
/** Location properties whose assignment navigates to another site. */
const LOCATION_NAV_PROPS = new Set(["href", "host", "hostname", "protocol"]);

/** A file read for C4, with TypeScript's name binding (see `bindFiles`). */
type Bound = { sf: ts.SourceFile; checker: ts.TypeChecker };

function skipOuter(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isAwaitExpression(e)
  )
    e = e.expression;
  return e;
}

/** The function a name is declared as at the top of the file (`function f` / `const f = () =>`). */
function topLevelFunction(
  sf: ts.SourceFile,
  name: string,
): { fn: FnLike; exported: boolean } | null {
  const exported = (n: ts.Node) =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name)
      return { fn: st, exported: exported(st) };
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (
          ts.isIdentifier(d.name) &&
          d.name.text === name &&
          d.initializer &&
          isFnLike(d.initializer)
        )
          return { fn: d.initializer, exported: exported(st) };
  }
  return null;
}

/** What a function can return: an arrow's expression body, else its `return x` statements. */
function returnsOf(fn: FnLike): ts.Expression[] | null {
  if (fn.body && !ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  let bare = false;
  const visit = (n: ts.Node) => {
    if (n !== fn && isFnLike(n)) return;
    if (ts.isReturnStatement(n)) {
      if (n.expression) out.push(n.expression);
      else bare = true;
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) ts.forEachChild(fn.body, visit);
  return bare || out.length === 0 ? null : out;
}

/** The symbol an identifier means, by TypeScript's scope rules (a shorthand `{ x }` means x). */
function symbolOf(id: ts.Identifier, { checker }: Bound): ts.Symbol | undefined {
  if (ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id)
    return checker.getShorthandAssignmentValueSymbol(id.parent);
  return checker.getSymbolAtLocation(id);
}

/**
 * The one declaration an identifier binds to, by TypeScript's own scope rules (M11 review: a
 * for-of / catch / hoisted `var` / inner function of the same name shadows an outer `const`).
 * Null for an import, a global, or a name declared more than once (a redeclared `var`, an
 * overload): none of those can be read as "visibly our own path".
 */
function declarationOf(id: ts.Identifier, b: Bound): ts.Declaration | null {
  const sym = symbolOf(id, b);
  if (!sym || sym.flags & ts.SymbolFlags.Alias) return null;
  const decls = sym.declarations ?? [];
  return decls.length === 1 ? decls[0]! : null;
}

/** True when `id` is written to: `x = …`, `x += …`, `[x] = …`, `({ x } = …)`, `for (x of …)`, `x++`. */
function isWriteTarget(id: ts.Identifier): boolean {
  let n: ts.Node = id;
  for (;;) {
    const p: ts.Node = n.parent;
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isArrayLiteralExpression(p) ||
      ts.isObjectLiteralExpression(p) ||
      ts.isSpreadElement(p) ||
      ts.isSpreadAssignment(p) ||
      ts.isShorthandPropertyAssignment(p) ||
      (ts.isPropertyAssignment(p) && p.initializer === n) ||
      ts.isNonNullExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p)
    ) {
      n = p;
      continue;
    }
    if (
      ts.isBinaryExpression(p) &&
      p.left === n &&
      p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      return true;
    if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === n) return true;
    if (
      (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
      (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)
    )
      return true;
    return false;
  }
}

/** Every identifier in the file that means `sym`, other than the name in its declaration. */
function usesOf(sym: ts.Symbol, b: Bound): ts.Identifier[] {
  const names = new Set((sym.declarations ?? []).map((d) => ts.getNameOfDeclaration(d)));
  const out: ts.Identifier[] = [];
  walk(b.sf, (n) => {
    if (ts.isIdentifier(n) && n.text === sym.name && !names.has(n) && symbolOf(n, b) === sym)
      out.push(n);
  });
  return out;
}

/** Calls of a function by its symbol, and whether it is ever used any other way. */
function callsOf(sym: ts.Symbol, b: Bound) {
  const calls: ts.CallExpression[] = [];
  let otherUse = false;
  for (const n of usesOf(sym, b)) {
    const p = n.parent;
    if (ts.isCallExpression(p) && p.expression === n) calls.push(p);
    else otherUse = true;
  }
  // `export { f }` / `export default f` hand it to callers we can't see.
  walk(b.sf, (n) => {
    if (
      ts.isIdentifier(n) &&
      n.text === sym.name &&
      (ts.isExportSpecifier(n.parent) || ts.isExportAssignment(n.parent))
    )
      otherUse = true;
  });
  return { calls, otherUse };
}

/** The function an identifier names, if it is one we can read: a function declaration or a
 * `const f = () => …`, never written to. */
function functionNamed(id: ts.Identifier, b: Bound): { fn: FnLike; sym: ts.Symbol } | null {
  const decl = declarationOf(id, b);
  const sym = symbolOf(id, b);
  if (!decl || !sym) return null;
  if (ts.isFunctionDeclaration(decl))
    return usesOf(sym, b).some(isWriteTarget) ? null : { fn: decl, sym };
  if (
    ts.isVariableDeclaration(decl) &&
    (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0 &&
    decl.initializer &&
    isFnLike(skipOuter(decl.initializer))
  )
    return { fn: skipOuter(decl.initializer) as FnLike, sym };
  return null;
}

/** True when `e` can only ever be one of our own paths (or appUrl of one). */
function safeTarget(e: ts.Expression, b: Bound, seen = new Set<ts.Node>()): boolean {
  const { sf } = b;
  e = skipOuter(e);
  if (seen.has(e)) return false;
  seen = new Set([...seen, e]);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return safeWhole(e.text);
  if (ts.isTemplateExpression(e)) return SAFE_PREFIX.test(e.head.text);
  if (ts.isConditionalExpression(e))
    return safeTarget(e.whenTrue, b, seen) && safeTarget(e.whenFalse, b, seen);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken)
      return safeTarget(e.left, b, seen) && safeTarget(e.right, b, seen);
    if (op === ts.SyntaxKind.PlusToken) {
      let first: ts.Expression = e;
      while (ts.isBinaryExpression(first) && first.operatorToken.kind === ts.SyntaxKind.PlusToken)
        first = skipOuter(first.left);
      return (
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) &&
        SAFE_PREFIX.test(first.text)
      );
    }
    return false;
  }
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
    const callee = e.expression;
    // appUrl(path) = our own origin + path, so the path must start with "/". Only our own
    // appUrl (imported from @/lib/app-url, or unbound in a fixture), never a local of that name.
    if (callee.text === "appUrl") {
      const sym = symbolOf(callee, b);
      const decl = sym?.declarations?.[0];
      const ours =
        !sym ||
        (!!decl &&
          ts.isImportSpecifier(decl) &&
          (decl.parent.parent.parent.moduleSpecifier as ts.StringLiteral).text === "@/lib/app-url");
      return ours && (e.arguments.length === 0 || safeTarget(e.arguments[0]!, b, seen));
    }
    // A helper that resolves to a function we can read: every value it can return must be safe.
    const local = functionNamed(callee, b);
    const returns = local && returnsOf(local.fn);
    return !!returns && returns.every((r) => safeTarget(r, b, seen));
  }
  if (ts.isIdentifier(e)) {
    const decl = declarationOf(e, b);
    if (!decl) return false;
    // `const x = <safe>`. Never `let` / `var` (it could be written to later), and never a
    // for-of / for-in / catch binding (no initializer: its value comes from elsewhere).
    if (ts.isVariableDeclaration(decl))
      return (
        !!decl.initializer &&
        (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0 &&
        safeTarget(decl.initializer, b, seen)
      );
    // A parameter of a top-level helper in this file that nothing outside can call: every call
    // passes a safe value, the helper is never passed around, and the parameter is never
    // written to.
    if (ts.isParameter(decl) && ts.isIdentifier(decl.name)) {
      const fn = decl.parent;
      if (!isFnLike(fn)) return false;
      const nameNode =
        ts.isFunctionDeclaration(fn) && fn.name
          ? fn.name
          : ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)
            ? fn.parent.name
            : null;
      const top = nameNode ? topLevelFunction(sf, nameNode.text) : null;
      if (!nameNode || !top || top.fn !== fn || top.exported) return false;
      const param = symbolOf(decl.name, b);
      if (!param || usesOf(param, b).some(isWriteTarget)) return false;
      const helper = functionNamed(nameNode, b);
      if (!helper || helper.fn !== fn) return false;
      const index = fn.parameters.indexOf(decl);
      const { calls, otherUse } = callsOf(helper.sym, b);
      return (
        !otherUse &&
        calls.length > 0 &&
        calls.every((c) => !!c.arguments[index] && safeTarget(c.arguments[index]!, b, seen))
      );
    }
    return false;
  }
  return false;
}

/** A property key as written: `location`, `"Location"`, `["location"]`; else null. */
function keyText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(skipOuter(name.expression)))
    return (skipOuter(name.expression) as ts.StringLiteralLike).text;
  return null;
}

/**
 * True when an object or array literal is where headers are given: the value of a `headers:`
 * property (also nested, as in `headers: [["location", x]]`) or an argument of `new Headers(…)`.
 */
function inHeaders(lit: ts.Node): boolean {
  let n = lit;
  while (
    ts.isArrayLiteralExpression(n.parent) ||
    ts.isParenthesizedExpression(n.parent) ||
    ts.isAsExpression(n.parent) ||
    ts.isSatisfiesExpression(n.parent)
  )
    n = n.parent;
  const p = n.parent;
  if (ts.isPropertyAssignment(p) && p.initializer === n)
    return keyText(p.name)?.toLowerCase() === "headers";
  return (
    ts.isNewExpression(p) &&
    ts.isIdentifier(p.expression) &&
    p.expression.text === "Headers" &&
    !!p.arguments?.some((a) => a === n)
  );
}

/** True when `e` is a router from `useRouter()` (called inline, or kept in a const of any name). */
function isRouter(e: ts.Expression, b: Bound): boolean {
  e = skipOuter(e);
  const fromUseRouter = (x: ts.Expression) => {
    x = skipOuter(x);
    return (
      ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === "useRouter"
    );
  };
  if (fromUseRouter(e)) return true;
  if (!ts.isIdentifier(e)) return false;
  if (e.text === "router") return true;
  const decl = declarationOf(e, b);
  return (
    !!decl &&
    ts.isVariableDeclaration(decl) &&
    !!decl.initializer &&
    fromUseRouter(decl.initializer)
  );
}

/** True when `e` is the browser's location object (not a local variable of that name). */
function isLocationObject(e: ts.Expression, b: Bound): boolean {
  e = skipOuter(e);
  if (!LOCATION_OBJECT.test(e.getText().replace(/\s+/g, ""))) return false;
  // A bare `location` that resolves to a declaration of ours is a variable, not the browser's.
  return !(ts.isIdentifier(e) && declarationOf(e, b));
}

/**
 * Every navigation in a file whose target isn't visibly our own path, as `sink(target)`.
 * Server: redirect() / permanentRedirect() (also renamed on import), any `.redirect(…)` such as
 * NextResponse.redirect / Response.redirect, Auth.js's `redirectTo` option, and a hand-set
 * Location header (any case; an object key, a `[name, value]` pair, or headers.set/append).
 * Client: router.push / router.replace on a `useRouter()` router, location.assign / replace,
 * window.open, and assigning `location` or its href / host / hostname / protocol. A navigation
 * function passed around as a value is reported too.
 */
function unsafeRedirects(b: Bound): string[] {
  const { sf } = b;
  const out: string[] = [];
  const navNames = new Set(NAV_SINKS);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings) continue;
    const nb = st.importClause.namedBindings;
    if (!ts.isNamedImports(nb)) continue;
    for (const el of nb.elements)
      if (NAV_SINKS.has((el.propertyName ?? el.name).text)) navNames.add(el.name.text);
  }
  const check = (sink: string, target: ts.Expression | undefined, at: ts.Node) => {
    if (!target) out.push(`${sink}() with no target: ${oneLine(at)}`);
    else if (!safeTarget(target, b)) out.push(`${sink}(${oneLine(target)})`);
  };
  /** A Location value: checked in a headers position; elsewhere a plain literal is just text. */
  const checkLocation = (value: ts.Expression | undefined, lit: ts.Node, at: ts.Node) => {
    const v = value && skipOuter(value);
    if (v && !inHeaders(lit) && (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)))
      return; // e.g. site.ts's `location: "Massachusetts, United States"` (author's own text)
    check("Location", value, at);
  };
  walk(sf, (n) => {
    if (ts.isImportSpecifier(n) || ts.isImportClause(n)) return;
    // redirect(x), permanentRedirect(x), go(x) after `import { redirect as go }`.
    if (ts.isIdentifier(n) && navNames.has(n.text)) {
      const p = n.parent;
      if (ts.isImportSpecifier(p)) return;
      if (ts.isPropertyAccessExpression(p) && p.name === n) return; // handled below
      if (ts.isPropertyAssignment(p) && p.name === n) return; // { redirect: … } is a key
      if (ts.isCallExpression(p) && p.expression === n) check(n.text, p.arguments[0], p);
      else out.push(`${n.text} used as a value: ${oneLine(p)}`);
      return;
    }
    // NextResponse.redirect(x), Response.redirect(x), nav.redirect(x), x["redirect"](y), and on
    // the client router.push / router.replace, location.assign / location.replace, window.open.
    const memberName = ts.isPropertyAccessExpression(n)
      ? n.name.text
      : ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)
        ? n.argumentExpression.text
        : null;
    if (memberName && (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))) {
      const recv = n.expression;
      const member = NAV_SINKS.has(memberName)
        ? memberName
        : (memberName === "push" || memberName === "replace") && isRouter(recv, b)
          ? memberName
          : (memberName === "assign" || memberName === "replace") && isLocationObject(recv, b)
            ? memberName
            : memberName === "open" && skipOuter(recv).getText() === "window"
              ? memberName
              : null;
      if (member) {
        const p = n.parent;
        const sink = `${skipOuter(recv).getText()}.${member}`;
        if (ts.isCallExpression(p) && p.expression === n) check(sink, p.arguments[0], p);
        else out.push(`${sink} used as a value: ${oneLine(p)}`);
        return;
      }
    }
    // window.location = x, location.href = x, document.location.host = x, …
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const left = skipOuter(n.left);
      const navigates =
        isLocationObject(left, b) ||
        (ts.isPropertyAccessExpression(left) &&
          LOCATION_NAV_PROPS.has(left.name.text) &&
          isLocationObject(left.expression, b));
      if (navigates) check(`${left.getText()} = `, n.right, n);
    }
    // Auth.js: signIn(…, { redirectTo }) / signOut({ redirectTo }).
    if (ts.isPropertyAssignment(n) && n.name.getText().replace(/["'`]/g, "") === "redirectTo")
      check("redirectTo", n.initializer, n);
    if (ts.isShorthandPropertyAssignment(n) && n.name.text === "redirectTo")
      check("redirectTo", n.name, n);
    // A Location header set by hand, in any case: { location: x }, { "Location": x },
    // { ["location"]: x }, { Location } (shorthand), [["location", x]], headers.set("location", x).
    if (ts.isPropertyAssignment(n) && keyText(n.name)?.toLowerCase() === "location")
      checkLocation(n.initializer, n.parent, n);
    if (ts.isShorthandPropertyAssignment(n) && n.name.text.toLowerCase() === "location")
      check("Location", n.name, n);
    if (ts.isArrayLiteralExpression(n) && n.elements.length >= 2) {
      const first = skipOuter(n.elements[0]!);
      if (ts.isStringLiteralLike(first) && first.text.toLowerCase() === "location")
        checkLocation(n.elements[1], n, n);
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ["set", "append"].includes(n.expression.name.text) &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0]) &&
      n.arguments[0].text.toLowerCase() === "location"
    )
      check("Location", n.arguments[1], n);
  });
  return out;
}

/** All of src bound together once (about two seconds), for the C4 scan. */
let SRC_BOUND: { program: ts.Program; checker: ts.TypeChecker } | null = null;
function boundSource(file: string): Bound {
  SRC_BOUND ??= bindFiles(new Map(ALL.map((f) => [f, readFileSync(f, "utf8")])));
  return { sf: SRC_BOUND.program.getSourceFile(file)!, checker: SRC_BOUND.checker };
}
/** A fixture bound on its own, as a file in src would be. */
function boundFixture(code: string, name = "x.ts"): Bound {
  const file = join(ROOT, "__c4_fixture__", name);
  const { program, checker } = bindFiles(new Map([[file, code]]));
  return { sf: program.getSourceFile(file)!, checker };
}

describe("C4: no open redirects", () => {
  /**
   * The only redirects whose target isn't visibly one of our paths, each reviewed. A new one,
   * or one of these changing shape, fails until it is reviewed here.
   */
  const REVIEWED_REDIRECTS: [string, string][] = [
    [
      "src/app/(app)/billing/actions.ts: redirect(url)",
      "Stripe Checkout: the URL createCheckout() got from Stripe, never from the form",
    ],
    [
      "src/app/(app)/billing/actions.ts: redirect(url)",
      "Stripe Billing Portal: the URL createPortal() got from Stripe, never from the form",
    ],
    [
      "src/app/welcome/terms/actions.ts: redirect(url)",
      "Stripe Billing Portal from the terms screen (to cancel without agreeing): the URL " +
        "createPortal() got from Stripe, never from the form",
    ],
    [
      "src/app/(app)/connect/actions.ts: redirect(createGmailConnector().authorizationUrl({ state, redirectUri: appUrl(gmailRedirectPath), loginHint: session?.user?.email ?? undefined, }))",
      "Google's consent screen, built by our connector with our own callback URL",
    ],
    [
      'src/app/(app)/settings/profile-actions.ts: redirect(returnTo.catch("/settings/business?done=profile").parse(raw.returnTo))',
      "a z.enum of two fixed paths (pinned by the returnTo test below)",
    ],
    [
      'src/app/welcome/terms/actions.ts: redirect(safeNextPath(formData.get("next")))',
      "back to the screen they were heading for after 'I agree': safeNextPath allows only a " +
        "path on this site (pinned by the safeNextPath test below and terms-agreement.test.ts)",
    ],
    [
      "src/app/welcome/terms/page.tsx: redirect(back)",
      "the same, for someone who had already agreed: const back = safeNextPath(next)",
    ],
  ];

  it("every redirect target is one of our own paths, or a reviewed exception", () => {
    const found = ALL.flatMap((f) => unsafeRedirects(boundSource(f)).map((r) => `${rel(f)}: ${r}`));
    expect(found.sort()).toEqual(REVIEWED_REDIRECTS.map(([site]) => site).sort());
    // The two billing targets really are Stripe's own URLs.
    const billing = readFileSync("src/app/(app)/billing/actions.ts", "utf8");
    expect(billing).toContain("url = await createCheckout(workspace, plan);");
    expect(billing).toContain("url = await createPortal(workspace);");
    expect(billing.match(/\burl = /g)).toHaveLength(2);
    const terms = readFileSync("src/app/welcome/terms/actions.ts", "utf8");
    expect(terms).toContain('url = await createPortal(workspace, "/welcome/terms");');
    expect(terms.match(/\burl = /g)).toHaveLength(1);
  });

  it("the scan sees the redirects that are there (it isn't silently empty)", () => {
    let sinks = 0;
    for (const f of ALL)
      walk(parse(f), (n) => {
        if (
          ts.isCallExpression(n) &&
          (ts.isIdentifier(n.expression) || ts.isPropertyAccessExpression(n.expression)) &&
          NAV_SINKS.has(ts.isIdentifier(n.expression) ? n.expression.text : n.expression.name.text)
        )
          sinks++;
      });
    expect(sinks).toBeGreaterThanOrEqual(100);
  });

  it("the redirect scan catches targets the old name list missed, and passes our own paths (self-test)", () => {
    const bad = [
      // Read from the form or the query under names the old list didn't have.
      'import { redirect } from "next/navigation";\nexport async function goBack(fd: FormData) {\n  await requireOwner();\n  redirect(String(fd.get("back")));\n}',
      'import { redirect } from "next/navigation";\nexport async function a(fd: FormData) { redirect(fd.get("to") as string); }',
      'import { redirect } from "next/navigation";\nexport default async function P(props) { const sp = await props.searchParams; redirect(sp.url); }',
      'import { redirect } from "next/navigation";\nexport default async function P(props) { const { dest } = await props.searchParams; redirect(dest); }',
      'import { redirect } from "next/navigation";\nexport async function a(fd: FormData) { const x = fd.get("x") as string; redirect(x); }',
      'import { redirect } from "next/navigation";\nexport async function a(fd: FormData) { let x = "/queue"; x = String(fd.get("x")); redirect(x); }',
      // Route handlers: query, headers and route params.
      'import { NextResponse } from "next/server";\nexport function GET(req) { return NextResponse.redirect(new URL(req.nextUrl.searchParams.get("u")!, req.url)); }',
      'export function GET(req: Request) { return Response.redirect(req.headers.get("referer")!); }',
      'import { permanentRedirect } from "next/navigation";\nexport default async function P({ params }) { permanentRedirect(`/${(await params).slug}`); }',
      // A leading "/" that isn't a path of ours.
      'import { redirect } from "next/navigation";\nexport async function a(fd: FormData) { redirect("/" + fd.get("to")); }',
      'import { redirect } from "next/navigation";\nexport async function a(host: string) { redirect(`//${host}`); }',
      'import { redirect } from "next/navigation";\nexport async function a() { redirect("//evil.example"); }',
      'import { redirect } from "next/navigation";\nexport async function a() { redirect("/\\\\evil.example"); }',
      'import { redirect } from "next/navigation";\nexport async function a(fd: FormData) { redirect(fd.get("ok") ? "/queue" : String(fd.get("to"))); }',
      // Renamed, passed around, or hidden behind a helper.
      'import { redirect as go } from "next/navigation";\nexport async function a(fd: FormData) { go(String(fd.get("x"))); }',
      'import { redirect } from "next/navigation";\nconst r = redirect;\nexport async function a(fd: FormData) { r(String(fd.get("x"))); }',
      'import * as nav from "next/navigation";\nexport async function a(fd: FormData) { nav.redirect(String(fd.get("x"))); }',
      'import { redirect } from "next/navigation";\nfunction to(p: string) { redirect(p); }\nexport async function a(fd: FormData) { to("/queue"); to(String(fd.get("x"))); }',
      'import { redirect } from "next/navigation";\nexport function to(p: string) { redirect(p); }',
      'import { redirect } from "next/navigation";\nconst pick = (fd: FormData) => String(fd.get("x"));\nexport async function a(fd: FormData) { redirect(pick(fd)); }',
      'import { NextResponse } from "next/server";\nexport function GET(req) { return NextResponse.redirect(appUrl(req.nextUrl.searchParams.get("p"))); }',
      'import { NextResponse } from "next/server";\nexport function GET() { return NextResponse.redirect(appUrl("@evil.example")); }',
      // Auth.js's own redirect option and a Location header set by hand.
      'export async function a(fd: FormData) { await signIn("google", { redirectTo: String(fd.get("cb")) }); }',
      'export function GET(req: Request) { return new Response(null, { status: 302, headers: { Location: req.headers.get("x")! } }); }',
      'export function GET(req: Request) { const h = new Headers(); h.set("location", new URL(req.url).searchParams.get("u")!); return new Response(null, { status: 302, headers: h }); }',
      // …in any case and any shape (M11 review: header names are case-insensitive).
      'export function GET(req: Request) { return new Response(null, { status: 302, headers: { location: req.headers.get("x")! } }); }',
      'export function GET(req: Request) { const Location = req.headers.get("x")!; return new Response(null, { status: 302, headers: { Location } }); }',
      'export function GET(req: Request) { return new Response(null, { status: 302, headers: { ["location"]: req.headers.get("x")! } }); }',
      'export function GET(req: Request) { return new Response(null, { status: 302, headers: [["location", req.headers.get("x")!]] }); }',
      'export function GET(req: Request) { return new Response(null, { status: 302, headers: new Headers([["Location", req.headers.get("x")!]]) }); }',
      'export function GET(req: Request) { return new Response(null, { status: 302, headers: new Headers({ location: req.headers.get("x")! }) }); }',
      'export function GET(req: Request) { const h = { location: new URL(req.url).searchParams.get("u")! }; return new Response(null, { status: 302, headers: h }); }',
      'export function GET() { return new Response(null, { status: 302, headers: { location: "https://evil.example" } }); }',
      // A same-named outer const must not lend its "safe" verdict to a shadowing binding.
      'import { redirect } from "next/navigation";\nconst to = "/queue";\nexport async function a(fd: FormData) { for (const to of [String(fd.get("x"))]) redirect(to); }',
      'import { redirect } from "next/navigation";\nconst to = "/queue";\nexport async function a(fd: FormData) { try { throw String(fd.get("x")); } catch (to) { redirect(to as string); } }',
      'import { redirect } from "next/navigation";\nconst to = "/queue";\nexport async function a(fd: FormData) { if (fd) { var to = String(fd.get("x")); } redirect(to); }',
      'import { redirect } from "next/navigation";\nconst back = () => "/queue";\nexport async function a(fd: FormData) { { const back = () => String(fd.get("x")); redirect(back()); } }',
      'import { redirect } from "next/navigation";\nfunction to(p: string) { [p] = [String(globalThis.x)]; redirect(p); }\nexport async function a() { to("/queue"); }',
      'import { redirect } from "next/navigation";\nconst appUrl = (p: string) => "https://evil.example" + p;\nexport async function a() { redirect(appUrl("/queue")); }',
      // Client navigation fed by the query.
      'import { useRouter, useSearchParams } from "next/navigation";\nexport function C() { const r = useRouter(); const sp = useSearchParams(); return () => r.push(sp.get("back")!); }',
      'import { useRouter, useSearchParams } from "next/navigation";\nexport function C() { const router = useRouter(); const sp = useSearchParams(); return () => router.replace(sp.get("to")!); }',
      'export function go() { window.location.href = new URLSearchParams(location.search).get("back")!; }',
      'export function go() { window.location = new URLSearchParams(location.search).get("back")!; }',
      'export function go() { location.assign(new URLSearchParams(location.search).get("url")!); }',
      'export function go() { window.location.replace(new URLSearchParams(location.search).get("url")!); }',
      'export function go() { document.location.host = new URLSearchParams(location.search).get("h")!; }',
      'export function go() { window.open(new URLSearchParams(location.search).get("url")!); }',
      // Old Settings anchors: a lookup into a table isn't a visible own path.
      'import { useRouter } from "next/navigation";\nconst T: Record<string, string> = { digest: "/settings/morning-email" };\nexport function C() { const router = useRouter(); return () => router.replace(T[location.hash.slice(1)]!); }',
    ];
    for (const code of bad)
      expect(unsafeRedirects(boundFixture(code)).length, code).toBeGreaterThan(0);

    const ok = [
      'import { redirect } from "next/navigation";\nexport async function a() { redirect("/queue?error=unknown"); }',
      'import { redirect } from "next/navigation";\nexport async function a() { redirect("/"); }',
      'import { redirect } from "next/navigation";\nexport async function a(id: string) { redirect(`/queue?sent=${id}`); }',
      'import { redirect } from "next/navigation";\nexport async function a(ok: boolean, w: string) { redirect(ok ? `/money?done=${w}` : "/money?error=unknown"); }',
      'import { redirect } from "next/navigation";\nconst back = (q: string) => `/settings?${q}#texts`;\nexport async function a(q: string) { redirect(back(q)); }',
      'import { redirect } from "next/navigation";\nexport async function a() { const to = "/queue"; redirect(to); }',
      'import { NextResponse } from "next/server";\nfunction to(path: string) { return NextResponse.redirect(appUrl(path), { status: 303 }); }\nexport async function GET(ok: boolean) { if (ok) return to("/"); return to(ok ? "/settings?done=connected" : "/welcome/profile"); }',
      'export async function a() { await signOut({ redirectTo: "/goodbye" }); }',
      'export const site = { location: "Massachusetts, United States" };',
      // Scope-aware, not just strict: an outer const or helper is still seen as ours.
      'import { redirect } from "next/navigation";\nconst to = "/queue";\nexport async function a(xs: string[]) { for (const x of xs) redirect(to); }',
      'import { redirect } from "next/navigation";\nconst back = () => "/queue";\nexport async function a() { { redirect(back()); } }',
      'import { NextResponse } from "next/server";\nimport { appUrl } from "@/lib/app-url";\nexport function GET() { return NextResponse.redirect(appUrl("/settings?done=connected")); }',
      'export function GET() { return new Response(null, { status: 303, headers: { location: "/queue" } }); }',
      // Client: the offline queue's own-path push, and look-alikes that don't navigate.
      'import { useRouter } from "next/navigation";\nexport function C(qs: string) { const router = useRouter(); return () => router.push(`/queue?${qs}`); }',
      'export function f(s: string, list: string[]) { list.push(s); return s.replace("a", "b"); }',
      // Old Settings anchors (legacy-anchors.tsx): a helper that only returns fixed own paths.
      'import { useRouter } from "next/navigation";\nexport function screen(h: string) { switch (h) { case "#digest": return "/settings/morning-email"; default: return "/settings"; } }\nexport function C() { const router = useRouter(); const to = screen(location.hash); return () => router.replace(to); }',
      'export function f(s: string) { let location = "x"; location = s; return location.replace("a", "b"); }',
    ];
    for (const code of ok) expect(unsafeRedirects(boundFixture(code)), code).toEqual([]);
  });

  const PARAM = "(callbackUrl|next|returnTo|return_to|redirect|redirectTo|redirect_to)";
  const READS = [
    new RegExp(`\\.get\\(\\s*["'\`]${PARAM}["'\`]\\s*\\)`),
    new RegExp(`\\b(params|searchParams|query|sp)\\??\\.${PARAM}\\b`),
    new RegExp(`\\[\\s*["'\`]${PARAM}["'\`]\\s*\\]`),
  ];

  /**
   * The other way a page reads its query: destructuring, as in
   * `const { next } = await props.searchParams;` or `const { returnTo: r } = params;`.
   * Each binding name (the property, not a rename) is checked when the value it comes from
   * mentions `searchParams` or `params`.
   */
  const PARAM_NAME = new RegExp(`^${PARAM}$`);
  function destructuredReads(sf: ts.SourceFile): string[] {
    const out: string[] = [];
    walk(sf, (n) => {
      if (!ts.isVariableDeclaration(n) || !n.initializer) return;
      if (!/\b(searchParams|params)\b/.test(n.initializer.getText())) return;
      const visit = (pattern: ts.BindingName) => {
        if (!ts.isObjectBindingPattern(pattern)) return;
        for (const el of pattern.elements) {
          const key = (el.propertyName ?? el.name).getText().replace(/^["'`]|["'`]$/g, "");
          if (PARAM_NAME.test(key)) out.push(el.getText());
          if (!ts.isIdentifier(el.name)) visit(el.name);
        }
      };
      visit(n.name);
    });
    return out;
  }

  it("no file reads a redirect-target query parameter, but the reviewed terms screen", () => {
    const hits = ALL.flatMap((f) => {
      const text = readFileSync(f, "utf8");
      return [
        ...READS.filter((re) => re.test(text)).map((re) => `${rel(f)} ${re}`),
        ...destructuredReads(parse(f)).map((d) => `${rel(f)} { ${d} }`),
      ];
    });
    // The terms screen (Davi, 2026-10-15) sends people back where they were going, and both of
    // its reads go straight through safeNextPath (the REVIEWED_REDIRECTS rows above).
    expect(hits.sort()).toEqual(
      [
        `src/app/welcome/terms/actions.ts ${READS[0]}`,
        "src/app/welcome/terms/page.tsx { next }",
      ].sort(),
    );
    const page = readFileSync("src/app/welcome/terms/page.tsx", "utf8");
    expect(page).toContain(
      "const { next, done: doneKey, error: errorKey } = await props.searchParams;\n" +
        "  const back = safeNextPath(next);",
    );
    expect(readFileSync("src/app/welcome/terms/actions.ts", "utf8")).toContain(
      'redirect(safeNextPath(formData.get("next")));',
    );
  });

  it("safeNextPath only ever returns a path on this site", async () => {
    const { safeNextPath } = await import("@/server/terms-rules");
    for (const raw of [
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "/queue\r\nLocation: //evil.example",
      " /queue",
      "\t//evil.example",
    ])
      expect(safeNextPath(raw), raw).toBe("/queue");
    expect(safeNextPath("/quotes?x=1")).toBe("/quotes?x=1");
    expect(safeNextPath("/quotes?x=1")).toMatch(SAFE_PREFIX);
  });

  it("the destructuring check catches the shapes it's meant to (self-test)", () => {
    const sf = (code: string) => ts.createSourceFile("x.ts", code, ts.ScriptTarget.Latest, true);
    for (const bad of [
      "const { next } = await props.searchParams;",
      "const { returnTo: r } = params;",
      "const { callbackUrl, done } = await searchParams;",
      'const { "redirect": to } = await props.searchParams;',
      "const { a: { next } } = params;",
    ])
      expect(destructuredReads(sf(bad)).length, bad).toBeGreaterThan(0);
    for (const ok of [
      "const { done } = await props.searchParams;",
      "const { error } = await props.searchParams;",
      "const { draftId } = await props.params;",
      "const { next } = await loadThings();",
    ])
      expect(destructuredReads(sf(ok)), ok).toEqual([]);
  });

  it("the business profile's returnTo is a fixed list, not a URL", () => {
    const src = readFileSync("src/app/(app)/settings/profile-actions.ts", "utf8");
    expect(src).toContain(
      'const returnTo = z.enum(["/settings/business?done=profile", "/welcome/learning"]);',
    );
    expect(src).toContain(
      'redirect(returnTo.catch("/settings/business?done=profile").parse(raw.returnTo));',
    );
  });

  it("the patterns catch the shapes they're meant to (self-test)", () => {
    for (const bad of [
      'searchParams.get("callbackUrl")',
      "params.next",
      "searchParams?.returnTo",
      'query["redirect"]',
    ]) {
      expect(
        READS.some((re) => re.test(bad)),
        bad,
      ).toBe(true);
    }
    for (const ok of [
      'params.get("state")',
      "params.done",
      'signIn("google", { redirectTo: "/queue" })',
    ])
      expect(
        READS.some((re) => re.test(ok)),
        ok,
      ).toBe(false);
  });
});

describe("Secrets at rest (re-confirmed in the M11 audit)", () => {
  it("a Gmail refresh token is only ever stored through encryptSecret()", () => {
    const writes: string[] = [];
    for (const f of ALL) {
      if (rel(f) === "src/db/schema.ts") continue;
      walk(parse(f), (n) => {
        if (
          ts.isPropertyAssignment(n) &&
          n.name.getText() === "encryptedRefreshToken" &&
          ts.isObjectLiteralExpression(n.parent)
        ) {
          writes.push(`${rel(f)} ${n.initializer.getText()}`);
        }
        if (ts.isShorthandPropertyAssignment(n) && n.name.text === "encryptedRefreshToken")
          writes.push(`${rel(f)} (shorthand)`);
      });
    }
    expect(writes).toEqual(["src/server/mailboxes.ts encryptSecret(result.refreshToken)"]);
    // Nothing writes the column through raw SQL either.
    for (const f of ALL)
      expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(/encrypted_refresh_token\s*=/);
  });

  it("the Stripe webhook signing secret is stored encrypted", () => {
    const src = readFileSync("src/server/billing.ts", "utf8");
    expect(src).toContain("const value = encryptSecret(endpoint.secret);");
    expect(src).toContain(".values({ key: WEBHOOK_SECRET_KEY, value })");
    expect(src).toContain("return row ? decryptSecret(row.value) : null;");
  });
});

/**
 * Check 31 P1: the core promise ("nothing leaves the inbox without the owner's okay") rests on
 * the only two Gmail send calls: writer.sendDraft inside sendDraft (behind canSend) and
 * writer.sendMessage inside practiceSend (to the owner only, checked by onlyToOwner). A third
 * call fails here. A new send path needs Davi's okay and a new row in SEND_SITES.
 */
describe("Only two places can send mail", () => {
  const SEND_METHODS = new Set(["sendDraft", "sendMessage"]);
  /** file → enclosing function, with the reason it may send. */
  const SEND_SITES: Array<{ site: string; why: string }> = [
    {
      site: "src/server/drafts.ts → sendDraft",
      why: "the owner's tap (or earned autopilot), behind canSend and every send check",
    },
    {
      site: "src/server/practice.ts → practiceSend",
      why: "a practice copy to the owner's own address only, checked by onlyToOwner",
    },
  ];
  /** Where the writer methods and their types are defined. */
  const DEFINED_IN = (file: string) => file.startsWith("src/mailbox/");

  /** The nearest named function around a node ("(top level)" if none). */
  function enclosingName(n: ts.Node): string {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) {
        return p.name.getText();
      }
      if (
        (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) &&
        ts.isVariableDeclaration(p.parent) &&
        ts.isIdentifier(p.parent.name)
      ) {
        return p.parent.name.text;
      }
    }
    return "(top level)";
  }

  /**
   * Every use of a writer send method in a file: `x.sendDraft`, `x?.sendMessage`,
   * `x["sendMessage"]`, and `const { sendMessage } = x` (called or not: a method passed along
   * can be called anywhere).
   */
  function sendUses(sf: ts.SourceFile): string[] {
    const out: string[] = [];
    walk(sf, (n) => {
      const hit =
        (ts.isPropertyAccessExpression(n) && SEND_METHODS.has(n.name.text)) ||
        (ts.isElementAccessExpression(n) &&
          ts.isStringLiteralLike(n.argumentExpression) &&
          SEND_METHODS.has(n.argumentExpression.text)) ||
        (ts.isBindingElement(n) && SEND_METHODS.has((n.propertyName ?? n.name).getText()));
      if (hit) out.push(enclosingName(n));
    });
    return out;
  }

  /** String literals naming a Gmail send endpoint. */
  function sendEndpoints(sf: ts.SourceFile): string[] {
    const out: string[] = [];
    walk(sf, (n) => {
      if (
        (ts.isStringLiteralLike(n) || ts.isTemplateLiteralToken(n)) &&
        /\/(messages|drafts)\/send/.test(n.text)
      ) {
        out.push(n.text);
      }
    });
    return out;
  }

  it("finds exactly the two allowed send calls in src/", () => {
    const found: string[] = [];
    for (const f of ALL) {
      const file = rel(f);
      if (DEFINED_IN(file)) continue;
      for (const fn of sendUses(parse(f))) found.push(`${file} → ${fn}`);
    }
    expect(found.sort()).toEqual(SEND_SITES.map((s) => s.site).sort());
    for (const s of SEND_SITES) expect(s.why.length, s.site).toBeGreaterThan(10);
  });

  it("names Gmail's send endpoints only in the Gmail client", () => {
    const found: string[] = [];
    for (const f of ALL) {
      const file = rel(f);
      for (const text of sendEndpoints(parse(f))) found.push(`${file}: ${text}`);
    }
    expect(found.map((x) => x.split(":")[0]).every((f) => f === "src/mailbox/gmail/api.ts")).toBe(
      true,
    );
    expect(found.length).toBeGreaterThanOrEqual(2);
  });

  it("self-test: catches the four call shapes, and the endpoint strings", () => {
    const uses = (code: string) => sendUses(parseText("fixture.ts", code));
    expect(uses("async function quickReply(obj) { await obj.sendMessage(x); }")).toEqual([
      "quickReply",
    ]);
    expect(uses("const fire = async (w) => { await w.sendDraft(id); };")).toEqual(["fire"]);
    expect(
      uses("function nudge(writer) { const { sendMessage } = writer; return sendMessage(x); }"),
    ).toEqual(["nudge"]);
    expect(uses("async function maybe(writer) { await writer?.sendDraft(id); }")).toEqual([
      "maybe",
    ]);
    expect(uses('async function odd(w) { await w["sendMessage"](x); }')).toEqual(["odd"]);
    expect(uses("const s = { sendMessage: 1 }; send(s);")).toEqual([]);
    expect(
      sendEndpoints(
        parseText("f.ts", 'fetch(base + "/messages/send"); fetch(`${b}/drafts/send`);'),
      ),
    ).toHaveLength(2);
  });
});
