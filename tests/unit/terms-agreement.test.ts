import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGREE_REQUIRED_MESSAGE,
  REQUEST_PATH_HEADER,
  TERMS_COOKIE,
  TERMS_COOKIE_MAX_AGE_SECONDS,
  TERMS_COOKIE_PATH,
  TERMS_REQUIRED_API_MESSAGE,
  TERMS_VERSION,
} from "@/config/legal";
import type { Database } from "@/db";
import { rateLimits, users, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  agreed,
  cookieAgreesToCurrent,
  hasCurrentTerms,
  requestPathOf,
  safeNextPath,
  termsScreenCopy,
} from "@/server/terms-rules";
import { createTestDb } from "../support/db";

/**
 * The "I agree" boxes (Davi, 2026-10-15): sign-in refuses without the box (on the server), the
 * acceptance is recorded per user with its version, and every signed-in screen, action and API
 * route asks for the current version — screens by redirect, API routes with a 403.
 */

// --- Request stand-ins: who's signed in, the cookie jar, the proxy's header -------------------

const req = vi.hoisted(() => ({
  session: null as { user: { id: string; email?: string } } | null,
  cookies: new Map<string, string>(),
  set: [] as { name: string; value: string; options: Record<string, unknown> }[],
  deleted: [] as unknown[],
  path: null as string | null,
  signIn: [] as unknown[][],
}));

vi.mock("@/auth", () => ({
  auth: async () => req.session,
  signIn: async (...args: unknown[]) => {
    req.signIn.push(args);
  },
  signOut: async () => {},
}));

vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  cookies: async () => ({
    get: (name: string) =>
      req.cookies.has(name) ? { name, value: req.cookies.get(name)! } : undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      req.set.push({ name, value, options });
      req.cookies.set(name, value);
    },
    delete: (arg: string | { name: string }) => {
      req.deleted.push(arg);
      req.cookies.delete(typeof arg === "string" ? arg : arg.name);
    },
  }),
  headers: async () => new Headers(req.path ? { [REQUEST_PATH_HEADER]: req.path } : {}),
}));

class Redirected extends Error {
  constructor(readonly url: string) {
    super("redirect");
  }
}
class NotFound extends Error {}
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Redirected(url);
  },
  notFound: () => {
    throw new NotFound("not found");
  },
}));

const whereTo = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (err) {
    if (err instanceof Redirected) return err.url;
    throw err;
  }
  return null;
};

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

// --- The pure rules ---------------------------------------------------------------------------

describe("TERMS_VERSION", () => {
  /** "October 15, 2026" → "2026-10-15". */
  const iso = (file: string) => {
    const text = readFileSync(`docs/${file}`, "utf8").match(/_Last updated: ([^_]+)_/)?.[1];
    expect(text, file).toBeTruthy();
    const d = new Date(`${text} 12:00 UTC`);
    return d.toISOString().slice(0, 10);
  };

  it("is the terms' 'Last updated' date (and the privacy policy's, which matches it)", () => {
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(iso("terms.md")).toBe(TERMS_VERSION);
    expect(iso("privacy-policy.md")).toBe(TERMS_VERSION);
  });
});

