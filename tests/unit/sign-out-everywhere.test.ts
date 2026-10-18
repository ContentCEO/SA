import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { activityLog, users, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace, signOutEverywhere } from "@/server/accounts";
import { describeActivity } from "@/server/activity";
import { recordTermsAcceptance } from "@/server/terms";
import { createTestDb } from "../support/db";

/**
 * Check 26 P3: every sign-in carries the account's session version (`sv`). "Sign out of every
 * phone and computer" (the owner) and "Sign them out everywhere" (Davi's admin move) move it on,
 * and a sign-in at any other version — or with none — gets what a signed-out visitor gets:
 * /signin for screens and actions, 401 for API routes.
 */

const ADMIN = "davi@example.com";
const req = vi.hoisted(() => ({
  session: null as { user: { id: string; email?: string; sv?: number } } | null,
  signOut: [] as unknown[],
}));

vi.mock("@/auth", () => ({
  auth: async () => req.session,
  signOut: async (opts: unknown) => {
    req.signOut.push(opts);
  },
}));
vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  cookies: async () => ({ get: () => undefined, delete: () => {} }),
  headers: async () => new Headers(),
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

const { requireAdmin, requireOwner, requireSignedIn } = await import("@/server/session");
const { GET: badgeGET } = await import("@/app/api/badge/route");
const { GET: summaryGET } = await import("@/app/api/push/summary/route");
const { POST: sendPOST } = await import("@/app/api/drafts/[id]/send/route");
const { signOutEverywhereAction } = await import("@/app/(app)/settings/actions");
const { adminMoveAction } = await import("@/app/(app)/admin/actions");

const outcome = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (err) {
    if (err instanceof Redirected) return `redirect ${err.url}`;
    if (err instanceof NotFound) return "404";
    throw err;
  }
  return "ok";
};
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const sendRequest = () =>
  sendPOST(
    new NextRequest("https://app.example/api/drafts/00000000-0000-4000-8000-000000000000/send", {
      method: "POST",
      headers: { origin: "https://app.example", host: "app.example" },
    }),
    { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }) },
  );
const versionOf = async (id: string) =>
  (await database.select().from(users).where(eq(users.id, id)))[0]!.sessionVersion;

let database: Database;
let owner: { id: string; email: string; workspaceId: string };
let admin: { id: string; email: string; workspaceId: string };

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.ADMIN_EMAIL = ADMIN;
  database = await createTestDb();
  const o = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  const a = await ensureUserAndWorkspace({ email: ADMIN });
  await recordTermsAcceptance(o.user.id);
  await recordTermsAcceptance(a.user.id);
  owner = { id: o.user.id, email: o.user.email, workspaceId: o.workspace.id };
  admin = { id: a.user.id, email: a.user.email, workspaceId: a.workspace.id };
  await database.update(workspaces).set({ status: "active" });
  req.session = { user: { id: owner.id, email: owner.email, sv: 0 } };
  req.signOut.length = 0;
});

describe("a sign-in at the account's current version", () => {
  it("is let in everywhere", async () => {
    expect(await outcome(requireOwner)).toBe("ok");
    expect(await outcome(requireSignedIn)).toBe("ok");
    expect((await badgeGET()).status).toBe(200);
    expect((await summaryGET()).status).toBe(200);
    // Signed in: the send route gets past the sign-in check (no such draft → 404).
    expect((await sendRequest()).status).toBe(404);
    req.session = { user: { id: admin.id, email: admin.email, sv: 0 } };
    expect(await outcome(requireAdmin)).toBe("ok");
  });
});

describe("GUARDRAIL: a sign-in from before 'Sign out everywhere', or with no version", () => {
  const stale = [
    ["an older version", 0, true],
    ["no version at all (a cookie from before session versions)", undefined, false],
    ["a newer version than the account's", 5, false],
  ] as const;

  for (const [label, sv, bump] of stale) {
    it(`${label}: screens and actions → /signin, API routes → 401`, async () => {
      if (bump) await signOutEverywhere(owner.workspaceId, "owner");
      req.session = { user: { id: owner.id, email: owner.email, sv } };
      expect(await outcome(requireOwner)).toBe("redirect /signin");
      expect(await outcome(requireSignedIn)).toBe("redirect /signin");
      expect((await badgeGET()).status).toBe(401);
      expect((await summaryGET()).status).toBe(401);
      expect((await sendRequest()).status).toBe(401);
      // An owner action is refused the same way (and changes nothing).
      expect(await outcome(signOutEverywhereAction)).toBe("redirect /signin");
      expect(req.signOut).toEqual([]);
    });
  }

  it("Davi too: requireAdmin sends an old sign-in to /signin (never locked out: he signs in again)", async () => {
    await signOutEverywhere(admin.workspaceId, "owner");
    req.session = { user: { id: admin.id, email: admin.email, sv: 0 } };
    expect(await outcome(requireAdmin)).toBe("redirect /signin");
    req.session = { user: { id: admin.id, email: admin.email, sv: 1 } };
    expect(await outcome(requireAdmin)).toBe("ok");
  });
});

describe("Sign out of every phone and computer (Settings → Account)", () => {
  it("moves the owner's version on, logs a content-free row, and signs this device out", async () => {
    expect(await versionOf(owner.id)).toBe(0);
    expect(await outcome(signOutEverywhereAction)).toBe("ok");
    expect(await versionOf(owner.id)).toBe(1);
    expect(await versionOf(admin.id)).toBe(0);
    expect(req.signOut).toEqual([{ redirectTo: "/signin?done=everywhere" }]);
    const rows = await database.select().from(activityLog);
    expect(rows.map((r) => [r.workspaceId, r.actor, r.action, r.detail])).toEqual([
      [owner.workspaceId, "owner", "signed_out_everywhere", { by: "owner" }],
    ]);
    expect(describeActivity("signed_out_everywhere", { by: "owner" }, null)).toBe(
      "You signed out on every phone and computer",
    );
    // The sign-in that tapped it is over too.
    expect(await outcome(requireOwner)).toBe("redirect /signin");
  });
});

describe("Sign them out everywhere (Davi's admin move)", () => {
  it("only works for the admin: an owner posting it gets a 404 and nothing moves", async () => {
    const f = form({ workspaceId: admin.workspaceId, move: "sign_out_everywhere" });
    expect(await outcome(() => adminMoveAction(f))).toBe("404");
    expect(await versionOf(admin.id)).toBe(0);
    expect(await database.select().from(activityLog)).toEqual([]);
  });

  it("the admin ends the owner's sign-ins; the status stays as it was", async () => {
    req.session = { user: { id: admin.id, email: admin.email, sv: 0 } };
    const f = form({ workspaceId: owner.workspaceId, move: "sign_out_everywhere" });
    expect(await outcome(() => adminMoveAction(f))).toBe(
      "redirect /admin?done=sign_out_everywhere",
    );
    expect(await versionOf(owner.id)).toBe(1);
    expect(await versionOf(admin.id)).toBe(0);
    const [w] = await database
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, owner.workspaceId));
    expect(w!.status).toBe("active");
    const rows = await database.select().from(activityLog);
    expect(rows.map((r) => [r.actor, r.action, r.detail])).toEqual([
      ["squared_away", "signed_out_everywhere", { by: "admin" }],
    ]);
    // The owner's old sign-in is refused; Davi's is untouched.
    req.session = { user: { id: owner.id, email: owner.email, sv: 0 } };
    expect(await outcome(requireOwner)).toBe("redirect /signin");
    req.session = { user: { id: admin.id, email: admin.email, sv: 0 } };
    expect(await outcome(requireAdmin)).toBe("ok");
  });
});
