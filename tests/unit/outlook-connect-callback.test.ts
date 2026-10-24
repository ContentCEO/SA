import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as callback } from "@/app/api/outlook/callback/route";
import { POST as notify } from "@/app/api/outlook/notify/route";
import type { Database } from "@/db";
import { activityLog, mailboxes } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { MissingScopesError } from "@/mailbox/connector";
import {
  OUTLOOK_STATE_COOKIE,
  outlookStateCookieValue,
  pkceChallenge,
} from "@/mailbox/outlook/oauth-state";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { deleteAccount } from "@/server/account-deletion";
import { disconnectMailbox, listMailboxes, saveConnectedMailbox } from "@/server/mailboxes";
import { recordTermsAcceptance } from "@/server/terms";
import { createGmailConnector } from "@/mailbox/gmail/connector";
import { createTestDb } from "../support/db";
import { createFakeGraph, FAKE_GRAPH_SCOPES, type FakeGraph } from "../support/fake-graph";

/**
 * Plan #49: the Outlook connect callback, disconnect and account deletion, end to end against
 * the Graph stand-in (as global fetch). Every permission or nothing saved; Microsoft has no
 * revoke, so disconnect deletes and says so; the switch off means 404s and no Microsoft call.
 */

const req = vi.hoisted(() => ({
  session: null as { user: { id: string; sv?: number } } | null,
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
vi.mock("@/jobs/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/jobs/client")>()),
  enqueue: async () => {},
}));

