/**
 * The minimum Gmail scopes. docs/google-verification.md explains each one in
 * plain language; keep the two in sync.
 */
export const GMAIL_SCOPES = {
  readonly: "https://www.googleapis.com/auth/gmail.readonly",
  compose: "https://www.googleapis.com/auth/gmail.compose",
  send: "https://www.googleapis.com/auth/gmail.send",
} as const;

export const IDENTITY_SCOPES = ["openid", "email", "profile"] as const;

export const REQUIRED_GMAIL_SCOPES = Object.values(GMAIL_SCOPES);

export const ALL_CONNECT_SCOPES = [...IDENTITY_SCOPES, ...REQUIRED_GMAIL_SCOPES];

/** Google lets people untick individual permissions. Report what's missing. */
export function missingScopes(granted: string[]): string[] {
  const set = new Set(granted);
  return REQUIRED_GMAIL_SCOPES.filter((s) => !set.has(s));
}
