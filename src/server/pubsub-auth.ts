import "server-only";
import { createPublicKey, timingSafeEqual, verify, type JsonWebKey } from "node:crypto";

/**
 * Check 26 P10: Gmail instant notifications arrive from Google Pub/Sub. With authenticated push,
 * Pub/Sub signs each request with a Google ID token (a JWT) in the Authorization header; we
 * check its signature against Google's public keys and its issuer, audience (our endpoint URL,
 * GMAIL_PUSH_AUDIENCE), service account (GMAIL_PUSH_SERVICE_ACCOUNT) and expiry. Nothing secret
 * travels in the URL, so nothing lands in request logs.
 *
 * The old way — a shared secret as ?token= — is accepted only while GMAIL_PUSH_VERIFICATION_TOKEN
 * is set and the two new settings aren't, so turning the signed setup on never breaks mid-switch.
 */
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const SKEW_SEC = 60;

export type GoogleJwk = JsonWebKey & { kid?: string; alg?: string; kty?: string };
/** Google's signing keys; `fresh` asks past the cache (a key we haven't seen yet). */
export type KeySource = (fresh: boolean) => Promise<GoogleJwk[]>;

let cache: { keys: GoogleJwk[]; until: number } | null = null;

/** Google's keys, cached for as long as Google says (Cache-Control max-age), else an hour. */
export const googleKeys: KeySource = async (fresh) => {
  const now = Date.now();
  if (!fresh && cache && cache.until > now) return cache.keys;
  // A literal URL, so the data-paths scan sees the host (Google; sends nothing about anyone).
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!res.ok) throw new Error(`Google certs ${res.status}`);
  const body = (await res.json()) as { keys?: GoogleJwk[] };
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1]);
  cache = {
    keys: body.keys ?? [],
    until: now + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 3600) * 1000,
  };
  return cache.keys;
};

let keySource: KeySource = googleKeys;
/** Tests only: a locally made key set instead of Google's. */
export function setGoogleKeysForTests(source: KeySource | undefined) {
  keySource = source ?? googleKeys;
  cache = null;
}

export type PushCheck =
  | "ok"
  | "missing"
  | "malformed"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "wrong_email"
  | "expired";

const json = (part: string) =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

/** Checks a Pub/Sub push's `Authorization: Bearer <Google ID token>`. */
export async function verifyPushToken(
  authorization: string | null,
  expected: { audience: string; email: string },
  { keys = keySource, now = new Date() }: { keys?: KeySource; now?: Date } = {},
): Promise<PushCheck> {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
  if (!token) return "missing";
  const parts = token.split(".");
  if (parts.length !== 3) return "malformed";
  const [h, p, s] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = json(h);
    claims = json(p);
  } catch {
    return "malformed";
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return "malformed";
  const find = (list: GoogleJwk[]) => list.find((k) => k.kid === header.kid && k.kty === "RSA");
  const jwk = find(await keys(false)) ?? find(await keys(true));
  if (!jwk) return "unknown_key";
  let good = false;
  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    good = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
  } catch {
    good = false;
  }
  if (!good) return "bad_signature";
  if (typeof claims.iss !== "string" || !ISSUERS.has(claims.iss)) return "wrong_issuer";
  if (claims.aud !== expected.audience) return "wrong_audience";
  if (claims.email !== expected.email || claims.email_verified !== true) return "wrong_email";
  const t = Math.floor(now.getTime() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + SKEW_SEC < t) return "expired";
  if (typeof claims.iat === "number" && claims.iat - SKEW_SEC > t) return "expired";
  return "ok";
}

/** The old shared secret, compared in constant time. */
export function legacyTokenOk(received: string | null, expected: string | undefined): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

type PushEnv = Partial<
  Record<
    "GMAIL_PUSH_AUDIENCE" | "GMAIL_PUSH_SERVICE_ACCOUNT" | "GMAIL_PUSH_VERIFICATION_TOKEN",
    string
  >
> &
  Record<string, string | undefined>;

let warnedLegacy = false;

/** Whether a push request may start a sync: the signed way, or (only during the switch) the old. */
export async function pushAuthorized(
  request: { headers: Headers; url: string },
  env: PushEnv = process.env,
  opts: { keys?: KeySource; now?: Date } = {},
): Promise<boolean> {
  const audience = env.GMAIL_PUSH_AUDIENCE;
  const email = env.GMAIL_PUSH_SERVICE_ACCOUNT;
  if (audience || email) {
    if (!audience || !email) return false; // half set up: refuse rather than guess
    const r = await verifyPushToken(
      request.headers.get("authorization"),
      { audience, email },
      opts,
    );
    if (r !== "ok") console.warn("gmail_push_refused", { reason: r });
    return r === "ok";
  }
  const token = new URL(request.url).searchParams.get("token");
  const ok = legacyTokenOk(token, env.GMAIL_PUSH_VERIFICATION_TOKEN);
  if (ok && !warnedLegacy) {
    warnedLegacy = true;
    // Content-free: which way it came in, never the token.
    console.warn("gmail_push_legacy_token", { switchTo: "GMAIL_PUSH_AUDIENCE" });
  }
  return ok;
}
