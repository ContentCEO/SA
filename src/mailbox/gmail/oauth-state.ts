import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";

export const GMAIL_STATE_COOKIE = "sa_gmail_oauth_state";
export const GMAIL_STATE_MAX_AGE_SECONDS = 10 * 60;

export function newOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time comparison of the `state` Google echoes back against our cookie. */
export function statesMatch(expected: string | undefined, received: string | null): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const gmailRedirectPath = "/api/gmail/callback";

/**
 * Check 42 P3: which Gmail the owner meant to connect. "first" (no inbox yet), "add" (another
 * inbox: Google's account chooser), or "reconnect" (this card's inbox). Carried in the state
 * cookie next to the random state; the mailbox id is re-checked against the workspace on the
 * way back, never trusted alone.
 */
export type ConnectMode =
  { mode: "first" } | { mode: "add" } | { mode: "reconnect"; mailboxId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The cookie value: `<state>~<mode>~<mailbox id or empty>`. The state is base64url (no ~). */
export function stateCookieValue(state: string, m: ConnectMode): string {
  return `${state}~${m.mode}~${m.mode === "reconnect" ? m.mailboxId : ""}`;
}

/** Splits the cookie back; an old plain-state cookie reads as "first". */
export function parseStateCookie(
  value: string | undefined,
): { state: string; connect: ConnectMode } | undefined {
  if (!value) return undefined;
  const [state, mode, mailboxId] = value.split("~");
  if (!state) return undefined;
  if (mode === "add") return { state, connect: { mode: "add" } };
  if (mode === "reconnect" && mailboxId && UUID.test(mailboxId))
    return { state, connect: { mode: "reconnect", mailboxId } };
  return { state, connect: { mode: "first" } };
}

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
