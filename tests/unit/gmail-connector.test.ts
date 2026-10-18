import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissingScopesError, NoGmailError } from "@/mailbox/connector";
import { createGmailConnector } from "@/mailbox/gmail/connector";
import {
  ALL_CONNECT_SCOPES,
  GMAIL_SCOPES,
  IDENTITY_SCOPES,
  REQUIRED_GMAIL_SCOPES,
  missingScopes,
} from "@/mailbox/gmail/scopes";
import { parseStateCookie, stateCookieValue, statesMatch } from "@/mailbox/gmail/oauth-state";

const allScopes = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  ...Object.values(GMAIL_SCOPES),
];

/** Dropped on 2026-10-15; owners who connected before still carry it in their grant. */
const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";

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
      ["openid", "email", "profile", GMAIL_SCOPES.readonly, GMAIL_SCOPES.compose].sort(),
    );
    expect(scopes.some((s) => s.includes("gmail.modify") || s === "https://mail.google.com/")).toBe(
      false,
    );
    expect(scopes).not.toContain(GMAIL_SEND);
    expect(scopes.some((s) => s.includes("gmail.send"))).toBe(false);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("s");
    expect(url.searchParams.get("login_hint")).toBe("a@b.com");
  });
});

describe("which Google account (Check 42 P3)", () => {
  const url = (opts: Parameters<ReturnType<typeof createGmailConnector>["authorizationUrl"]>[0]) =>
    new URL(createGmailConnector().authorizationUrl(opts));

  it("first: hinted the sign-in address; reconnect: hinted that card's address", () => {
    const first = url({ state: "s", redirectUri: "https://x/cb", loginHint: "owner@shop.com" });
    expect(first.searchParams.get("login_hint")).toBe("owner@shop.com");
    expect(first.searchParams.get("prompt")).toBe("consent");
    const again = url({ state: "s", redirectUri: "https://x/cb", loginHint: "mike@shop.com" });
    expect(again.searchParams.get("login_hint")).toBe("mike@shop.com");
  });

  it("add: no hint, and Google's account chooser", () => {
    const add = url({ state: "s", redirectUri: "https://x/cb", prompt: "consent select_account" });
    expect(add.searchParams.has("login_hint")).toBe(false);
    expect(add.searchParams.get("prompt")).toBe("consent select_account");
    expect(add.searchParams.get("access_type")).toBe("offline");
  });

  it("the state cookie carries the mode; the state itself is still compared in constant time", () => {
    const v = stateCookieValue("abc", {
      mode: "reconnect",
      mailboxId: "7c9e1a3b-5d7f-4a9b-8c1d-2e3f4a5b6c7d",
    });
    expect(parseStateCookie(v)).toEqual({
      state: "abc",
      connect: { mode: "reconnect", mailboxId: "7c9e1a3b-5d7f-4a9b-8c1d-2e3f4a5b6c7d" },
    });
    expect(parseStateCookie(stateCookieValue("abc", { mode: "add" }))!.connect).toEqual({
      mode: "add",
    });
    // An old plain cookie, or a mailbox id that isn't one, reads as a plain first connect.
    expect(parseStateCookie("abc")).toEqual({ state: "abc", connect: { mode: "first" } });
    expect(parseStateCookie("abc~reconnect~not-a-uuid")!.connect).toEqual({ mode: "first" });
    expect(parseStateCookie(undefined)).toBeUndefined();
    expect(statesMatch(parseStateCookie(v)!.state, "abc")).toBe(true);
    expect(statesMatch(parseStateCookie(v)!.state, v)).toBe(false);
  });
});

