/**
 * The minimum Gmail scopes. docs/google-verification.md explains each one in
 * plain language; keep the two in sync.
 *
 * Two, not three (Davi, 2026-10-15): Google's API reference authorizes `drafts.send` (every
 * customer reply) and `messages.send` (trial practice copies) under `gmail.compose`, so
 * `gmail.send` added nothing. Owners who connected while we still asked for it keep that grant
 * (Google adds it back on a reconnect, since we pass `include_granted_scopes=true`); a grant
 * with extra scopes is fine, only a missing one is refused.
 */
export const GMAIL_SCOPES = {
  readonly: "https://www.googleapis.com/auth/gmail.readonly",
  compose: "https://www.googleapis.com/auth/gmail.compose",
} as const;

export const IDENTITY_SCOPES = ["openid", "email", "profile"] as const;

export const REQUIRED_GMAIL_SCOPES = Object.values(GMAIL_SCOPES);

export const ALL_CONNECT_SCOPES = [...IDENTITY_SCOPES, ...REQUIRED_GMAIL_SCOPES];

/**
 * Google lets people untick individual permissions. Report which of ours are missing; anything
 * extra in the grant (an older connection's `gmail.send`) is ignored.
 */
export function missingScopes(granted: string[]): string[] {
  const set = new Set(granted);
  return REQUIRED_GMAIL_SCOPES.filter((s) => !set.has(s));
}
