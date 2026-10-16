import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { activityLog, mailboxes, workspaces } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { GMAIL_STATE_COOKIE } from "@/mailbox/gmail/oauth-state";
import { ALL_CONNECT_SCOPES, GMAIL_SCOPES } from "@/mailbox/gmail/scopes";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { recordTermsAcceptance } from "@/server/terms";
import { createTestDb } from "../support/db";

/**
 * Gmail connect asks for two scopes, gmail.readonly and gmail.compose (Davi dropped gmail.send
 * on 2026-10-15). Google's granular consent lets the owner untick either: then the callback
 * revokes what was granted and saves nothing. A grant with more than we asked for (an older
 * connection's gmail.send, which Google adds back) connects as usual.
 */

const req = vi.hoisted(() => ({
  session: null as { user: { id: string } } | null,
  cookies: new Map<string, string>(),
}));

vi.mock("@/auth", () => ({ auth: async () => req.session }));

vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  cookies: async () => ({
    get: (name: string) =>
      req.cookies.has(name) ? { name, value: req.cookies.get(name)! } : undefined,
    delete: (arg: string | { name: string }) => {
      req.cookies.delete(typeof arg === "string" ? arg : arg.name);
    },
  }),
}));

// The background sync isn't under test; it never runs here.
vi.mock("@/jobs/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/jobs/client")>()),
  enqueue: async () => {},
}));

const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

let database: Database;
let workspaceId: string;
/** What Google's token answer says was granted, and every call made to "Google". */
let granted: string[];
let google: { url: string; body: string }[];

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AUTH_GOOGLE_ID = "client-id";
  process.env.AUTH_GOOGLE_SECRET = "client-secret";
  database = await createTestDb();
  const { user, workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  await recordTermsAcceptance(user.id);
  workspaceId = workspace.id;
  req.session = { user: { id: user.id } };
  req.cookies = new Map([[GMAIL_STATE_COOKIE, "state-123"]]);
  google = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    google.push({ url, body: String(init?.body ?? "") });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url === TOKEN_URL)
      return json({ access_token: "at-new", refresh_token: "rt-new", scope: granted.join(" ") });
    if (url === USERINFO_URL) return json({ email: "owner@shop.com", email_verified: true });
    if (url === REVOKE_URL) return new Response(null, { status: 200 });
    return new Response(null, { status: 404 });
  });
});

afterEach(() => vi.unstubAllGlobals());

async function callback() {
  const { GET } = await import("@/app/api/gmail/callback/route");
  const res = await GET(
    new NextRequest("http://localhost/api/gmail/callback?state=state-123&code=c"),
  );
  expect(res.status).toBe(303);
  const to = new URL(res.headers.get("location")!);
  return to.pathname + to.search;
}

const statusOf = async () =>
  (await database.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0]!.status;

describe("Gmail connect callback: the two scopes", () => {
  for (const missing of [GMAIL_SCOPES.compose, GMAIL_SCOPES.readonly]) {
    it(`GUARDRAIL: ${missing.replace(/^.*\//, "")} unticked → revoked, nothing saved`, async () => {
      granted = ALL_CONNECT_SCOPES.filter((s) => s !== missing);
      expect(await callback()).toBe("/connect?error=scopes");
      expect(await database.select().from(mailboxes)).toEqual([]);
      expect(await database.select().from(activityLog)).toEqual([]);
      // The trial clock doesn't start: nothing was connected.
      expect(await statusOf()).toBe("invited");
      expect(google.map((c) => c.url)).toEqual([TOKEN_URL, REVOKE_URL]);
      expect(google[1]!.body).toBe("token=rt-new");
    });
  }

  it("GUARDRAIL: gmail.send can't stand in for gmail.compose", async () => {
    granted = [...ALL_CONNECT_SCOPES.filter((s) => s !== GMAIL_SCOPES.compose), GMAIL_SEND];
    expect(await callback()).toBe("/connect?error=scopes");
    expect(await database.select().from(mailboxes)).toEqual([]);
    expect(google.map((c) => c.url)).toEqual([TOKEN_URL, REVOKE_URL]);
  });

  it("a reconnect with a permission unticked leaves the saved mailbox exactly as it was", async () => {
    const [w] = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    await saveConnectedMailbox(w!, {
      email: "owner@shop.com",
      refreshToken: "rt-old",
      grantedScopes: ALL_CONNECT_SCOPES,
    });
    const [before] = await database.select().from(mailboxes);
    granted = ALL_CONNECT_SCOPES.filter((s) => s !== GMAIL_SCOPES.compose);
    expect(await callback()).toBe("/connect?error=scopes");
    const [after] = await database.select().from(mailboxes);
    expect(after).toEqual(before);
    expect(decryptSecret(after!.encryptedRefreshToken)).toBe("rt-old");
  });

  it("both scopes → connected; an extra gmail.send from an older connection is fine", async () => {
    for (const extra of [[], [GMAIL_SEND]]) {
      await database.delete(mailboxes);
      google = [];
      req.cookies.set(GMAIL_STATE_COOKIE, "state-123");
      granted = [...ALL_CONNECT_SCOPES, ...extra];
      expect(await callback()).toBe("/welcome/profile");
      const [row] = await database.select().from(mailboxes);
      expect(row?.email).toBe("owner@shop.com");
      expect(row?.status).toBe("active");
      expect(row?.scopes).toBe(granted.join(" "));
      expect(decryptSecret(row!.encryptedRefreshToken)).toBe("rt-new");
      expect(google.map((c) => c.url)).toEqual([TOKEN_URL, USERINFO_URL]);
      expect(await statusOf()).toBe("evaluating");
    }
  });
});
