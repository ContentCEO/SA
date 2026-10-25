/**
 * Plan #49: the Microsoft Graph permissions Squared Away asks for — exactly these four, all
 * delegated (acting as the owner, only on their own mailbox). docs/notes/legal-m12-outlook.md
 * explains each in plain words; keep the two in sync.
 *
 * - `Mail.ReadWrite`: read mail to sort it, and write reply drafts into the owner's Drafts.
 * - `Mail.Send`: send a draft, only when the owner taps Send reply (or earned autopilot).
 * - `offline_access`: a refresh token, so jobs can run while the owner is away.
 * - `User.Read`: the owner's own address (`/me`).
 */
export const OUTLOOK_SCOPES = {
  readWrite: "Mail.ReadWrite",
  send: "Mail.Send",
  offline: "offline_access",
  user: "User.Read",
} as const;

export const REQUIRED_OUTLOOK_SCOPES = Object.values(OUTLOOK_SCOPES);

const GRAPH_PREFIX = "https://graph.microsoft.com/";

/** "https://graph.microsoft.com/Mail.Send" and "mail.send" both read as "mail.send". */
const norm = (s: string) =>
  (s.toLowerCase().startsWith(GRAPH_PREFIX) ? s.slice(GRAPH_PREFIX.length) : s).toLowerCase();

/**
 * Which of ours are missing from a token response. Microsoft lists the granted Graph scopes in
 * `scope` (sometimes with the Graph prefix) but not always `offline_access`: a refresh token in
 * the same response is what proves that one. Anything extra in the grant is fine.
 */
export function missingOutlookScopes(granted: string[], hasRefreshToken: boolean): string[] {
  const set = new Set(granted.map(norm));
  return REQUIRED_OUTLOOK_SCOPES.filter((s) =>
    s === OUTLOOK_SCOPES.offline ? !hasRefreshToken && !set.has(norm(s)) : !set.has(norm(s)),
  );
}