describe("rules", () => {
  it("only the current version counts as agreed", () => {
    expect(hasCurrentTerms({ termsVersion: TERMS_VERSION })).toBe(true);
    expect(hasCurrentTerms({ termsVersion: "2026-01-01" })).toBe(false);
    expect(hasCurrentTerms({ termsVersion: null })).toBe(false);
    expect(hasCurrentTerms(null)).toBe(false);
    expect(cookieAgreesToCurrent(TERMS_VERSION)).toBe(true);
    expect(cookieAgreesToCurrent("2026-01-01")).toBe(false);
    expect(cookieAgreesToCurrent(undefined)).toBe(false);
  });

  it("the box counts only with our exact value (a missing box sends nothing)", () => {
    expect(agreed("yes")).toBe(true);
    for (const v of [null, undefined, "", "on", "true", "YES"])
      expect(agreed(v), String(v)).toBe(false);
  });

  it("safeNextPath keeps paths on this site and sends everything else to the queue", () => {
    for (const ok of [
      "/queue",
      "/queue?t=0b6c1f0e-1d7e-4a43-9a8f-2f7e6c1d2a3b",
      "/settings/profile",
      "/customers/abc?x=1&y=2",
      "/admin",
    ])
      expect(safeNextPath(ok), ok).toBe(ok);
    expect(safeNextPath("/queue#t-1")).toBe("/queue");
    expect(safeNextPath("/a/../settings")).toBe("/settings");
    for (const bad of [
      undefined,
      null,
      42,
      ["/queue"],
      "",
      "queue",
      "//evil.example",
      "//evil.example/queue",
      "/\\evil.example",
      "/\\/evil.example",
      "https://evil.example/queue",
      "javascript:alert(1)",
      "/queue\nLocation: https://evil.example",
      "/queue\tx",
      "/ /evil.example",
      "/welcome/terms",
      "/welcome/terms?next=/queue",
      "/api/badge",
      "/api",
      `/${"a".repeat(1000)}`,
    ])
      expect(safeNextPath(bad), JSON.stringify(bad)).toBe("/queue");
  });

  it("an encoded line break stays encoded: a (missing) page of ours, never a header", () => {
    expect(safeNextPath("/%0d%0aSet-Cookie:x")).toBe("/%0d%0aSet-Cookie:x");
    expect(safeNextPath("/%0d%0aSet-Cookie:x")).not.toMatch(/[\r\n]/);
  });

  it("the proxy's path drops Next's _rsc marker and keeps the rest", () => {
    expect(requestPathOf("/queue", "")).toBe("/queue");
    expect(requestPathOf("/queue", "?t=abc&_rsc=xyz")).toBe("/queue?t=abc");
    expect(requestPathOf("/inbox", "?_rsc=1")).toBe("/inbox");
  });

  it("first-time and updated wording", () => {
    expect(termsScreenCopy({ termsVersion: null }).heavy).toBe("the fine print.");
    expect(termsScreenCopy({ termsVersion: "2026-01-01" })).toMatchObject({
      serif: "we've updated",
      heavy: "our terms.",
    });
  });
});

describe("the proxy", () => {
  it("runs on every signed-in screen folder, and on /welcome", async () => {
    const { config } = await import("@/proxy");
    const app = join("src", "app", "(app)");
    const folders = readdirSync(app).filter((f) => statSync(join(app, f)).isDirectory());
    expect(folders.length).toBeGreaterThanOrEqual(12);
    const matched = new Set(config.matcher.map((m) => m.replace(/^\/([^/]+)\/:path\*$/, "$1")));
    for (const f of folders) expect(matched.has(f), f).toBe(true);
    expect(matched.has("welcome")).toBe(true);
    // Never the API, the Auth.js routes, or the public pages.
    for (const m of config.matcher) expect(m).not.toMatch(/^\/(api|terms|privacy|signin|_next)/);
  });

  it("always overwrites the path header with what was really asked for", async () => {
    const { proxy } = await import("@/proxy");
    const res = proxy(
      new NextRequest("http://localhost/queue?t=abc&_rsc=1", {
        headers: { [REQUEST_PATH_HEADER]: "//evil.example" },
      }),
    );
    expect(res.headers.get(`x-middleware-request-${REQUEST_PATH_HEADER}`)).toBe("/queue?t=abc");
  });
});

// --- With a database ------------------------------------------------------------------------

let database: Database;
let owner: { id: string; email: string };
let workspaceId: string;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
  const made = await ensureUserAndWorkspace({ email: "owner@shop.com", name: "Owner" });
  owner = { id: made.user.id, email: made.user.email };
  workspaceId = made.workspace.id;
  req.session = { user: { id: owner.id, email: owner.email } };
  req.cookies.clear();
  req.set.length = 0;
  req.deleted.length = 0;
  req.path = null;
  req.signIn.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const termsRow = async (id = owner.id) => {
  const [row] = await database
    .select({ at: users.termsAcceptedAt, version: users.termsVersion })
    .from(users)
    .where(eq(users.id, id));
  return row!;
};
const accept = async (version = TERMS_VERSION, id = owner.id) =>
  database
    .update(users)
    .set({ termsAcceptedAt: new Date(), termsVersion: version })
    .where(eq(users.id, id));

