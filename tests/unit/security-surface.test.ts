import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  awaitsIn,
  calleeName,
  exportedFunctions,
  type FnLike,
  isFnLike,
  localFunctions,
  otherExports,
  parse,
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

const GUARDS = new Set(["requireOwner", "requireAdmin"]);
type GuardName = "requireOwner" | "requireAdmin";
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

describe("C1: every server action checks who's asking before anything else", () => {
  /** Public on purpose: the forms anyone may use, each with its own hashed-IP limit. */
  const PUBLIC_ACTIONS: Record<string, string> = {
    "src/app/waitlist-actions.ts#joinWaitlistAction":
      "public waitlist form (honeypot + hashed-IP limit); joining never allows sign-in",
    "src/app/growth-actions.ts#requestGrowthCallAction":
      "public Book a free call form (honeypot + the same hashed-IP limit)",
  };
  /**
   * Inline "use server" blocks, by file and the exact calls they await. Any change to one of
   * them (a new call, a new block) fails until it is reviewed here.
   */
  const INLINE_ACTIONS: Record<string, string> = {
    "src/app/signin/page.tsx#signIn": "the Sign in with Google button: starts Auth.js sign-in",
    "src/app/(app)/settings/page.tsx#cookies,signOut":
      "Sign out: deletes this phone's offline cookie and signs out; must work even for a " +
      "deleted account, so it can't require one",
  };

  const actionFiles = ALL.filter((f) => startsWithUseServer(parse(f).statements));
  const exportedActions = actionFiles.flatMap((f) => {
    const sf = parse(f);
    const locals = localFunctions(sf);
    return exportedFunctions(sf).map(({ name, fn }) => ({
      id: `${rel(f)}#${name}`,
      admin: f.startsWith(ADMIN + "/"),
      guard: guardOf(fn, locals),
      guarded: guardedFirst(fn, locals),
    }));
  });

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
      .filter((a) => a.guarded && a.guard !== (a.admin ? "requireAdmin" : "requireOwner"))
      .map((a) => `${a.id} → ${a.guard}`);
    expect(wrong).toEqual([]);
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
    const pages = ALL.filter((f) => f.startsWith(ADMIN) && f.endsWith("page.tsx"));
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
    ];
    const loadings = ALL.filter((f) => /\/loading\.tsx$/.test(f));
    for (const dir of mustNotFound) {
      expect(existsSync(join(dir, "page.tsx")), rel(dir)).toBe(true);
      // Inside it…
      expect(loadings.filter((l) => l.startsWith(dir + "/")).map(rel), rel(dir)).toEqual([]);
      // …and in any folder above it, which would wrap it too.
      for (let up = dirname(dir); up.startsWith(APP); up = dirname(up)) {
        expect(existsSync(join(up, "loading.tsx")), rel(up)).toBe(false);
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
    | "e2e-hook" // local e2e only: 404 unless e2e mode + loopback host + secret
    | "authjs" // Auth.js's own handlers
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
    "src/app/app-icon/[size]/route.tsx": "public",
  };
  const routeFiles = ALL.filter((f) => f.startsWith(APP) && /\/route\.tsx?$/.test(f)).map(rel);

  it("no route without a row, no row without a route", () => {
    expect(routeFiles.sort()).toEqual(Object.keys(ROUTES).sort());
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
          expect(src).toContain("if (!isLoopbackHostname(hostname)) return notFound();");
          expect(src).toContain('secretMatches(secret, request.headers.get("x-e2e-hook-secret"))');
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

describe("C4: no open redirects", () => {
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

  it("no file reads a redirect-target query parameter", () => {
    const hits = ALL.flatMap((f) => {
      const text = readFileSync(f, "utf8");
      return [
        ...READS.filter((re) => re.test(text)).map((re) => `${rel(f)} ${re}`),
        ...destructuredReads(parse(f)).map((d) => `${rel(f)} { ${d} }`),
      ];
    });
    expect(hits).toEqual([]);
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
      'const returnTo = z.enum(["/settings?done=profile", "/welcome/learning"]);',
    );
    expect(src).toContain(
      'redirect(returnTo.catch("/settings?done=profile").parse(raw.returnTo));',
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