describe("gmail code exchange", () => {
  it("returns the mailbox email and refresh token when all scopes are granted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ access_token: "at", refresh_token: "rt", scope: allScopes.join(" ") }),
      )
      .mockResolvedValueOnce(json({ emailAddress: "owner@shop.com", historyId: "1" }))
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

  it("accepts a grant that also carries gmail.send (an owner who connected before 2026-10-15)", async () => {
    const older = [...allScopes, GMAIL_SEND];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ access_token: "at", refresh_token: "rt", scope: older.join(" ") }),
      )
      .mockResolvedValueOnce(json({ emailAddress: "owner@shop.com", historyId: "1" }))
      .mockResolvedValueOnce(json({ email: "owner@shop.com", email_verified: true }));
    const result = await createGmailConnector(fetchMock).exchangeCode({
      code: "c",
      redirectUri: "https://x/cb",
    });
    expect(result).toEqual({ email: "owner@shop.com", refreshToken: "rt", grantedScopes: older });
    // No revoke: only the token exchange, the Gmail check and the userinfo lookup.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain(
      "https://oauth2.googleapis.com/revoke",
    );
  });

  it("refuses and revokes when the owner unticked either permission, even with gmail.send there", async () => {
    for (const [granted, missing] of [
      [allScopes.filter((s) => s !== GMAIL_SCOPES.compose), [GMAIL_SCOPES.compose]],
      [allScopes.filter((s) => s !== GMAIL_SCOPES.readonly), [GMAIL_SCOPES.readonly]],
      [
        ["openid", GMAIL_SEND],
        [GMAIL_SCOPES.readonly, GMAIL_SCOPES.compose],
      ],
      // The old three-scope grant with compose unticked: gmail.send can't stand in for it.
      [
        [...allScopes.filter((s) => s !== GMAIL_SCOPES.compose), GMAIL_SEND],
        [GMAIL_SCOPES.compose],
      ],
    ] as const) {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          json({ access_token: "at", refresh_token: "rt", scope: granted.join(" ") }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 200 }));
      const err = await createGmailConnector(fetchMock)
        .exchangeCode({ code: "c", redirectUri: "https://x/cb" })
        .catch((e: unknown) => e);
      expect(err, granted.join(" ")).toBeInstanceOf(MissingScopesError);
      expect((err as MissingScopesError).missing).toEqual(missing);
      // Revoked (the refresh token), and nothing else asked: no userinfo, so nothing to save.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[1]![0])).toBe("https://oauth2.googleapis.com/revoke");
      expect(String((fetchMock.mock.calls[1]![1] as RequestInit).body)).toBe("token=rt");
    }
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

describe("a Google account without Gmail (Check 47 P1)", () => {
  const exchange = (profile: Response) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ access_token: "at", refresh_token: "rt", scope: allScopes.join(" ") }),
      )
      .mockResolvedValueOnce(profile)
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const run = createGmailConnector(fetchMock)
      .exchangeCode({ code: "c", redirectUri: "https://x/cb" })
      .catch((e: unknown) => e);
    return { fetchMock, run };
  };

  it("profile 400 failedPrecondition → revoked and NoGmailError, no userinfo", async () => {
    const { fetchMock, run } = exchange(
      json(
        {
          error: {
            code: 400,
            message: "Mail service not enabled",
            errors: [{ reason: "failedPrecondition", message: "Mail service not enabled" }],
          },
        },
        400,
      ),
    );
    expect(await run).toBeInstanceOf(NoGmailError);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      "https://oauth2.googleapis.com/revoke",
    ]);
    expect(String((fetchMock.mock.calls[2]![1] as RequestInit).body)).toBe("token=rt");
  });

  it("a 400 that only says Mail service not enabled counts too", async () => {
    const { run } = exchange(json({ error: { message: "Mail service not enabled" } }, 400));
    expect(await run).toBeInstanceOf(NoGmailError);
  });

  it("profile 500 → a plain error, nothing revoked", async () => {
    const { fetchMock, run } = exchange(json({ error: { message: "Backend Error" } }, 500));
    const err = await run;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NoGmailError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

describe("where it calls (Milestone 11 e2e seam)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const LOCAL_E2E = {
    SA_E2E: "1",
    SA_E2E_GOOGLE_BASE_URL: "http://127.0.0.1:3301",
    SA_E2E_ANTHROPIC_BASE_URL: "http://127.0.0.1:3301",
    DATABASE_URL: "postgres://u@localhost/db",
  };
  const exchangeMock = () =>
    vi
      .fn()
      .mockResolvedValueOnce(
        json({ access_token: "at", refresh_token: "rt", scope: allScopes.join(" ") }),
      )
      .mockResolvedValueOnce(json({ emailAddress: "owner@shop.com", historyId: "1" }))
      .mockResolvedValueOnce(json({ email: "owner@shop.com", email_verified: true }))
      .mockResolvedValueOnce(json({}, 200));
  async function urlsCalled() {
    const fetchMock = exchangeMock();
    const c = createGmailConnector(fetchMock as unknown as typeof fetch);
    await c.exchangeCode({ code: "c", redirectUri: "https://x/cb" });
    await c.revoke("rt");
    const consent = new URL(c.authorizationUrl({ state: "s", redirectUri: "https://x/cb" }));
    return [
      ...fetchMock.mock.calls.map((call) => String(call[0])),
      consent.origin + consent.pathname,
    ];
  }

  it("GUARDRAIL: a fake base URL without SA_E2E=1 (or on Vercel) still calls the real Google", async () => {
    for (const env of [
      { SA_E2E_GOOGLE_BASE_URL: "http://127.0.0.1:3301" },
      { ...LOCAL_E2E, VERCEL_ENV: "production" },
    ]) {
      vi.unstubAllEnvs();
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      expect(await urlsCalled()).toEqual([
        "https://oauth2.googleapis.com/token",
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        "https://openidconnect.googleapis.com/v1/userinfo",
        "https://oauth2.googleapis.com/revoke",
        "https://accounts.google.com/o/oauth2/v2/auth",
      ]);
    }
  });

  it("in a local e2e run the server calls go to the fake; the consent page stays Google's", async () => {
    for (const [k, v] of Object.entries(LOCAL_E2E)) vi.stubEnv(k, v);
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("VERCEL_ENV", undefined);
    expect(await urlsCalled()).toEqual([
      "http://127.0.0.1:3301/token",
      "http://127.0.0.1:3301/gmail/v1/users/me/profile",
      "http://127.0.0.1:3301/userinfo",
      "http://127.0.0.1:3301/revoke",
      "https://accounts.google.com/o/oauth2/v2/auth",
    ]);
  });
});