describe("sign-in", () => {
  it("GUARDRAIL: without the box the server refuses: no cookie, no Google", async () => {
    const { signInWithGoogleAction } = await import("@/app/signin/actions");
    req.session = null;
    for (const fd of [form({}), form({ agree: "on" }), form({ agree: "" })]) {
      expect(await signInWithGoogleAction({}, fd)).toEqual({ error: AGREE_REQUIRED_MESSAGE });
    }
    expect(req.set).toEqual([]);
    expect(req.signIn).toEqual([]);
  });

  it("with the box: a short-lived httpOnly, SameSite=Lax cookie with the version, then Google", async () => {
    const { signInWithGoogleAction } = await import("@/app/signin/actions");
    req.session = null;
    await signInWithGoogleAction({}, form({ agree: "yes" }));
    expect(req.set).toEqual([
      {
        name: TERMS_COOKIE,
        value: TERMS_VERSION,
        options: expect.objectContaining({
          httpOnly: true,
          sameSite: "lax",
          path: TERMS_COOKIE_PATH,
          maxAge: TERMS_COOKIE_MAX_AGE_SECONDS,
        }),
      },
    ]);
    expect(TERMS_COOKIE_MAX_AGE_SECONDS).toBeLessThanOrEqual(15 * 60);
    expect(req.signIn).toEqual([["google", { redirectTo: "/queue" }]]);
  });

  it("Google's callback records the acceptance from the cookie, and deletes the cookie", async () => {
    const { takeSignInAgreement } = await import("@/server/terms");
    req.cookies.set(TERMS_COOKIE, TERMS_VERSION);
    const before = Date.now();
    expect(await takeSignInAgreement(owner.id)).toBe(true);
    const row = await termsRow();
    expect(row.version).toBe(TERMS_VERSION);
    expect(row.at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(req.deleted).toEqual([{ name: TERMS_COOKIE, path: TERMS_COOKIE_PATH }]);
  });

  it("no cookie, or one for another version: nothing recorded (the first screen asks)", async () => {
    const { takeSignInAgreement } = await import("@/server/terms");
    expect(await takeSignInAgreement(owner.id)).toBe(false);
    req.cookies.set(TERMS_COOKIE, "2020-01-01");
    expect(await takeSignInAgreement(owner.id)).toBe(false);
    expect(await termsRow()).toEqual({ at: null, version: null });
    // The stale one is deleted all the same.
    expect(req.deleted).toHaveLength(1);
  });

  it("the Auth.js callback calls it on sign-in", () => {
    const src = readFileSync("src/auth.ts", "utf8");
    expect(src).toContain("await takeSignInAgreement(user.id);");
  });
});

describe("signed-in screens and actions", () => {
  it("GUARDRAIL: requireOwner sends someone who hasn't agreed to /welcome/terms, back to where they were going", async () => {
    const { requireOwner } = await import("@/server/session");
    req.path = "/queue?t=abc";
    expect(await whereTo(requireOwner)).toBe(
      `/welcome/terms?next=${encodeURIComponent("/queue?t=abc")}`,
    );
    // An old version is the same as none.
    await accept("2020-01-01");
    expect(await whereTo(requireOwner)).toBe(
      `/welcome/terms?next=${encodeURIComponent("/queue?t=abc")}`,
    );
    // A forged header can't point anywhere else.
    req.path = "//evil.example";
    expect(await whereTo(requireOwner)).toBe(`/welcome/terms?next=${encodeURIComponent("/queue")}`);
    await accept();
    expect(await whereTo(requireOwner)).toBeNull();
  });

  it("signed out still goes to sign-in, not the terms", async () => {
    const { requireOwner } = await import("@/server/session");
    req.session = null;
    expect(await whereTo(requireOwner)).toBe("/signin");
  });

  it("GUARDRAIL: an action stops before doing anything for someone who hasn't agreed", async () => {
    const { saveFollowupSettingsAction } = await import("@/app/(app)/settings/profile-actions");
    req.path = "/settings";
    expect(
      await whereTo(() => saveFollowupSettingsAction(form({ enabled: "on", days: "5" }))),
    ).toBe(`/welcome/terms?next=${encodeURIComponent("/settings")}`);
  });

  it("/admin: anyone else still gets a 404; Davi agrees first like everyone", async () => {
    const { requireAdmin } = await import("@/server/session");
    vi.stubEnv("ADMIN_EMAIL", "owner@shop.com");
    req.path = "/admin";
    expect(await whereTo(requireAdmin)).toBe(`/welcome/terms?next=${encodeURIComponent("/admin")}`);
    await accept();
    expect(await whereTo(requireAdmin)).toBeNull();
    vi.stubEnv("ADMIN_EMAIL", "davi@shop.com");
    await expect(requireAdmin()).rejects.toBeInstanceOf(NotFound);
  });
});

describe("/welcome/terms", () => {
  it("GUARDRAIL: Agree and continue refuses without the box, and records nothing", async () => {
    const { agreeToTermsAction } = await import("@/app/welcome/terms/actions");
    expect(await agreeToTermsAction({}, form({ next: "/inbox" }))).toEqual({
      error: AGREE_REQUIRED_MESSAGE,
    });
    expect(await termsRow()).toEqual({ at: null, version: null });
  });

  it("with the box: records the time and version, then goes back (our own paths only)", async () => {
    const { agreeToTermsAction } = await import("@/app/welcome/terms/actions");
    expect(
      await whereTo(() => agreeToTermsAction({}, form({ agree: "yes", next: "/inbox?x=1" }))),
    ).toBe("/inbox?x=1");
    expect((await termsRow()).version).toBe(TERMS_VERSION);
    expect(
      await whereTo(() =>
        agreeToTermsAction({}, form({ agree: "yes", next: "https://evil.example" })),
      ),
    ).toBe("/queue");
    expect(await whereTo(() => agreeToTermsAction({}, form({ agree: "yes" })))).toBe("/queue");
  });

  it("signed out: back to sign-in, nothing recorded", async () => {
    const { agreeToTermsAction } = await import("@/app/welcome/terms/actions");
    req.session = null;
    expect(await whereTo(() => agreeToTermsAction({}, form({ agree: "yes" })))).toBe("/signin");
  });

  it("the page lives outside the (app) layout, with the box, the button and Sign out", () => {
    const page = readFileSync("src/app/welcome/terms/page.tsx", "utf8");
    expect(page).toContain("await requireSignedIn()");
    expect(page).toContain('submitLabel="Agree and continue"');
    expect(page).toContain("<Headline serif={copy.serif} heavy={copy.heavy} />");
    expect(page).toContain("Sign out");
    const form = readFileSync("src/components/app/terms-form.tsx", "utf8");
    expect(form).toContain('href="/terms"');
    expect(form).toContain('href="/privacy"');
    // Unticked to start, and not `required`: the server's refusal is the gate.
    expect(form).not.toMatch(/defaultChecked|\brequired\b/);
    // requireSignedIn is used only by this screen.
    const users = readFileSync("src/server/session.ts", "utf8");
    expect(users).toContain("export async function requireSignedIn()");
  });
});

describe("API routes: 403, never a redirect", () => {
  const json = async (res: Response) => (await res.json()) as { error?: string };

  it("GUARDRAIL: /api/badge and /api/push/summary", async () => {
    const badge = await import("@/app/api/badge/route");
    const summary = await import("@/app/api/push/summary/route");
    for (const get of [badge.GET, summary.GET]) {
      const res = await get();
      expect(res.status).toBe(403);
      expect(await json(res)).toEqual({
        error: TERMS_REQUIRED_API_MESSAGE,
        status: "terms_required",
      });
    }
    // Refused before the poll limit is even counted.
    expect(await database.select().from(rateLimits)).toEqual([]);
    await accept();
    expect((await badge.GET()).status).toBe(200);
    req.session = null;
    expect((await badge.GET()).status).toBe(401);
  });

  it("GUARDRAIL: sending a draft through the API", async () => {
    const { POST } = await import("@/app/api/drafts/[id]/send/route");
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, workspaceId));
    const send = () =>
      POST(
        new NextRequest(`http://localhost/api/drafts/${randomUUID()}/send`, {
          method: "POST",
          headers: { origin: "http://localhost", host: "localhost" },
          body: "{}",
        }),
        { params: Promise.resolve({ id: randomUUID() }) },
      );
    const res = await send();
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({
      error: TERMS_REQUIRED_API_MESSAGE,
      status: "terms_required",
    });
    expect(await database.select().from(rateLimits)).toEqual([]);
    await accept();
    // Past the terms check: an unknown draft is a 404.
    expect((await send()).status).toBe(404);
  });

  it("GUARDRAIL: the Gmail connect callback saves nothing", async () => {
    const { GET } = await import("@/app/api/gmail/callback/route");
    const res = await GET(new NextRequest("http://localhost/api/gmail/callback?code=c&state=s"));
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({
      error: TERMS_REQUIRED_API_MESSAGE,
      status: "terms_required",
    });
  });
});

describe("Delete my account", () => {
  it("the acceptance goes with the user row", async () => {
    await accept();
    await database.delete(users).where(eq(users.id, owner.id));
    expect(await database.select().from(users)).toEqual([]);
  });
});
