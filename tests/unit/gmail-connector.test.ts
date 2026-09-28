import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissingScopesError } from "@/mailbox/connector";
import { createGmailConnector } from "@/mailbox/gmail/connector";
import { GMAIL_SCOPES, missingScopes } from "@/mailbox/gmail/scopes";
import { statesMatch } from "@/mailbox/gmail/oauth-state";

const allScopes = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  ...Object.values(GMAIL_SCOPES),
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  process.env.AUTH_GOOGLE_ID = "client-id";
  process.env.AUTH_GOOGLE_SECRET = "client-secret";
});

describe("gmail authorization url", () => {
  it("asks for exactly the minimum scopes, offline, with fresh consent", () => {
    const url = new URL(
      createGmailConnector().authorizationUrl({
        state: "s",
        redirectUri: "https://x/cb",
        loginHint: "a@b.com",
      }),
    );
    const scopes = url.searchParams.get("scope")!.split(" ");
    expect(scopes.sort()).toEqual(
      [
        "openid",
        "email",
        "profile",
        GMAIL_SCOPES.readonly,
        GMAIL_SCOPES.compose,
        GMAIL_SCOPES.send,
      ].sort(),
    );
    expect(scopes.some((s) => s.includes("gmail.modify") || s === "https://mail.google.com/")).toBe(
      false,
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("s");
    expect(url.searchParams.get("login_hint")).toBe("a@b.com");
  });
});

describe("gmail code exchange", () => {
  it("returns the mailbox email and refresh token when all scopes are granted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ access_token: "at", refresh_token: "rt", scope: allScopes.join(" ") }),
      )
      .mockResolvedValueOnce(json({ email: "Owner@Shop.com", email_verified: true }));
    const result = await createGmailConnector(fetchMock).exchangeCode({
      code: "c",
      redirectUri: "https://x/cb",
    });
    expect(result).toEqual({
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: allScopes,
    });
  });

  it("refuses and revokes when the owner unticked a permission", async () => {
    const partial = allScopes.filter((s) => s !== GMAIL_SCOPES.send);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ access_token: "at", refresh_token: "rt", scope: partial.join(" ") }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(
      createGmailConnector(fetchMock).exchangeCode({ code: "c", redirectUri: "https://x/cb" }),
    ).rejects.toBeInstanceOf(MissingScopesError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/revoke");
  });

  it("fails loudly when Google returns no refresh token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: "at", scope: allScopes.join(" ") }));
    await expect(
      createGmailConnector(fetchMock).exchangeCode({ code: "c", redirectUri: "https://x/cb" }),
    ).rejects.toThrow(/refresh token/);
  });
});

describe("gmail revoke", () => {
  it("treats an already-revoked token as success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: "invalid_token" }, 400));
    await expect(createGmailConnector(fetchMock).revoke("rt")).resolves.toBeUndefined();
  });

  it("throws on a real failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(createGmailConnector(fetchMock).revoke("rt")).rejects.toThrow();
  });
});

describe("scopes and oauth state", () => {
  it("reports missing scopes", () => {
    expect(missingScopes([GMAIL_SCOPES.readonly])).toEqual([
      GMAIL_SCOPES.compose,
      GMAIL_SCOPES.send,
    ]);
    expect(missingScopes(Object.values(GMAIL_SCOPES))).toEqual([]);
  });

  it("matches state only on an exact value", () => {
    expect(statesMatch("abc", "abc")).toBe(true);
    expect(statesMatch("abc", "abd")).toBe(false);
    expect(statesMatch("abc", "abcd")).toBe(false);
    expect(statesMatch(undefined, "abc")).toBe(false);
    expect(statesMatch("abc", null)).toBe(false);
  });
});
