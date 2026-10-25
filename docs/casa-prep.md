# CASA preparation (for Davi and the engineers; never pasted into Google's form)

Gmail's restricted scopes need a yearly security assessment (CASA) by an App Defense Alliance
lab, based on the OWASP Application Security Verification Standard (ASVS). Labs run a scan and a
questionnaire of roughly 50 questions. High and medium scan findings should be cleared **before**
the lab, or they cost a second scan cycle. This file is the evidence folder: what is in scope, where
each control lives in the code and which test proves it, which risks we accept and why, and the
open items. `docs/LAUNCH.md` step 0g says when to use it; `pnpm` has no step for it, the pre-scan
is the GitHub action **CASA pre-scan** (`.github/workflows/casa-prescan.yml`, run by hand).

## 1. Scope

**In scope (what the lab tests):** the production web app on the production domain
(`APP_URL`), its signed-in screens and its `/api/*` routes (Gmail OAuth callback, Stripe and Pub/Sub
webhooks, Inngest, health, drafts, push and badge). One Next.js app on Vercel; no mobile binary (the
"app" is the website installed to the home screen).

**Out of scope (providers with their own assessments; each is named in the privacy policy):**

| Provider  | What it holds for us                             | Its security page                       |
| --------- | ------------------------------------------------ | --------------------------------------- |
| Vercel    | hosting, TLS, edge, environment variables        | https://vercel.com/security             |
| Neon      | the Postgres database (encrypted at rest)        | https://neon.com/security               |
| Anthropic | the AI that sorts and drafts (no training on it) | https://trust.anthropic.com             |
| Inngest   | background job scheduling (ids and counts only)  | https://www.inngest.com/security        |
| Stripe    | card payments (we never see card numbers)        | https://stripe.com/docs/security        |
| Resend    | the emails we send owners                        | https://resend.com/security             |
| Google    | Gmail itself, sign-in                            | https://safety.google/security-privacy/ |
| Twilio    | text alerts, only if switched on                 | https://www.twilio.com/en-us/security   |

## 2. Evidence, one row per topic

Each row names where the control lives and the test that proves it (all tests run in CI,
`.github/workflows/ci.yml`, on every pull request).