describe("scopes and oauth state", () => {
  it("GUARDRAIL: asks for exactly gmail.readonly and gmail.compose (Davi, 2026-10-15)", () => {
    expect(GMAIL_SCOPES).toEqual({
      readonly: "https://www.googleapis.com/auth/gmail.readonly",
      compose: "https://www.googleapis.com/auth/gmail.compose",
    });
    expect(REQUIRED_GMAIL_SCOPES).toEqual([GMAIL_SCOPES.readonly, GMAIL_SCOPES.compose]);
    expect(ALL_CONNECT_SCOPES).toEqual([...IDENTITY_SCOPES, ...REQUIRED_GMAIL_SCOPES]);
    expect(IDENTITY_SCOPES).toEqual(["openid", "email", "profile"]);
    for (const never of [GMAIL_SEND, "gmail.modify", "https://mail.google.com/"])
      expect(
        ALL_CONNECT_SCOPES.some((s) => s.includes(never)),
        never,
      ).toBe(false);
  });

  it("GUARDRAIL: nothing in the app asks for gmail.send or reads the stored grant", () => {
    const files = readdirSync("src", { recursive: true, encoding: "utf8" })
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .map((f) => ({ f, text: readFileSync(`src/${f}`, "utf8") }));
    expect(files.length).toBeGreaterThan(50);
    // Owners who connected before 2026-10-15 still carry gmail.send; nothing may depend on it
    // (mailbox health, sending, practice copies, autopilot's lookup, the reconnect banner).
    expect(files.filter((x) => x.text.includes("auth/gmail.send")).map((x) => x.f)).toEqual([]);
    // The granted scopes are written once at connect and never read back.
    expect(
      files
        .filter((x) => /\.scopes\b|grantedScopes/.test(x.text))
        .map((x) => x.f)
        .sort(),
    ).toEqual(["mailbox/connector.ts", "mailbox/gmail/connector.ts", "server/mailboxes.ts"]);
    expect(readFileSync("src/server/mailboxes.ts", "utf8")).toContain(
      'scopes: result.grantedScopes.join(" "),',
    );
  });

  it("reports missing scopes: both are required, and anything extra is fine", () => {
    expect(missingScopes([GMAIL_SCOPES.readonly])).toEqual([GMAIL_SCOPES.compose]);
    expect(missingScopes([GMAIL_SCOPES.compose])).toEqual([GMAIL_SCOPES.readonly]);
    expect(missingScopes([])).toEqual([GMAIL_SCOPES.readonly, GMAIL_SCOPES.compose]);
    expect(missingScopes([GMAIL_SEND])).toEqual([GMAIL_SCOPES.readonly, GMAIL_SCOPES.compose]);
    expect(missingScopes([GMAIL_SCOPES.readonly, GMAIL_SEND])).toEqual([GMAIL_SCOPES.compose]);
    expect(missingScopes(Object.values(GMAIL_SCOPES))).toEqual([]);
    expect(missingScopes([...ALL_CONNECT_SCOPES, GMAIL_SEND])).toEqual([]);
    // Google spells the identity scopes its own way in the token answer: still fine.
    expect(
      missingScopes([
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        ...REQUIRED_GMAIL_SCOPES,
      ]),
    ).toEqual([]);
  });

  it("matches state only on an exact value", () => {
    expect(statesMatch("abc", "abc")).toBe(true);
    expect(statesMatch("abc", "abd")).toBe(false);
    expect(statesMatch("abc", "abcd")).toBe(false);
    expect(statesMatch(undefined, "abc")).toBe(false);
    expect(statesMatch("abc", null)).toBe(false);
  });
});
