import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { isUuid, type ConnectMode } from "../gmail/oauth-state";

/**
 * Plan #49: Outlook's connect state. The same rules as Gmail's (random 32 bytes, httpOnly,
 * SameSite=Lax, 10 minutes, compared in constant time with `statesMatch`), in its own cookie
 * scoped to `/api/outlook`, plus a PKCE verifier (RFC 7636, S256): Microsoft's token endpoint
 * then only accepts the code from the browser that started the connect.
 */
export const OUTLOOK_STATE_COOKIE = "sa_outlook_oauth_state";
export const OUTLOOK_STATE_MAX_AGE_SECONDS = 10 * 60;
export const outlookRedirectPath = "/api/outlook/callback";

export function newPkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** `<state>~<mode>~<mailbox id or empty>~<pkce verifier>`. Both random parts are base64url. */
export function outlookStateCookieValue(state: string, m: ConnectMode, verifier: string): string {
  return `${state}~${m.mode}~${m.mode === "reconnect" ? m.mailboxId : ""}~${verifier}`;
}

export function parseOutlookStateCookie(
  value: string | undefined,
): { state: string; connect: ConnectMode; verifier: string } | undefined {
  if (!value) return undefined;
  const [state, mode, mailboxId, verifier] = value.split("~");
  if (!state || !verifier || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) return undefined;
  const connect: ConnectMode =
    mode === "add"
      ? { mode: "add" }
      : mode === "reconnect" && isUuid(mailboxId)
        ? { mode: "reconnect", mailboxId: mailboxId! }
        : { mode: "first" };
  return { state, connect, verifier };
}
