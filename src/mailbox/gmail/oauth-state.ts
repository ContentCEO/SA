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
