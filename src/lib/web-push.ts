import "server-only";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { appUrl } from "./app-url";

/**
 * Web Push (plan #36) over plain fetch, with VAPID (RFC 8292) signing in Node
 * crypto. We send an EMPTY push: the push service (Google, Apple, Mozilla)
 * only ever sees a ping. The phone then asks us for counts and shows them —
 * so no customer name or email text goes through anyone else's servers.
 *
 * Off unless VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set (the usual
 * base64url keys from any VAPID key generator).
 */

const b64url = (b: Buffer) => b.toString("base64url");

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY?.trim() || null;
}

export function pushConfigured(): boolean {
  return !!(vapidPublicKey() && process.env.VAPID_PRIVATE_KEY?.trim());
}

let cached: { pub: string; key: KeyObject } | null = null;
function signingKey(): KeyObject {
  const pub = vapidPublicKey()!;
  if (cached?.pub === pub) return cached.key;
  const raw = Buffer.from(pub, "base64url"); // 0x04 || x || y
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("VAPID_PUBLIC_KEY is not a P-256 key");
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: b64url(raw.subarray(1, 33)),
      y: b64url(raw.subarray(33, 65)),
      d: process.env.VAPID_PRIVATE_KEY!.trim(),
    },
    format: "jwk",
  });
  cached = { pub, key };
  return key;
}

/** The `Authorization: vapid …` header for one push service origin. */
export function vapidAuthorization(endpoint: string, now: Date = new Date()): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now.getTime() / 1000) + 12 * 60 * 60,
        sub: process.env.VAPID_SUBJECT?.trim() || appUrl("/"),
      }),
    ),
  );
  const input = `${header}.${claims}`;
  const sig = sign("sha256", Buffer.from(input), {
    key: signingKey(),
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${input}.${b64url(sig)}, k=${vapidPublicKey()}`;
}

export type PushResult = "sent" | "gone" | "failed" | "not_configured";
export type PushSender = (endpoint: string) => Promise<PushResult>;

/** Send one empty push. "gone" = the phone unsubscribed; forget that endpoint. */
export const sendPush: PushSender = async (endpoint) => {
  if (!pushConfigured()) return "not_configured";
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidAuthorization(endpoint),
        TTL: String(4 * 60 * 60),
        Urgency: "normal",
        "Content-Length": "0",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
};