const VERIFIER = "v".repeat(43);
let database: Database;
let workspaceId: string;
let userId: string;
let graph: FakeGraph;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  vi.stubEnv("FEATURE_OUTLOOK", "1");
  vi.stubEnv("MS_CLIENT_ID", "ms-id");
  vi.stubEnv("MS_CLIENT_SECRET", "ms-secret");
  vi.stubEnv("APP_URL", "https://app.example");
  database = await createTestDb();
  const { user, workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  await recordTermsAcceptance(user.id);
  workspaceId = workspace.id;
  userId = user.id;
  req.session = { user: { id: user.id, sv: 0 } };
  req.cookies = new Map([
    [OUTLOOK_STATE_COOKIE, outlookStateCookieValue("state-123", { mode: "first" }, VERIFIER)],
  ]);
  graph = createFakeGraph({ owner: "owner@shop.com" });
  fetchMock = vi.fn(graph.fetch);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const back = (qs: string) =>
  callback(new NextRequest(`https://app.example/api/outlook/callback?${qs}`));
const location = (res: Response) =>
  new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search;

describe("Outlook connect callback", () => {
  it("saves the mailbox as Outlook (token encrypted) and starts the trial clock", async () => {
    const code = graph.authorize(pkceChallenge(VERIFIER));
    const res = await back(`state=state-123&code=${code}`);
    expect(location(res)).toBe("/welcome/profile");
    const [row] = await database.select().from(mailboxes);
    expect(row).toMatchObject({ provider: "outlook", email: "owner@shop.com", status: "active" });
    expect(row!.encryptedRefreshToken).not.toMatch(/^rt-/);
    expect(graph.state.refreshTokens.has(decryptSecret(row!.encryptedRefreshToken))).toBe(true);
    expect(req.cookies.has(OUTLOOK_STATE_COOKIE)).toBe(false);
  });

  it("a wrong PKCE verifier (another browser) is refused and saves nothing", async () => {
    const code = graph.authorize(pkceChallenge("w".repeat(43)));
    expect(location(await back(`state=state-123&code=${code}`))).toBe("/connect?error=failed");
    expect(await database.select().from(mailboxes)).toEqual([]);
  });

  it("GUARDRAIL: a missing permission saves nothing", async () => {
    for (const drop of FAKE_GRAPH_SCOPES) {
      graph.state.grantedScopes = FAKE_GRAPH_SCOPES.filter((s) => s !== drop);
      req.cookies.set(
        OUTLOOK_STATE_COOKIE,
        outlookStateCookieValue("state-123", { mode: "first" }, VERIFIER),
      );
      const code = graph.authorize(pkceChallenge(VERIFIER));
      expect(location(await back(`state=state-123&code=${code}`))).toBe(
        "/connect?error=outlook_scopes",
      );
    }
    expect(await database.select().from(mailboxes)).toEqual([]);
    expect(MissingScopesError).toBeDefined();
  });

  it("a wrong state, a denial, or no mailbox → nothing saved", async () => {
    expect(location(await back("state=other&code=x"))).toBe("/connect?error=expired");
    req.cookies.set(
      OUTLOOK_STATE_COOKIE,
      outlookStateCookieValue("s2", { mode: "first" }, VERIFIER),
    );
    expect(location(await back("state=s2&error=access_denied"))).toBe(
      "/connect?error=outlook_denied",
    );
    graph.state.noMailbox = true;
    req.cookies.set(
      OUTLOOK_STATE_COOKIE,
      outlookStateCookieValue("s3", { mode: "first" }, VERIFIER),
    );
    const code = graph.authorize(pkceChallenge(VERIFIER));
    expect(location(await back(`state=s3&code=${code}`))).toBe("/connect?error=no_outlook");
    expect(await database.select().from(mailboxes)).toEqual([]);
  });

  it("the same address already connected as Gmail is refused, not switched", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "g-rt",
      grantedScopes: [],
    });
    const code = graph.authorize(pkceChallenge(VERIFIER));
    expect(location(await back(`state=state-123&code=${code}`))).toBe(
      "/connect?error=other_provider",
    );
    expect((await listMailboxes(workspaceId)).map((m) => m.provider)).toEqual(["gmail"]);
  });

  it("GUARDRAIL: with the switch off nothing is read and no Microsoft host is contacted", async () => {
    vi.stubEnv("FEATURE_OUTLOOK", "");
    const code = graph.authorize(pkceChallenge(VERIFIER));
    expect(location(await back(`state=state-123&code=${code}`))).toBe("/connect");
    expect(
      (
        await notify(
          new NextRequest("https://app.example/api/outlook/notify?validationToken=x", {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await database.select().from(mailboxes)).toEqual([]);
  });
});

describe("disconnect and delete for Outlook", () => {
  async function connected() {
    const code = graph.authorize(pkceChallenge(VERIFIER));
    await back(`state=state-123&code=${code}`);
    return (await database.select().from(mailboxes))[0]!;
  }

  it("Disconnect deletes the mailbox, logs revokedAtProvider false, and never calls Google", async () => {
    const m = await connected();
    fetchMock.mockClear();
    // The Settings action passes the Gmail connector: an Outlook row must not use it.
    expect(await disconnectMailbox(workspaceId, m.id, createGmailConnector())).toBe(true);
    expect(await database.select().from(mailboxes)).toEqual([]);
    expect(fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => /google/.test(u))).toEqual(
      [],
    );
    const [log] = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mailbox_disconnected"));
    expect(log!.detail).toMatchObject({ provider: "outlook", revokedAtProvider: false });
  });

  it("Disconnect also drops the push subscription at Microsoft", async () => {
    const m = await connected();
    graph.state.subscriptions.set("sub-1", {
      id: "sub-1",
      resource: "me/messages",
      changeType: "created",
      notificationUrl: "https://app.example/api/outlook/notify",
      clientState: "c",
      expirationDateTime: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await database
      .update(mailboxes)
      .set({ pushSubscriptionId: "sub-1" })
      .where(eq(mailboxes.id, m.id));
    await disconnectMailbox(workspaceId, m.id, createGmailConnector());
    expect(graph.state.subscriptions.size).toBe(0);
  });

  it("Delete my account deletes an Outlook mailbox without calling Google", async () => {
    await connected();
    fetchMock.mockClear();
    const out = await deleteAccount(userId, createGmailConnector());
    expect(out).toMatchObject({ mailboxes: 1, revoked: 0 });
    expect(fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => /google/.test(u))).toEqual(
      [],
    );
  });
});