| Topic                           | How it's done                                                                                                                                                                                                                        | Code                                                                                                  | Test                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication                  | Google sign-in only (Auth.js, `openid email profile`), JWT sessions, invite-only; a session whose version is behind is signed out everywhere; irreversible actions ask for a fresh sign-in.                                          | `src/auth.ts`, `src/server/session.ts`, `src/server/accounts.ts`                                      | `tests/unit/accounts-mailboxes.test.ts`, `tests/unit/terms-agreement.test.ts`, `tests/unit/delete-account-confirm.test.ts`, `tests/e2e/security.spec.ts` |
| Session and CSRF                | Every mutation is a Server Action (POST, Origin/Host checked by Next) or an API route checked for a session; cookies are httpOnly, SameSite=Lax; the OAuth `state` is a random 32-byte cookie compared in constant time.             | `src/app/**/actions.ts`, `src/mailbox/gmail/oauth-state.ts`, `src/app/api/gmail/callback/route.ts`    | `tests/unit/security-surface.test.ts`, `tests/unit/gmail-connector.test.ts`, `tests/e2e/security.spec.ts`                                                |
| Access control                  | `requireOwner()` / `requireAdmin()` in every action and screen; every query scoped by `workspaceId`; `/admin` answers 404 to anyone but `ADMIN_EMAIL`; a 10-minute signed-in check for Delete my account.                            | `src/server/session.ts`, `src/server/admin.ts`                                                        | `tests/unit/security-surface.test.ts`, `tests/unit/lifecycle.test.ts`, `tests/e2e/security.spec.ts`, `tests/e2e/lifecycle.spec.ts`                       |
| Secrets at rest                 | Gmail refresh tokens and the Stripe webhook secret are AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY`; a previous key is accepted only while `pnpm reseal:secrets` moves stored secrets to the new one (key rotation).            | `src/lib/crypto.ts`, `scripts/reseal-secrets.ts`                                                      | `tests/unit/crypto.test.ts`, `tests/unit/key-rotation.test.ts`                                                                                           |
| Transport and browser hardening | HTTPS only with Strict-Transport-Security for a year; Content-Security-Policy, X-Frame-Options DENY, nosniff, Referrer-Policy, Cross-Origin-Opener-Policy, Permissions-Policy; no `x-powered-by`.                                    | `src/config/security-headers.ts`, `next.config.ts`                                                    | `tests/unit/security-headers.test.ts`, `tests/e2e/public-site.spec.ts`, `tests/e2e/security-public.spec.ts`                                              |
| Logging without content         | Logs carry ids, counts, prompt versions and error names, never tokens, email text, addresses or `err.message`; Sentry (if on) is scrubbed of request data, cookies, headers and query, with emails masked.                           | `src/lib/sentry.ts`, every `console.error` call site                                                  | `tests/unit/no-content-logs.test.ts`, `tests/unit/quiet-logs.test.ts`, `tests/unit/sentry.test.ts`, `tests/unit/admin-no-content.test.ts`                |
| Rate limits                     | Fixed windows in the `rate_limits` table, one atomic upsert, per workspace (sends, drafts, re-learn, billing, Gmail connect) and per hashed IP for public forms; webhooks are signature- or token-checked instead.                   | `src/server/rate-limit.ts`                                                                            | `tests/unit/rate-limit-deletion.test.ts`, `tests/unit/queue-actions-limit.test.ts`, `tests/unit/draft-limit.test.ts`                                     |
| Webhook and push authentication | Stripe webhooks are signature-checked; Gmail Pub/Sub pushes carry a Google-signed ID token checked against the audience and service account; Inngest requests are signed.                                                            | `src/app/api/stripe/webhook/route.ts`, `src/app/api/gmail/push/route.ts`, `src/server/pubsub-auth.ts` | `tests/unit/billing.test.ts`, `tests/unit/pubsub-auth.test.ts`, `tests/unit/push-poll.test.ts`                                                           |
| Data retention and purge        | Email text (bodies, snippets, draft text, extracted words) is purged after `RETENTION_BODY_DAYS` (30) by a daily job; mail older than that is never stored with a body.                                                              | `src/server/sync.ts` (`purgeExpiredBodies`), `src/config/retention.ts`                                | `tests/unit/sync.test.ts`, `tests/unit/data-lifecycle.test.ts`                                                                                           |
| Deletion on request             | Settings → Account → Delete my account: cancels the subscription, revokes Google access for each mailbox, deletes the user row and everything that cascades; Disconnect Gmail deletes what was stored from that mailbox.             | `src/server/account-deletion.ts`, `src/server/mailboxes.ts`                                           | `tests/unit/data-lifecycle.test.ts`, `tests/unit/delete-account-confirm.test.ts`, `tests/e2e/account.spec.ts`                                            |
| Least privilege at Google       | Two Gmail scopes (`gmail.readonly`, `gmail.compose`); no `gmail.modify`, `gmail.send` or full mail access; a grant missing either scope is revoked and nothing saved.                                                                | `src/mailbox/gmail/scopes.ts`, `src/mailbox/gmail/connector.ts`                                       | `tests/unit/gmail-connector.test.ts`, `tests/unit/verification-doc.test.ts`                                                                              |
| Where data may go               | Email text goes to Anthropic only; a static scan refuses any other AI SDK, Anthropic's batch or files APIs, and any `fetch()` host not tied to a privacy-policy line.                                                                | `src/ai/client.ts`, `src/config/models.ts`                                                            | `tests/unit/data-paths.test.ts`, `tests/unit/price-memory.test.ts`, `tests/unit/growth-boundary.test.ts`                                                 |
| Dependency updates              | CI fails on a high or critical advisory in production dependencies (reviewed exceptions, if any, in `.github/audit-allow.txt`, empty today); Dependabot opens security-update pull requests weekly.                                  | `scripts/audit-check.ts`, `.github/dependabot.yml`                                                    | `tests/unit/audit-check.test.ts`, CI step "Audit production dependencies"                                                                                |
| Secrets handling                | Secrets live only in Vercel's environment variables (never in the repository); every Markdown file and `.env.example` is scanned for credential shapes; a preview pointed at production's database or keys refuses to start.         | `src/config/environment-guard.ts`, `docs/SETUP.md` §4                                                 | `tests/unit/launch-doc.test.ts` (secret patterns), `tests/unit/environment-guard.test.ts`, `tests/unit/env-docs.test.ts`                                 |
| Test and production separation  | Local e2e mode (fake Google, Gmail and Anthropic) switches on only off Vercel with a loopback database; the fakes refuse any real client id or key.                                                                                  | `src/config/e2e.ts`, `tests/e2e/fakes/server.ts`                                                      | `tests/unit/e2e-mode.test.ts`                                                                                                                            |
| Input handling                  | Form input is validated with Zod (plain-language messages); Markdown is rendered to React elements, never raw HTML; email text is wrapped in `untrusted()` before it reaches the model and instruction-like text is flagged in code. | `src/server/profile.ts`, `src/lib/markdown.tsx`, `src/ai/prompts/untrusted.ts`, `src/ai/guards.ts`    | `tests/unit/profile.test.ts`, `tests/unit/guards.test.ts`                                                                                                |
| Incident contact                | `SUPPORT_EMAIL` (in the footer and the legal pages) and Davi's phone from `src/config/site.ts`; the privacy policy has the breach-notice sentence (legal release pending).                                                           | `src/config/site.ts`, `docs/privacy-policy.md`                                                        | `tests/unit/legal-docs.test.ts`                                                                                                                          |

## 3. Accepted risks (with the reason)

1. **`'unsafe-inline'` for scripts and styles in the Content-Security-Policy**
   (`src/config/security-headers.ts`). Next's inline page data and a few style attributes need it.
   Per-request nonces would force every public page to render on each request (no CDN caching),
   which the homepage and Growth page were deliberately made static for (Check 29 P3). The rest of
   the policy is tight: `default-src 'self'`, no `unsafe-eval` outside local development, no
   framing, scripts only from our origin. Revisit if Next's nonce support no longer costs static
   rendering.
2. **One `TOKEN_ENCRYPTION_KEY`, rotated by hand.** Rotation exists (`TOKEN_ENCRYPTION_KEY_PREVIOUS`
   - `pnpm reseal:secrets`, `tests/unit/key-rotation.test.ts`) but runs when an engineer decides,
     not on a schedule. Acceptable for a two-person company; write the yearly rotation into the CASA
     renewal reminder (LAUNCH.md 0g).
3. **Error alerts (Sentry) off until `NEXT_PUBLIC_SENTRY_DSN` is set.** Errors still reach Vercel's
   own logs (content-free by the logging rule). Turning Sentry on is LAUNCH.md step 8; the scrubber
   is already tested.
4. **Previews share production's database until LAUNCH.md step 2 is done.** Previews sit behind
   Vercel's login and only team members can open them; the preview guard
   (`src/config/environment-guard.ts`) refuses a preview pointed at production once the
   fingerprints are in. Closed by the `sa-preview` Neon project (Davi's step).

## 4. Open items

| Item                                              | State                                                                                         | Fix                                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Next.js advisories                                | **Open until checked**: `next` is pinned (`package.json`); CI's audit fails on high/critical. | Run `pnpm audit --prod` before the lab; bump `next` to the fixed patch if one is named. |
| `x-powered-by: Next.js` on every response         | **Done** (Check 26 P9): `poweredByHeader: false` in `next.config.ts`.                         | `tests/unit/security-headers.test.ts` keeps it off.                                     |
| Key rotation without a schedule                   | **Accepted** (risk 2).                                                                        | Yearly, with the CASA renewal.                                                          |
| Sentry off                                        | **Open** (Davi's step, LAUNCH.md step 8).                                                     | Set `NEXT_PUBLIC_SENTRY_DSN` and redeploy.                                              |
| `'unsafe-inline'` in the CSP                      | **Accepted** (risk 1).                                                                        | Revisit with Next's nonce support.                                                      |
| `x-robots-tag: noindex` on the vercel.app address | **Open** until the domain move (LAUNCH.md step 5); not a security finding.                    | `pnpm check:headers https://<your domain>` after the move.                              |
| Pre-scan not yet run                              | **Open**: the workflow exists; run it from Actions → CASA pre-scan once on a branch.          | Clear high and medium findings or add them here with a reason.                          |

## 5. How to run the pre-scan

Actions → **CASA pre-scan** → Run workflow (any branch). It builds the app in CI with the same
stand-ins the browser tests use (fake Google, Gmail and Anthropic, a throwaway Postgres), so it
never touches production or a preview and needs no production secret. It runs OWASP ZAP's baseline
scan against the public pages and the Fluid Attacks `skims` static scan the App Defense Alliance
documents for CASA, and attaches both reports as workflow artifacts (`zap-report`,
`skims-report`). Read them, fix what is high or medium, or write it into section 3 with a reason.
