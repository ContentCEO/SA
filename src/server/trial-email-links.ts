import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { appUrl } from "@/lib/app-url";

/**
 * The trial emails' one-click "Stop these emails" link (Davi, 2026-10-16): the workspace id and
 * an HMAC-SHA256 over it keyed with AUTH_SECRET, checked in constant time. No database here, so
 * both the senders and the route can use it.
 */

const STOP_PURPOSE = "trial-emails:stop:";

/** The link's signature: HMAC-SHA256 over the workspace id, keyed with AUTH_SECRET. */
function stopSignature(workspaceId: string): string | null {
  const secret = process.env.AUTH_SECRET ?? "";
  // No usable secret, no link: an empty key would make every signature guessable.
  if (secret.length < 16) return null;
  return createHmac("sha256", secret)
    .update(STOP_PURPOSE + workspaceId)
    .digest("base64url");
}

/** The address of the stop link (`/api/emails/stop?w=…&s=…`), or null without a secret. */
export function stopLinkFor(workspaceId: string): string | null {
  const s = stopSignature(workspaceId);
  if (!s) return null;
  return appUrl(`/api/emails/stop?w=${encodeURIComponent(workspaceId)}&s=${s}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The workspace a stop link names, if its signature is right (constant-time compare). */
export function verifiedStopLink(params: URLSearchParams): { workspaceId: string } | null {
  const w = params.get("w") ?? "";
  const s = params.get("s") ?? "";
  if (!UUID.test(w) || !s) return null;
  const expected = stopSignature(w);
  if (!expected) return null;
  const a = Buffer.from(expected);
  const b = Buffer.from(s);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { workspaceId: w.toLowerCase() };
}

/** One-click unsubscribe headers (RFC 8058), so Gmail can offer its own button too. */
export function stopHeaders(link: string): Record<string, string> {
  return { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}
