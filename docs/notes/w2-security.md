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
- **Delete my account needs a fresh sign-in and the typed word (Check 26 P4):** the jwt callback
  stores `sat` (sign-in time, seconds) on a fresh Google sign-in, because Auth.js re-issues the
  token (and its `iat`) on every visit. `requireRecentSignIn(15)` (`src/server/session.ts`)
  redirects an older sign-in (or one with no `sat`) to `/signin?next=<this screen>&reason=recent`
  ("For your safety, sign in again to delete your account."; `/signin` doesn't bounce a
  signed-in person to /start then, and the sign-in action sends them back through
  `safeNextPath`). Both delete actions (Settings and the terms screen) then require the form
  field `confirm` = DELETE (trimmed, any case; `src/server/account-deletion-rules.ts`), else
  `?error=confirm` ("Type DELETE to confirm."). The screen's field keeps the button off until it
  matches; the server is the gate. Google can't be made to ask for a password again (its OIDC
  has no `prompt=login`), so a browser still signed in to Google goes straight through: the
  check proves the Google account is at hand, not a password.
- **No row values in query errors (Check 26 P5):** `src/db/safe-errors.ts` wraps Drizzle's
  `PgPreparedQuery.prototype.queryWithCache` once (installed when `@/db` loads; every query,
  postgres.js and PGlite, inside transactions too) and rethrows any DrizzleQueryError as
  `SafeQueryError`: message = "Failed query: <first SQL line>" plus " (code 23505)" when the
  driver gave a code; `.code` kept (so `isUniqueViolation` still works); params, cause and the
  original stack dropped. Inngest middleware `ScrubErrors` (`src/jobs/client.ts`,
  `wrapFunctionHandler` + `wrapStepHandler`) runs `scrubText` (now exported from
  `src/lib/sentry.ts`) over the error's message, stack and causes and deletes a `params` field,
  in place, so NonRetriableError / RetryAfterError still behave. The waitlist and Growth catches
  stay. The unit-test date guard now fails with code `SA_DATE_BOUND_INTO_SQL` (its message is a
  dropped cause now).
- **Notices take own keys only (Check 26 P6):** `noticeText(map, key)` (`src/lib/notice-text.ts`)
  returns a notice only for a string key the map owns with a string value. Every `?done=` /
  `?error=` lookup in src/app uses it (settings screens and list, queue, money, quotes, inbox,
  customers, billing, connect, admin incl. Growth and waitlist, welcome/terms), and
  `isCategory` (inbox `?c=`) uses `Object.hasOwn`. A unit test fails on any new
  `map[params.x]` lookup in src/app.
- **Replacing the encryption key (Check 26 P7):** `decryptSecret` (`src/lib/crypto.ts`) tries
  `TOKEN_ENCRYPTION_KEY`, then `TOKEN_ENCRYPTION_KEY_PREVIOUS` (optional, same 32-byte check,
  same preview guard) when the auth tag fails; `encryptSecret` always uses the current key.
  `pnpm reseal:secrets` (`scripts/reseal-secrets.ts` → `src/server/reseal-secrets.ts`) re-seals
  every mailbox refresh token and every `v1.`-format `app_settings` value in batches, with a
  conditional update (safe to re-run), and prints counts only. Steps in `docs/SETUP.md` §5a.
  LAUNCH.md's secret-rotation step can point at §5a: rotating `TOKEN_ENCRYPTION_KEY` no longer
  means every owner reconnects.
- **Draft a reply: 90 an hour, counted at the model (Check 40 P3):** `LIMITS.draft` = 90 per
  hour. `createDraftForThread` takes `beforeModelCall` (runs once, right before the model is
  asked; false → skipped `rate_limited`); Queue's Draft a reply and the Inbox/Money offers
  (`askFor`) count the limit there, so taps that end in already-pending, no text or any other
  skip use nothing (the check and the count are still hitLimit's one upsert). Found money's
  "Draft them" counts before it queues the job (one tap, a batch). The refusal goes to
  `/queue?error=draft_limit&until=<ms>` and reads "You've asked for a lot of drafts this hour.
  You can ask again at 10:00am." in the owner's zone (`src/server/draft-limit-rules.ts`; a
  missing or odd time says "Try again in a little while."). The daily AI cap is unchanged.
  CLAUDE.md's rate-limit line should say "Draft a reply 90/h (counted at the model call)".
- **Every rate limit is proven wired (Check 31 P4):** `tests/unit/security-surface.test.ts`
  `LIMIT_SITES`: one row per `hitLimit` call in src (file, function, limit, the work calls it
  guards); each row checks an awaited `hitLimit("<name>")` comes before the first work call
  (the two Draft a reply rows check it sits in `createDraftForThread`'s `beforeModelCall`). It
  fails when a LIMITS key has no row or a hitLimit call isn't in the table, and has a fixture
  self-test. `send-route.test.ts` proves the send API's 429 + Retry-After with no Gmail call.
  Spot-checked: deleting the send (sendTap), billing (checkout) or connect limit fails it.
  New hitLimit calls (other groups) need a row here.
- **Headers and robots (Check 26 P9):** `poweredByHeader: false` in next.config.ts;
  `Cross-Origin-Opener-Policy: same-origin` in `securityHeaders()` (sign-in, Gmail connect and
  Stripe are full-page redirects, not popups); robots.txt no longer names /admin (its three
  pages already say `robots: { index: false }`, now tested). e2e `security-public.spec.ts`
  (also in smoke runs) checks COOP, no x-powered-by and robots.txt.
- **Gmail push checks Pub/Sub's signed token (Check 26 P10):** `src/server/pubsub-auth.ts`
  verifies the `Authorization: Bearer` Google ID token (RS256 against Google's keys from
  `https://www.googleapis.com/oauth2/v3/certs`, cached per Cache-Control; iss
  accounts.google.com, aud = `GMAIL_PUSH_AUDIENCE`, email = `GMAIL_PUSH_SERVICE_ACCOUNT` and
  verified, exp/iat with 60s skew). With either new setting set, only the signed way counts
  (half set up refuses everything); the old `?token=` (`GMAIL_PUSH_VERIFICATION_TOKEN`) is
  accepted only when neither is set, with one content-free `gmail_push_legacy_token` warning per
  cold start. Refusals log `gmail_push_refused` {reason}. `www.googleapis.com` added to the
  data-paths FETCH_HOSTS under the existing **Google** line (public keys; nothing about anyone
  is sent). SETUP.md §6a now describes only the signed setup (`--push-auth-service-account`,
  `--push-auth-token-audience`).
- **LAUNCH.md (integrator):** the Gmail push rows (`GMAIL_PUBSUB_TOPIC`,
  `GMAIL_PUSH_VERIFICATION_TOKEN`, around lines 662 and 963 at 05bb296) should become
  `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_AUDIENCE`, `GMAIL_PUSH_SERVICE_ACCOUNT` (none sensitive)
  and point at SETUP.md §6a; the token is no longer set up.
