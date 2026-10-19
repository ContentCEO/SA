import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { appUrl } from "@/lib/app-url";

/**
 * The trial emails' one-click "Stop these emails" link (Davi, 2026-10-16): the workspace id and
 * an HMAC-SHA256 over it keyed with AUTH_SECRET, checked in constant time. No database here, so
 * both the senders and the route can use it.
 */

/**
 * Which email a stop link switches off. `trial`: the trial emails (links carry no `k`, as before).
 * `digest` (Check 18 P9): the morning email, and the monthly summary that follows its switch. Each
 * kind signs a different purpose, so a trial link can never turn the morning email off.
 */
export type StopKind = "trial" | "digest";

const STOP_PURPOSE: Record<StopKind, string> = {
  trial: "trial-emails:stop:",
  digest: "digest-emails:stop:",
};

/** The link's signature: HMAC-SHA256 over the kind's purpose and the workspace id, keyed with AUTH_SECRET. */
function stopSignature(workspaceId: string, kind: StopKind): string | null {
  const secret = process.env.AUTH_SECRET ?? "";
  // No usable secret, no link: an empty key would make every signature guessable.
  if (secret.length < 16) return null;
  return createHmac("sha256", secret)
    .update(STOP_PURPOSE[kind] + workspaceId)
    .digest("base64url");
}

/** The address of the stop link (`/api/emails/stop?w=…&s=…`, plus `k=digest`), or null without a secret. */
export function stopLinkFor(workspaceId: string, kind: StopKind = "trial"): string | null {
  const s = stopSignature(workspaceId, kind);
  if (!s) return null;
  const k = kind === "trial" ? "" : `&k=${kind}`;
  return appUrl(`/api/emails/stop?w=${encodeURIComponent(workspaceId)}&s=${s}${k}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The kind a link names (`k`), or null for anything we don't know. */
export function stopKindOf(params: URLSearchParams): StopKind | null {
  const k = params.get("k");
  if (k === null || k === "trial") return "trial";
  return k === "digest" ? "digest" : null;
}

/** The workspace and kind a stop link names, if its signature is right (constant-time compare). */
export function verifiedStopLink(
  params: URLSearchParams,
): { workspaceId: string; kind: StopKind } | null {
  const w = params.get("w") ?? "";
  const s = params.get("s") ?? "";
  const kind = stopKindOf(params);
  if (!UUID.test(w) || !s || !kind) return null;
  const expected = stopSignature(w, kind);
  if (!expected) return null;
  const a = Buffer.from(expected);
  const b = Buffer.from(s);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { workspaceId: w.toLowerCase(), kind };
}

/** One-click unsubscribe headers (RFC 8058), so Gmail can offer its own button too. */
export function stopHeaders(link: string): Record<string, string> {
  return { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}
