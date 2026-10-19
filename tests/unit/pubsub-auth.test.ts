import { createSign, generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pushAuthorized,
  setGoogleKeysForTests,
  verifyPushToken,
  type GoogleJwk,
} from "@/server/pubsub-auth";

/**
 * Check 26 P10: Gmail push requests are checked by Pub/Sub's signed Google ID token (a locally
 * signed test JWT here, against an injected key set): signature, issuer, audience, service
 * account and expiry. The old ?token= works only while the new settings aren't set.
 */
const AUDIENCE = "https://sa.example.com/api/gmail/push";
const EMAIL = "gmail-push@sa-project.iam.gserviceaccount.com";
const NOW = new Date("2026-10-18T12:00:00Z");
const t = Math.floor(NOW.getTime() / 1000);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as GoogleJwk), kid: "k1", alg: "RS256" };
const keys = async () => [jwk];

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function sign(claims: Record<string, unknown>, { kid = "k1", key = privateKey } = {}) {
  const head = b64({ alg: "RS256", kid, typ: "JWT" });
  const body = b64({
    iss: "https://accounts.google.com",
    aud: AUDIENCE,
    email: EMAIL,
    email_verified: true,
    iat: t - 10,
    exp: t + 3600,
    ...claims,
  });
  const s = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key).toString("base64url");
  return `Bearer ${head}.${body}.${s}`;
}
const check = (auth: string | null) =>
  verifyPushToken(auth, { audience: AUDIENCE, email: EMAIL }, { keys, now: NOW });

describe("verifyPushToken", () => {
  it("a valid token from Pub/Sub's service account passes", async () => {
    expect(await check(sign({}))).toBe("ok");
    expect(await check(sign({ iss: "accounts.google.com" }))).toBe("ok");
  });
  it("GUARDRAIL: wrong audience", async () => {
    expect(await check(sign({ aud: "https://evil.example/api/gmail/push" }))).toBe(
      "wrong_audience",
    );
  });
  it("GUARDRAIL: wrong issuer", async () => {
    expect(await check(sign({ iss: "https://evil.example" }))).toBe("wrong_issuer");
  });
  it("GUARDRAIL: wrong service account (or an unverified one)", async () => {
    expect(await check(sign({ email: "someone@else.iam.gserviceaccount.com" }))).toBe(
      "wrong_email",
    );
    expect(await check(sign({ email_verified: false }))).toBe("wrong_email");
  });
  it("GUARDRAIL: expired", async () => {
    expect(await check(sign({ exp: t - 3600, iat: t - 7200 }))).toBe("expired");
  });
  it("GUARDRAIL: missing header, garbage, an unknown key or a forged signature", async () => {
    expect(await check(null)).toBe("missing");
    expect(await check("Bearer nope")).toBe("malformed");
    expect(await check(sign({}, { kid: "k9" }))).toBe("unknown_key");
    expect(await check(sign({}, { key: other.privateKey }))).toBe("bad_signature");
  });
});

describe("pushAuthorized: which way is accepted", () => {
  const req = (url: string, auth?: string) =>
    new NextRequest(url, { method: "POST", headers: auth ? { authorization: auth } : {} });
  const signed = { GMAIL_PUSH_AUDIENCE: AUDIENCE, GMAIL_PUSH_SERVICE_ACCOUNT: EMAIL };
  afterEach(() => vi.restoreAllMocks());

  it("with the new settings: only the signed token, never ?token=", async () => {
    const env = { ...signed, GMAIL_PUSH_VERIFICATION_TOKEN: "s3cret-token" };
    const opts = { keys, now: NOW };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await pushAuthorized(req(AUDIENCE, sign({})), env, opts)).toBe(true);
    expect(await pushAuthorized(req(`${AUDIENCE}?token=s3cret-token`), env, opts)).toBe(false);
  });

  it("half set up refuses everything", async () => {
    const env = { GMAIL_PUSH_AUDIENCE: AUDIENCE, GMAIL_PUSH_VERIFICATION_TOKEN: "s3cret-token" };
    expect(await pushAuthorized(req(`${AUDIENCE}?token=s3cret-token`, sign({})), env)).toBe(false);
  });

  it("the old ?token= still works on its own, with a content-free warning once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { GMAIL_PUSH_VERIFICATION_TOKEN: "s3cret-token" };
    expect(await pushAuthorized(req(`${AUDIENCE}?token=s3cret-token`), env)).toBe(true);
    expect(await pushAuthorized(req(`${AUDIENCE}?token=s3cret-token`), env)).toBe(true);
    expect(await pushAuthorized(req(`${AUDIENCE}?token=wrong`), env)).toBe(false);
    expect(warn.mock.calls.filter((c) => c[0] === "gmail_push_legacy_token")).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("s3cret");
  });

  it("nothing set: refused", async () => {
    expect(await pushAuthorized(req(AUDIENCE, sign({})), {})).toBe(false);
  });
});

describe("the push route uses it", () => {
  afterEach(() => {
    setGoogleKeysForTests(undefined);
    delete process.env.GMAIL_PUSH_AUDIENCE;
    delete process.env.GMAIL_PUSH_SERVICE_ACCOUNT;
    vi.restoreAllMocks();
  });
  it("a signed push is acknowledged (204); an unsigned one is 403", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.GMAIL_PUSH_AUDIENCE = AUDIENCE;
    process.env.GMAIL_PUSH_SERVICE_ACCOUNT = EMAIL;
    setGoogleKeysForTests(keys);
    const { POST } = await import("@/app/api/gmail/push/route");
    const body = JSON.stringify({ message: { data: "bm90IGpzb24=" } }); // garbled: no DB needed
    const signedNow = sign({
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const ok = await POST(
      new NextRequest(AUDIENCE, { method: "POST", body, headers: { authorization: signedNow } }),
    );
    expect(ok.status).toBe(204);
    const no = await POST(new NextRequest(AUDIENCE, { method: "POST", body }));
    expect(no.status).toBe(403);
  });
});
