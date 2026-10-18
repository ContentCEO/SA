# Notes from branch `w2-security` (wave 2, group "Security and limits")

For the integrator: what `CLAUDE.md`, `docs/LAUNCH.md` and the legal drafts should say.

## CLAUDE.md (Decisions)

- **Sign out everywhere (Check 26 P3, migration `0067_session_version`):** `users.session_version`
  (int, default 0). Auth.js's jwt callback stores it in the token as `sv` on a fresh sign-in, and
  the session carries it as `session.user.sv`. `getWorkspaceForSession(session.user)`
  (`src/server/accounts.ts`, one query joining users) returns the workspace only when `sv` is a
  number equal to the account's version; `requireOwner`, `requireSignedIn`, `requireAdmin`,
  `/signin`'s bounce, and the API routes (`/api/badge`, `/api/push/summary`,
  `/api/drafts/[id]/send` → 401, `/api/gmail/callback` → `/`, nothing saved) all use it. **A
  cookie with no `sv` (every cookie from before this change) is refused**, so every owner — Davi
  too — signs in again once after this deploys. Settings → Account → "Sign out of every phone
  and computer" (`signOutEverywhereAction`) bumps the version, logs `signed_out_everywhere`
  {by: owner}, then signs this device out to `/signin?done=everywhere` ("Signed out
  everywhere."). /admin → "Sign them out everywhere" (`ADMIN_MOVES.sign_out_everywhere`, allowed
  from every status, changes no status; `applyAdminMove` special-cases it; the action re-checks
  `requireAdmin`), logged {by: admin}. `session.maxAge` stays Auth.js's default 30 days until Davi
  answers (see Questions). e2e `signInAs` reads the account's version into the forged cookie.
