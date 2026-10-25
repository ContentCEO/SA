import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REQUEST_PATH_HEADER } from "@/config/legal";
import type { Database } from "@/db";
import { users } from "@/db/schema";
import { deleteConfirmed } from "@/server/account-deletion-rules";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { recordTermsAcceptance } from "@/server/terms";
import { createTestDb } from "../support/db";

/**
 * Check 26 P4: Delete my account (Settings, and the terms screen's way out) checks on the server
 * that the owner typed DELETE and signed in with Google in the last 15 minutes. The screen's
 * confirmation is a convenience; a direct POST without both deletes nothing.
 */

const req = vi.hoisted(() => ({
  session: null as { user: { id: string; sv?: number; sat?: number } } | null,
  path: null as string | null,
  signOut: [] as unknown[],
}));

vi.mock("@/auth", () => ({
  auth: async () => req.session,
  signOut: async (opts: unknown) => {
    req.signOut.push(opts);
  },
}));
vi.mock("@/mailbox/gmail/connector", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mailbox/gmail/connector")>()),
  createGmailConnector: () => ({ revoke: async () => {} }),
}));
vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  cookies: async () => ({ get: () => undefined, delete: () => {} }),
  headers: async () => new Headers(req.path ? { [REQUEST_PATH_HEADER]: req.path } : {}),
}));
class Redirected extends Error {
  constructor(readonly url: string) {
    super("redirect");
  }
}
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Redirected(url);
  },
}));

const { deleteAccountAction } = await import("@/app/(app)/settings/actions");
const { deleteAccountFromTermsAction } = await import("@/app/welcome/terms/actions");

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
const minutesAgo = (m: number) => Math.floor((Date.now() - m * 60_000) / 1000);

let database: Database;
let userId: string;
const userExists = async () =>
  (await database.select().from(users).where(eq(users.id, userId))).length === 1;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
  const made = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  userId = made.user.id;
  await recordTermsAcceptance(userId);
  req.session = { user: { id: userId, sv: 0, sat: minutesAgo(2) } };
  req.signOut.length = 0;
});

describe("deleteConfirmed", () => {
  it("is the word DELETE, trimmed, in any case — nothing else", () => {
    for (const yes of ["DELETE", "delete", "  Delete  "])
      expect(deleteConfirmed(yes), yes).toBe(true);
    for (const no of ["", "DELET", "DELETE ME", "yes", null, undefined, 1])
      expect(deleteConfirmed(no), String(no)).toBe(false);
  });
});

const ACTIONS = [
  ["Settings → Account", deleteAccountAction, "/settings/account", "/settings/account"],
  // The terms screen can't be a "next" (safeNextPath), so it comes back via the queue.
  ["the terms screen", deleteAccountFromTermsAction, "/welcome/terms", "/queue"],
] as const;

for (const [label, action, screen, back] of ACTIONS) {
  describe(`GUARDRAIL: Delete my account from ${label}`, () => {
    beforeEach(() => {
      req.path = screen;
    });

    it("refuses without the typed word, and deletes nothing", async () => {
      expect(await whereTo(() => action(form({})))).toBe(`${screen}?error=confirm`);
      expect(await whereTo(() => action(form({ confirm: "yes" })))).toBe(`${screen}?error=confirm`);
      expect(await userExists()).toBe(true);
      expect(req.signOut).toEqual([]);
    });

    it("refuses a sign-in older than 15 minutes (or with no sign-in time), and deletes nothing", async () => {
      for (const sat of [minutesAgo(16), undefined]) {
        req.session = { user: { id: userId, sv: 0, sat } };
        expect(await whereTo(() => action(form({ confirm: "DELETE" })))).toBe(
          `/signin?next=${encodeURIComponent(back)}&reason=recent`,
        );
      }
      expect(await userExists()).toBe(true);
    });

    it("deletes when both hold", async () => {
      req.session = { user: { id: userId, sv: 0, sat: minutesAgo(14) } };
      await action(form({ confirm: " delete " }));
      expect(await userExists()).toBe(false);
      expect(req.signOut).toEqual([{ redirectTo: "/goodbye" }]);
    });
  });
}
