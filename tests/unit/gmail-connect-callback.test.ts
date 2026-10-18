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
const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
/** Check 47 P1: whether the Google account has Gmail at all. */
let hasGmail: boolean;

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
  hasGmail = true;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    google.push({ url, body: String(init?.body ?? "") });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url === TOKEN_URL)
      return json({ access_token: "at-new", refresh_token: "rt-new", scope: granted.join(" ") });
    if (url === USERINFO_URL) return json({ email: "owner@shop.com", email_verified: true });
    if (url === PROFILE_URL)
      return hasGmail
        ? json({ emailAddress: "owner@shop.com", historyId: "1" })
        : new Response(
            JSON.stringify({
              error: {
                code: 400,
                message: "Mail service not enabled",
                errors: [{ reason: "failedPrecondition" }],
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
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
      expect(google.map((c) => c.url)).toEqual([TOKEN_URL, PROFILE_URL, USERINFO_URL]);
      expect(await statusOf()).toBe("evaluating");
    }
  });
});

describe("Gmail connect callback: a Google account without Gmail (Check 47 P1)", () => {
  it("GUARDRAIL: redirects to no_gmail, saves nothing, and the trial clock doesn't start", async () => {
    granted = ALL_CONNECT_SCOPES;
    hasGmail = false;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await callback()).toBe("/connect?error=no_gmail");
    expect(await database.select().from(mailboxes)).toEqual([]);
    const [w] = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(w!.status).toBe("invited");
    expect(w!.evaluationEndsAt).toBeNull();
    expect(google.map((c) => c.url)).toEqual([TOKEN_URL, PROFILE_URL, REVOKE_URL]);
    expect(google[2]!.body).toBe("token=rt-new");
    // Content-free: the kind of failure only.
    expect(errors.mock.calls).toEqual([["gmail_connect_no_mailbox", { name: "NoGmailError" }]]);
    errors.mockRestore();
  });
});

describe("Gmail connect callback: a Gmail already in another account (Check 25 P7)", () => {
  it("GUARDRAIL: redirects to in_use and saves nothing; the other account's token is not revoked", async () => {
    const other = await ensureUserAndWorkspace({ email: "spouse@shop.com" });
    await saveConnectedMailbox(other.workspace, {
      email: "owner@shop.com",
      refreshToken: "rt-theirs",
      grantedScopes: ALL_CONNECT_SCOPES,
    });
    granted = ALL_CONNECT_SCOPES;
    expect(await callback()).toBe("/connect?error=in_use");
    const rows = await database.select().from(mailboxes);
    expect(rows.map((r) => r.workspaceId)).toEqual([other.workspace.id]);
    expect(decryptSecret(rows[0]!.encryptedRefreshToken)).toBe("rt-theirs");
    expect(google.map((c) => c.url)).not.toContain(REVOKE_URL);
    expect(await statusOf()).toBe("invited");
  });
});

describe("Gmail connect callback: the Gmail the owner meant (Check 42 P3)", () => {
  const ws = async () =>
    (await database.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0]!;

  it("Connect another Gmail that comes back as the one already connected: says so, saves nothing", async () => {
    const first = await saveConnectedMailbox(await ws(), {
      email: "owner@shop.com",
      refreshToken: "rt-old",
      grantedScopes: ALL_CONNECT_SCOPES,
    });
    granted = ALL_CONNECT_SCOPES;
    req.cookies.set(GMAIL_STATE_COOKIE, "state-123~add~");
    expect(await callback()).toBe(`/connect?error=already_connected&mailbox=${first.id}`);
    const rows = await database.select().from(mailboxes);
    expect(rows).toHaveLength(1);
    expect(decryptSecret(rows[0]!.encryptedRefreshToken)).toBe("rt-old");
    expect(google.map((c) => c.url)).not.toContain(REVOKE_URL);
  });

  it("Reconnect that comes back as a different address: not saved as new, says which card it was", async () => {
    const [w] = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    await database.update(workspaces).set({ plan: "crew" }).where(eq(workspaces.id, workspaceId));
    const mike = await saveConnectedMailbox(
      { ...w!, plan: "crew" },
      { email: "mike@shop.com", refreshToken: "rt-mike", grantedScopes: ALL_CONNECT_SCOPES },
    );
    granted = ALL_CONNECT_SCOPES; // userinfo answers owner@shop.com
    req.cookies.set(GMAIL_STATE_COOKIE, `state-123~reconnect~${mike.id}`);
    expect(await callback()).toBe(`/connect?error=wrong_account&mailbox=${mike.id}`);
    expect((await database.select().from(mailboxes)).map((m) => m.email)).toEqual([
      "mike@shop.com",
    ]);
  });

  it("Reconnect that comes back as the right address saves the new token", async () => {
    const box = await saveConnectedMailbox(await ws(), {
      email: "owner@shop.com",
      refreshToken: "rt-old",
      grantedScopes: ALL_CONNECT_SCOPES,
    });
    granted = ALL_CONNECT_SCOPES;
    req.cookies.set(GMAIL_STATE_COOKIE, `state-123~reconnect~${box.id}`);
    await callback();
    const [row] = await database.select().from(mailboxes);
    expect(decryptSecret(row!.encryptedRefreshToken)).toBe("rt-new");
  });
});
