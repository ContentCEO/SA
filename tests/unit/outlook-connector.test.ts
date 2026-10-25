import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MissingScopesError,
  NoOutlookMailboxError,
  ProviderCannotRevokeError,
} from "@/mailbox/connector";
import { addressFromMe, createOutlookConnector } from "@/mailbox/outlook/connector";
import {
  newPkceVerifier,
  outlookStateCookieValue,
  parseOutlookStateCookie,
  pkceChallenge,
} from "@/mailbox/outlook/oauth-state";
import { missingOutlookScopes, REQUIRED_OUTLOOK_SCOPES } from "@/mailbox/outlook/scopes";

/** Plan #49: connecting Outlook (the `<provider>-connector` half of SETUP §8b's shared tests). */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.stubEnv("FEATURE_OUTLOOK", "1");
  vi.stubEnv("MS_CLIENT_ID", "ms-id");
  vi.stubEnv("MS_CLIENT_SECRET", "ms-secret");
});
afterEach(() => vi.unstubAllEnvs());

const GRANTED =
  "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read";

describe("Outlook consent link", () => {
  it("asks for exactly the four permissions, with PKCE and fresh consent", () => {
    const url = new URL(
      createOutlookConnector().authorizationUrl({
        state: "st",
        redirectUri: "https://app.example/api/outlook/callback",
        loginHint: "o@shop.com",
        codeChallenge: "ch",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("scope")!.split(" ").sort()).toEqual(
      ["Mail.ReadWrite", "Mail.Send", "User.Read", "offline_access"].sort(),
    );
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe("ms-id");
    expect(url.searchParams.get("login_hint")).toBe("o@shop.com");
    expect(url.searchParams.get("state")).toBe("st");
  });

  it("adding another inbox shows Microsoft's account chooser", () => {
    const url = new URL(
      createOutlookConnector().authorizationUrl({
        state: "st",
        redirectUri: "https://app.example/cb",
        prompt: "consent select_account",
        codeChallenge: "ch",
      }),
    );
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.has("login_hint")).toBe(false);
  });

  it("refuses to build a link with the switch off", () => {
    vi.stubEnv("FEATURE_OUTLOOK", "");
    expect(() =>
      createOutlookConnector().authorizationUrl({
        state: "s",
        redirectUri: "r",
        codeChallenge: "c",
      }),
    ).toThrow(/not switched on/);
  });

  it("PKCE: S256 of the verifier, carried in the state cookie with the mode", () => {
    const v = newPkceVerifier();
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    const id = "6f1c2b8e-1d2a-4c3b-9a8f-0e1d2c3b4a59";
    const cookie = outlookStateCookieValue("abc", { mode: "reconnect", mailboxId: id }, v);
    expect(parseOutlookStateCookie(cookie)).toEqual({
      state: "abc",
      connect: { mode: "reconnect", mailboxId: id },
      verifier: v,
    });
    expect(parseOutlookStateCookie("abc~first~")).toBeUndefined();
    expect(parseOutlookStateCookie(undefined)).toBeUndefined();
  });
});

describe("Outlook code exchange", () => {
  const exchange = (f: ReturnType<typeof vi.fn>) =>
    createOutlookConnector(f as unknown as typeof fetch).exchangeCode({
      code: "c",
      redirectUri: "https://app.example/api/outlook/callback",
      codeVerifier: "v".repeat(43),
    });

  it("returns the address and refresh token when every permission is granted", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: "at", refresh_token: "rt", scope: GRANTED }))
      .mockResolvedValueOnce(json({ mail: null, userPrincipalName: "Owner@Outlook.com" }))
      .mockResolvedValueOnce(json({ id: "inbox-id" }));
    await expect(exchange(f)).resolves.toEqual({
      email: "owner@outlook.com",
      refreshToken: "rt",
      grantedScopes: GRANTED.split(" "),
    });
    const body = String(f.mock.calls[0]![1].body);
    expect(body).toContain("code_verifier=" + "v".repeat(43));
    expect(body).toContain("grant_type=authorization_code");
    for (const [, init] of f.mock.calls.slice(1))
      expect(init.headers.prefer).toBe('IdType="ImmutableId"');
  });

  it("GUARDRAIL: refuses and saves nothing when a permission is missing", async () => {
    for (const scope of [
      "Mail.ReadWrite User.Read",
      "Mail.Send User.Read",
      "Mail.ReadWrite Mail.Send",
      "Mail.Read Mail.Send User.Read",
    ]) {
      const f = vi
        .fn()
        .mockResolvedValueOnce(json({ access_token: "at", refresh_token: "rt", scope }));
      await expect(exchange(f)).rejects.toBeInstanceOf(MissingScopesError);
      // No profile read, nothing else: the tokens are dropped.
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it("no refresh token = offline_access missing", async () => {
    const f = vi.fn().mockResolvedValueOnce(json({ access_token: "at", scope: GRANTED }));
    await expect(exchange(f)).rejects.toMatchObject({ missing: ["offline_access"] });
  });

  it("a Microsoft account with no mailbox Graph can reach → NoOutlookMailboxError", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: "at", refresh_token: "rt", scope: GRANTED }))
      .mockResolvedValueOnce(json({ mail: "o@shop.com" }))
      .mockResolvedValueOnce(json({ error: { code: "MailboxNotEnabledForRESTAPI" } }, 404));
    await expect(exchange(f)).rejects.toBeInstanceOf(NoOutlookMailboxError);
  });

  it("revoke: Microsoft has none, so it says so (Disconnect deletes anyway)", async () => {
    await expect(createOutlookConnector().revoke("rt")).rejects.toBeInstanceOf(
      ProviderCannotRevokeError,
    );
  });
});

describe("Outlook scopes", () => {
  it("are exactly the four the plan names", () => {
    expect([...REQUIRED_OUTLOOK_SCOPES].sort()).toEqual(
      ["Mail.ReadWrite", "Mail.Send", "User.Read", "offline_access"].sort(),
    );
  });
  it("reads granted scopes with or without the Graph prefix, any case", () => {
    expect(missingOutlookScopes(["mail.readwrite", "MAIL.SEND", "user.read"], true)).toEqual([]);
    expect(missingOutlookScopes(GRANTED.split(" "), false)).toEqual(["offline_access"]);
    expect(missingOutlookScopes([...GRANTED.split(" "), "offline_access"], false)).toEqual([]);
    expect(missingOutlookScopes([], true)).toEqual(["Mail.ReadWrite", "Mail.Send", "User.Read"]);
  });
  it("the address comes from mail, else the sign-in name", () => {
    expect(addressFromMe({ mail: "A@B.com", userPrincipalName: "x@y.com" })).toBe("a@b.com");
    expect(addressFromMe({ mail: null, userPrincipalName: "x@y.com" })).toBe("x@y.com");
    expect(addressFromMe({ mail: "", userPrincipalName: "not an address" })).toBeNull();
  });
});
